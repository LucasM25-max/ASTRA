import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, type EngineFrameInfo } from '../src/core/Engine';
import { EventBus } from '../src/core/EventBus';
import { TimeController, TimeState } from '../src/core/TimeController';

let frameQueue: FrameRequestCallback[] = [];
let now = 0;

/** Replace requestAnimationFrame with a queue the test drives by hand. */
function installAnimationFrame(): void {
  frameQueue = [];
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frameQueue.push(callback);
    return frameQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (): void => undefined);
}

/** Advance the simulation clock by `ms` and run exactly one engine frame. */
function step(engine: Engine, ms: number): void {
  now += ms;
  engine.advance(now);
}

beforeEach(() => {
  installAnimationFrame();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Engine', () => {
  it('creates its own time controller when none is supplied', () => {
    const engine = new Engine();
    expect(engine.timeController).toBeInstanceOf(TimeController);
    expect(engine.timeController.gameSpeed).toBe(1);
  });

  it('uses a supplied time controller', () => {
    const timeController = new TimeController({ dilatedSpeed: 0.5 });
    const engine = new Engine({ timeController });
    expect(engine.timeController).toBe(timeController);
  });

  it('does nothing until it is started', () => {
    const engine = new Engine();
    const render = vi.fn();
    engine.onRender(render);

    step(engine, 16);

    expect(engine.isRunning).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });

  it('emits lifecycle events', () => {
    const bus = new EventBus();
    const engine = new Engine({ eventBus: bus });
    const events: string[] = [];
    bus.on('engine:started', () => events.push('started'));
    bus.on('engine:stopped', () => events.push('stopped'));

    engine.start();
    expect(engine.isRunning).toBe(true);
    engine.stop();
    expect(engine.isRunning).toBe(false);
    expect(events).toEqual(['started', 'stopped']);

    // A stopped engine must not tick any more.
    const render = vi.fn();
    engine.onRender(render);
    step(engine, 20);
    expect(render).not.toHaveBeenCalled();
  });

  it('ignores a redundant start()', () => {
    const bus = new EventBus();
    const engine = new Engine({ eventBus: bus });
    const started = vi.fn();
    bus.on('engine:started', started);

    engine.start();
    engine.start();

    expect(started).toHaveBeenCalledTimes(1);
  });

  it('seeds the clock on the first frame so nothing jumps', () => {
    const timeController = new TimeController();
    const engine = new Engine({ timeController });
    const fixed = vi.fn();
    const render = vi.fn();
    engine.onFixedUpdate(fixed);
    engine.onRender(render);

    engine.start();
    step(engine, 16);

    expect(timeController.realElapsed).toBe(0);
    expect(timeController.getDelta()).toBe(0);
    expect(fixed).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('runs one fixed step and one render for a 60fps frame', () => {
    const timeController = new TimeController();
    const engine = new Engine({ timeController });
    const fixed = vi.fn();
    const render = vi.fn();
    engine.onFixedUpdate(fixed);
    engine.onRender(render);

    engine.start();
    step(engine, 16); // seeds the clock
    step(engine, 20); // 20ms of real time

    expect(fixed).toHaveBeenCalledTimes(1);
    expect(fixed).toHaveBeenCalledWith(1 / 60);
    expect(render).toHaveBeenCalledTimes(2);
    expect(timeController.getDelta()).toBeCloseTo(0.02, 6);
  });

  it('catches up with several fixed steps on a slow frame', () => {
    const engine = new Engine();
    const fixed = vi.fn();
    engine.onFixedUpdate(fixed);

    engine.start();
    step(engine, 16); // seeds the clock
    step(engine, 1000 / 30); // ~33ms -> two 16.67ms steps

    expect(fixed).toHaveBeenCalledTimes(2);
  });

  it('caps fixed steps per frame and drops the backlog', () => {
    const engine = new Engine(); // maxSubSteps = 5, maxFrameDelta = 0.1
    const fixed = vi.fn();
    engine.onFixedUpdate(fixed);

    engine.start();
    step(engine, 16);
    step(engine, 5000); // clamped to 100ms, which would need 6 steps

    expect(fixed).toHaveBeenCalledTimes(5);

    // The leftover backlog was dropped rather than carried forward.
    step(engine, 5);
    expect(fixed).toHaveBeenCalledTimes(5);
  });

  it('honours a custom fixed timestep and substep cap', () => {
    const engine = new Engine({ fixedTimeStep: 0.05, maxSubSteps: 2 });
    const fixed = vi.fn();
    engine.onFixedUpdate(fixed);

    engine.start();
    step(engine, 16);
    step(engine, 200); // clamped to 100ms -> exactly 2 steps of 50ms

    expect(fixed).toHaveBeenCalledTimes(2);
  });

  it('clamps the frame delta so a stalled tab cannot fast-forward the world', () => {
    const timeController = new TimeController();
    const engine = new Engine({ timeController });

    engine.start();
    step(engine, 16);
    step(engine, 5000);

    expect(timeController.unscaledDelta).toBeCloseTo(0.1, 6);
  });

  it('slows the simulation when game time is dilated, but keeps rendering', () => {
    const timeController = new TimeController();
    const engine = new Engine({ timeController });
    const fixed = vi.fn();
    const render = vi.fn();
    engine.onFixedUpdate(fixed);
    engine.onRender(render);

    engine.start();
    step(engine, 16);

    timeController.setState(TimeState.DILATED, 0);
    step(engine, 20); // 20ms * 0.25 = 5ms of game time: no full step

    expect(fixed).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(2);
    expect(timeController.getDelta()).toBeCloseTo(0.005, 6);
  });

  it('freezes the simulation while paused but still renders every frame', () => {
    const timeController = new TimeController();
    const engine = new Engine({ timeController });
    const fixed = vi.fn();
    const render = vi.fn();
    engine.onFixedUpdate(fixed);
    engine.onRender(render);

    engine.start();
    step(engine, 16);
    timeController.setState(TimeState.PAUSED, 0);
    step(engine, 20);
    step(engine, 20);

    expect(fixed).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(3);
  });

  it('runs frame-start listeners exactly once per frame, before the simulation', () => {
    const engine = new Engine();
    const order: string[] = [];

    engine.onFrameStart(() => order.push('frame-start'));
    engine.onFixedUpdate(() => order.push('fixed'));
    engine.onRender(() => order.push('render'));

    engine.start();
    step(engine, 16); // seed frame: zero delta, so no fixed step runs
    expect(order).toEqual(['frame-start', 'render']);

    order.length = 0;
    step(engine, 20);

    expect(order).toEqual(['frame-start', 'fixed', 'render']);
  });

  it('reports frame information to render listeners', () => {
    const timeController = new TimeController();
    const engine = new Engine({ timeController });
    const frames: EngineFrameInfo[] = [];
    engine.onRender((frame) => frames.push({ ...frame }));

    engine.start();
    step(engine, 16);
    step(engine, 20);

    expect(frames).toHaveLength(2);
    expect(frames[0].frame).toBe(1);
    expect(frames[0].realDelta).toBe(0);
    expect(frames[1].frame).toBe(2);
    expect(frames[1].realDelta).toBeCloseTo(0.02, 6);
    expect(frames[1].gameDelta).toBeCloseTo(0.02, 6);
    expect(frames[1].fixedSteps).toBe(1);
    expect(frames[1].alpha).toBeGreaterThan(0);
    expect(frames[1].alpha).toBeLessThan(1);
    expect(frames[1].gameSpeed).toBe(1);
    expect(frames[1].elapsed).toBeCloseTo(timeController.elapsed, 6);
    expect(frames[1].realElapsed).toBeCloseTo(0.02, 6);
  });

  it('reuses the same frame object so the loop stays garbage free', () => {
    const engine = new Engine();
    const seen: EngineFrameInfo[] = [];
    engine.onRender((frame) => seen.push(frame));

    engine.start();
    step(engine, 16);
    step(engine, 20);

    expect(seen[0]).toBe(seen[1]);
  });

  it('reports a smoothed fps reading', () => {
    const engine = new Engine();
    engine.start();
    for (let i = 0; i < 30; i += 1) {
      step(engine, 1000 / 60);
    }
    // 30 frames at 60fps clears the 0.25s sampling window several times.
    expect(engine.fps).toBeGreaterThan(50);
    expect(engine.fps).toBeLessThan(70);
  });

  it('can unsubscribe listeners', () => {
    const engine = new Engine();
    const fixed = vi.fn();
    const render = vi.fn();

    const unsubscribeFixed = engine.onFixedUpdate(fixed);
    const unsubscribeRender = engine.onRender(render);

    engine.start();
    step(engine, 16);
    unsubscribeFixed();
    unsubscribeRender();
    unsubscribeFixed(); // idempotent
    step(engine, 20);

    expect(fixed).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('survives a listener that throws', () => {
    const engine = new Engine();
    const survivor = vi.fn();
    engine.onRender(survivor);
    engine.onRender(() => {
      throw new Error('boom');
    });

    engine.start();
    expect(() => step(engine, 16)).toThrow('boom');
    expect(() => step(engine, 20)).toThrow('boom');

    expect(survivor).toHaveBeenCalledTimes(2);
    expect(engine.isRunning).toBe(true);
  });
});
