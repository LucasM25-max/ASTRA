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
 *   PhysicsWorld    Rapier world, gravity, ground collider
 *   Engine          the fixed-timestep / variable-render loop
 *
 * The only cross-system rule enforced here is the one the whole design leans
 * on: while the scene is PAUSED, game time is frozen.
 *
 * Why boot is async
 * -----------------
 * Rapier's compat build inlines its WASM as base64, and that WASM has to be
 * initialised before a single `new RAPIER.World()` can exist. `PhysicsWorld.create()`
 * owns that `await`, so this is the one place in the app that has to be async.
 * The exported `ready` promise is how tests (and any future loader) wait for
 * boot to finish; `index.html` needs no change because the module auto-starts.
 * =============================================================================
 */

import { Engine } from './core/Engine';
import { EventBus, eventBus } from './core/EventBus';
import { InputManager } from './core/InputManager';
import { SceneManager, SceneState } from './core/SceneManager';
import { TimeController, TimeState } from './core/TimeController';
import { RenderPipeline } from './renderer/RenderPipeline';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { WorldScene } from './world/WorldScene';
import { DEFAULT_FOG_FAR, DEFAULT_FOG_NEAR } from './world/WorldScene';

/** Console handle: `window.__ASTRA__.timeController.gameSpeed`, and so on. */
export interface AstraDebugHandle {
  readonly eventBus: EventBus;
  readonly engine: Engine;
  readonly timeController: TimeController;
  readonly sceneManager: SceneManager;
  readonly inputManager: InputManager;
  readonly renderPipeline: RenderPipeline;
  readonly physics: PhysicsWorld;
  readonly worldScene: WorldScene;
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

/** Tear down a previous run. Shared by the HMR path and by tests. */
function teardown(handle: AstraDebugHandle): void {
  handle.engine.stop();
  handle.inputManager.dispose();
  handle.worldScene.dispose();
  handle.physics.dispose();
  handle.renderPipeline.dispose();
}

async function boot(): Promise<void> {
  try {
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      showBootError('Missing <canvas id="game-canvas"> in index.html.');
      return;
    }

    // Hot reload (or an accidental double boot): tear the previous run down.
    const previous = window.__ASTRA__;
    if (previous !== undefined) {
      teardown(previous);
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

    // Physics needs Rapier's WASM, which is why boot is async. The timestep is
    // taken from the engine so the two can never disagree.
    let physics: PhysicsWorld;
    try {
      physics = await PhysicsWorld.create({ timestep: engine.fixedTimeStep });
    } catch (error) {
      showBootError(
        `Physics could not be initialised.\n${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    // The world: ground plane, sky dome, light rig, depth fog and the player.
    const worldScene = new WorldScene({ scene: renderPipeline.scene, physics });

    // --- Wiring ------------------------------------------------------------

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

    // Physics runs on the engine's fixed timestep. It is the only thing that
    // moves the simulation, which keeps Rapier deterministic and makes time
    // dilation work for free: when gameSpeed drops the engine issues fewer
    // fixed steps, and the world slows down with no special case anywhere.
    engine.onFixedUpdate((delta) => {
      worldScene.fixedUpdate(delta);
    });

    // Draw exactly once per animation frame.
    //
    // The world is advanced with the *scaled* delta from the TimeController, so
    // the sky slows and freezes with everything else during time dilation while
    // rendering itself keeps running at full frame rate. `worldScene.update()`
    // also reconciles the player's mesh with its physics body.
    engine.onRender(() => {
      worldScene.update(timeController.getDelta());
      renderPipeline.render();
    });

    // --- Temporary developer bindings -------------------------------------
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
      physics,
      worldScene,
    };

    // --- Boot --------------------------------------------------------------

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
        `canvas=${renderPipeline.size.width}x${renderPipeline.size.height} ` +
        `ground=${worldScene.terrain.sizeMetres}m fog=${DEFAULT_FOG_NEAR}-${DEFAULT_FOG_FAR}m ` +
        `player=${worldScene.player.height}m@${worldScene.physics.timestep.toFixed(4)}s`,
    );
  } catch (error) {
    showBootError(
      `Unexpected failure during boot.\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

/**
 * Boot has been started. Resolves once boot has finished, successfully or not -
 * `boot()` never rejects, it reports failures through the boot-error panel.
 */
export const ready: Promise<void> = boot();
