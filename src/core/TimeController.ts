/**
 * TimeController.ts - ASTRA core
 * =============================================================================
 * The single source of truth for game time.
 *
 * `gameSpeed` is a scalar applied to the engine's delta time. Every simulation
 * system - physics, animation, AI, particles - reads its delta from here via
 * `getDelta()`, never from the engine directly. That is what makes the Active
 * Encounter combat system work: dropping `gameSpeed` to 0.25 slows the whole
 * world while the camera and UI keep running at full speed.
 *
 * Speed transitions are interpolated over *real* time, never game time. If they
 * were interpolated in game time, slowing the game down would also slow the
 * ramp, and a paused game could never speed back up.
 *
 * Named states (see `TimeState`) are the vocabulary the rest of the game uses:
 *
 *   REALTIME (1.0)  - normal exploration
 *   DILATED  (0.25) - between combat turns, during dialogue
 *   PAUSED   (0.0)  - player's combat turn, menu navigation
 *   CUSTOM          - scripted one-off speeds (e.g. a 0.1 reaction flash)
 * =============================================================================
 */

import { EventBus, type AstraEvents } from './EventBus';

export const TimeState = {
  REALTIME: 'REALTIME',
  DILATED: 'DILATED',
  PAUSED: 'PAUSED',
  CUSTOM: 'CUSTOM',
} as const;
export type TimeState = (typeof TimeState)[keyof typeof TimeState];

/** Canonical speed of each named state. `CUSTOM` has no canonical speed. */
export const TIME_STATE_SPEEDS = {
  REALTIME: 1.0,
  DILATED: 0.25,
  PAUSED: 0.0,
} as const;

export const REALTIME_SPEED = TIME_STATE_SPEEDS.REALTIME;
export const DILATED_SPEED = TIME_STATE_SPEEDS.DILATED;
export const PAUSED_SPEED = TIME_STATE_SPEEDS.PAUSED;

/** Default length of a speed transition, in real seconds. */
export const DEFAULT_TRANSITION_DURATION = 0.5;

/** Tolerance used when matching a speed back to a named state. */
const SPEED_EPSILON = 1e-4;

/**
 * Below this, a transition counts as finished. Without it, summing deltas such
 * as 0.1 + 0.1 + 0.05 can leave ~1e-17 seconds on the clock, and `isTransitioning`
 * would then report true forever even though `gameSpeed` is already exact.
 */
const TRANSITION_EPSILON = 1e-9;

export interface TimeControllerOptions {
  /** Bus used to publish speed/state changes. */
  eventBus?: EventBus;
  /** Speed used by the `DILATED` state. Defaults to 0.25 (25% speed). */
  dilatedSpeed?: number;
  /** Default transition duration in real seconds. Defaults to 0.5. */
  transitionDuration?: number;
}

/** Linear interpolation, used for speed ramps. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Clamp a speed to a sane, non-negative, finite value. */
function sanitizeSpeed(speed: number): number {
  if (!Number.isFinite(speed)) {
    throw new RangeError(`[TimeController] speed must be a finite number, received ${speed}`);
  }
  if (speed < 0) {
    console.warn(`[TimeController] negative speed ${speed} clamped to 0 (PAUSED)`);
    return 0;
  }
  return speed;
}

/** Map an arbitrary speed back onto the named state it corresponds to. */
export function stateForSpeed(speed: number, dilatedSpeed: number = DILATED_SPEED): TimeState {
  if (speed <= 0) return TimeState.PAUSED;
  if (Math.abs(speed - REALTIME_SPEED) < SPEED_EPSILON) return TimeState.REALTIME;
  if (Math.abs(speed - dilatedSpeed) < SPEED_EPSILON) return TimeState.DILATED;
  return TimeState.CUSTOM;
}

export class TimeController {
  private readonly bus: EventBus | undefined;

  private _dilatedSpeed: number;
  private readonly _transitionDuration: number;

  /** Speed right now - may be mid-transition, so it can differ from the target. */
  private _gameSpeed: number;
  /** Speed the controller is heading towards. */
  private _targetSpeed: number;
  /** Speed the current transition started from. */
  private _transitionFrom: number;
  /** Real seconds the current transition is scheduled to take. */
  private _transitionLength: number;
  /** Real seconds left in the current transition. */
  private _transitionRemaining: number;
  /** Target speed to restore when `resume()` is called. */
  private _speedBeforePause: number;

  private _unscaledDelta = 0;
  private _gameDelta = 0;
  private _elapsed = 0;
  private _realElapsed = 0;

  constructor(options: TimeControllerOptions = {}) {
    this.bus = options.eventBus;
    this._dilatedSpeed = sanitizeSpeed(options.dilatedSpeed ?? DILATED_SPEED);
    this._transitionDuration = Math.max(0, options.transitionDuration ?? DEFAULT_TRANSITION_DURATION);
    this._gameSpeed = REALTIME_SPEED;
    this._targetSpeed = REALTIME_SPEED;
    this._transitionFrom = REALTIME_SPEED;
    this._transitionLength = this._transitionDuration;
    this._transitionRemaining = 0;
    this._speedBeforePause = REALTIME_SPEED;
  }

  /* ---------------------------------------------------------------------- */
  /* State                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Current (possibly mid-transition) game speed. */
  get gameSpeed(): number {
    return this._gameSpeed;
  }

  /** Speed the controller is currently heading towards. */
  get targetSpeed(): number {
    return this._targetSpeed;
  }

  /** Named state implied by the target speed. */
  get state(): TimeState {
    return stateForSpeed(this._targetSpeed, this._dilatedSpeed);
  }

  /** Speed used by the `DILATED` state. */
  get dilatedSpeed(): number {
    return this._dilatedSpeed;
  }

  /** True when the target speed is zero. */
  get isPaused(): boolean {
    return this._targetSpeed <= 0;
  }

  /** True while a speed transition is still ramping. */
  get isTransitioning(): boolean {
    return this._transitionRemaining > 0;
  }

  /** Unscaled delta of the most recent `update()` call, in seconds. */
  get unscaledDelta(): number {
    return this._unscaledDelta;
  }

  /** Scaled delta of the most recent `update()` call, in seconds. */
  get delta(): number {
    return this._gameDelta;
  }

  /** Total *scaled* time accumulated since construction/reset, in seconds. */
  get elapsed(): number {
    return this._elapsed;
  }

  /** Total *real* time accumulated since construction/reset, in seconds. */
  get realElapsed(): number {
    return this._realElapsed;
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame update                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance game time by `realDelta` seconds of wall-clock time.
   *
   * This is the only place `gameSpeed` changes on its own: it ramps any
   * in-flight transition and accumulates the scaled elapsed time. Returns the
   * scaled delta for this frame.
   */
  update(realDelta: number): number {
    const dt = Number.isFinite(realDelta) && realDelta > 0 ? realDelta : 0;

    this._unscaledDelta = dt;
    this._realElapsed += dt;

    if (this._transitionRemaining > 0) {
      this._transitionRemaining = Math.max(0, this._transitionRemaining - dt);
      if (this._transitionRemaining < TRANSITION_EPSILON) {
        this._transitionRemaining = 0;
      }
      const duration = this._transitionLength;
      const t = duration > 0 ? 1 - this._transitionRemaining / duration : 1;
      this._gameSpeed = t >= 1 ? this._targetSpeed : lerp(this._transitionFrom, this._targetSpeed, t);
    } else {
      this._gameSpeed = this._targetSpeed;
    }

    this._gameDelta = this._gameSpeed * dt;
    this._elapsed += this._gameDelta;
    return this._gameDelta;
  }

  /**
   * The delta every game system should use this frame:
   * `engineDelta * gameSpeed`.
   */
  getDelta(): number {
    return this._gameDelta;
  }

  /* ---------------------------------------------------------------------- */
  /* Speed control                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Ramp the game speed to `target` over `duration` real seconds.
   * A duration of 0 (or less) applies the change immediately.
   */
  setSpeed(target: number, duration: number = this._transitionDuration): void {
    const next = sanitizeSpeed(target);
    const transitionDuration = Math.max(0, duration);
    const previous = this._targetSpeed;

    this._transitionLength = transitionDuration;

    if (transitionDuration <= 0) {
      this._transitionRemaining = 0;
      this._transitionFrom = next;
      this._gameSpeed = next;
    } else {
      // Start the ramp from wherever the speed currently is, so an interrupted
      // transition re-ramps smoothly instead of snapping.
      this._transitionFrom = this._gameSpeed;
      this._transitionRemaining = transitionDuration;
    }

    this._targetSpeed = next;

    if (previous !== next) {
      this.publishSpeedChange(previous, next);
    }
  }

  /** Ramp to one of the named states. */
  setState(state: TimeState, duration: number = this._transitionDuration): void {
    switch (state) {
      case TimeState.REALTIME:
        this.setSpeed(REALTIME_SPEED, duration);
        return;
      case TimeState.DILATED:
        this.setSpeed(this._dilatedSpeed, duration);
        return;
      case TimeState.PAUSED:
        this.pause(duration);
        return;
      case TimeState.CUSTOM:
        throw new Error(
          '[TimeController] setState(CUSTOM) has no canonical speed - use setSpeed() with an explicit speed.',
        );
      default:
        throw new Error(`[TimeController] unknown time state "${String(state)}"`);
    }
  }

  /**
   * Freeze the game. Remembers the speed to restore on `resume()`.
   * A no-op when already paused.
   */
  pause(duration: number = this._transitionDuration): void {
    if (this._targetSpeed <= 0) return;
    this._speedBeforePause = this._targetSpeed;
    this.setSpeed(PAUSED_SPEED, duration);
    this.bus?.emit('time:paused', { previousSpeed: this._speedBeforePause });
  }

  /**
   * Unfreeze the game, restoring the speed it had before `pause()`.
   * A no-op when not paused.
   */
  resume(duration: number = this._transitionDuration): void {
    if (this._targetSpeed > 0) return;
    const restored = this._speedBeforePause > 0 ? this._speedBeforePause : REALTIME_SPEED;
    this.setSpeed(restored, duration);
    this.bus?.emit('time:resumed', { speed: restored });
  }

  /** Pause if running, resume if paused. */
  togglePause(): void {
    if (this.isPaused) {
      this.resume();
    } else {
      this.pause();
    }
  }

  /** Snap straight back to full speed and clear all accumulated time. */
  reset(): void {
    this._gameSpeed = REALTIME_SPEED;
    this._targetSpeed = REALTIME_SPEED;
    this._transitionFrom = REALTIME_SPEED;
    this._transitionLength = this._transitionDuration;
    this._transitionRemaining = 0;
    this._speedBeforePause = REALTIME_SPEED;
    this._unscaledDelta = 0;
    this._gameDelta = 0;
    this._elapsed = 0;
    this._realElapsed = 0;
  }

  private publishSpeedChange(previousSpeed: number, currentSpeed: number): void {
    this.bus?.emit('time:speed-changed', {
      previousSpeed,
      currentSpeed,
      previousState: stateForSpeed(previousSpeed, this._dilatedSpeed),
      currentState: stateForSpeed(currentSpeed, this._dilatedSpeed),
    } satisfies AstraEvents['time:speed-changed']);
  }
}
