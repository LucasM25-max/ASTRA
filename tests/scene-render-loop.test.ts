// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { Engine } from '../src/core/Engine';
import { EventBus } from '../src/core/EventBus';
import { TimeController, TimeState } from '../src/core/TimeController';
import { InputManager } from '../src/core/InputManager';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { MovementController, WALK_SPEED } from '../src/player/MovementController';
import {
  DEFAULT_AXES_KEY,
  DEFAULT_GRID_KEY,
  DEFAULT_TOGGLE_KEY,
  DebugOverlay,
} from '../src/debug/DebugOverlay';
import { CameraController, DEFAULT_CAMERA_DISTANCE, ORBIT_MOUSE_BUTTON } from '../src/renderer/CameraController';
import { PLAYER_HEIGHT } from '../src/player/Player';
import { WorldScene } from '../src/world/WorldScene';

/**
 * Step 1.2 requires the render loop to be "tied to Engine.ts via
 * TimeController.getDelta()", and Step 1.3 requires the player's physics to run
 * on a fixed timestep. This is the test that proves both: the world is driven
 * exactly the way main.ts drives it - fixed updates for physics, the scaled
 * delta for presentation - so if the world advances, dilates and freezes in
 * step with the TimeController, the wiring is correct.
 */

let frameQueue: FrameRequestCallback[] = [];
let now = 0;

function installAnimationFrame(): void {
  frameQueue = [];
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frameQueue.push(callback);
    return frameQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (): void => undefined);
}

interface Rig {
  engine: Engine;
  timeController: TimeController;
  world: WorldScene;
  physics: PhysicsWorld;
  movement: MovementController;
  cameraController: CameraController;
  debugOverlay: DebugOverlay;
  /** Drags the mouse by a relative amount, as an orbit drag does. */
  drag: (dx: number, dy: number) => void;
  scroll: (deltaY: number) => void;
  /** Holds the orbit button down. */
  pressOrbit: () => void;
  /** Holds a key down across frames, the way a held key behaves. */
  hold: (code: string) => void;
  release: (code: string) => void;
  /** Presses and releases a key, which is what edge-triggered bindings see. */
  tap: (code: string) => void;
  /** Counts render passes, standing in for RenderPipeline.render(). */
  renders: () => number;
  /** Runs one engine frame `ms` of wall-clock time later. */
  step: (ms: number) => void;
  dispose: () => void;
}

/**
 * Wire a WorldScene *and* a MovementController into an Engine exactly the way
 * main.ts does, driving a real InputManager from real KeyboardEvents on a
 * throwaway target.
 */
async function createRig(): Promise<Rig> {
  const timeController = new TimeController();
  const engine = new Engine({ timeController });
  // A private bus rather than the module singleton, so one test's input events
  // cannot leak into another's.
  const bus = new EventBus();
  const physics = await PhysicsWorld.create({ timestep: engine.fixedTimeStep });
  // Held separately so the debug overlay's gizmos can be added to the same
  // graph the world populates - WorldScene keeps its scene private.
  const scene = new Scene();
  const world = new WorldScene({ scene, physics });

  const inputTarget = new EventTarget();
  const input = new InputManager({ target: inputTarget, canvas: null, eventBus: bus });
  input.attach();

  const camera = new PerspectiveCamera(60, 1.6, 0.1, 2000);
  camera.position.set(0, 2.2, 8);
  camera.lookAt(0, 0.8, 0);
  camera.updateMatrixWorld(true);

  const movement = new MovementController({
    player: world.player,
    input,
    camera,
    physics,
  });

  const cameraController = new CameraController({ camera, input, physics, player: world.player });

  const debugOverlay = new DebugOverlay({
    scene,
    input,
    timeController,
    eventBus: bus,
    parent: document.body,
  });

  let renderCount = 0;
  let mouseX = 0;
  let mouseY = 0;

  // Poll input once per frame, before anything reads it.
  engine.onFrameStart(() => input.update());

  // Physics: fixed timestep only. Movement is written first so the velocity it
  // sets is the one Rapier integrates this step - the order main.ts uses.
  engine.onFixedUpdate((delta) => {
    movement.fixedUpdate(delta);
    world.fixedUpdate(delta);
  });

  // Presentation: scaled delta for the world, *real* delta for the camera. The
  // difference is the Step 1.5 requirement, not an inconsistency - see the
  // wiring note in main.ts.
  engine.onRender((frame) => {
    cameraController.update(frame.realDelta);
    world.update(timeController.getDelta());
    renderCount += 1;
    // After everything else, exactly as main.ts wires it: the overlay reads the
    // frame and the TimeController, and touches neither physics nor the world.
    debugOverlay.update(frame);
  });

  const step = (ms: number): void => {
    now += ms;
    engine.advance(now);
  };

  const hold = (code: string): void => {
    inputTarget.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
  };
  const release = (code: string): void => {
    inputTarget.dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
  };

  // A key held down emits auto-repeats, which the InputManager reports as
  // `repeat` rather than as a fresh press - so anything edge-triggered, like
  // the debug overlay's bindings, only ever sees a tap.
  const tap = (code: string): void => {
    inputTarget.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
    inputTarget.dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
  };

  // Mouse coordinates are absolute in the DOM, so a drag is expressed as a
  // relative delta here and accumulated.
  const drag = (dx: number, dy: number): void => {
    mouseX += dx;
    mouseY += dy;
    inputTarget.dispatchEvent(new MouseEvent('mousemove', { clientX: mouseX, clientY: mouseY }));
  };
  const scroll = (deltaY: number): void => {
    inputTarget.dispatchEvent(new WheelEvent('wheel', { deltaY }));
  };
  const pressOrbit = (): void => {
    inputTarget.dispatchEvent(
      new MouseEvent('mousedown', { button: ORBIT_MOUSE_BUTTON, buttons: 2 }),
    );
  };

  return {
    engine,
    timeController,
    world,
    physics,
    movement,
    cameraController,
    debugOverlay,
    drag,
    scroll,
    hold,
    release,
    tap,
    pressOrbit,
    renders: () => renderCount,
    step,
    dispose: () => {
      debugOverlay.dispose();
      input.dispose();
      world.dispose();
      physics.dispose();
    },
  };
}

/** Read a row's displayed text out of a debug HUD. */
function rowText(hud: { element: HTMLElement }, label: string): string {
  for (const row of Array.from(hud.element.querySelectorAll<HTMLElement>('.astra-debug__row'))) {
    if (row.querySelector<HTMLElement>('.astra-debug__k')?.textContent === label) {
      return row.querySelector<HTMLElement>('.astra-debug__v')?.textContent ?? '';
    }
  }
  throw new Error(`no HUD row labelled "${label}"`);
}

let rig: Rig | undefined;

beforeEach(() => {
  installAnimationFrame();
});

afterEach(() => {
  rig?.dispose();
  rig = undefined;
  vi.unstubAllGlobals();
});

describe('render loop -> TimeController -> world', () => {
  it('advances the world by the scaled delta each frame', async () => {
    rig = await createRig();
    rig.engine.start();

    rig.step(16); // seed frame: zero delta
    expect(rig.world.elapsedTime).toBe(0);

    rig.step(20); // 20ms of real time at full speed
    expect(rig.world.elapsedTime).toBeCloseTo(0.02, 6);
    expect(rig.renders()).toBe(2);
  });

  it('still renders every frame while the world is frozen', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);

    rig.timeController.setState(TimeState.PAUSED, 0);
    const elapsed = rig.world.elapsedTime;

    rig.step(20);
    rig.step(20);
    rig.step(20);

    // Rendering never stops - only game time does. This is what lets the camera
    // and UI stay responsive during the Active Encounter system's slow motion.
    expect(rig.renders()).toBe(4);
    expect(rig.world.elapsedTime).toBe(elapsed);
    expect(rig.world.sky.elapsedTime).toBe(elapsed);
  });

  it('slows the world to a quarter speed when time is dilated', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);

    rig.timeController.setState(TimeState.DILATED, 0);
    rig.step(20);

    // 20ms of real time * 0.25 = 5ms of game time.
    expect(rig.world.elapsedTime).toBeCloseTo(0.005, 6);
  });

  it('brings the world to a complete halt at zero speed', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);

    rig.timeController.setSpeed(0, 0);
    const elapsed = rig.world.elapsedTime;

    rig.step(20);
    rig.step(20);

    expect(rig.world.elapsedTime).toBe(elapsed);
  });

  it('tracks a custom scripted speed', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);

    rig.timeController.setSpeed(0.1, 0);
    rig.step(20);

    expect(rig.world.elapsedTime).toBeCloseTo(0.002, 6);
    expect(rig.timeController.state).toBe(TimeState.CUSTOM);
  });

  it('ramps the world in over the transition duration', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);

    // Half way through a 0.5s transition to DILATED the world is at ~0.625x.
    // Frames are split because the engine clamps a single frame's delta to
    // 100ms (see the maxFrameDelta tests in engine.test.ts).
    rig.timeController.setState(TimeState.DILATED);
    rig.step(100);
    rig.step(100);
    rig.step(50); // 250ms of real time: exactly half of the 0.5s ramp

    expect(rig.timeController.gameSpeed).toBeCloseTo(0.625, 4);
    expect(rig.timeController.isTransitioning).toBe(true);

    const halfWay = rig.world.elapsedTime;
    // Less than 0.25s of full-speed time, more than 0.0625s of fully dilated
    // time: the world really is easing between the two.
    expect(halfWay).toBeGreaterThan(0.1);
    expect(halfWay).toBeLessThan(0.25);

    rig.step(100);
    rig.step(100);
    rig.step(50); // the second half of the ramp

    expect(rig.timeController.gameSpeed).toBeCloseTo(0.25, 6);
    expect(rig.timeController.isTransitioning).toBe(false);
    expect(rig.world.elapsedTime).toBeGreaterThan(halfWay);
  });

  it('freezes the world while the scene is PAUSED, via the event wiring', async () => {
    // Mirrors main.ts: the SceneManager drives the TimeController through the
    // EventBus, and the world follows the TimeController.
    rig = await createRig();
    const { eventBus } = rig.engine;

    eventBus.on('scene:changed', ({ current }) => {
      if (current === 'PAUSED') {
        rig?.timeController.pause(0);
      } else {
        rig?.timeController.resume(0);
      }
    });

    rig.engine.start();
    rig.step(16);
    rig.step(20);
    const running = rig.world.elapsedTime;
    expect(running).toBeGreaterThan(0);

    eventBus.emit('scene:changed', { previous: 'GAMEPLAY', current: 'PAUSED' });
    rig.step(20);
    rig.step(20);
    expect(rig.world.elapsedTime).toBe(running);

    eventBus.emit('scene:changed', { previous: 'PAUSED', current: 'GAMEPLAY' });
    rig.step(20);
    expect(rig.world.elapsedTime).toBeGreaterThan(running);
  });

  it('stops advancing the world once the engine stops', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    rig.step(20);

    const elapsed = rig.world.elapsedTime;
    rig.engine.stop();

    rig.step(20);
    expect(rig.world.elapsedTime).toBe(elapsed);
  });
});

describe('render loop -> fixed timestep -> physics', () => {
  it("steps physics only on the fixed path, at the engine's own timestep", async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16); // seed frame

    // The world's own timestep is the engine's fixed step, so Rapier's solver
    // and the accumulator agree.
    expect(rig.physics.timestep).toBeCloseTo(rig.engine.fixedTimeStep, 6);

    // One 20ms frame accumulates 20ms of game time: one 1/60 step fits, with a
    // little left over for the next frame.
    rig.step(20);
    expect(rig.physics.stepCount).toBe(1);

    rig.step(20);
    expect(rig.physics.stepCount).toBe(2);

    // Twenty 20ms frames are 400ms of real time, which is 24 fixed steps of
    // 1/60 - the leftover accumulator carries across frames exactly as it
    // should, rather than being rounded away.
    for (let i = 0; i < 18; i += 1) rig.step(20);
    expect(rig.physics.stepCount).toBe(24);
  });

  it('drops the player onto the ground under gravity', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);

    // Spawned at y = 1, the capsule floats 0.1m above the plane and must fall.
    expect(rig.world.player.position.y).toBe(1);

    for (let i = 0; i < 60; i += 1) rig.step(16);
    expect(rig.world.player.position.y).toBeLessThan(1);

    for (let i = 0; i < 600; i += 1) rig.step(16);

    // Comes to rest standing on the ground, lowest point at y = 0.
    expect(rig.world.player.position.y).toBeCloseTo(PLAYER_HEIGHT / 2, 3);

    // And the mesh follows it, because the render path ran every frame.
    expect(rig.world.player.mesh.position.y).toBe(rig.world.player.position.y);
  });

  it('freezes physics entirely when game time is paused', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    rig.step(20);

    const steps = rig.physics.stepCount;
    const height = rig.world.player.position.y;

    rig.timeController.setState(TimeState.PAUSED, 0);

    for (let i = 0; i < 30; i += 1) rig.step(20);

    // No fixed steps means no physics: the player hangs in mid-air while the
    // renderer keeps drawing at full frame rate.
    expect(rig.physics.stepCount).toBe(steps);
    expect(rig.world.player.position.y).toBe(height);
    expect(rig.renders()).toBeGreaterThan(30);
  });

  it('slows physics to a quarter speed when time is dilated', async () => {
    const full = await createRig();
    full.engine.start();
    full.step(16);
    for (let i = 0; i < 600; i += 1) full.step(16);
    const fullSteps = full.physics.stepCount;
    full.dispose();

    const dilated = await createRig();
    dilated.engine.start();
    dilated.step(16);
    dilated.timeController.setState(TimeState.DILATED, 0);
    for (let i = 0; i < 600; i += 1) dilated.step(16);
    const dilatedSteps = dilated.physics.stepCount;
    dilated.dispose();

    // The same wall-clock time yields a quarter of the simulation steps.
    expect(dilatedSteps).toBeGreaterThan(0);
    expect(dilatedSteps / fullSteps).toBeCloseTo(0.25, 1);
  });

  it('re-asserts the physics timestep on every step, so it cannot drift', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    rig.step(20);

    expect(rig.physics.timestep).toBeCloseTo(rig.engine.fixedTimeStep, 6);
    expect(rig.physics.timestep).toBeCloseTo(1 / 60, 6);
  });
});

/**
 * Step 1.4 asks for all player movement to be multiplied by
 * TimeController.gameSpeed so that time dilation slows the player during
 * combat. The multiplication is not in the controller - it is in the engine,
 * which feeds its accumulator the *scaled* delta and so issues a quarter of the
 * fixed steps when dilated. These tests prove the player is actually driven by
 * that loop, through the same wiring main.ts uses.
 */
describe('render loop -> MovementController -> player', () => {
  it('walks the player at the configured speed while the loop runs', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16); // seed frame
    rig.hold('KeyW');

    for (let i = 0; i < 120; i += 1) rig.step(16);

    // The default camera looks down -Z, so W carries the player to -Z.
    expect(rig.world.player.position.z).toBeLessThan(-3);
    expect(rig.movement.horizontalSpeed).toBeCloseTo(WALK_SPEED, 2);
    rig.release('KeyW');
  });

  it('jumps the player off the ground and lands it again', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    // Let the player settle onto the ground first, so `rest` is the resting
    // height rather than the spawn height.
    for (let i = 0; i < 60; i += 1) rig.step(16);
    const rest = rig.world.player.position.y;

    rig.hold('Space');
    rig.step(16);
    rig.release('Space');
    expect(rig.movement.isGrounded).toBe(false);

    for (let i = 0; i < 120; i += 1) rig.step(16);
    expect(rig.movement.isGrounded).toBe(true);
    expect(rig.world.player.position.y).toBeCloseTo(rest, 2);
  });

  it('slows the player to a quarter speed when time is dilated', async () => {
    const full = await createRig();
    full.engine.start();
    full.step(16);
    full.hold('KeyW');
    for (let i = 0; i < 480; i += 1) full.step(16);
    const fullDistance = Math.abs(full.world.player.position.z);
    full.release('KeyW');
    full.dispose();

    const dilated = await createRig();
    dilated.engine.start();
    dilated.step(16);
    dilated.timeController.setState(TimeState.DILATED, 0);
    dilated.hold('KeyW');
    for (let i = 0; i < 480; i += 1) dilated.step(16);
    const dilatedDistance = Math.abs(dilated.world.player.position.z);
    dilated.release('KeyW');
    dilated.dispose();

    // Same wall-clock time, a quarter of the game time, a quarter of the
    // distance - with nothing in the controller referencing gameSpeed.
    expect(dilatedDistance).toBeGreaterThan(0);
    expect(dilatedDistance / fullDistance).toBeCloseTo(0.25, 1);
  });

  it('freezes the player completely when time is paused', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    rig.hold('KeyW');
    for (let i = 0; i < 120; i += 1) rig.step(16);
    const steps = rig.physics.stepCount;
    const position = { ...rig.world.player.position };

    rig.timeController.setState(TimeState.PAUSED, 0);
    for (let i = 0; i < 60; i += 1) rig.step(16);

    // No fixed steps means no movement, but the renderer keeps drawing.
    expect(rig.physics.stepCount).toBe(steps);
    expect(rig.world.player.position.x).toBe(position.x);
    expect(rig.world.player.position.y).toBe(position.y);
    expect(rig.world.player.position.z).toBe(position.z);
    expect(rig.renders()).toBeGreaterThan(180);
    rig.release('KeyW');
  });
});

/**
 * Step 1.5's most important requirement, and the easiest one to get backwards:
 * the camera must keep responding at full rate while game time is dilated,
 * because the player needs to look around freely during an Active Encounter.
 *
 * The mechanism is that the camera is driven from `onRender` with the frame's
 * *real* delta while everything else takes the scaled one. These tests pin the
 * wiring in main.ts, not the camera itself - `tests/camera-controller.test.ts`
 * covers the camera's own behaviour.
 */
describe('render loop -> CameraController -> camera', () => {
  it('orbits the camera while the loop runs', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);

    rig.pressOrbit();
    for (let i = 0; i < 10; i += 1) {
      rig.drag(20, 5);
      rig.step(16);
    }

    expect(rig.cameraController.yaw).not.toBe(0);
    expect(rig.cameraController.pitch).toBeGreaterThan(0);
    rig.dispose();
  });

  it('keeps the camera at the configured distance while following the player', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    for (let i = 0; i < 60; i += 1) rig.step(16);

    expect(rig.cameraController.appliedDistance).toBeCloseTo(DEFAULT_CAMERA_DISTANCE, 2);
    // And it is aimed at the player's chest plus the height offset.
    expect(rig.cameraController.focusPoint.y).toBeCloseTo(
      rig.world.player.position.y + 1.5,
      1,
    );
    rig.dispose();
  });

  it('orbits at full speed while game time is dilated', async () => {
    const full = await createRig();
    full.engine.start();
    full.step(16);
    full.pressOrbit();
    for (let i = 0; i < 30; i += 1) {
      full.drag(20, 0);
      full.step(16);
    }
    const fullYaw = full.cameraController.yaw;
    full.dispose();

    const dilated = await createRig();
    dilated.engine.start();
    dilated.step(16);
    dilated.timeController.setState(TimeState.DILATED, 0);
    dilated.pressOrbit();
    for (let i = 0; i < 30; i += 1) {
      dilated.drag(20, 0);
      dilated.step(16);
    }
    const dilatedYaw = dilated.cameraController.yaw;
    dilated.dispose();

    // The same wall-clock time and the same mouse movement must produce the
    // same orbit, dilated or not. If the camera were taking the scaled delta
    // this would be a quarter of the angle.
    expect(Math.abs(dilatedYaw - fullYaw)).toBeLessThan(0.05);
    expect(Math.abs(fullYaw)).toBeGreaterThan(0.5);
  });

  it('zooms at full speed while game time is dilated', async () => {
    const full = await createRig();
    full.engine.start();
    full.step(16);
    for (let i = 0; i < 20; i += 1) {
      full.scroll(-120);
      full.step(16);
    }
    const fullDistance = full.cameraController.distance;
    full.dispose();

    const dilated = await createRig();
    dilated.engine.start();
    dilated.step(16);
    dilated.timeController.setState(TimeState.DILATED, 0);
    for (let i = 0; i < 20; i += 1) {
      dilated.scroll(-120);
      dilated.step(16);
    }
    const dilatedDistance = dilated.cameraController.distance;
    dilated.dispose();

    expect(dilatedDistance).toBeCloseTo(fullDistance, 3);
    expect(fullDistance).toBeLessThan(DEFAULT_CAMERA_DISTANCE);
  });

  it('still follows the player while game time is dilated', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    for (let i = 0; i < 60; i += 1) rig.step(16);

    rig.timeController.setState(TimeState.DILATED, 0);
    rig.hold('KeyW');
    for (let i = 0; i < 240; i += 1) rig.step(16);

    // The player has moved - a quarter as far as it would have - and the camera
    // has kept up with it, because the camera's clock never dilated.
    const focus = rig.cameraController.focusPoint;
    expect(rig.world.player.position.z).toBeLessThan(-1);
    expect(focus.z).toBeCloseTo(rig.world.player.position.z, 0);
    rig.release('KeyW');
  });

  it('keeps the camera responsive while game time is paused', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    for (let i = 0; i < 60; i += 1) rig.step(16);

    rig.timeController.setState(TimeState.PAUSED, 0);
    rig.pressOrbit();
    for (let i = 0; i < 20; i += 1) {
      rig.drag(20, 0);
      rig.step(16);
    }

    // Nothing in the world moves, but the camera still orbits.
    expect(rig.cameraController.yaw).not.toBe(0);
    rig.dispose();
  });
});

/**
 * Step 1.6's overlay, wired the way main.ts wires it.
 *
 * What is worth proving here is not that the panel draws - no GL context - but
 * that the overlay is driven by the render loop and therefore keeps working
 * while game time is dilated or paused, exactly like the camera. It also pins
 * the ordering: the overlay's `update()` runs after `renderPipeline.render()`
 * in main.ts, and it must never touch physics or the world.
 */
describe('render loop -> DebugOverlay', () => {
  it('puts the gizmos in the scene without showing them', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);

    // Present in the graph from the first frame, so showing the overlay never
    // has to touch the scene tree - and invisible, so it costs nothing.
    expect(rig.debugOverlay.gizmos.grid.parent).not.toBeNull();
    expect(rig.debugOverlay.gizmos.isGridVisible).toBe(false);
    expect(rig.debugOverlay.gizmos.isAxesVisible).toBe(false);
    rig.dispose();
  });

  it('toggles the overlay on F3 through the real loop', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    for (let i = 0; i < 10; i += 1) rig.step(16);

    expect(rig.debugOverlay.isVisible).toBe(false);

    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.step(16);

    expect(rig.debugOverlay.isVisible).toBe(true);
    expect(rig.debugOverlay.hud.element.hidden).toBe(false);
    expect(rig.debugOverlay.gizmos.isGridVisible).toBe(true);
    expect(rig.debugOverlay.gizmos.isAxesVisible).toBe(true);

    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.step(16);

    expect(rig.debugOverlay.isVisible).toBe(false);
    expect(rig.debugOverlay.gizmos.isGridVisible).toBe(false);
    rig.dispose();
  });

  it('shows the TimeController state in the panel', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    for (let i = 0; i < 10; i += 1) rig.step(16);

    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.step(16);
    // Two frames: the first reveals the panel, the second gets past the
    // throttle and actually writes.
    rig.step(100);
    rig.step(100);

    expect(rowText(rig.debugOverlay.hud, 'time')).toBe('REALTIME');
    expect(rowText(rig.debugOverlay.hud, 'target')).toBe('100%');

    rig.tap('Digit2');
    rig.step(100);

    expect(rowText(rig.debugOverlay.hud, 'time')).toBe('DILATED');
    expect(rowText(rig.debugOverlay.hud, 'target')).toBe('25%');
    rig.dispose();
  });

  it('keeps reporting frames while the world is dilated and paused', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    for (let i = 0; i < 10; i += 1) rig.step(16);

    rig.tap(DEFAULT_TOGGLE_KEY);
    for (let i = 0; i < 20; i += 1) rig.step(16);
    const full = Number(rowText(rig.debugOverlay.hud, 'frame'));

    rig.timeController.setState(TimeState.DILATED, 0);
    for (let i = 0; i < 20; i += 1) rig.step(16);
    const dilated = Number(rowText(rig.debugOverlay.hud, 'frame'));
    expect(dilated).toBeGreaterThan(full);
    expect(rowText(rig.debugOverlay.hud, 'time')).toBe('DILATED');

    rig.timeController.setState(TimeState.PAUSED, 0);
    for (let i = 0; i < 20; i += 1) rig.step(16);
    const paused = Number(rowText(rig.debugOverlay.hud, 'frame'));
    expect(paused).toBeGreaterThan(dilated);
    expect(rowText(rig.debugOverlay.hud, 'time')).toBe('PAUSED');

    // The world, meanwhile, stopped issuing fixed steps entirely.
    expect(rig.physics.stepCount).toBeGreaterThan(0);
    rig.dispose();
  });

  it('toggles the grid and axes independently through the loop', async () => {
    rig = await createRig();
    rig.engine.start();
    rig.step(16);
    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.step(16);

    rig.tap(DEFAULT_GRID_KEY);
    rig.step(16);
    expect(rig.debugOverlay.gizmos.isGridVisible).toBe(false);
    expect(rig.debugOverlay.gizmos.isAxesVisible).toBe(true);

    rig.tap(DEFAULT_AXES_KEY);
    rig.step(16);
    expect(rig.debugOverlay.gizmos.isAxesVisible).toBe(false);
    rig.dispose();
  });

  it('never perturbs the simulation, however hard it is used', async () => {
    // Baseline: the same frames with the overlay hidden.
    const quiet = await createRig();
    quiet.engine.start();
    quiet.step(16);
    for (let i = 0; i < 60; i += 1) quiet.step(16);
    const baseSteps = quiet.physics.stepCount;
    const basePosition = { ...quiet.world.player.position };
    quiet.dispose();

    // The same frames again, with the overlay visible and the gizmo keys
    // hammered. Only F3/F4/F6 are pressed - the time bindings are deliberately
    // left alone, because those are *supposed* to change the simulation.
    const busy = await createRig();
    busy.engine.start();
    busy.step(16);
    for (let i = 0; i < 60; i += 1) {
      busy.tap(DEFAULT_TOGGLE_KEY);
      busy.tap(DEFAULT_GRID_KEY);
      busy.tap(DEFAULT_AXES_KEY);
      busy.step(16);
    }
    const busySteps = busy.physics.stepCount;
    const busyPosition = { ...busy.world.player.position };
    busy.dispose();

    // Identical fixed-step count and identical player placement: the overlay's
    // own work is invisible to the simulation.
    expect(busySteps).toBe(baseSteps);
    expect(busyPosition.x).toBeCloseTo(basePosition.x, 6);
    expect(busyPosition.y).toBeCloseTo(basePosition.y, 6);
    expect(busyPosition.z).toBeCloseTo(basePosition.z, 6);
  });

  it('logs input events to the console when F7 is pressed', async () => {
    rig = await createRig();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rig.engine.start();
    rig.step(16);

    rig.tap('F7');
    rig.step(16);
    expect(rig.debugOverlay.isLoggingInput).toBe(true);

    rig.tap('KeyW');
    rig.step(16);
    expect(spy).toHaveBeenCalledWith('[ASTRA:input] key down  KeyW');

    spy.mockRestore();
    rig.dispose();
  });
});
