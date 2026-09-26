/**
 * WorldScene.ts - ASTRA world
 * =============================================================================
 * Composes everything that is visible and physical in the world right now: the
 * ground, the stream, the sky dome, the light rig, the depth fog and the player.
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
import type { PhysicsWorld, Vec3 } from '../physics/PhysicsWorld';
import { Player, PLAYER_HEIGHT, PLAYER_SPAWN } from '../player/Player';
import { Terrain } from './Terrain';
import { Stream } from './Stream';
import type { SplinePoint, StreamSpline } from '../procedural/StreamSpline';
import type { WaterMaterialOptions as StreamWaterOptions } from '../procedural/WaterShader';
import type { WaterAudioOptions as StreamAudioOptions } from '../audio/WaterAudio';

/**
 * Fog distances tuned for a 500m terrain viewed from ~8m out.
 *
 * The old 25-60m band was chosen to dissolve the edge of a 100m plane. Kept
 * at that scale against a 500m world it would hide the entire terrain - the
 * rolling hills and the carved valley would never be visible, which would make
 * most of Step 2.1 invisible. 80-400m shows the hills and the valley clearly
 * while still dissolving the terrain's far edge into the haze, and Step 2.5
 * replaces this linear fog with volumetric ground fog in the stream valley.
 */
export const DEFAULT_FOG_NEAR = 80;
export const DEFAULT_FOG_FAR = 400;

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
  /**
   * Terrain generation parameters. Defaults to the standard 500m world.
   * Passed straight through to `Terrain`, so a smaller `resolution` is the
   * cheap way to build a test world.
   */
  terrain?: {
    /** Side length in metres. */
    size?: number;
    /** Vertices per side. */
    resolution?: number;
    /** World seed. */
    seed?: number;
    /** Octaves of fbm for the rolling hills. */
    octaves?: number;
    /** The stream path the valley is carved along. */
    spline?: StreamSpline;
  };
  /**
   * Stream generation parameters. Defaults to the standard sweep.
   *
   * Pass `moteCount: 0` to build the water without the drifting sprites, and
   * omit `audio` entirely to build it without sound - which is what the tests
   * do, because there is no `AudioContext` in Node.
   */
  stream?: {
    /** The stream path. Defaults to the terrain's own spline. */
    spline?: StreamSpline;
    /** World seed. Defaults to the terrain's. */
    seed?: number;
    /** Number of drifting motes on the surface. */
    moteCount?: number;
    /** Water material overrides. */
    water?: StreamWaterOptions;
    /** Audio overrides. Omit to run silent. */
    audio?: StreamAudioOptions;
  };
}

export class WorldScene {
  readonly terrain: Terrain;
  readonly stream: Stream;
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

    this.terrain = new Terrain({
      size: options.terrain?.size,
      resolution: options.terrain?.resolution,
      seed: options.terrain?.seed,
      octaves: options.terrain?.octaves,
      spline: options.terrain?.spline,
    });
    this.sky = new SkySystem({ horizonColor: DEFAULT_HORIZON_COLOR });
    this.lighting = new LightingSystem();

    // Spawn on the surface, not at a fixed height. On a heightmap a fixed
    // spawn puts the player inside a hill about half the time, and Rapier's
    // resolution of that is a shove in an arbitrary direction - which reads as
    // a bug rather than as terrain.
    const spawnXZ = options.playerSpawn ?? PLAYER_SPAWN;
    const spawn = this.terrain.restHeight(
      spawnXZ.x,
      spawnXZ.z,
      options.playerHeight ?? PLAYER_HEIGHT,
    );

    this.player = new Player({
      physics: this.physics,
      spawn,
      radius: options.playerRadius,
      height: options.playerHeight,
    });

    // The stream is built against the terrain that was just generated, and
    // against the *same* spline: the valley was carved along it, so a stream on
    // any other path would run through uncarved ground and float.
    this.stream = new Stream({
      spline: options.stream?.spline ?? this.terrain.stream,
      heightAt: (x, z) => this.terrain.heightAt(x, z),
      seed: options.stream?.seed ?? options.terrain?.seed,
      moteCount: options.stream?.moteCount,
      water: options.stream?.water,
      audio: options.stream?.audio,
    });

    this.terrain.addTo(this.scene);
    this.stream.addTo(this.scene);
    this.sky.addTo(this.scene);
    this.lighting.addTo(this.scene);
    this.player.addTo(this.scene);

    // Static collision for the ground, built from the terrain mesh's own
    // vertex and index buffers. Using the same numbers as the visual mesh is
    // what makes what the player sees and what the player stands on the same
    // surface - there is no second heightmap to drift out of sync.
    this.physics.createTerrainCollider(this.terrain.collisionData());

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
   *
   * `listener` is where the ears are, which is the camera rather than the
   * player: the stream's sound is placed relative to it. Omit it and the
   * player's own body is used, which is close enough for anything that does not
   * move the camera independently - and is what keeps this callable with one
   * argument, as it always has been.
   */
  update(delta: number, listener?: SplinePoint): void {
    if (this.disposed) return;
    if (!Number.isFinite(delta) || delta < 0) return;

    this.elapsed += delta;
    this.sky.update(delta);
    this.stream.update(delta, listener ?? this.player.position);
    this.player.syncMesh();
  }

  /** Detach everything and release the resources this scene created. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.terrain.removeFrom(this.scene);
    this.stream.removeFrom(this.scene);
    this.sky.removeFrom(this.scene);
    this.lighting.removeFrom(this.scene);
    this.player.removeFrom(this.scene);

    this.scene.fog = null;

    this.terrain.dispose();
    this.stream.dispose();
    this.sky.dispose();
    this.lighting.dispose();
    this.player.dispose();
  }
}
