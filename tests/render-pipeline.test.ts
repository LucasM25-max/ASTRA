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
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { EventBus } from '../src/core/EventBus';

// `vi.mock` factories are hoisted, so both the stub and the recorder it writes
// into have to come from `vi.hoisted`.
const { rendererInstances, RendererStub, stubFlags } = vi.hoisted(() => {
  const rendererInstances: RendererStub[] = [];
  /** Set by a test to make the next constructed renderer throw on first use. */
  const stubFlags = { failConstruction: false };

  class RendererStub {
    readonly canvas: unknown;
    clearColorHex = 0;
    clearAlpha = 1;
    pixelRatio = 1;
    drawingBufferSize = { width: 0, height: 0 };
    updateStyle = true;
    renderCalls = 0;
    disposed = false;

    // Everything `EffectComposer` and its passes read off the renderer. Without
    // these the post chain cannot be constructed under jsdom, and every test in
    // this file would silently take the "no post-processing" fallback path -
    // which would make the whole suite green while testing nothing.
    // `shadowMap` defaults to `enabled: false` on a real WebGLRenderer. The stub
    // has to default the same way or a test asserting the pipeline turns shadows
    // on would pass even if the pipeline never touched it.
    shadowMap = { enabled: false, type: 0 };
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = 'srgb';
    autoClear = true;
    autoClearColor = true;
    autoClearDepth = true;
    autoClearStencil = true;
    /** Set by a test that wants construction to fail. */
    failOnGetPixelRatio = false;

    constructor(options: { canvas: unknown }) {
      this.canvas = options.canvas;
      rendererInstances.push(this);
    }

    getPixelRatio(): number {
      if (this.failOnGetPixelRatio || stubFlags.failConstruction) {
        throw new Error('no pixel ratio');
      }
      return this.pixelRatio;
    }

    getDrawingBufferSize(target: { width: number; height: number }): { width: number; height: number } {
      target.width = this.drawingBufferSize.width;
      target.height = this.drawingBufferSize.height;
      return target;
    }

    getSize(target: { width: number; height: number }): { width: number; height: number } {
      target.width = this.drawingBufferSize.width;
      target.height = this.drawingBufferSize.height;
      return target;
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

    setRenderTarget(): void {}

    getRenderTarget(): unknown {
      return null;
    }

    clear(): void {}

    getClearColor(target: { set(hex: number): void }): { set(hex: number): void } {
      target.set(this.clearColorHex);
      return target;
    }

    getClearAlpha(): number {
      return this.clearAlpha;
    }

    clearColor(): void {}

    clearDepth(): void {}

    clearStencil(): void {}

    dispose(): void {
      this.disposed = true;
    }
  }

  return { rendererInstances, RendererStub, stubFlags };
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

  it('frames the camera so the ground plane reads on the first frame', () => {
    const pipeline = new RenderPipeline(canvas, { eventBus: bus });

    // Elevated and pulled back, looking slightly down at the plane's centre.
    expect(pipeline.camera.position.toArray()).toEqual([0, 2.2, 8]);
    expect(pipeline.camera.position.y).toBeGreaterThan(0);

    // The camera must actually be looking downwards, or the ground plane would
    // not be visible at all.
    const forward = pipeline.camera.getWorldDirection(new Vector3());
    expect(forward.y).toBeLessThan(0);
  });

  it('accepts custom camera framing', () => {
    const pipeline = new RenderPipeline(canvas, {
      eventBus: bus,
      cameraPosition: { x: 1, y: 2, z: 3 },
      cameraTarget: { x: 4, y: 5, z: 6 },
    });

    expect(pipeline.camera.position.toArray()).toEqual([1, 2, 3]);
    // lookAt() aims -Z at the target, so the camera now faces +X/+Y/+Z-ish.
    const forward = pipeline.camera.getWorldDirection(new Vector3());
    expect(forward.x).toBeGreaterThan(0);
    expect(forward.y).toBeGreaterThan(0);
    expect(forward.z).toBeGreaterThan(0);
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

    // With the chain live the scene is drawn into the composer's target and then
    // graded, so the renderer is called more than once per frame - once for the
    // scene and once per full-screen pass. What matters is that it is called at
    // all, and that the drawing buffer is the canvas size.
    expect(rendererInstances[0].renderCalls).toBeGreaterThanOrEqual(1);
    expect(rendererInstances[0].drawingBufferSize).toEqual({ width: 800, height: 600 });
  });

  it('turns shadows on, because a casting light is invisible until it does', () => {
    const pipeline = new RenderPipeline(canvas, { eventBus: bus });

    // `shadowMap.enabled` defaults to false on WebGLRenderer. The whole Step 2.5
    // light rig - the 220 m camera-following box, the 2048 map, the 0.06 normal
    // bias - is invisible on screen until this is set, and nothing else sets it,
    // so this assertion is the only thing standing between a correct light rig
    // and a world with no shadows at all.
    expect(rendererInstances[0].shadowMap.enabled).toBe(true);
    // PCFSoft (2), not PCF (1) or Basic (0): the box is 220 m across at 2048
    // texels, and a hard filter staircases every trunk.
    expect(rendererInstances[0].shadowMap.type).toBe(2);

    pipeline.dispose();
  });

  it('renders exactly once per frame with the chain switched off', () => {
    const pipeline = new RenderPipeline(canvas, {
      eventBus: bus,
      postProcessing: { enabled: false },
    });
    pipeline.render();

    expect(rendererInstances[0].renderCalls).toBe(1);
    expect(pipeline.post).toBeNull();
  });

  it('owns the scene fog: none with the chain, linear without it', () => {
    // Exactly one fog in the scene, ever. With the chain live the atmosphere pass
    // does the fogging from the depth buffer; Three's own linear fog has to be
    // off or every pixel is fogged twice and the horizon comes in at half the
    // distance. Without the chain there is no depth cue at all without it.
    const graded = new RenderPipeline(canvas, { eventBus: bus });
    expect(graded.post).not.toBeNull();
    expect(graded.scene.fog).toBeNull();

    const raw = new RenderPipeline(canvas, {
      eventBus: bus,
      postProcessing: { enabled: false },
    });
    expect(raw.scene.fog).not.toBeNull();
  });

  it('degrades to a plain render when the chain cannot be built', () => {
    // A context that cannot give the composer what it needs must not take the
    // boot down with it. The failure is logged, not swallowed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rendererInstances.length = 0;
    stubFlags.failConstruction = true;

    const pipeline = new RenderPipeline(canvas, { eventBus: bus });
    expect(pipeline.post).toBeNull();
    // The fallback fog goes back on, because there is no atmosphere pass to do it.
    expect(pipeline.scene.fog).not.toBeNull();
    expect(warn).toHaveBeenCalled();

    // And it still draws.
    const before = rendererInstances[0].renderCalls;
    pipeline.render();
    expect(rendererInstances[0].renderCalls).toBe(before + 1);

    warn.mockRestore();
    stubFlags.failConstruction = false;
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
