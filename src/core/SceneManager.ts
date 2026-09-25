/**
 * SceneManager.ts - ASTRA core
 * =============================================================================
 * Macro state machine for the whole application.
 *
 * These are the top-level screens of the game. Gameplay sub-states (exploration,
 * dialogue, combat rounds) live in the EncounterManager and are *not* modelled
 * here - this machine only answers "which screen is the player looking at".
 *
 * Every transition is published on the EventBus, so nothing needs a direct
 * reference to the SceneManager to react to a state change.
 *
 * Gameplay sub-states are intentionally permissive: the plan calls for a
 * "basic" SceneManager, so any state may be entered from any other. Narrowing
 * this down is a later step's decision, not the bootstrap's.
 * =============================================================================
 */

import { EventBus, type AstraEvents } from './EventBus';

export const SceneState = {
  LOADING: 'LOADING',
  MAIN_MENU: 'MAIN_MENU',
  GAME_MODE_SELECT: 'GAME_MODE_SELECT',
  GAMEPLAY: 'GAMEPLAY',
  PAUSED: 'PAUSED',
  CINEMATIC: 'CINEMATIC',
} as const;
export type SceneState = (typeof SceneState)[keyof typeof SceneState];

/** All valid states, in a sensible presentation order. */
export const SCENE_STATES: readonly SceneState[] = [
  SceneState.LOADING,
  SceneState.MAIN_MENU,
  SceneState.GAME_MODE_SELECT,
  SceneState.GAMEPLAY,
  SceneState.PAUSED,
  SceneState.CINEMATIC,
];

export function isSceneState(value: unknown): value is SceneState {
  return typeof value === 'string' && (SCENE_STATES as readonly string[]).includes(value);
}

export interface SceneManagerOptions {
  eventBus?: EventBus;
  initialState?: SceneState;
}

export class SceneManager {
  private readonly bus: EventBus | undefined;

  private _current: SceneState;
  private _previous: SceneState | null = null;
  private _changeCount = 0;

  constructor(options: SceneManagerOptions = {}) {
    this.bus = options.eventBus;
    this._current = options.initialState ?? SceneState.LOADING;
  }

  get current(): SceneState {
    return this._current;
  }

  /** The state we came from, or `null` if we have never transitioned. */
  get previous(): SceneState | null {
    return this._previous;
  }

  /** How many successful transitions have happened. */
  get changeCount(): number {
    return this._changeCount;
  }

  is(state: SceneState): boolean {
    return this._current === state;
  }

  get isLoading(): boolean {
    return this._current === SceneState.LOADING;
  }

  get isGameplay(): boolean {
    return this._current === SceneState.GAMEPLAY;
  }

  get isPaused(): boolean {
    return this._current === SceneState.PAUSED;
  }

  get isCinematic(): boolean {
    return this._current === SceneState.CINEMATIC;
  }

  get isInMenu(): boolean {
    return this._current === SceneState.MAIN_MENU || this._current === SceneState.GAME_MODE_SELECT;
  }

  /**
   * Transition to `next`.
   *
   * Returns `true` when the state actually changed. Re-entering the current
   * state is a no-op (and publishes nothing); an unknown state is rejected and
   * logged rather than silently corrupting the machine.
   */
  setState(next: SceneState): boolean {
    if (!isSceneState(next)) {
      console.error(`[SceneManager] refusing to enter unknown state "${String(next)}"`);
      return false;
    }
    if (next === this._current) return false;

    const previous = this._current;
    this._previous = previous;
    this._current = next;
    this._changeCount += 1;

    this.bus?.emit('scene:changed', {
      previous,
      current: next,
    } satisfies AstraEvents['scene:changed']);

    return true;
  }

  /** Return to the state we came from. A no-op if there is no history. */
  revert(): boolean {
    if (this._previous === null) return false;
    const target = this._previous;
    return this.setState(target);
  }

  toString(): string {
    return `SceneManager(${this._current})`;
  }
}
