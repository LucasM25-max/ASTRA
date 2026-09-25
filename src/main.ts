/**
 * main.ts - ASTRA entry point
 * =============================================================================
 * Boots the engine and wires the core services together.
 *
 * Construction order matters only for readability - every dependency is passed
 * in explicitly, so the modules stay decoupled and individually testable:
 *
 *   EventBus        the single message hub
 *   TimeController  game time (the source of truth for every delta)
 *   InputManager    keyboard + mouse
 *   SceneManager    macro state machine
 *   RenderPipeline  WebGL renderer, scene graph, camera
 *   Engine          the fixed-timestep / variable-render loop
 *
 * The only cross-system rule enforced here is the one the whole design leans
 * on: while the scene is PAUSED, game time is frozen.
 * =============================================================================
 */

import { Engine } from './core/Engine';
import { EventBus, eventBus } from './core/EventBus';
import { InputManager } from './core/InputManager';
import { SceneManager, SceneState } from './core/SceneManager';
import { TimeController, TimeState } from './core/TimeController';
import { RenderPipeline } from './renderer/RenderPipeline';

/** Console handle: `window.__ASTRA__.timeController.gameSpeed`, and so on. */
export interface AstraDebugHandle {
  readonly eventBus: EventBus;
  readonly engine: Engine;
  readonly timeController: TimeController;
  readonly sceneManager: SceneManager;
  readonly inputManager: InputManager;
  readonly renderPipeline: RenderPipeline;
}

declare global {
  interface Window {
    __ASTRA__?: AstraDebugHandle;
  }
}

function showBootError(message: string): void {
  const box = document.getElementById('boot-error');
  const detail = document.getElementById('boot-error-message');
  if (detail !== null) {
    detail.textContent = message;
  }
  if (box !== null) {
    box.hidden = false;
  }
  console.error(`[ASTRA] ${message}`);
}

function main(): void {
  const canvas = document.getElementById('game-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    showBootError('Missing <canvas id="game-canvas"> in index.html.');
    return;
  }

  // Hot reload (or an accidental double boot): tear the previous run down.
  const previous = window.__ASTRA__;
  if (previous !== undefined) {
    previous.engine.stop();
    previous.inputManager.dispose();
    previous.renderPipeline.dispose();
    window.__ASTRA__ = undefined;
  }

  const timeController = new TimeController({ eventBus });
  const inputManager = new InputManager({ canvas, eventBus });
  const sceneManager = new SceneManager({
    eventBus,
    initialState: SceneState.LOADING,
  });

  let renderPipeline: RenderPipeline;
  try {
    renderPipeline = new RenderPipeline(canvas, { eventBus });
  } catch (error) {
    showBootError(
      `WebGL could not be initialised.\n${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const engine = new Engine({ eventBus, timeController });

  // --- Wiring --------------------------------------------------------------

  // A paused scene freezes game time; leaving it restores the previous speed.
  // Nothing here references the TimeController's internals - it is all events.
  eventBus.on('scene:changed', ({ current, previous }) => {
    if (current === SceneState.PAUSED) {
      timeController.pause();
    } else if (previous === SceneState.PAUSED) {
      timeController.resume();
    }
  });

  // Poll input once per frame, before anything reads it.
  engine.onFrameStart(() => inputManager.update());

  // Draw exactly once per animation frame.
  engine.onRender(() => renderPipeline.render());

  // --- Temporary developer bindings ---------------------------------------
  // Step 1.6 replaces these with the real debug overlay. Until then they are
  // the quickest way to feel the time-dilation system working in the browser.
  engine.onRender(() => {
    if (inputManager.wasKeyPressed('Digit1')) {
      timeController.setState(TimeState.REALTIME);
    } else if (inputManager.wasKeyPressed('Digit2')) {
      timeController.setState(TimeState.DILATED);
    } else if (inputManager.wasKeyPressed('Digit3')) {
      timeController.setState(TimeState.PAUSED);
    } else if (inputManager.wasKeyPressed('KeyP')) {
      sceneManager.setState(sceneManager.isPaused ? SceneState.GAMEPLAY : SceneState.PAUSED);
    }
  });

  window.__ASTRA__ = {
    eventBus,
    engine,
    timeController,
    sceneManager,
    inputManager,
    renderPipeline,
  };

  // --- Boot ----------------------------------------------------------------

  engine.start();

  // Nothing is loaded from disk yet, so the LOADING state is exited on the
  // first rendered frame rather than by an asset callback. That still exercises
  // the real LOADING -> MAIN_MENU transition the UI will hook into later.
  let loadingExited = false;
  engine.onRender(() => {
    if (loadingExited) return;
    loadingExited = true;
    sceneManager.setState(SceneState.MAIN_MENU);
  });

  console.info(
    `[ASTRA] booted - scene=${sceneManager.current} speed=${timeController.gameSpeed} ` +
      `canvas=${renderPipeline.size.width}x${renderPipeline.size.height}`,
  );
}

try {
  main();
} catch (error) {
  showBootError(`Unexpected failure during boot.\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
}
