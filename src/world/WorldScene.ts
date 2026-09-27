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

import { DataTexture, Fog, type Scene } from 'three';
import { LightingSystem } from '../renderer/LightingSystem';
import { buildAtmosphereMask } from '../renderer/PostProcessing';
import { Forest, type ForestOptions } from './Forest';
import {
  CorruptionSystem,
  type CorruptionSystemOptions,
} from './CorruptionSystem';
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
/**
 * How far from the water the valley mist is felt, in metres.
 *
 * Wide on purpose. The stream is a valley, not a channel - the ground either
 * side of it is low, and a mist that stopped at the water's edge would read as a
 * rendered plane lying on the surface rather than as air.
 */
export const DEFAULT_FOG_VALLEY_WIDTH = 38;

/** Kept for callers that still read the old linear-fog numbers. */
export const DEFAULT_FOG_NEAR = 80;
export const DEFAULT_FOG_FAR = 400;

/** A touch cooler than the horizon colour, so haze reads as air not fog. */
export const DEFAULT_FOG_COLOR = 0xdfe8ee;

export interface WorldSceneOptions {
  /** The Three scene to populate. Owned by RenderPipeline. */
  scene: Scene;
  /** An initialised physics world. Build it with `PhysicsWorld.create()`. */
  physics: PhysicsWorld;
  /**
   * Unused, and ignored.
   *
   * The render pipeline owns the scene's fog now. With the post chain live the
   * atmosphere pass does the fogging - from the depth buffer, with a height
   * falloff, a valley floor and a corruption tint, none of which a linear
   * distance fog can express - so Three's own linear fog has to be off or every
   * pixel is fogged twice and the horizon comes in at half the distance. With the
   * chain off the pipeline installs a plain linear fog as the fallback.
   *
   * The option is kept so an existing caller does not break at the type level.
   */
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
  /**
   * Forest generation parameters.
   *
   * The forest needs the terrain's height and normal samplers and the stream's
   * spline, and takes both from what was just built - so the only things worth
   * passing here are a different seed and the collider radius. Omit `physics`
   * and the trees are drawn with no colliders at all, which is what a caller
   * without a Rapier world does.
   */
  forest?: {
    /** The stream path the forest reads pollution from. Defaults to the terrain's. */
    spline?: StreamSpline;
    /** World seed. Defaults to the terrain's. */
    seed?: number;
    /** How far from the camera trunks get a collider, in metres. */
    colliderRadius?: number;
    /** Per-kind foliage counts. */
    foliageCounts?: ForestOptions['foliageCounts'];
    /** Radius of the camera-following foliage patch, in metres. */
    foliageRadius?: number;
  };
  /**
   * Corruption parameters. Defaults to the standard rot along the stream.
   *
   * The corruption system needs the terrain's height sampler and the stream's
   * spline, and takes both from what was just built - so the only things worth
   * passing here are a different seed, a smaller patch for a cheap test world,
   * and `sporeCount: 0` for a test that does not want the particles.
   */
  corruption?: {
    /** The stream path the corruption field is built over. Defaults to the terrain's. */
    spline?: StreamSpline;
    /** World seed. Defaults to the terrain's. */
    seed?: number;
    /** Radius of the camera-following fungus patch, in metres. */
    patchRadius?: number;
    /** Triangles the ground fungus may cost per patch. */
    triangleBudget?: number;
    /** Per-kind instance counts, overriding the budget-derived defaults. */
    counts?: CorruptionSystemOptions['counts'];
    /** Number of drifting spores. Zero disables them entirely. */
    sporeCount?: number;
    /** Radius of the disc the spores drift in, in metres. */
    sporeRadius?: number;
    /** The light that comes off the rot. Pass `intensity: 0` to disable it. */
    light?: { intensity?: number; color?: number; distance?: number };
  };
}

export class WorldScene {
  readonly terrain: Terrain;
  readonly stream: Stream;
  readonly forest: Forest;
  readonly corruption: CorruptionSystem;
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

    // The forest is placed against the terrain and the stream that were just
    // built, and against the *same* spline: the dead-tree share comes from the
    // stream's pollution, and a forest placed against any other path would put
    // its corruption somewhere else entirely.
    this.forest = new Forest({
      heightAt: (x, z) => this.terrain.heightAt(x, z),
      normalAt: (x, z) => this.terrain.normalAt(x, z),
      spline: options.forest?.spline ?? this.terrain.stream,
      seed: options.forest?.seed ?? options.terrain?.seed,
      size: options.terrain?.size,
      physics: this.physics,
      colliderRadius: options.forest?.colliderRadius,
      foliageCounts: options.forest?.foliageCounts,
      foliageRadius: options.forest?.foliageRadius,
    });

    // The corruption is built last of the three that grow out of the terrain,
    // because it needs the terrain's samplers and the stream's path and adds
    // nothing either of them depends on.
    this.corruption = new CorruptionSystem({
      heightAt: (x, z) => this.terrain.heightAt(x, z),
      normalAt: (x, z) => this.terrain.normalAt(x, z),
      spline: options.corruption?.spline ?? this.terrain.stream,
      seed: options.corruption?.seed ?? options.terrain?.seed,
      patchRadius: options.corruption?.patchRadius,
      triangleBudget: options.corruption?.triangleBudget,
      counts: options.corruption?.counts,
      sporeCount: options.corruption?.sporeCount,
      sporeRadius: options.corruption?.sporeRadius,
      light: options.corruption?.light,
      // Spores drift downstream. The direction comes from the spline's tangent
      // at the nearest point, which is a polyline scan - and it is sampled once
      // per spore re-homing, which happens every twenty metres of walking, so
      // the scan is a rounding error rather than a per-frame cost.
      flowAt: (x, z) => {
        const nearest = this.terrain.stream.distanceTo({ x, y: 0, z });
        return this.terrain.stream.tangentAtDistance(nearest.arcLength);
      },
    });

    // The rot's light flickers. The baseline is read live from the corruption
    // system rather than captured once, so the glow keeps fading in and out with
    // the corruption underfoot while it flickers - two systems modulating one
    // quantity through two different fields, rather than fighting over one.
    this.lighting.flicker(this.corruption.light, {
      baseline: () => this.corruption.currentGlowIntensity,
      // Slow and shallow. A fast, deep flicker reads as a broken bulb; the rot's
      // glow should breathe, not strobe.
      rate: 1.7,
      secondary: 4.3,
      depth: 0.22,
    });

    this.terrain.addTo(this.scene);
    this.stream.addTo(this.scene);
    this.forest.addTo(this.scene);
    this.corruption.addTo(this.scene);
    this.sky.addTo(this.scene);
    this.lighting.addTo(this.scene);
    this.player.addTo(this.scene);

    // Static collision for the ground, built from the terrain mesh's own
    // vertex and index buffers. Using the same numbers as the visual mesh is
    // what makes what the player sees and what the player stands on the same
    // surface - there is no second heightmap to drift out of sync.
    this.physics.createTerrainCollider(this.terrain.collisionData());

    // No fog here - see the `fog` option above. The render pipeline owns it.
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
    // The light rig runs on the listener, not the player: the shadow box has to
    // sit under the camera, and the camera is what the player actually looks
    // through. Passing the player instead would leave the shadows a third-person
    // arm's length behind the view.
    const focus = listener ?? this.player.position;
    this.lighting.followShadowFocus(focus.x, focus.z, this.terrain.heightAt(focus.x, focus.z));
    this.lighting.update(delta);
    this.stream.update(delta, focus);
    this.forest.update(delta, focus);
    this.corruption.update(delta, focus);
    this.player.syncMesh();
  }

  /**
   * The atmosphere pass's top-down mask: R valley density, G corruption.
   *
   * Both channels come from the same walk over the world, so the mist that pools
   * in the stream bed and the mist that goes green in the rot are exactly
   * co-located - which matters, because the corruption is strongest in the valley
   * and two masks from different lattices would visibly disagree about where the
   * foul air is.
   *
   * This is a method rather than something built in the constructor because the
   * render pipeline is constructed before the world exists. `main.ts` calls it
   * straight after building the scene.
   */
  buildAtmosphereMask(resolution = 256): DataTexture {
    const stream = this.terrain.stream;
    return buildAtmosphereMask(
      (x, z) => ({
        distance: stream.distanceTo({ x, y: 0, z }).distance,
        // `intensityAt` is the corruption system's own clamped answer, so the
        // mist goes green exactly where the fungus does.
        corruption: this.corruption.intensityAt(x, z),
      }),
      { size: this.terrain.sizeMetres, resolution, valleyWidth: DEFAULT_FOG_VALLEY_WIDTH },
    );
  }

  /** Detach everything and release the resources this scene created. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.terrain.removeFrom(this.scene);
    this.stream.removeFrom(this.scene);
    this.forest.removeFrom(this.scene);
    this.corruption.removeFrom(this.scene);
    this.sky.removeFrom(this.scene);
    this.lighting.removeFrom(this.scene);
    this.player.removeFrom(this.scene);

    this.scene.fog = null;

    this.terrain.dispose();
    this.stream.dispose();
    this.forest.dispose();
    this.corruption.dispose();
    this.sky.dispose();
    this.lighting.dispose();
    this.player.dispose();
  }
}
