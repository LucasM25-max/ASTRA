import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { Engine } from '../src/core/Engine';
import { TimeController, TimeState } from '../src/core/TimeController';
import { WorldScene } from '../src/world/WorldScene';

/**
 * Step 1.2 requires the render loop to be "tied to Engine.ts via
 * TimeController.getDelta()". This is the test that proves it: the world is
 * driven exactly the way main.ts drives it, so if the world advances, dilates
 * and freezes in step with the TimeController, the wiring is correct.
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
  /** Counts render passes, standing in for RenderPipeline.render(). */
  renders: () => number;
  /** Runs one engine frame `ms` of wall-clock time later. */
  step: (ms: number) => void;
}

/** Wire a WorldScene into an Engine exactly the way main.ts does. */
function createRig(): Rig {
  const timeController = new TimeController();
  const engine = new Engine({ timeController });
  const world = new WorldScene({ scene: new Scene() });

  let renderCount = 0;
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
    renders: () => renderCount,
    step,
  };
}

beforeEach(() => {
  installAnimationFrame();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('render loop -> TimeController -> world', () => {
  it('advances the world by the scaled delta each frame', () => {
    const rig = createRig();
    rig.engine.start();

    rig.step(16); // seed frame: zero delta
    expect(rig.world.elapsedTime).toBe(0);

    rig.step(20); // 20ms of real time at full speed
    expect(rig.world.elapsedTime).toBeCloseTo(0.02, 6);
    expect(rig.renders()).toBe(2);
  });

  it('still renders every frame while the world is frozen', () => {
    const rig = createRig();
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

  it('slows the world to a quarter speed when time is dilated', () => {
    const rig = createRig();
    rig.engine.start();
    rig.step(16);

    rig.timeController.setState(TimeState.DILATED, 0);
    rig.step(20);

    // 20ms of real time * 0.25 = 5ms of game time.
    expect(rig.world.elapsedTime).toBeCloseTo(0.005, 6);
  });

  it('brings the world to a complete halt at zero speed', () => {
    const rig = createRig();
    rig.engine.start();
    rig.step(16);

    rig.timeController.setSpeed(0, 0);
    const elapsed = rig.world.elapsedTime;

    rig.step(20);
    rig.step(20);

    expect(rig.world.elapsedTime).toBe(elapsed);
  });

  it('tracks a custom scripted speed', () => {
    const rig = createRig();
    rig.engine.start();
    rig.step(16);

    rig.timeController.setSpeed(0.1, 0);
    rig.step(20);

    expect(rig.world.elapsedTime).toBeCloseTo(0.002, 6);
    expect(rig.timeController.state).toBe(TimeState.CUSTOM);
  });

  it('ramps the world in over the transition duration', () => {
    const rig = createRig();
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

  it('freezes the world while the scene is PAUSED, via the event wiring', () => {
    // Mirrors main.ts: the SceneManager drives the TimeController through the
    // EventBus, and the world follows the TimeController.
    const rig = createRig();
    const { eventBus } = rig.engine;

    let paused = false;
    eventBus.on('scene:changed', ({ current }) => {
      paused = current === 'PAUSED';
      if (paused) {
        rig.timeController.pause(0);
      } else {
        rig.timeController.resume(0);
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

  it('stops advancing the world once the engine stops', () => {
    const rig = createRig();
    rig.engine.start();
    rig.step(16);
    rig.step(20);

    const elapsed = rig.world.elapsedTime;
    rig.engine.stop();

    rig.step(20);
    expect(rig.world.elapsedTime).toBe(elapsed);
  });
});
