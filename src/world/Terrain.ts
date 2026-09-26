/**
 * Terrain.ts - ASTRA world
 * =============================================================================
 * The ground the player stands on, and the single seam between the procedural
 * generators and the rest of the game.
 *
 * Step 1.2 put a flat 100m plane here. Step 2.1 replaces it with 500m of
 * displaced FBM noise, a valley carved along the stream, a vertex-painted
 * biome blend and a matching collision surface - but the class keeps the same
 * shape it always had (`mesh`, `sizeMetres`, `normalAt`, `addTo`, `removeFrom`,
 * `dispose`) so that everything above it, from `WorldScene` to the debug
 * overlay, needed no change to survive the swap.
 *
 * What changed, and why it matters
 * --------------------------------
 * `normal` was a constant `(0, 1, 0)` because the ground was flat. On a
 * heightmap that constant is not merely imprecise, it is wrong, and anything
 * that consumed it - footstep orientation, the camera's ground clamp, future
 * slope handling - would have silently ignored every slope in the world. It is
 * now `normalAt(x, z)`, sampled from the height gradient.
 *
 * Ownership: `Terrain` builds the geometry, the material and the data behind
 * them, and `dispose()` releases all three. The collision collider belongs to
 * `PhysicsWorld` and is released with the world.
 * =============================================================================
 */

import {
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  type BufferGeometry,
  type Object3D,
} from 'three';
import {
  BIOME_COLORS,
  TERRAIN_SIZE,
  buildTerrainCollisionData,
  buildTerrainGeometry,
  generateTerrain,
  type TerrainData,
} from '../procedural/TerrainGenerator';
import { createTerrainMaterial } from '../procedural/MaterialFactory';
import { StreamSpline } from '../procedural/StreamSpline';

/**
 * Side length of the playable ground, in metres.
 *
 * Re-exported from the generator so existing imports of `TERRAIN_SIZE` keep
 * working; the generator is now the source of truth.
 */
export { TERRAIN_SIZE, TERRAIN_RESOLUTION } from '../procedural/TerrainGenerator';

/** The dominant biome colour, kept for callers that want "the ground colour". */
export const DEFAULT_GROUND_COLOR = BIOME_COLORS[0];

/** How far above the surface the player capsule's centre rests. */
const SPAWN_CLEARANCE = 0.05;

export interface TerrainOptions {
  /** Side length in metres. Defaults to `TERRAIN_SIZE`. */
  size?: number;
  /** Vertices per side. Defaults to `TERRAIN_RESOLUTION`. */
  resolution?: number;
  /** World seed. Same seed, same terrain. */
  seed?: number;
  /** The stream the valley is carved along. Defaults to the standard sweep. */
  spline?: StreamSpline;
  /** Octaves of fbm for the rolling hills. */
  octaves?: number;
  /** Hill amplitude in metres. Zero gives flat ground - useful for tests. */
  hillAmplitude?: number;
  /** Rim roughness amplitude in metres. */
  rimAmplitude?: number;
  /** Rim lift in metres. */
  rimLift?: number;
  /** Valley depth in metres. */
  valleyDepth?: number;
  /** Valley width in metres. */
  valleyWidth?: number;
  /** How far from the stream still counts as bank. */
  bankWidth?: number;
}

/** What the terrain exposes about a point on its surface. */
export interface TerrainSample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export class Terrain {
  readonly mesh: Mesh<BufferGeometry, MeshStandardMaterial>;

  /** The stream path this terrain's valley was carved along. */
  readonly stream: StreamSpline;

  /** The generated heightmap and everything derived from it. */
  readonly data: TerrainData;

  private readonly size: number;

  constructor(options: TerrainOptions = {}) {
    this.size = options.size ?? TERRAIN_SIZE;

    this.data = generateTerrain({
      size: this.size,
      resolution: options.resolution,
      seed: options.seed,
      spline: options.spline,
      octaves: options.octaves,
      hillAmplitude: options.hillAmplitude,
      rimAmplitude: options.rimAmplitude,
      rimLift: options.rimLift,
      valleyDepth: options.valleyDepth,
      valleyWidth: options.valleyWidth,
      bankWidth: options.bankWidth,
    });
    this.stream = this.data.spline;

    const geometry = buildTerrainGeometry(this.data);
    const material = createTerrainMaterial({ noiseSeed: options.seed ?? 0 });

    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'terrain';

    // The geometry already carries its own rotation (see
    // `buildTerrainGeometry`), so the mesh transform is left at identity.
    // That is deliberate: it keeps the `position` attribute in world
    // coordinates, which is what lets the collider be built from those exact
    // numbers.
    this.mesh.position.set(0, 0, 0);

    // Harmless until shadow maps arrive in Step 2.5, and correct when they do.
    this.mesh.receiveShadow = true;
    // Rendered from both sides so the ground never disappears if the camera
    // dips below it during a jump or a camera-collision pull-in.
    this.mesh.material.side = DoubleSide;
  }

  /** Side length in metres. */
  get sizeMetres(): number {
    return this.size;
  }

  /**
   * Height of the ground at a world position, bilinearly interpolated.
   * Outside the terrain it returns the nearest edge height rather than
   * throwing - the player can walk off the edge, and the systems that ask
   * this question should get an answer, not an exception.
   */
  heightAt(x: number, z: number): number {
    return this.data.heightAt(x, z);
  }

  /** Unit surface normal at a world position. */
  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.data.normalAt(x, z);
  }

  /** 0 = flat, 1 = vertical. */
  slopeAt(x: number, z: number): number {
    return this.data.slopeAt(x, z);
  }

  /** Distance from a world position to the stream, in metres. */
  distanceToStream(x: number, z: number): number {
    return this.stream.distanceTo({ x, y: 0, z }).distance;
  }

  /**
   * A world position resting on the surface, `clearance` above the ground.
   *
   * This is how the player gets spawned: on a heightmap, spawning at a fixed
   * height means spawning inside a hill about half the time, and Rapier's
   * resolution of that is a shove in an arbitrary direction.
   */
  restHeight(x: number, z: number, capsuleHeight: number, clearance = SPAWN_CLEARANCE): TerrainSample {
    return {
      x,
      y: this.heightAt(x, z) + capsuleHeight / 2 + clearance,
      z,
    };
  }

  /**
   * The terrain mesh's own vertex and index buffers, in world coordinates.
   *
   * Handed to `PhysicsWorld.createTerrainCollider` unchanged, which is what
   * makes the collision surface and the visual surface the same surface.
   */
  collisionData(): { vertices: Float32Array; indices: Uint32Array } {
    return buildTerrainCollisionData(this.mesh.geometry);
  }

  addTo(parent: Object3D): void {
    parent.add(this.mesh);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.mesh);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
