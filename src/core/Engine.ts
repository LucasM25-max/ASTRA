/**
 * Engine.ts - ASTRA core
 * =============================================================================
 * The main game loop: a fixed timestep simulation with a variable-rate render.
 *
 *   each animation frame:
 *     1. clamp the raw delta so a stalled tab cannot fast-forward the world
 *     2. timeController.update(realDelta)  ->  game delta (already scaled)
 *     3. fixed update(s): 0..maxSubSteps calls at a constant `fixedTimeStep`
 *     4. render: exactly one call, carrying the interpolation alpha
 *
 * Why fixed + variable:
 *   - The fixed step keeps physics and animation deterministic regardless of
 *     frame rate, which matters once Rapier and the dice theatre arrive.
 *   - The render step runs at whatever rate the browser gives us, so the camera
 *     and visuals stay smooth even when the simulation is throttled.
 *   - When `gameSpeed` drops (time dilation) the accumulator fills more slowly,
 *     so slow motion falls out of the same code path - no special cases.
 *
 * The engine owns *nothing* about the world: it drives the clock and the
 * listeners. Everything else subscribes through `onFixedUpdate` / `onRender`.
 * =============================================================================
 */

import { EventBus } from './EventBus';
import { TimeController } from './TimeController';

/** Read-only view of the frame handed to render listeners. */
export type EngineFrameInfo = Readonly<{
  /** Monotonic frame counter, starting at 1 for the first rendered frame. */
  frame: number;
  /** Clamped wall-clock delta for this frame, in seconds. */
  realDelta: number;
  /** Scaled delta for this frame (`realDelta * gameSpeed`), in seconds. */
  gameDelta: number;
  /** How many fixed steps ran this frame. */
  fixedSteps: number;
  /** Leftover accumulator / fixedTimeStep, for interpolating renders. */
  alpha: number;
  /** Total scaled time since the engine started, in seconds. */
  elapsed: number;
  /** Total real time since the engine started, in seconds. */
  realElapsed: number;
  /** Smoothed frames per second, refreshed 4x a second. */
  fps: number;
  /** The game speed that produced this frame. */
  gameSpeed: number;
}>;

export type FixedUpdateListener = (fixedDelta: number) => void;
export type RenderListener = (frame: EngineFrameInfo) => void;
/** Runs once per frame, after the clock is advanced and before any simulation. */
export type FrameStartListener = () => void;

/** Mutable twin of `EngineFrameInfo`; reused every frame to stay garbage free. */
interface MutableFrameInfo {
  frame: number;
  realDelta: number;
  gameDelta: number;
  fixedSteps: number;
  alpha: number;
  elapsed: number;
  realElapsed: number;
  fps: number;
  gameSpeed: number;
}

export interface EngineOptions {
  eventBus?: EventBus;
  /** Supply an existing controller to share it with other systems. */
  timeController?: TimeController;
  /** Simulation step, in seconds. Defaults to 1/60. */
  fixedTimeStep?: number;
  /** Safety cap on fixed steps per frame. Defaults to 5. */
  maxSubSteps?: number;
  /** Largest delta the loop will honour, in seconds. Defaults to 0.1. */
  maxFrameDelta?: number;
}

const DEFAULT_FIXED_TIME_STEP = 1 / 60;
const DEFAULT_MAX_SUB_STEPS = 5;
const DEFAULT_MAX_FRAME_DELTA = 0.1;
/** How often the smoothed FPS reading is refreshed. */
const FPS_SAMPLE_WINDOW = 0.25;

export class Engine {
  readonly eventBus: EventBus;
  readonly timeController: TimeController;

  private readonly fixedTimeStep: number;
  private readonly maxSubSteps: number;
  private readonly maxFrameDelta: number;

  private readonly fixedListeners = new Set<FixedUpdateListener>();
  private readonly frameStartListeners = new Set<FrameStartListener>();
  private readonly renderListeners = new Set<RenderListener>();

  private readonly frameInfo: MutableFrameInfo = {
    frame: 0,
    realDelta: 0,
    gameDelta: 0,
    fixedSteps: 0,
    alpha: 0,
    elapsed: 0,
    realElapsed: 0,
    fps: 0,
    gameSpeed: 1,
  };

  private rafHandle: number | null = null;
  private lastTimestamp = 0;
  private accumulator = 0;
  private running = false;

  private fpsFrames = 0;
  private fpsAccumulator = 0;

  constructor(options: EngineOptions = {}) {
    this.eventBus = options.eventBus ?? new EventBus();
    this.timeController = options.timeController ?? new TimeController({ eventBus: this.eventBus });
    this.fixedTimeStep =
      options.fixedTimeStep !== undefined && options.fixedTimeStep > 0
        ? options.fixedTimeStep
        : DEFAULT_FIXED_TIME_STEP;
    this.maxSubSteps =
      options.maxSubSteps !== undefined && options.maxSubSteps > 0
        ? options.maxSubSteps
        : DEFAULT_MAX_SUB_STEPS;
    this.maxFrameDelta =
      options.maxFrameDelta !== undefined && options.maxFrameDelta > 0
        ? options.maxFrameDelta
        : DEFAULT_MAX_FRAME_DELTA;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  get isRunning(): boolean {
    return this.running;
  }

  get frame(): number {
    return this.frameInfo.frame;
  }

  get fps(): number {
    return this.frameInfo.fps;
  }

  /** Start the loop. Safe to call when already running. */
  start(): void {
    if (this.running) return;
    if (typeof requestAnimationFrame !== 'function') {
      throw new Error('[Engine] requestAnimationFrame is unavailable - the engine needs a DOM environment.');
    }

    this.running = true;
    this.lastTimestamp = 0;
    this.rafHandle = requestAnimationFrame(this.tick);
    this.eventBus.emit('engine:started', { frame: this.frameInfo.frame });
  }

  /** Stop the loop. The simulation state is preserved. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.rafHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafHandle);
    }
    this.rafHandle = null;
    this.eventBus.emit('engine:stopped', { frame: this.frameInfo.frame });
  }

  /* ---------------------------------------------------------------------- */
  /* Subscriptions                                                          */
  /* ---------------------------------------------------------------------- */

  /** Subscribe to the fixed-timestep simulation (0..`maxSubSteps` per frame). */
  onFixedUpdate(listener: FixedUpdateListener): () => void {
    this.fixedListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.fixedListeners.delete(listener);
    };
  }

  /**
   * Subscribe to the very start of a frame, after the clock has advanced but
   * before any simulation runs. This is where per-frame input polling belongs:
   * it runs exactly once per frame, unlike the fixed update.
   */
  onFrameStart(listener: FrameStartListener): () => void {
    this.frameStartListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.frameStartListeners.delete(listener);
    };
  }

  /** Subscribe to the variable-rate render step (exactly once per frame). */
  onRender(listener: RenderListener): () => void {
    this.renderListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.renderListeners.delete(listener);
    };
  }

  /* ---------------------------------------------------------------------- */
  /* The loop                                                               */
  /* ---------------------------------------------------------------------- */

  private readonly tick = (timestamp: number): void => {
    if (!this.running) return;

    // Re-arm before doing any work: if a listener throws, the loop survives.
    // (Guarded by `running` above so a stopped engine never re-queues itself.)
    this.rafHandle = requestAnimationFrame(this.tick);

    if (this.lastTimestamp === 0) {
      // First frame after start: no elapsed time to account for yet.
      this.lastTimestamp = timestamp;
    }

    let realDelta = (timestamp - this.lastTimestamp) / 1000;
    this.lastTimestamp = timestamp;
    if (!Number.isFinite(realDelta) || realDelta < 0) realDelta = 0;
    realDelta = Math.min(realDelta, this.maxFrameDelta);

    // Advance game time. This also ramps any in-flight speed transition, and
    // returns the scaled delta every system below should be using.
    const gameDelta = this.timeController.update(realDelta);

    // Per-frame bookkeeping that must happen before simulation reads it.
    for (const listener of this.frameStartListeners) {
      listener();
    }

    // Fixed timestep simulation.
    this.accumulator += gameDelta;
    let steps = 0;
    while (this.accumulator >= this.fixedTimeStep && steps < this.maxSubSteps) {
      this.accumulator -= this.fixedTimeStep;
      steps += 1;
      for (const listener of this.fixedListeners) {
        listener(this.fixedTimeStep);
      }
    }
    if (this.accumulator >= this.fixedTimeStep) {
      // Hit the substep cap with time still outstanding: drop the backlog so a
      // slow machine degrades into slow motion instead of a death spiral.
      this.accumulator = 0;
    }

    // Smoothed FPS, refreshed a few times a second.
    this.fpsFrames += 1;
    this.fpsAccumulator += realDelta;
    if (this.fpsAccumulator >= FPS_SAMPLE_WINDOW) {
      this.frameInfo.fps = this.fpsFrames / this.fpsAccumulator;
      this.fpsFrames = 0;
      this.fpsAccumulator = 0;
    }

    const info = this.frameInfo;
    info.frame += 1;
    info.realDelta = realDelta;
    info.gameDelta = gameDelta;
    info.fixedSteps = steps;
    info.alpha = this.accumulator / this.fixedTimeStep;
    info.elapsed = this.timeController.elapsed;
    info.realElapsed = this.timeController.realElapsed;
    info.gameSpeed = this.timeController.gameSpeed;

    // Variable-rate render, always exactly once per frame.
    for (const listener of this.renderListeners) {
      listener(info);
    }
  };

  /** Advance the loop by hand - used by tests and deterministic replays. */
  advance(timestamp: number): void {
    this.tick(timestamp);
  }
}
