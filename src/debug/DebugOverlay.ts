/**
 * DebugOverlay.ts - ASTRA debug
 * =============================================================================
 * Step 1.6: the developer overlay. One class that owns the FPS counter, the
 * grid and axis gizmos, the console log of input events, and the readout of the
 * TimeController's state and speed.
 *
 * What it replaces
 * ----------------
 * Steps 1.3-1.5 left a handful of temporary key bindings in `main.ts` (1/2/3 to
 * force a time state, P to pause). They are folded in here, so every developer
 * binding in the game lives in one place with one visibility rule, and the
 * production wiring in `main.ts` is nothing but construction plus one call.
 *
 * Bindings
 * --------
 *   F3  toggle the whole overlay (HUD + gizmos)
 *   F4  toggle the grid
 *   F6  toggle the axis tripod
 *   F7  toggle input-event logging
 *   1   REALTIME      2   DILATED      3   PAUSED      P   toggle pause
 *
 * Function keys rather than letters on purpose: the gameplay verbs are WASD,
 * Shift and Space, and a debug key that steals one of those is a bug waiting to
 * happen. F5 is avoided because every browser binds it to reload. These keys are
 * added to `InputManager`'s `preventDefaultKeys` so the browser does not act on
 * them either (F3 opens the find bar in Firefox, F6 moves focus).
 *
 * F4/F6/F7 also reveal the overlay if it is hidden, so pressing one always does
 * something visible. Turning a gizmo *off* leaves the overlay's visibility
 * alone, because that is a different decision.
 *
 * The real-time rule
 * ------------------
 * Like the camera, this overlay runs on real time and never on game time. It is
 * driven from `Engine.onRender`, which is exactly why it keeps working while the
 * world is dilated or paused - and why it is the natural place to *observe*
 * dilation: press 2 and watch the speed ramp while the frame rate does not move.
 *
 * The cost contract
 * -----------------
 * A debug tool must not be the reason a 60fps target is missed, so:
 *
 *   - The gizmos are created but invisible, and Three skips invisible subtrees
 *     outright. Zero render cost while hidden.
 *   - The HUD returns before touching the DOM while hidden, and throttles its
 *     writes to 20Hz while shown.
 *   - Key polling is eight `Set` lookups per frame.
 *   - Input logging is off by default and, when on, coalesces mouse movement to
 *     at most one console line per `INPUT_LOG_INTERVAL` - a raw per-event log at
 *     120Hz is unreadable and would itself cost frame time.
 * =============================================================================
 */

import type { EngineFrameInfo } from '../core/Engine';
import type { EventBus, AstraEvents } from '../core/EventBus';
import type { InputManager } from '../core/InputManager';
import type { SceneManager } from '../core/SceneManager';
import { TimeState } from '../core/TimeController';
import type { WebGLRenderer } from 'three';
import type { Scene } from 'three';
import { DebugGizmos } from './DebugGizmos';
import { DebugHud, type DebugSnapshot } from './DebugHud';

/** Key that toggles the whole overlay. Specified by the plan. */
export const DEFAULT_TOGGLE_KEY = 'F3';
/** Key that toggles the grid. */
export const DEFAULT_GRID_KEY = 'F4';
/** Key that toggles the axis tripod. */
export const DEFAULT_AXES_KEY = 'F6';
/** Key that toggles input-event logging. */
export const DEFAULT_INPUT_LOG_KEY = 'F7';

/** Keys that force a named time state. */
export const DEFAULT_TIME_KEYS = {
  realtime: 'Digit1',
  dilated: 'Digit2',
  paused: 'Digit3',
} as const;

/** Key that toggles pause. */
export const DEFAULT_PAUSE_KEY = 'KeyP';

/** Minimum real seconds between flushed mouse-move log lines. */
export const INPUT_LOG_INTERVAL = 0.1;

/** Console prefix for logged input events. */
const INPUT_LOG_PREFIX = '[ASTRA:input]';

/**
 * The slice of `TimeController` this overlay needs.
 *
 * Structural rather than a direct import so the overlay can be pointed at a
 * stub, and so it is obvious from the type exactly which parts of game time it
 * is allowed to touch: it reads three values and calls two commands.
 */
export interface DebugTimeSource {
  /** Current (possibly mid-transition) game speed. */
  readonly gameSpeed: number;
  /** Speed the controller is heading towards. */
  readonly targetSpeed: number;
  /** Named state implied by the target speed. */
  readonly state: TimeState;
  setState(state: TimeState, duration?: number): void;
  togglePause(): void;
}

export interface DebugOverlayOptions {
  /** Scene the gizmos are added to. */
  scene: Scene;
  /** Polled for the overlay's key bindings. */
  input: InputManager;
  /** Read for the HUD's time readout, and driven by the 1/2/3/P bindings. */
  timeController: DebugTimeSource;
  /** Read for the HUD's scene readout. Optional. */
  sceneManager?: SceneManager;
  /** Read for the HUD's draw-call and triangle counters. Optional. */
  renderer?: WebGLRenderer;
  /** Subscribed to for input-event logging. Optional. */
  eventBus?: EventBus;
  /** Element the HUD is appended to. Defaults to `document.body`. */
  parent?: HTMLElement | null;
  /** Start with the overlay visible. Defaults to false. */
  visible?: boolean;
  /** Start with input logging on. Defaults to false. */
  logInput?: boolean;
  /** Start with the grid enabled. Defaults to true. */
  gridEnabled?: boolean;
  /** Start with the axis tripod enabled. Defaults to true. */
  axesEnabled?: boolean;
  /** Override the key bindings. See the module header for the defaults. */
  keys?: {
    toggle?: string;
    grid?: string;
    axes?: string;
    inputLog?: string;
    time?: { realtime?: string; dilated?: string; paused?: string };
    pause?: string;
  };
  /** Passed through to `DebugGizmos`. */
  gizmos?: ConstructorParameters<typeof DebugGizmos>[0];
}

/** Compact rendering of the modifier keys held with an input event. */
function formatModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string {
  const parts: string[] = [];
  if (event.altKey) parts.push('alt');
  if (event.ctrlKey) parts.push('ctrl');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');
  return parts.length > 0 ? ` +${parts.join('+')}` : '';
}

export class DebugOverlay {
  readonly gizmos: DebugGizmos;
  readonly hud: DebugHud;

  private readonly scene: Scene;
  private readonly input: InputManager;
  private readonly timeController: DebugTimeSource;
  private readonly sceneManager: SceneManager | undefined;
  /**
   * Read for the HUD's draw-call and triangle counters. Optional.
   *
   * `WebGLInfo.autoReset` is true by default, so `info.render` describes the
   * frame that has just been drawn - which is why `update()` runs after
   * `renderPipeline.render()` in main.ts.
   *
   * Read defensively rather than typed strictly: a partial stub is a legitimate
   * thing to hand a test.
   */
  private readonly renderer: WebGLRenderer | undefined;
  private readonly bus: EventBus | undefined;

  private readonly toggleKey: string;
  private readonly gridKey: string;
  private readonly axesKey: string;
  private readonly inputLogKey: string;
  private readonly realtimeKey: string;
  private readonly dilatedKey: string;
  private readonly pausedKey: string;
  private readonly pauseKey: string;

  private overlayVisible: boolean;
  private gridEnabled: boolean;
  private axesEnabled: boolean;
  private loggingInput: boolean;

  private readonly unsubscribes: (() => void)[] = [];

  /** Mouse-move events seen since the last flushed log line. */
  private pendingMoves = 0;
  private lastMove: AstraEvents['input:mouse-move'] | null = null;
  /** Real seconds accumulated towards the next flushed log line. */
  private logClock = 0;

  /**
   * Reused every frame rather than allocated, matching `Engine`'s frame info
   * and `CameraController`'s scratch vectors. Safe because the HUD consumes it
   * synchronously and never retains it.
   */
  private readonly snapshot: DebugSnapshot = {
    fps: 0,
    realDelta: 0,
    frame: 0,
    fixedSteps: 0,
    alpha: 0,
    timeState: TimeState.REALTIME,
    gameSpeed: 1,
    targetSpeed: 1,
    scene: null,
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    grid: false,
    axes: false,
    inputLog: false,
  };

  private disposed = false;

  constructor(options: DebugOverlayOptions) {
    this.scene = options.scene;
    this.input = options.input;
    this.timeController = options.timeController;
    this.sceneManager = options.sceneManager;
    this.renderer = options.renderer;
    this.bus = options.eventBus;

    const keys = options.keys ?? {};
    this.toggleKey = keys.toggle ?? DEFAULT_TOGGLE_KEY;
    this.gridKey = keys.grid ?? DEFAULT_GRID_KEY;
    this.axesKey = keys.axes ?? DEFAULT_AXES_KEY;
    this.inputLogKey = keys.inputLog ?? DEFAULT_INPUT_LOG_KEY;
    this.realtimeKey = keys.time?.realtime ?? DEFAULT_TIME_KEYS.realtime;
    this.dilatedKey = keys.time?.dilated ?? DEFAULT_TIME_KEYS.dilated;
    this.pausedKey = keys.time?.paused ?? DEFAULT_TIME_KEYS.paused;
    this.pauseKey = keys.pause ?? DEFAULT_PAUSE_KEY;

    this.overlayVisible = options.visible ?? false;
    this.gridEnabled = options.gridEnabled ?? true;
    this.axesEnabled = options.axesEnabled ?? true;
    this.loggingInput = options.logInput ?? false;

    this.gizmos = new DebugGizmos(options.gizmos);
    this.hud = new DebugHud({ parent: options.parent, visible: this.overlayVisible });

    // The gizmos live in the scene graph from the start and are simply
    // invisible, so showing the overlay never has to touch the scene tree.
    this.gizmos.addTo(this.scene);
    this.applyGizmoVisibility();

    if (this.bus !== undefined) {
      this.subscribeToInput();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* State                                                                  */
  /* ---------------------------------------------------------------------- */

  get isVisible(): boolean {
    return this.overlayVisible;
  }

  get isGridEnabled(): boolean {
    return this.gridEnabled;
  }

  get isAxesEnabled(): boolean {
    return this.axesEnabled;
  }

  get isLoggingInput(): boolean {
    return this.loggingInput;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /* ---------------------------------------------------------------------- */
  /* Commands                                                               */
  /* ---------------------------------------------------------------------- */

  /** Show or hide the whole overlay. */
  setVisible(visible: boolean): void {
    if (this.disposed || this.overlayVisible === visible) return;
    this.overlayVisible = visible;
    this.hud.setVisible(visible);
    this.applyGizmoVisibility();
  }

  /** Show or hide the whole overlay, whichever it is not. */
  toggle(): void {
    this.setVisible(!this.overlayVisible);
  }

  /** Enable or disable the grid gizmo. Enabling also reveals the overlay. */
  setGridEnabled(enabled: boolean): void {
    if (this.disposed || this.gridEnabled === enabled) return;
    this.gridEnabled = enabled;
    if (enabled) this.setVisible(true);
    this.applyGizmoVisibility();
  }

  toggleGrid(): void {
    this.setGridEnabled(!this.gridEnabled);
  }

  /** Enable or disable the axis tripod. Enabling also reveals the overlay. */
  setAxesEnabled(enabled: boolean): void {
    if (this.disposed || this.axesEnabled === enabled) return;
    this.axesEnabled = enabled;
    if (enabled) this.setVisible(true);
    this.applyGizmoVisibility();
  }

  toggleAxes(): void {
    this.setAxesEnabled(!this.axesEnabled);
  }

  /** Start or stop logging input events to the console. */
  setInputLogging(enabled: boolean): void {
    if (this.disposed || this.loggingInput === enabled) return;
    this.loggingInput = enabled;
    if (!enabled) {
      // Drop anything buffered for a line that will now never be written.
      this.pendingMoves = 0;
      this.lastMove = null;
    }
  }

  toggleInputLogging(): void {
    this.setInputLogging(!this.loggingInput);
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the overlay by one rendered frame.
   *
   * Wire this to `Engine.onRender` and pass the frame straight through. It is
   * deliberately last in the render chain, after `renderPipeline.render()`, so
   * the draw-call and triangle counters describe the frame that was just drawn
   * rather than the one before it.
   */
  update(frame: EngineFrameInfo): void {
    if (this.disposed) return;

    this.handleKeys();

    if (this.loggingInput) {
      this.logClock += frame.realDelta;
      this.flushMoveLog();
    }

    if (this.overlayVisible) {
      this.hud.render(this.buildSnapshot(frame));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Keys                                                                   */
  /* ---------------------------------------------------------------------- */

  private handleKeys(): void {
    const input = this.input;
    const time = this.timeController;

    if (input.wasKeyPressed(this.toggleKey)) this.toggle();
    if (input.wasKeyPressed(this.gridKey)) this.toggleGrid();
    if (input.wasKeyPressed(this.axesKey)) this.toggleAxes();
    if (input.wasKeyPressed(this.inputLogKey)) this.toggleInputLogging();

    // The default transition duration is used on purpose: the HUD shows the
    // named state change immediately while the speed column ramps, which makes
    // the transition itself - the thing Step 3.11 will lean on - observable.
    if (input.wasKeyPressed(this.realtimeKey)) time.setState(TimeState.REALTIME);
    if (input.wasKeyPressed(this.dilatedKey)) time.setState(TimeState.DILATED);
    if (input.wasKeyPressed(this.pausedKey)) time.setState(TimeState.PAUSED);
    if (input.wasKeyPressed(this.pauseKey)) time.togglePause();
  }

  /* ---------------------------------------------------------------------- */
  /* Snapshot                                                               */
  /* ---------------------------------------------------------------------- */

  private buildSnapshot(frame: EngineFrameInfo): DebugSnapshot {
    const snapshot = this.snapshot;
    const info = this.renderer?.info;

    snapshot.fps = frame.fps;
    snapshot.realDelta = frame.realDelta;
    snapshot.frame = frame.frame;
    snapshot.fixedSteps = frame.fixedSteps;
    snapshot.alpha = frame.alpha;
    snapshot.timeState = this.timeController.state;
    snapshot.gameSpeed = this.timeController.gameSpeed;
    snapshot.targetSpeed = this.timeController.targetSpeed;
    snapshot.scene = this.sceneManager?.current ?? null;
    snapshot.drawCalls = info?.render.calls ?? 0;
    snapshot.triangles = info?.render.triangles ?? 0;
    snapshot.geometries = info?.memory.geometries ?? 0;
    snapshot.textures = info?.memory.textures ?? 0;
    snapshot.grid = this.gridEnabled;
    snapshot.axes = this.axesEnabled;
    snapshot.inputLog = this.loggingInput;

    return snapshot;
  }

  /* ---------------------------------------------------------------------- */
  /* Input logging                                                          */
  /* ---------------------------------------------------------------------- */

  private subscribeToInput(): void {
    const bus = this.bus;
    if (bus === undefined) return;

    this.unsubscribes.push(
      bus.on('input:key-down', (event) => {
        if (!this.loggingInput) return;
        console.info(
          `${INPUT_LOG_PREFIX} key down  ${event.code}${event.repeat ? ' (repeat)' : ''}` +
            `${formatModifiers(event)}`,
        );
      }),
      bus.on('input:key-up', (event) => {
        if (!this.loggingInput) return;
        console.info(`${INPUT_LOG_PREFIX} key up    ${event.code}${formatModifiers(event)}`);
      }),
      bus.on('input:mouse-down', (event) => {
        if (!this.loggingInput) return;
        console.info(
          `${INPUT_LOG_PREFIX} mouse down  button=${event.button} ` +
            `at ${event.x},${event.y}${formatModifiers(event)}`,
        );
      }),
      bus.on('input:mouse-up', (event) => {
        if (!this.loggingInput) return;
        console.info(
          `${INPUT_LOG_PREFIX} mouse up    button=${event.button} ` +
            `at ${event.x},${event.y}${formatModifiers(event)}`,
        );
      }),
      bus.on('input:mouse-wheel', (event) => {
        if (!this.loggingInput) return;
        console.info(
          `${INPUT_LOG_PREFIX} wheel       dx=${event.deltaX} dy=${event.deltaY}`,
        );
      }),
      bus.on('input:pointer-lock-changed', (event) => {
        if (!this.loggingInput) return;
        console.info(`${INPUT_LOG_PREFIX} pointer lock ${event.locked ? 'acquired' : 'released'}`);
      }),
      bus.on('input:mouse-move', (event) => {
        if (!this.loggingInput) return;
        // Buffered rather than logged: the DOM emits one mousemove per sample,
        // which at a 120Hz mouse is twice per rendered frame. Logging each one
        // is unreadable, and the console itself becomes the bottleneck.
        this.pendingMoves += 1;
        this.lastMove = event;
      }),
    );
  }

  /** Write one line for however many mouse moves arrived since the last one. */
  private flushMoveLog(): void {
    if (this.pendingMoves === 0 || this.lastMove === null) return;
    if (this.logClock < INPUT_LOG_INTERVAL) return;

    this.logClock = 0;
    const event = this.lastMove;
    const extra = this.pendingMoves - 1;
    console.info(
      `${INPUT_LOG_PREFIX} mouse move  ${event.x},${event.y} ` +
        `dx=${event.dx} dy=${event.dy}` +
        `${extra > 0 ? ` (+${extra} more)` : ''}${formatModifiers(event)}`,
    );
    this.pendingMoves = 0;
    this.lastMove = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Gizmo policy                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * A gizmo is on screen when the overlay is visible *and* it is enabled.
   *
   * The two flags are separate on purpose: "enabled" is what F4/F6 control and
   * survives the overlay being hidden, so hiding and re-showing the overlay
   * does not silently undo a choice the developer made.
   */
  private applyGizmoVisibility(): void {
    this.gizmos.setGridVisible(this.overlayVisible && this.gridEnabled);
    this.gizmos.setAxesVisible(this.overlayVisible && this.axesEnabled);
  }

  /* ---------------------------------------------------------------------- */
  /* Teardown                                                               */
  /* ---------------------------------------------------------------------- */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    this.gizmos.dispose();
    this.hud.dispose();
    this.pendingMoves = 0;
    this.lastMove = null;
  }
}
