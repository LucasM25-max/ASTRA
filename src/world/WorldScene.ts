/**
 * WorldScene.ts - ASTRA world
 * =============================================================================
 * Composes everything that is visible and physical in the world right now: the
 * ground plane, the sky dome, the light rig, the depth fog and the player.
 *
 * This is the single place Step 2 will grow. Terrain, the stream, the forest,
 * the corruption and the post-processing pipeline all attach here, and callers
 * (main.ts today, the encounter and DM systems later) never reach past it into
 * Three.js or Rapier.
 *
 * Two update paths, and the difference matters
 * --------------------------------------------
 *   fixedUpdate(delta)  simulation. Called from `Engine.onFixedUpdate` with the
 *                       engine's constant fixed timestep. Physics lives here,
 *                       and only here, so the simulation stays deterministic
 *                       and time dilation works for free - when `gameSpeed`
 *                       drops the engine issues fewer fixed steps, and the
 *                       world slows down with no special case in this file.
 *
 *   update(delta)       presentation. Called from the render loop with the
 *                       *scaled* delta from `TimeController.getDelta()`. This
 *                       advances the sky and reconciles the render meshes with
 *                       the simulation. It never moves physics.
 *
 * Both take game time, never raw engine time. That is the whole point: when the
 * Active Encounter combat system dilates time in Phase 3, the world slows and
 * stops with everything else while the camera and UI keep running at full
 * speed.
 *
 * Ownership: WorldScene disposes what it creates. `scene` and `physics` are
 * passed in, so their creators keep them - exactly as `eventBus` has always
 * been handled.
 * =============================================================================
 */

import { Fog, type Scene } from 'three';
import { LightingSystem } from '../renderer/LightingSystem';
import { SkySystem, DEFAULT_HORIZON_COLOR } from '../renderer/SkySystem';
import { DEFAULT_GROUND_THICKNESS, type PhysicsWorld, type Vec3 } from '../physics/PhysicsWorld';
import { Player, PLAYER_SPAWN } from '../player/Player';
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
  /** An initialised physics world. Build it with `PhysicsWorld.create()`. */
  physics: PhysicsWorld;
  fog?: {
    near?: number;
    far?: number;
    color?: number;
  };
  /** Initial position of the player's capsule centre. Defaults to (0, 1, 0). */
  playerSpawn?: Vec3;
  /** Capsule radius in metres. Defaults to `PLAYER_RADIUS`. */
  playerRadius?: number;
  /** Total capsule height in metres. Defaults to `PLAYER_HEIGHT`. */
  playerHeight?: number;
}

export class WorldScene {
  readonly terrain: Terrain;
  readonly sky: SkySystem;
  readonly lighting: LightingSystem;
  readonly player: Player;
  readonly physics: PhysicsWorld;

  private readonly scene: Scene;

  private elapsed = 0;
  private disposed = false;

  constructor(options: WorldSceneOptions) {
    this.scene = options.scene;
    this.physics = options.physics;

    const fogColor = options.fog?.color ?? DEFAULT_FOG_COLOR;
    const fogNear = options.fog?.near ?? DEFAULT_FOG_NEAR;
    const fogFar = options.fog?.far ?? DEFAULT_FOG_FAR;

    this.terrain = new Terrain();
    this.sky = new SkySystem({ horizonColor: DEFAULT_HORIZON_COLOR });
    this.lighting = new LightingSystem();
    this.player = new Player({
      physics: this.physics,
      spawn: options.playerSpawn ?? PLAYER_SPAWN,
      radius: options.playerRadius,
      height: options.playerHeight,
    });

    this.terrain.addTo(this.scene);
    this.sky.addTo(this.scene);
    this.lighting.addTo(this.scene);
    this.player.addTo(this.scene);

    // Static collision for the ground. The slab's top face sits exactly on
    // y = 0, level with the visual plane, so what the player sees and what the
    // player stands on are the same surface.
    this.physics.createGround(
      this.terrain.sizeMetres / 2,
      DEFAULT_GROUND_THICKNESS,
    );

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

  /* ---------------------------------------------------------------------- */
  /* Simulation                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the simulation by one fixed step.
   *
   * Wire this to `Engine.onFixedUpdate` and pass its delta straight through -
   * it is already the engine's constant fixed timestep, which is what Rapier
   * needs. Do not pass a frame delta here.
   */
  fixedUpdate(delta: number): void {
    if (this.disposed) return;
    this.physics.step(delta);
  }

  /* ---------------------------------------------------------------------- */
  /* Presentation                                                           */
  /* ---------------------------------------------------------------------- */

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
    this.player.syncMesh();
  }

  /** Detach everything and release the resources this scene created. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.terrain.removeFrom(this.scene);
    this.sky.removeFrom(this.scene);
    this.lighting.removeFrom(this.scene);
    this.player.removeFrom(this.scene);

    this.scene.fog = null;

    this.terrain.dispose();
    this.sky.dispose();
    this.lighting.dispose();
    this.player.dispose();
  }
}
