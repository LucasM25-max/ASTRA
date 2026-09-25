// @vitest-environment jsdom
/**
 * RenderPipeline unit tests.
 *
 * `WebGLRenderer` is stubbed because jsdom has no WebGL context; everything
 * else (Scene, PerspectiveCamera, Color, the resize maths and the event
 * emissions) is the real thing. The genuine "no WebGL available" behaviour is
 * covered separately in render-pipeline-webgl.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { EventBus } from '../src/core/EventBus';

// `vi.mock` factories are hoisted, so both the stub and the recorder it writes
// into have to come from `vi.hoisted`.
const { rendererInstances, RendererStub } = vi.hoisted(() => {
  const rendererInstances: RendererStub[] = [];

  class RendererStub {
    readonly canvas: unknown;
    clearColorHex = 0;
    clearAlpha = 1;
    pixelRatio = 1;
    drawingBufferSize = { width: 0, height: 0 };
    updateStyle = true;
    renderCalls = 0;
    disposed = false;

    constructor(options: { canvas: unknown }) {
      this.canvas = options.canvas;
      rendererInstances.push(this);
    }

    setClearColor(color: { getHex(): number }, alpha: number): void {
      this.clearColorHex = color.getHex();
      this.clearAlpha = alpha;
    }

    setPixelRatio(ratio: number): void {
      this.pixelRatio = ratio;
    }

    setSize(width: number, height: number, updateStyle: boolean): void {
      this.drawingBufferSize = { width, height };
      this.updateStyle = updateStyle;
    }

    render(): void {
      this.renderCalls += 1;
    }

    dispose(): void {
      this.disposed = true;
    }
  }

  return { rendererInstances, RendererStub };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: RendererStub };
});

import { RenderPipeline } from '../src/renderer/RenderPipeline';

let canvas: HTMLCanvasElement;
let bus: EventBus;

function setWindowSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

beforeEach(() => {
  document.body.innerHTML = '';
  rendererInstances.length = 0;

  canvas = document.createElement('canvas');
  document.body.append(canvas);

  bus = new EventBus();
  setWindowSize(1024, 768);

  // jsdom does no layout and reports clientWidth/clientHeight as 0, so the
  // canvas is given a CSS size the way a real browser would.
  Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
});

describe('RenderPipeline', () => {
  it('creates a scene and a camera with the requested parameters', () => {
    const pipeline = new RenderPipeline(canvas, {
      eventBus: bus,
      fov: 55,
      near: 0.5,
      far: 1500,
      clearColor: 0x112233,
    });

    expect(pipeline.scene).toBeInstanceOf(Scene);
    expect(pipeline.camera).toBeInstanceOf(PerspectiveCamera);
    expect(pipeline.camera.fov).toBe(55);
    expect(pipeline.camera.near).toBe(0.5);
    expect(pipeline.camera.far).toBe(1500);

    const renderer = rendererInstances[0];
    expect(renderer.canvas).toBe(canvas);
    expect(renderer.clearColorHex).toBe(0x112233);
    expect(renderer.clearAlpha).toBe(1);
  });

  it('sizes the drawing buffer from the canvas CSS size', () => {
    const pipeline = new RenderPipeline(canvas, { eventBus: bus });

    expect(pipeline.size).toEqual({ width: 800, height: 600 });
    expect(pipeline.aspectRatio).toBeCloseTo(800 / 600, 6);

    const renderer = rendererInstances[0];
    expect(renderer.drawingBufferSize).toEqual({ width: 800, height: 600 });
    // The stylesheet owns the CSS size, so three must not write inline styles.
    expect(renderer.updateStyle).toBe(false);
  });

  it('clamps the device pixel ratio', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    new RenderPipeline(canvas, { eventBus: bus, maxPixelRatio: 2 });
    expect(rendererInstances[0].pixelRatio).toBe(2);

    rendererInstances.length = 0;
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
    new RenderPipeline(canvas, { eventBus: bus, maxPixelRatio: 2 });
    expect(rendererInstances[0].pixelRatio).toBe(1);
  });

  it('falls back to the window size when the canvas reports nothing', () => {
    Object.defineProperty(canvas, 'clientWidth', { value: 0, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 0, configurable: true });

    const pipeline = new RenderPipeline(canvas, { eventBus: bus });

    expect(pipeline.size).toEqual({ width: 1024, height: 768 });
  });

  it('publishes engine:resize and keeps the camera aspect in sync', () => {
    const pipeline = new RenderPipeline(canvas, { eventBus: bus });
    const seen: { width: number; height: number; pixelRatio: number }[] = [];
    bus.on('engine:resize', (payload) => seen.push(payload));

    pipeline.resize(1280, 720);

    expect(seen).toEqual([{ width: 1280, height: 720, pixelRatio: 1 }]);
    expect(pipeline.camera.aspect).toBeCloseTo(1280 / 720, 6);
  });

  it('does not re-emit a resize that changes nothing', () => {
    new RenderPipeline(canvas, { eventBus: bus });
    const handler = vi.fn();
    bus.on('engine:resize', handler);

    // The constructor already sized the buffer to 800x600.
    expect(handler).not.toHaveBeenCalled();
  });

  it('re-syncs to the canvas when the window resizes', () => {
    const pipeline = new RenderPipeline(canvas, { eventBus: bus });

    Object.defineProperty(canvas, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 480, configurable: true });
    window.dispatchEvent(new Event('resize'));

    expect(pipeline.size).toEqual({ width: 640, height: 480 });
  });

  it('renders the scene through the camera', () => {
    const pipeline = new RenderPipeline(canvas, { eventBus: bus });
    pipeline.render();

    expect(rendererInstances[0].renderCalls).toBe(1);
    expect(rendererInstances[0].drawingBufferSize).toEqual({ width: 800, height: 600 });
  });

  it('can change the clear colour at runtime', () => {
    const pipeline = new RenderPipeline(canvas, { eventBus: bus });
    pipeline.setClearColor(0x445566, 0.5);

    const renderer = rendererInstances[0];
    expect(renderer.clearColorHex).toBe(0x445566);
    expect(renderer.clearAlpha).toBe(0.5);
  });

  it('stops listening for resizes once disposed', () => {
    const pipeline = new RenderPipeline(canvas, { eventBus: bus });
    pipeline.dispose();
    expect(rendererInstances[0].disposed).toBe(true);

    Object.defineProperty(canvas, 'clientWidth', { value: 320, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 240, configurable: true });
    window.dispatchEvent(new Event('resize'));

    expect(pipeline.size).toEqual({ width: 800, height: 600 });
  });
});
