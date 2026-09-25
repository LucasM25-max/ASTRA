/**
 * RenderPipeline.ts - ASTRA renderer
 * =============================================================================
 * Owns the Three.js objects that outlive individual scenes: the WebGL renderer,
 * the root scene graph and the primary camera.
 *
 * This is deliberately thin for now - it is the bootstrap. Content (terrain,
 * lights, sky, post-processing) arrives in later steps and hangs off `scene`.
 *
 * Responsibilities:
 *   - create the WebGLRenderer against the fullscreen canvas
 *   - own the perspective camera and keep its aspect ratio correct
 *   - track the drawing-buffer size (capped pixel ratio) and publish
 *     `engine:resize` so UI and cameras can react
 *   - draw one frame on demand
 * =============================================================================
 */

import { Color, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { EventBus, type AstraEvents } from '../core/EventBus';

/** Near-black with a cold cast, so a first frame never flashes white. */
const DEFAULT_CLEAR_COLOR = 0x05070a;

export interface RenderPipelineOptions {
  eventBus?: EventBus;
  /** Defaults to true. */
  antialias?: boolean;
  /** Defaults to 0x05070a. */
  clearColor?: number;
  /** Defaults to 60 degrees. */
  fov?: number;
  /** Defaults to 0.1. */
  near?: number;
  /** Defaults to 2000 (room for a 500m world plus sky). */
  far?: number;
  /** Upper bound on devicePixelRatio. Defaults to 2. */
  maxPixelRatio?: number;
  /** Initial camera position. Defaults to a low three-quarter view of the plane. */
  cameraPosition?: { readonly x: number; readonly y: number; readonly z: number };
  /** Point the camera looks at. Defaults to just ahead of the plane's centre. */
  cameraTarget?: { readonly x: number; readonly y: number; readonly z: number };
}

/** Framing that shows the ground plane receding into the fog. */
export const DEFAULT_CAMERA_POSITION = { x: 0, y: 2.2, z: 8 } as const;
export const DEFAULT_CAMERA_TARGET = { x: 0, y: 0.8, z: 0 } as const;

export class RenderPipeline {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;

  /** The canvas this pipeline draws into; also the source of truth for sizing. */
  private readonly canvas: HTMLCanvasElement;

  private readonly bus: EventBus | undefined;
  private readonly maxPixelRatio: number;
  private resizeObserver: ResizeObserver | null = null;

  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  constructor(canvas: HTMLCanvasElement, options: RenderPipelineOptions = {}) {
    this.bus = options.eventBus;
    this.maxPixelRatio = options.maxPixelRatio ?? 2;
    this.canvas = canvas;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: options.antialias ?? true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor(new Color(options.clearColor ?? DEFAULT_CLEAR_COLOR), 1);

    this.scene = new Scene();

    this.camera = new PerspectiveCamera(
      options.fov ?? 60,
      1,
      options.near ?? 0.1,
      options.far ?? 2000,
    );
    // Placeholder framing so the basic scene reads correctly on the first
    // frame; the third-person camera takes over in Step 1.5.
    const position = options.cameraPosition ?? DEFAULT_CAMERA_POSITION;
    const target = options.cameraTarget ?? DEFAULT_CAMERA_TARGET;
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.lookAt(target.x, target.y, target.z);

    this.attachResizeHandlers(canvas);

    const initialWidth = canvas.clientWidth > 0 ? canvas.clientWidth : this.fallbackWidth();
    const initialHeight = canvas.clientHeight > 0 ? canvas.clientHeight : this.fallbackHeight();
    this.resize(initialWidth, initialHeight);
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  /** CSS pixel size of the drawing buffer. */
  get size(): { readonly width: number; readonly height: number } {
    return { width: this.width, height: this.height };
  }

  get aspectRatio(): number {
    return this.width / this.height;
  }

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                              */
  /* ---------------------------------------------------------------------- */

  /** Draw one frame of `scene` through `camera`. */
  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  setClearColor(color: number, alpha = 1): void {
    this.renderer.setClearColor(new Color(color), alpha);
  }

  /* ---------------------------------------------------------------------- */
  /* Sizing                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Resize the drawing buffer. The canvas CSS size is left to the stylesheet
   * (100% x 100%), so `updateStyle` is false.
   */
  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    const nextPixelRatio = Math.min(
      typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
      this.maxPixelRatio,
    );

    if (
      nextWidth === this.width &&
      nextHeight === this.height &&
      nextPixelRatio === this.pixelRatio
    ) {
      return;
    }

    this.width = nextWidth;
    this.height = nextHeight;
    this.pixelRatio = nextPixelRatio;

    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();

    this.bus?.emit('engine:resize', {
      width: this.width,
      height: this.height,
      pixelRatio: this.pixelRatio,
    } satisfies AstraEvents['engine:resize']);
  }

  /* ---------------------------------------------------------------------- */
  /* Teardown                                                               */
  /* ---------------------------------------------------------------------- */

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onWindowResize);
      window.removeEventListener('orientationchange', this.onWindowResize);
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer.dispose();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private attachResizeHandlers(canvas: HTMLCanvasElement): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onWindowResize);
      window.addEventListener('orientationchange', this.onWindowResize);
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.syncToCanvas(canvas));
      this.resizeObserver.observe(canvas);
    }
  }

  private readonly onWindowResize = (): void => {
    this.syncToCanvas(this.canvas);
  };

  /** Push a canvas' current CSS size into the drawing buffer. */
  syncToCanvas(canvas: HTMLCanvasElement = this.canvas): void {
    const width = canvas.clientWidth > 0 ? canvas.clientWidth : this.fallbackWidth();
    const height = canvas.clientHeight > 0 ? canvas.clientHeight : this.fallbackHeight();
    this.resize(width, height);
  }

  private fallbackWidth(): number {
    return typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1;
  }

  private fallbackHeight(): number {
    return typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 1;
  }
}
