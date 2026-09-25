// @vitest-environment jsdom
/**
 * Integration test for the bootstrap wiring.
 *
 * Runs the real `main.ts` against a real (jsdom) DOM with only the WebGL
 * renderer stubbed out, so this exercises the whole chain:
 *   DOM -> EventBus -> InputManager -> SceneManager -> TimeController -> Engine
 *
 * The stub is deliberate: jsdom has no WebGL, and the production path already
 * handles that failure (see the boot-error test at the bottom).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../src/renderer/RenderPipeline', async () => {
  // A real Scene, because WorldScene (Step 1.2) populates it for real.
  const { PerspectiveCamera, Scene } = await import('three');

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

beforeEach(() => {
  installDom(true);
  window.__ASTRA__ = undefined;
  vi.resetModules();
});

describe('bootstrap (src/main.ts)', () => {
  it('exposes the core services on window.__ASTRA__', async () => {
    await import('../src/main');

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
    await import('../src/main');
    await nextFrame();
    await nextFrame();

    const handle = window.__ASTRA__;
    expect(handle?.sceneManager.current).toBe('MAIN_MENU');
    expect(handle?.sceneManager.previous).toBe('LOADING');
    expect(handle?.sceneManager.changeCount).toBe(1);
  });

  it('advances the world through the TimeController delta', async () => {
    await import('../src/main');
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
    await import('../src/main');
    await nextFrame();

    const render = (window.__ASTRA__?.renderPipeline as unknown as { render: Mock }).render;
    const before = render.mock.calls.length;

    await nextFrame();
    await nextFrame();

    expect(render.mock.calls.length).toBe(before + 2);
  });

  it('freezes game time while the scene is PAUSED and restores it after', async () => {
    await import('../src/main');
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
    await import('../src/main');
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
    await import('../src/main');

    const box = document.getElementById('boot-error');
    expect(box?.hidden).toBe(false);
    expect(document.getElementById('boot-error-message')?.textContent).toContain('canvas');
  });
});
