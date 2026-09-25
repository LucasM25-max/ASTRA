import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/EventBus';
import { SCENE_STATES, SceneManager, SceneState, isSceneState } from '../src/core/SceneManager';

describe('SceneManager', () => {
  it('starts in LOADING by default', () => {
    const manager = new SceneManager();
    expect(manager.current).toBe(SceneState.LOADING);
    expect(manager.previous).toBeNull();
    expect(manager.changeCount).toBe(0);
    expect(manager.isLoading).toBe(true);
  });

  it('accepts a custom initial state', () => {
    const manager = new SceneManager({ initialState: SceneState.MAIN_MENU });
    expect(manager.current).toBe(SceneState.MAIN_MENU);
  });

  it('transitions and reports the change', () => {
    const manager = new SceneManager();
    expect(manager.setState(SceneState.GAMEPLAY)).toBe(true);
    expect(manager.current).toBe(SceneState.GAMEPLAY);
    expect(manager.previous).toBe(SceneState.LOADING);
    expect(manager.changeCount).toBe(1);
    expect(manager.isGameplay).toBe(true);
  });

  it('treats re-entering the current state as a no-op', () => {
    const manager = new SceneManager({ initialState: SceneState.GAMEPLAY });
    expect(manager.setState(SceneState.GAMEPLAY)).toBe(false);
    expect(manager.changeCount).toBe(0);
  });

  it('rejects unknown states without changing anything', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const manager = new SceneManager({ initialState: SceneState.GAMEPLAY });

    // @ts-expect-error - deliberately invalid runtime value
    expect(manager.setState('TURBO')).toBe(false);
    expect(manager.current).toBe(SceneState.GAMEPLAY);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('publishes scene:changed with the previous and current state', () => {
    const bus = new EventBus();
    const manager = new SceneManager({ eventBus: bus, initialState: SceneState.LOADING });
    const seen: unknown[] = [];
    bus.on('scene:changed', (payload) => seen.push(payload));

    manager.setState(SceneState.MAIN_MENU);
    manager.setState(SceneState.GAMEPLAY);
    manager.setState(SceneState.GAMEPLAY); // no event

    expect(seen).toEqual([
      { previous: SceneState.LOADING, current: SceneState.MAIN_MENU },
      { previous: SceneState.MAIN_MENU, current: SceneState.GAMEPLAY },
    ]);
  });

  it('walks back through the documented menu flow', () => {
    const manager = new SceneManager({ initialState: SceneState.MAIN_MENU });
    manager.setState(SceneState.GAME_MODE_SELECT);
    manager.setState(SceneState.LOADING);
    manager.setState(SceneState.CINEMATIC);
    manager.setState(SceneState.GAMEPLAY);
    manager.setState(SceneState.PAUSED);
    manager.setState(SceneState.GAMEPLAY);

    expect(manager.changeCount).toBe(6);
    expect(SCENE_STATES).toHaveLength(6);
  });

  it('reverts to the previous state', () => {
    const manager = new SceneManager({ initialState: SceneState.GAMEPLAY });
    manager.setState(SceneState.PAUSED);
    expect(manager.revert()).toBe(true);
    expect(manager.current).toBe(SceneState.GAMEPLAY);

    // GAMEPLAY -> (revert) -> PAUSED again; the history is one step deep.
    manager.setState(SceneState.PAUSED);
    manager.setState(SceneState.GAMEPLAY);
    expect(manager.revert()).toBe(true);
    expect(manager.current).toBe(SceneState.PAUSED);
  });

  it('cannot revert without history', () => {
    const manager = new SceneManager();
    expect(manager.revert()).toBe(false);
  });

  it('exposes the state helpers', () => {
    const manager = new SceneManager({ initialState: SceneState.PAUSED });
    expect(manager.isPaused).toBe(true);
    expect(manager.isInMenu).toBe(false);

    manager.setState(SceneState.MAIN_MENU);
    expect(manager.isInMenu).toBe(true);
    expect(manager.isLoading).toBe(false);

    manager.setState(SceneState.GAME_MODE_SELECT);
    expect(manager.isInMenu).toBe(true);

    manager.setState(SceneState.CINEMATIC);
    expect(manager.isCinematic).toBe(true);
  });

  it('validates states with isSceneState', () => {
    expect(isSceneState('GAMEPLAY')).toBe(true);
    expect(isSceneState('gameplay')).toBe(false);
    expect(isSceneState('TURBO')).toBe(false);
    expect(isSceneState(42)).toBe(false);
    expect(isSceneState(null)).toBe(false);
  });

  it('describes itself for debugging', () => {
    const manager = new SceneManager({ initialState: SceneState.GAMEPLAY });
    expect(manager.toString()).toBe('SceneManager(GAMEPLAY)');
  });
});
