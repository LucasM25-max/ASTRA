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
import {
  DEFAULT_PREVENT_DEFAULT_KEYS,
  InputManager,
  type InputManagerOptions,
} from './core/InputManager';
import { SceneManager, SceneState } from './core/SceneManager';
import { TimeController } from './core/TimeController';
import {
  DEFAULT_AXES_KEY,
  DEFAULT_GRID_KEY,
  DEFAULT_INPUT_LOG_KEY,
  DEFAULT_TOGGLE_KEY,
  DebugOverlay,
} from './debug/DebugOverlay';
import { CameraController } from './renderer/CameraController';
import { RenderPipeline } from './renderer/RenderPipeline';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { MovementController } from './player/MovementController';
import { PLAYER_HALF_HEIGHT, type Player } from './player/Player';
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
  readonly movement: MovementController;
  readonly cameraController: CameraController;
  readonly debugOverlay: DebugOverlay;
}

declare global {
  interface Window {
    __ASTRA__?: AstraDebugHandle;
  }
}

/**
 * Depth of water, in metres, at which wading costs the player nothing.
 *
 * Below this the water is a film on the ground and should not be felt at all -
 * a drag that starts at zero depth makes every puddle on the bank sticky.
 */
const WADE_START_DEPTH = 0.12;

/**
 * Depth of water, in metres, at which wading is at its slowest.
 *
 * The stream is about 0.45 m deep at its centre, so this is reached in the
 * middle of the channel and never exceeded: the player wades through the
 * stream, they do not swim, and Step 2.2 rules swimming out of scope.
 */
const WADE_FULL_DEPTH = 0.45;

/**
 * Fraction of horizontal speed retained in water `WADE_FULL_DEPTH` deep.
 *
 * 0.45 is a deliberate number. It is slow enough that crossing the stream is a
 * decision rather than something that happens while the player is looking
 * elsewhere, and fast enough that it never feels like the controls have failed.
 * Below `WADE_START_DEPTH` nothing is removed at all, so the bank and the
 * shallows are unaffected.
 */
const WADE_SPEED_RETENTION = 0.45;

/**
 * Fraction of upward velocity retained per fixed step in deep water.
 *
 * Only the vertical component, and only the *upward* one: this is what makes a
 * jump in the stream feel like a jump in water rather than a jump on land. A
 * downward velocity is left alone, because sinking is what water does and
 * damping it would make the player bob.
 */
const WADE_JUMP_RETENTION = 0.55;

/**
 * Scale the player's velocity for the water they are standing in.
 *
 * Takes the scene and the player rather than closing over them, so it is a pure
 * function of its arguments and can be driven directly by a test.
 *
 * Reads the stream's depth profile at the player's feet and damps horizontal
 * speed and upward speed in proportion. Nothing is written when the player is
 * on dry ground, so the common case costs one distance query and nothing else.
 *
 * The depth is measured from the *feet*, not the body centre: a capsule 1.8 m
 * tall standing in 0.3 m of water has its centre 0.9 m above the surface, and
 * asking the centre how deep the water is would answer "not in the water at
 * all" - which is the classic version of this bug, and it is invisible until
 * someone walks into a stream.
 */
function applyWadingDrag(delta: number, scene: WorldScene, player: Player): void {
  void delta;
  const body = player.body;
  if (body === undefined) return;

  const centre = body.translation();
  const submersion = scene.stream.submersionAt(centre.x, centre.z, centre.y - PLAYER_HALF_HEIGHT);
  if (submersion <= WADE_START_DEPTH) return;

  // 0 at the threshold, 1 in water deep enough to be a real obstacle.
  // Smoothstep rather than a linear ramp, so the transition has no corner in it
  // that the player can feel as a sudden gear change.
  const t = Math.min(1, (submersion - WADE_START_DEPTH) / (WADE_FULL_DEPTH - WADE_START_DEPTH));
  const wade = t * t * (3 - 2 * t);

  const v = body.linvel();
  const horizontal = 1 - (1 - WADE_SPEED_RETENTION) * wade;
  const lift = v.y > 0 ? 1 - (1 - WADE_JUMP_RETENTION) * wade : 1;

  // The velocity is scaled, not an impulse applied: Rapier integrates whatever
  // velocity it finds at the step, so scaling the velocity scales the distance
  // travelled this step by exactly the same factor. An impulse here would need
  // a `delta` and would be wrong by whatever the step turned out to be.
  body.setLinvel({ x: v.x * horizontal, y: v.y * lift, z: v.z * horizontal }, true);
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
  handle.debugOverlay.dispose();
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

    // The debug overlay binds the function keys F3/F4/F6/F7. They are added to
    // the prevent-default list so the browser does not act on them as well -
    // F3 opens the find bar in Firefox and F6 moves focus - which would
    // otherwise swallow the press before the game ever sees it.
    const inputOptions: InputManagerOptions = {
      canvas,
      eventBus,
      preventDefaultKeys: [
        ...DEFAULT_PREVENT_DEFAULT_KEYS,
        DEFAULT_TOGGLE_KEY,
        DEFAULT_GRID_KEY,
        DEFAULT_AXES_KEY,
        DEFAULT_INPUT_LOG_KEY,
      ],
    };
    const inputManager = new InputManager(inputOptions);
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

    // The player's movement: WASD, walk/run, jump, gravity and landing.
    //
    // It reads the render camera for its facing direction, which is what makes
    // the controls camera-relative. Step 1.5 turns that camera into an orbit
    // rig, and the controller needs no change for it.
    const movement = new MovementController({
      player: worldScene.player,
      input: inputManager,
      camera: renderPipeline.camera,
      physics,
    });

    // The third-person camera. It owns no Three objects of its own - it drives
    // the pipeline's camera - so it is created after both and wired below.
    const cameraController = new CameraController({
      camera: renderPipeline.camera,
      input: inputManager,
      physics,
      player: worldScene.player,
    });

    // The developer overlay: FPS counter, grid and axis gizmos, a console log
    // of input events, and the TimeController readout. It is hidden by default
    // and costs nothing until F3 is pressed - see the cost contract in
    // DebugOverlay. The 1/2/3 and P time bindings that used to live here now
    // live inside it, so every developer binding is in one place.
    const debugOverlay = new DebugOverlay({
      scene: renderPipeline.scene,
      input: inputManager,
      timeController,
      sceneManager,
      renderer: renderPipeline.renderer,
      eventBus,
    });

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
    //
    // Movement is written before the world is stepped so the velocity it sets
    // is the one Rapier integrates this step. The two are independent - neither
    // reads the other's state - so the order is not load-bearing, but writing
    // first reads more naturally: the controller decides where the player goes,
    // then the world moves them there.
    //
    // Wading sits between the two, and the position is load-bearing. It reads
    // the velocity the controller has just written and damps it, so it has to
    // run after `movement.fixedUpdate`; and it has to run before
    // `worldScene.fixedUpdate`, because that is what calls `physics.step` and
    // Rapier integrates whatever velocity it finds at that moment. Applying the
    // drag after the step would be a frame late - the player would glide one
    // whole fixed step at full speed through the shallows before slowing down.
    //
    // It lives here rather than in `MovementController` on purpose. Step 2.2's
    // scope guardrails rule out touching the controller, and the drag is not a
    // movement rule anyway: it is a property of the water, and it is driven by
    // the stream's own depth profile. When Step 2.4 gives the stream a physical
    // volume this hook moves with it.
    engine.onFixedUpdate((delta) => {
      movement.fixedUpdate(delta);
      applyWadingDrag(delta, worldScene, worldScene.player);
      worldScene.fixedUpdate(delta);
    });

    // Draw exactly once per animation frame.
    //
    // The world is advanced with the *scaled* delta from the TimeController, so
    // the sky slows and freezes with everything else during time dilation while
    // rendering itself keeps running at full frame rate. `worldScene.update()`
    // also reconciles the player's mesh with its physics body.
    //
    // The camera is advanced with the *real* delta instead, and that difference
    // is the Step 1.5 requirement, not an inconsistency: the camera has to stay
    // responsive while the world is slowed, because the player needs to look
    // around freely during an Active Encounter. Passing `frame.realDelta` here
    // is what buys that - `gameDelta` would dilate the orbit along with
    // everything else.
    engine.onRender((frame) => {
      cameraController.update(frame.realDelta);
      // The camera, not the player, is the listener: the stream's sound should
      // come from where the player is looking, and the camera is what follows
      // the player through the world.
      worldScene.update(timeController.getDelta(), renderPipeline.camera.position);
      renderPipeline.render();
      // Last, so the renderer counters it reports describe the frame that has
      // just been drawn rather than the one before it.
      debugOverlay.update(frame);
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
      movement,
      cameraController,
      debugOverlay,
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
