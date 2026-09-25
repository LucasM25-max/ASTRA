import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { Engine } from '../src/core/Engine';
import { TimeController, TimeState } from '../src/core/TimeController';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
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
  /** Counts render passes, standing in for RenderPipeline.render(). */
  renders: () => number;
  /** Runs one engine frame `ms` of wall-clock time later. */
  step: (ms: number) => void;
  dispose: () => void;
}

/** Wire a WorldScene into an Engine exactly the way main.ts does. */
async function createRig(): Promise<Rig> {
  const timeController = new TimeController();
  const engine = new Engine({ timeController });
  const physics = await PhysicsWorld.create({ timestep: engine.fixedTimeStep });
  const world = new WorldScene({ scene: new Scene(), physics });

  let renderCount = 0;

  // Physics: fixed timestep only.
  engine.onFixedUpdate((delta) => {
    world.fixedUpdate(delta);
  });

  // Presentation: scaled delta, exactly once per frame.
  engine.onRender(() => {
    world.update(timeController.getDelta());
    renderCount += 1;
  });

  const step = (ms: number): void => {
    now += ms;
    engine.advance(now);
  };

  return {
    engine,
    timeController,
    world,
    physics,
    renders: () => renderCount,
    step,
    dispose: () => {
      world.dispose();
      physics.dispose();
    },
  };
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
