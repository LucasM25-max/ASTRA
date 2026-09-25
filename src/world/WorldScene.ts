/**
 * WorldScene.ts - ASTRA world
 * =============================================================================
 * Composes everything that is visible in the world right now: the ground plane,
 * the sky dome, the light rig and the depth fog.
 *
 * This is the single place Step 2 will grow. Terrain, the stream, the forest,
 * the corruption and the post-processing pipeline all attach here, and callers
 * (main.ts today, the encounter and DM systems later) never reach past it into
 * Three.js.
 *
 * `update(delta)` takes *game* delta from `TimeController.getDelta()`, never a
 * raw engine delta. That is the whole point: when the Active Encounter combat
 * system dilates time in Phase 3, the sky slows and stops with everything else
 * while the camera and UI keep running at full speed.
 * =============================================================================
 */

import { Fog, type Scene } from 'three';
import { LightingSystem } from '../renderer/LightingSystem';
import { SkySystem, DEFAULT_HORIZON_COLOR } from '../renderer/SkySystem';
import { Terrain } from './Terrain';

/**
 * Fog distances tuned for a 100m plane viewed from ~8m out: the near edge of
 * the ground sits at 42m and the far edge at 58m, so the plane dissolves into
 * the haze instead of ending in a hard line against the sky.
 */
export const DEFAULT_FOG_NEAR = 25;
export const DEFAULT_FOG_FAR = 60;

/** A touch cooler than the horizon colour, so haze reads as air not fog. */
export const DEFAULT_FOG_COLOR = 0xdfe8ee;

export interface WorldSceneOptions {
  /** The Three scene to populate. Owned by RenderPipeline. */
  scene: Scene;
  fog?: {
    near?: number;
    far?: number;
    color?: number;
  };
}

export class WorldScene {
  readonly terrain: Terrain;
  readonly sky: SkySystem;
  readonly lighting: LightingSystem;

  private readonly scene: Scene;

  private elapsed = 0;
  private disposed = false;

  constructor(options: WorldSceneOptions) {
    this.scene = options.scene;

    const fogColor = options.fog?.color ?? DEFAULT_FOG_COLOR;
    const fogNear = options.fog?.near ?? DEFAULT_FOG_NEAR;
    const fogFar = options.fog?.far ?? DEFAULT_FOG_FAR;

    this.terrain = new Terrain();
    this.sky = new SkySystem({ horizonColor: DEFAULT_HORIZON_COLOR });
    this.lighting = new LightingSystem();

    this.terrain.addTo(this.scene);
    this.sky.addTo(this.scene);
    this.lighting.addTo(this.scene);

    // Linear fog: the cheapest depth cue that works, and the one Step 2.5
    // replaces with volumetric ground fog in the stream valley.
    this.scene.fog = new Fog(fogColor, fogNear, fogFar);
  }

  /** The scene's fog, or `null` once disposed. */
  get fog(): Fog | null {
    return this.scene.fog as Fog | null;
  }

  /** Seconds of game time this world has been advanced by. */
  get elapsedTime(): number {
    return this.elapsed;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Advance the world by `delta` seconds of game time.
   *
   * Pass `TimeController.getDelta()` - never a raw engine delta - so time
   * dilation and pause apply to the world automatically.
   */
  update(delta: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(delta) || delta < 0) return;

    this.elapsed += delta;
    this.sky.update(delta);
  }

  /** Detach everything and release the GPU resources it owns. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.terrain.removeFrom(this.scene);
    this.sky.removeFrom(this.scene);
    this.lighting.removeFrom(this.scene);

    this.scene.fog = null;

    this.terrain.dispose();
    this.sky.dispose();
    this.lighting.dispose();
  }
}
