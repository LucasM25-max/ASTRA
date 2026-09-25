// @vitest-environment jsdom
/**
 * Integration test for the bootstrap wiring.
 * Runs the real `main.ts` against a real (jsdom) DOM with only the WebGL
 * renderer stubbed out, so this exercises the whole chain:
 *   DOM -> EventBus -> InputManager -> SceneManager -> TimeController -> Engine
 *   -> PhysicsWorld -> WorldScene -> Player
 *
 * The stub is deliberate: jsdom has no WebGL, and the production path already
 * handles that failure (see the boot-error test at the bottom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { Box3, Frustum, Matrix4, Vector3 } from 'three';

vi.mock('../src/renderer/RenderPipeline', async (importOriginal) => {
  // A real Scene, because WorldScene populates it for real.
  const { PerspectiveCamera, Scene } = await import('three');
  // Reuse the real framing defaults so the stub behaves like the thing it
  // replaces - a stub that leaves the camera at the origin would make any
  // "is the player on screen" assertion meaningless.
  const actual = await importOriginal<typeof import('../src/renderer/RenderPipeline')>();

  class RenderPipelineStub {
    renderer = {
      domElement: null,
      render: vi.fn(),
      dispose: vi.fn(),
      setPixelRatio: vi.fn(),
      setSize: vi.fn(),
      setClearColor: vi.fn(),
    };
    scene = new Scene();
    camera = new PerspectiveCamera(60, 1.6, 0.1, 2000);

    constructor() {
      this.camera.position.set(
        actual.DEFAULT_CAMERA_POSITION.x,
        actual.DEFAULT_CAMERA_POSITION.y,
        actual.DEFAULT_CAMERA_POSITION.z,
      );
      this.camera.lookAt(
        actual.DEFAULT_CAMERA_TARGET.x,
        actual.DEFAULT_CAMERA_TARGET.y,
        actual.DEFAULT_CAMERA_TARGET.z,
      );
    }

    size = { width: 800, height: 600 };
    render = vi.fn();
    resize = vi.fn();
    dispose = vi.fn();
  }
  return { RenderPipeline: RenderPipelineStub };
});

/** Wait for the next animation frame (jsdom drives rAF on a timer). */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function installDom(withCanvas: boolean): void {
  document.body.innerHTML = withCanvas
    ? '<canvas id="game-canvas"></canvas>' +
      '<div id="boot-error" hidden><pre id="boot-error-message"></pre></div>'
    : '<div id="boot-error" hidden><pre id="boot-error-message"></pre></div>';
}

/** Import the real main.ts and wait for its async boot to finish. */
async function bootApp(): Promise<void> {
  const { ready } = await import('../src/main');
  await ready;
}

beforeEach(() => {
  installDom(true);
  window.__ASTRA__ = undefined;
  vi.resetModules();
});

afterEach(() => {
  // Tear the run down so a leaked engine cannot keep ticking Rapier into the
  // next test.
  const handle = window.__ASTRA__;
  if (handle !== undefined) {
    handle.engine.stop();
    handle.inputManager.dispose();
    handle.worldScene.dispose();
    handle.physics.dispose();
    handle.renderPipeline.dispose();
  }
  window.__ASTRA__ = undefined;
});

describe('bootstrap (src/main.ts)', () => {
  it('exposes the core services on window.__ASTRA__', async () => {
    await bootApp();

    const handle = window.__ASTRA__;
    expect(handle).toBeDefined();
    expect(handle?.engine.isRunning).toBe(true);
    expect(handle?.inputManager.isAttached).toBe(true);
    expect(handle?.sceneManager.current).toBe('LOADING');

    // Step 1.2: the world is built and attached to the renderer's scene.
    expect(handle?.worldScene.isDisposed).toBe(false);
    expect(handle?.worldScene.terrain.sizeMetres).toBe(100);
    expect(handle?.worldScene.fog).not.toBeNull();
    expect(handle?.renderPipeline.scene.children).toContain(handle?.worldScene.sky.mesh);
  });

  it('leaves LOADING and enters MAIN_MENU on the first rendered frame', async () => {
    await bootApp();
    await nextFrame();
    await nextFrame();

    const handle = window.__ASTRA__;
    expect(handle?.sceneManager.current).toBe('MAIN_MENU');
    expect(handle?.sceneManager.previous).toBe('LOADING');
    expect(handle?.sceneManager.changeCount).toBe(1);
  });

  it('advances the world through the TimeController delta', async () => {
    await bootApp();
    await nextFrame();
    await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    // The sky only moves because the render loop feeds it game time.
    expect(handle.worldScene.elapsedTime).toBeGreaterThan(0);
    expect(handle.worldScene.sky.elapsedTime).toBeCloseTo(handle.worldScene.elapsedTime, 6);

    // Freezing game time must freeze the world while rendering continues.
    handle.timeController.setState('PAUSED', 0);
    await nextFrame();
    const frozen = handle.worldScene.elapsedTime;
    await nextFrame();
    expect(handle.worldScene.elapsedTime).toBe(frozen);
  });

  it('renders through the pipeline exactly once per frame', async () => {
    await bootApp();
    await nextFrame();

    const render = (window.__ASTRA__?.renderPipeline as unknown as { render: Mock }).render;
    const before = render.mock.calls.length;

    await nextFrame();
    await nextFrame();

    expect(render.mock.calls.length).toBe(before + 2);
  });

  it('freezes game time while the scene is PAUSED and restores it after', async () => {
    await bootApp();
    await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    expect(handle.timeController.state).toBe('REALTIME');

    handle.sceneManager.setState('PAUSED');
    expect(handle.timeController.isPaused).toBe(true);
    expect(handle.timeController.targetSpeed).toBe(0);

    handle.sceneManager.setState('GAMEPLAY');
    expect(handle.timeController.isPaused).toBe(false);
    expect(handle.timeController.targetSpeed).toBe(1);
  });

  it('dilates game time from the temporary debug binding', async () => {
    await bootApp();
    await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', key: '2' }));
    await nextFrame();

    expect(handle.timeController.state).toBe('DILATED');
    expect(handle.timeController.targetSpeed).toBeCloseTo(0.25, 6);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', key: '1' }));
    await nextFrame();

    expect(handle.timeController.state).toBe('REALTIME');
  });

  it('shows a boot error instead of throwing when the canvas is missing', async () => {
    installDom(false);
    await bootApp();

    const box = document.getElementById('boot-error');
    expect(box?.hidden).toBe(false);
    expect(document.getElementById('boot-error-message')?.textContent).toContain('canvas');
  });
});

describe('bootstrap physics (Step 1.3)', () => {
  it('initialises Rapier and builds the world with gravity at -9.81', async () => {
    await bootApp();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    expect(handle.physics.isFreed).toBe(false);
    expect(handle.physics.gravity).toEqual({ x: 0, y: -9.81, z: 0 });

    // The physics timestep matches the engine's fixed step, so the accumulator
    // and Rapier's solver cannot disagree.
    expect(handle.physics.timestep).toBeCloseTo(handle.engine.fixedTimeStep, 6);
  });

  it('puts a player capsule in the scene at the spec spawn point', async () => {
    await bootApp();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    expect(handle.renderPipeline.scene.children).toContain(handle.worldScene.player.mesh);
    expect(handle.worldScene.player.position).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('frames the player in the default camera, so the capsule is on screen', async () => {
    await bootApp();
    await nextFrame();
    await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    const { camera } = handle.renderPipeline;

    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const frustum = new Frustum();
    frustum.setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );

    // The player's whole bounding box must be inside the view, or Step 1.4's
    // movement would happen off screen.
    const box = new Box3().setFromObject(handle.worldScene.player.mesh);
    expect(frustum.intersectsBox(box)).toBe(true);
    for (const corner of [
      new Vector3(box.min.x, box.min.y, box.min.z),
      new Vector3(box.max.x, box.min.y, box.max.z),
      new Vector3(box.min.x, box.max.y, box.min.z),
      new Vector3(box.max.x, box.max.y, box.max.z),
    ]) {
      expect(frustum.containsPoint(corner)).toBe(true);
    }
  });

  it('steps physics on the fixed path and drops the player onto the ground', async () => {
    await bootApp();

    // jsdom's rAF ticks at roughly 16ms, so the engine's fixed-step
    // accumulator needs a few frames to fill one 1/60 step.
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    const steps = handle.physics.stepCount;
    expect(steps).toBeGreaterThan(0);

    // Long enough to fall the 0.1m from the spawn point and settle on it.
    for (let i = 0; i < 120; i += 1) await nextFrame();

    expect(handle.physics.stepCount).toBeGreaterThan(steps);
    expect(handle.worldScene.player.position.y).toBeLessThan(1);
    expect(handle.worldScene.player.position.y).toBeGreaterThan(0.85);
  });
});
