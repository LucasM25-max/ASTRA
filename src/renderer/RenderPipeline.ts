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

import {
  Color,
  Fog,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type DataTexture,
  type Vector3,
} from 'three';
import { EventBus, type AstraEvents } from '../core/EventBus';
import { PostProcessing, type PostProcessingOptions } from './PostProcessing';

/** Near-black with a cold cast, so a first frame never flashes white. */
const DEFAULT_CLEAR_COLOR = 0x05070a;

/**
 * The fallback fog, used only when the post chain is off.
 *
 * The pipeline owns the scene's fog, and this is the one place that decision is
 * made. With the chain live the atmosphere pass does the fogging - from the
 * depth buffer, with a height falloff and a valley floor - so Three's own linear
 * fog has to come off or every pixel would be fogged twice and the horizon would
 * come in at half the distance. With the chain off there is no depth cue at all
 * without it, so the plain linear fog goes back.
 */
const FALLBACK_FOG_COLOR = 0xa8b8bc;
const FALLBACK_FOG_NEAR = 80;
const FALLBACK_FOG_FAR = 400;

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
  /**
   * Build the post-processing chain. Defaults to on, with the plan's Step 2.5
   * settings. Pass `postProcessing: { enabled: false }` for a raw render, which
   * is what a screenshot or a benchmark wants.
   */
  postProcessing?: Omit<PostProcessingOptions, 'scene' | 'camera'> & { enabled?: boolean };
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
  /** The post-processing chain, or `null` when it is switched off. */
  readonly post: PostProcessing | null;

  /** The canvas this pipeline draws into; also the source of truth for sizing. */
  private readonly canvas: HTMLCanvasElement;

  private readonly bus: EventBus | undefined;
  private readonly maxPixelRatio: number;
  private resizeObserver: ResizeObserver | null = null;

  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  /** Where the sun is, for the light shafts. `null` means no rays. */
  private sunWorldPosition: Vector3 | null = null;

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

    // Shadows, and only shadows, are a renderer-level switch - a light that
    // casts is invisible until `shadowMap.enabled` is true. It defaults to
    // FALSE, so without these three lines the whole light rig from Step 2.5 -
    // the 220 m camera-following shadow box, the 2048 map, the normal bias -
    // compiles, unit-tests green, and does nothing at all on screen.
    //
    // PCFSoft rather than PCF or Basic: the shadow box is 220 m across at
    // 2048 texels, which is ~10.7 cm per texel, and a hard filter turns every
    // trunk into a staircase. Soft costs a few more texture taps and is the
    // difference between "shadow" and "decals".
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

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

    this.post = RenderPipeline.buildPost(this.renderer, this.camera, this.scene, options);

    // Exactly one fog in the scene, ever. See `FALLBACK_FOG_*` above.
    this.scene.fog = this.post
      ? null
      : new Fog(FALLBACK_FOG_COLOR, FALLBACK_FOG_NEAR, FALLBACK_FOG_FAR);

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

  /**
   * Build the post chain, or fall back to a plain render.
   *
   * A context that cannot give the chain what it needs - no multisampled
   * targets, no depth texture, a software rasteriser that refuses a format - has
   * to degrade to an ungraded render rather than a blank canvas. The alternative
   * is a boot that dies inside the renderer with nothing to show the player,
   * which is the one failure mode `main.ts` cannot recover from.
   *
   * The failure is logged rather than swallowed: a silently missing grade looks
   * exactly like a lighting bug, and nobody would think to look here.
   */
  private static buildPost(
    renderer: WebGLRenderer,
    camera: PerspectiveCamera,
    scene: Scene,
    options: RenderPipelineOptions,
  ): PostProcessing | null {
    if (options.postProcessing?.enabled === false) return null;
    try {
      return new PostProcessing(renderer, camera, scene, {
        ...options.postProcessing,
        enabled: true,
        scene,
        camera,
      });
    } catch (error) {
      console.warn(
        '[RenderPipeline] post-processing unavailable, rendering ungraded:',
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Draw one frame.
   *
   * With the chain live this is the composer, not the renderer - the scene is
   * drawn into a multisampled target and then graded. Without it this is a plain
   * `renderer.render`, which is what a screenshot or a benchmark wants.
   */
  render(): void {
    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Feed the post chain the per-frame things it needs.
   *
   * The sun's position comes from `setSunPosition` rather than from an argument,
   * because the sun is a property of the world rather than of a frame - and a
   * caller that forgets it on one frame should get the same shafts as on every
   * other, not a frame with no light in it.
   */
  updatePost(delta: number): void {
    this.post?.update(delta, this.camera, this.sunWorldPosition ?? undefined);
  }

  /** Switch the chain on or off without rebuilding it. */
  setPostProcessingEnabled(enabled: boolean): void {
    this.post?.setEnabled(enabled);
  }

  /**
   * Give the atmosphere pass its top-down world mask.
   *
   * This has to be a setter rather than a constructor option because the mask is
   * built from the world - the stream spline and the corruption field - and the
   * world does not exist yet when the pipeline is constructed. The mask is
   * `R` valley density, `G` corruption, sampled by world XZ.
   */
  setAtmosphereMask(mask: DataTexture | null, halfSize = 250): void {
    if (!this.post) return;
    this.post.atmospherePass.uniforms.uMask.value = mask;
    this.post.atmospherePass.uniforms.uMaskHalfSize.value = halfSize;
  }

  /** Centre the light shafts on the sun. Without this the shader sees no sun. */
  setSunPosition(sunWorldPosition: Vector3): void {
    this.sunWorldPosition = sunWorldPosition;
  }

  /**
   * Recolour the fog's haze to match the sky.
   *
   * The day/night cycle drives this once per frame: distant air is the sky seen
   * through more air, so a fog that keeps a fixed colour while the sun moves is
   * lit by a sun that has already set. `corruption` is optional and defaults to
   * leaving the rot's own tint alone.
   */
  setAtmosphereHaze(hazeColor: number, corruptionColor?: number): void {
    if (!this.post) return;
    this.post.setHazeColors(hazeColor, corruptionColor);
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
    // The composer owns its own targets, sized in device pixels, so it has to be
    // told separately from the renderer. Skipping this leaves the chain rendering
    // at whatever size it was built at - a stretched image on the first resize.
    this.post?.setSize(this.width, this.height);

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
    this.post?.dispose();
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
