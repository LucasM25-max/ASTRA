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
  Group,
  Mesh,
  MeshStandardMaterial,
  type BufferGeometry,
  type Object3D,
} from 'three';
import {
  BIOME_COLORS,
  TERRAIN_SIZE,
  TERRAIN_TILES_PER_SIDE,
  buildTerrainGeometry,
  buildTerrainTiles,
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
export { TERRAIN_SIZE, TERRAIN_RESOLUTION, TERRAIN_TILES_PER_SIDE } from '../procedural/TerrainGenerator';

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
  /**
   * The ground as it is drawn: one mesh per cullable tile, in row-major order.
   *
   * The whole 500 m grid used to be a single mesh. Three culls per mesh
   * against the mesh's bounding sphere, and the terrain's sphere covers the
   * world, so the entire grid was submitted every frame regardless of where
   * the player looked. Split into `TERRAIN_TILES_PER_SIDE^2` tiles, the ones
   * behind and beside the camera are culled as whole objects: 141,376 of
   * 293,378 triangles at the default camera pitch. See
   * `buildTerrainTiles` for why the normals are copied rather than recomputed.
   */
  readonly tiles: Mesh<BufferGeometry, MeshStandardMaterial>[];

  /**
   * The tiles' parent, and the only object added to the scene.
   *
   * A Group rather than a bare list so `addTo`/`removeFrom` stay one call and
   * so the terrain is one named thing in the scene graph.
   */
  readonly group: Group;

  /** The complete surface as one mesh. Not added to the scene. */
  readonly mesh: Mesh<BufferGeometry, MeshStandardMaterial>;

  /** The stream path this terrain's valley was carved along. */
  readonly stream: StreamSpline;

  /** The generated heightmap and everything derived from it. */
  readonly data: TerrainData;

  private readonly size: number;

  /**
   * The collider's arrays, copied out of the master geometry before it was
   * disposed. Rapier reads them once during `createTerrainCollider`; keeping
   * our own copy means the collision surface cannot be invalidated by anything
   * that happens to the geometry afterwards.
   */
  private readonly collision: { vertices: Float32Array; indices: Uint32Array };

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

    // The tiles are sliced from that geometry, so they inherit every vertex
    // attribute and every normal exactly - the culling is invisible. One
    // material is shared by all of them: the terrain's look is driven by
    // uniforms, and one instance means one place to write them.
    this.tiles = buildTerrainTiles(geometry, TERRAIN_TILES_PER_SIDE).map((tileGeometry, i) => {
      const tile = new Mesh(tileGeometry, material);
      tile.name = `terrain-tile-${i}`;
      tile.receiveShadow = true;
      tile.matrixAutoUpdate = false;
      tile.updateMatrix();
      return tile;
    });

    this.group = new Group();
    this.group.name = 'terrain';
    for (const tile of this.tiles) this.group.add(tile);

    // The master grid has done its job. Its arrays live on inside the tiles
    // and inside the collider (which `collisionData` copies out below), so
    // releasing the master's own buffers halves the terrain's memory with no
    // loss - the tiles are the only surviving copy of the geometry.
    this.collision = {
      vertices: new Float32Array(geometry.getAttribute('position').array as Float32Array),
      indices: new Uint32Array(geometry.getIndex()!.array as ArrayLike<number>),
    };
    geometry.dispose();
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

  /**
   * 0..1 corruption at a world position, bilinearly interpolated.
   *
   * Reads the same baked field the terrain shader blends with, so the audio and
   * the visuals agree about where the rot is without either of them having to
   * be told about the other.
   */
  corruptionAt(x: number, z: number): number {
    return this.data.corruptionAt(x, z);
  }

  /**
   * The four terrain biome weights at a world position. They sum to one.
   *
   * This is what a footstep uses to decide what it landed on. It reads the
   * terrain's own weights rather than re-deriving them from height and slope,
   * because a second implementation of the same rules is a second thing that
   * can be wrong - and the visible consequence would be footstep sounds that
   * disagree with the ground the player can see.
   */
  biomeAt(x: number, z: number): { grass: number; dirt: number; rock: number; mud: number } {
    return this.data.biomeAt(x, z);
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
    return {
      vertices: new Float32Array(this.collision.vertices),
      indices: new Uint32Array(this.collision.indices),
    };
  }

  addTo(parent: Object3D): void {
    parent.add(this.group);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.group);
  }

  dispose(): void {
    for (const tile of this.tiles) tile.geometry.dispose();
    this.tiles.length = 0;
    this.group.clear();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
