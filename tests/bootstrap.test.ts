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
import { SceneState } from '../src/core/SceneManager';
import { TimeState } from '../src/core/TimeController';

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
    handle.debugOverlay.dispose();
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

describe('bootstrap camera (Step 1.5)', () => {
  it('exposes a camera controller driving the pipeline camera', async () => {
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    expect(handle.cameraController.camera).toBe(handle.renderPipeline.camera);
    expect(handle.cameraController.player).toBe(handle.worldScene.player);
    expect(handle.cameraController.distance).toBe(4);
  });

  it('puts the camera behind and above the player', async () => {
    await bootApp();
    for (let i = 0; i < 30; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    const player = handle.worldScene.player.position;
    const camera = handle.renderPipeline.camera.position;

    // Default yaw 0 puts the camera at +Z, behind a player whose forward is -Z.
    expect(camera.z).toBeGreaterThan(player.z);
    expect(Math.abs(camera.x - player.x)).toBeLessThan(0.5);
    // Aimed at the player's centre plus the 1.5m height offset, so the camera
    // sits above that point too.
    expect(camera.y).toBeGreaterThan(player.y + 1.5);
  });

  it('orbits the camera with the mouse while the loop runs', async () => {
    await bootApp();
    for (let i = 0; i < 30; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    window.dispatchEvent(
      new MouseEvent('mousedown', { button: 2, buttons: 2 }),
    );
    for (let i = 0; i < 20; i += 1) {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: i * 20, clientY: 0 }));
      await nextFrame();
    }
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2, buttons: 0 }));

    expect(Math.abs(handle.cameraController.yaw)).toBeGreaterThan(0.5);
  });

  it('zooms the camera with the wheel, clamped to 2m-10m', async () => {
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    for (let i = 0; i < 40; i += 1) {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
      await nextFrame();
    }
    expect(handle.cameraController.distance).toBeCloseTo(2, 5);

    for (let i = 0; i < 80; i += 1) {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
      await nextFrame();
    }
    expect(handle.cameraController.distance).toBeCloseTo(10, 5);
  });

  it('keeps orbiting while game time is dilated', async () => {
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    handle.timeController.setState(TimeState.DILATED, 0);
    window.dispatchEvent(new MouseEvent('mousedown', { button: 2, buttons: 2 }));
    for (let i = 0; i < 20; i += 1) {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: i * 20, clientY: 0 }));
      await nextFrame();
    }
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2, buttons: 0 }));

    // The camera's clock is the wall clock, so dilation does not slow it.
    expect(Math.abs(handle.cameraController.yaw)).toBeGreaterThan(0.5);
  });
});

describe('bootstrap debug overlay (Step 1.6)', () => {
  it('exposes a debug overlay wired to the scene and the TimeController', async () => {
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    const overlay = handle.debugOverlay;
    expect(overlay.isDisposed).toBe(false);
    expect(overlay.isVisible).toBe(false);
    // The gizmos live in the renderer's scene graph from the first frame.
    expect(overlay.gizmos.grid.parent).not.toBeNull();
    expect(overlay.gizmos.grid.parent).toBe(handle.renderPipeline.scene);
  });

  it('starts with both gizmos in the scene but invisible', async () => {
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    // Present so showing the overlay never has to touch the scene tree, and
    // invisible so a hidden overlay costs nothing.
    expect(handle.renderPipeline.scene.children).toContain(handle.debugOverlay.gizmos.grid);
    expect(handle.renderPipeline.scene.children).toContain(handle.debugOverlay.gizmos.axes);
    expect(handle.debugOverlay.gizmos.isGridVisible).toBe(false);
    expect(handle.debugOverlay.gizmos.isAxesVisible).toBe(false);
  });

  it('toggles the whole overlay on F3 through the real loop', async () => {
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3', key: 'F3' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F3', key: 'F3' }));
    await nextFrame();

    expect(handle.debugOverlay.isVisible).toBe(true);
    expect(handle.debugOverlay.gizmos.isGridVisible).toBe(true);
    expect(handle.debugOverlay.gizmos.isAxesVisible).toBe(true);
    expect(document.querySelector('#astra-debug-hud')?.hasAttribute('hidden')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3', key: 'F3' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F3', key: 'F3' }));
    await nextFrame();

    expect(handle.debugOverlay.isVisible).toBe(false);
    expect(handle.debugOverlay.gizmos.isGridVisible).toBe(false);
  });

  it('toggles the grid and axis gizmos independently', async () => {
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3', key: 'F3' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F3', key: 'F3' }));
    await nextFrame();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F4', key: 'F4' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F4', key: 'F4' }));
    await nextFrame();

    expect(handle.debugOverlay.isGridEnabled).toBe(false);
    expect(handle.debugOverlay.gizmos.isGridVisible).toBe(false);
    expect(handle.debugOverlay.gizmos.isAxesVisible).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F6', key: 'F6' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F6', key: 'F6' }));
    await nextFrame();

    expect(handle.debugOverlay.gizmos.isAxesVisible).toBe(false);
  });

  it('shows the TimeController state and gameSpeed in the panel', async () => {
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3', key: 'F3' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F3', key: 'F3' }));
    // Two frames: the first reveals the panel, the second gets past the
    // throttle and actually writes.
    await nextFrame();
    await nextFrame();

    const read = (label: string): string => {
      const panel = document.querySelector('#astra-debug-hud');
      for (const row of Array.from(panel?.querySelectorAll('.astra-debug__row') ?? [])) {
        const key = row.querySelector('.astra-debug__k');
        if (key?.textContent === label) {
          return row.querySelector('.astra-debug__v')?.textContent ?? '';
        }
      }
      throw new Error(`no HUD row labelled "${label}"`);
    };

    expect(read('time')).toBe('REALTIME');
    expect(read('speed')).toBe('100%');

    handle.timeController.setState(TimeState.DILATED, 0);
    // The panel repaints at 20Hz, so it takes a few frames of wall-clock time
    // for the change to reach the DOM.
    for (let i = 0; i < 8; i += 1) await nextFrame();

    expect(read('time')).toBe('DILATED');
    expect(read('target')).toBe('25%');
  });

  it('logs input events to the console when F7 is pressed', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F7', key: 'F7' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F7', key: 'F7' }));
    await nextFrame();
    expect(handle.debugOverlay.isLoggingInput).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    await nextFrame();

    expect(spy).toHaveBeenCalledWith('[ASTRA:input] key down  KeyW');
    spy.mockRestore();
  });

  it('suppresses the browser default for the debug function keys', async () => {
    await bootApp();
    for (let i = 0; i < 6; i += 1) await nextFrame();

    // F3 opens the find bar in Firefox and F6 moves focus. A debug key that
    // also drives the browser is worse than no debug key.
    for (const code of ['F3', 'F4', 'F6', 'F7']) {
      const event = new KeyboardEvent('keydown', { code, key: code, cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('is torn down with the rest of the run', async () => {
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3', key: 'F3' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F3', key: 'F3' }));
    await nextFrame();
    expect(handle.debugOverlay.isVisible).toBe(true);

    handle.debugOverlay.dispose();

    expect(handle.debugOverlay.isDisposed).toBe(true);
    expect(handle.debugOverlay.gizmos.grid.parent).toBeNull();
    expect(document.querySelector('#astra-debug-hud')).toBeNull();
  });
});

describe('bootstrap movement (Step 1.4)', () => {
  it('exposes a movement controller bound to the booted player', async () => {
    await bootApp();
    // Let the player settle out of its spawn height onto the ground.
    for (let i = 0; i < 24; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    expect(handle.movement.player).toBe(handle.worldScene.player);
    expect(handle.movement.isGrounded).toBe(true);
    expect(handle.movement.horizontalSpeed).toBeCloseTo(0, 3);
  });

  it('walks the player with WASD through the booted engine loop', async () => {
    await bootApp();
    for (let i = 0; i < 12; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');
    const start = { ...handle.worldScene.player.position };

    // A real key event on the real window target the InputManager attached to.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    for (let i = 0; i < 150; i += 1) await nextFrame();
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }));

    // The default camera looks down -Z, so W carries the player to -Z.
    expect(handle.worldScene.player.position.z).toBeLessThan(start.z - 3);
    expect(Math.abs(handle.worldScene.player.position.x - start.x)).toBeLessThan(0.5);
  });

  it('does not move the player while the scene is paused', async () => {
    await bootApp();
    for (let i = 0; i < 24; i += 1) await nextFrame();

    const handle = window.__ASTRA__;
    if (handle === undefined) throw new Error('bootstrap did not expose a debug handle');

    handle.sceneManager.setState(SceneState.PAUSED);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    for (let i = 0; i < 60; i += 1) await nextFrame();

    // Pausing freezes game time, so no fixed steps are issued, so the player
    // cannot move however hard the key is held.
    const steps = handle.physics.stepCount;
    const position = { ...handle.worldScene.player.position };
    for (let i = 0; i < 60; i += 1) await nextFrame();

    expect(handle.physics.stepCount).toBe(steps);
    expect(handle.worldScene.player.position.z).toBe(position.z);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }));
  });
});
