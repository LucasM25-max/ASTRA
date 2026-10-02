/**
 * BoundarySystem.ts - ASTRA world
 * =============================================================================
 * The edge of the world: four invisible walls, and the field of large rocks
 * that stands against them.
 *
 * Step 2.9's first three tasks, in the plan's words:
 *
 *   - Invisible collision walls at world edges (with soft fog to hide boundary)
 *   - Dense procedural trees/rocks at edges to make boundaries feel natural
 *   - Collision on all trees (cylinder colliders), large rocks
 *
 * The walls are colliders and nothing else
 * ----------------------------------------
 * A wall you can see is a wall the player resents. The terrain is 500 m and the
 * atmosphere's fog is exponential at 0.0052/m, so by the time the eye reaches
 * 250 m out - the edge of the world from the middle - roughly three-quarters of
 * what is there has been absorbed. What survives the fog is the belt's job: a
 * dense ring of trees and boulders means the last thing the player sees before
 * the haze takes over is forest, not a cut edge.
 *
 * The tree belt is not built here
 * -------------------------------
 * It is a rim term in `forestDensityAt`, so the edge trees go through exactly
 * the same placement, LOD tiers, materials and trunk colliders as every other
 * tree in the world. A second belt built here would be a second forest that
 * could drift out of agreement with the first - different LOD distances, a
 * different wind phase, trees popping at a different moment - and the whole
 * point of a boundary is that the player never notices it.
 *
 * What lives here is the part the forest does not already do: the four walls,
 * and the rocks. A rock is not a tree. It does not sway, it needs no LOD tiers,
 * and its collider is a capsule sized to the stone rather than to a trunk.
 * =============================================================================
 */

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Object3D,
} from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { Terrain } from './Terrain';
import { createRng } from '../procedural/NoiseLibrary';
import {
  ROCK_PRESETS,
  ROCK_SHAPES,
  ROCK_VARIANTS,
  generateRock,
  pickRockShape,
  type RockShape,
} from '../procedural/RockGenerator';

/**
 * How far inside the terrain edge the wall stands, in metres.
 *
 * Not zero. A wall exactly on the boundary is reachable only by walking to the
 * last vertex of the terrain, and the player's capsule is a metre wide, so they
 * would be stopped with their nose against nothing at all. Two metres in, the
 * wall is firmly inside ground the player can walk on and there is no gap
 * between the edge of the world and the thing that stops them leaving it.
 */
export const WALL_INSET = 2;

/**
 * How thick each wall is, in metres.
 *
 * Thick enough that a fast player cannot tunnel through it. Rapier's character
 * controller uses speculative contacts, but a capsule in a long fall can still
 * cross a thin static box between steps, and falling out of the world is a
 * worse failure than being stopped by an invisible plane.
 */
export const WALL_THICKNESS = 4;

/**
 * How far below and above the terrain the walls reach, in metres.
 *
 * The rim lift and roughness put the outer edge near +16 m and the lowest point
 * in the world is about -7 m, so a wall from -20 to +60 encloses all of it with
 * room for a jump. The parts above the ridge are invisible against the sky.
 */
const WALL_BELOW = 20;
const WALL_ABOVE = 60;

/** Friction of the walls. Ice would be worse than nothing. */
const WALL_FRICTION = 1.0;

/**
 * How many large rocks the field holds, in total.
 *
 * Costed rather than guessed: every rock is drawn whole regardless of distance,
 * so the field is `DEFAULT_ROCK_COUNT * ROCK_TRIANGLES` triangles at worst. At
 * 44 and 320 that is 14,080 - under 3% of the 500K budget - and it buys a
 * scatter dense enough that the rim reads as scree rather than as a handful of
 * props.
 */
export const DEFAULT_ROCK_COUNT = 44;

/**
 * How far in from a wall the rock density peaks, in metres.
 *
 * Rocks are rejection-sampled against a density that rises towards the rim, so
 * most of them end up in this belt doing boundary work and the rest are
 * scattered through the playable area for their own sake.
 */
const RIM_BELT_WIDTH = 45;

/** How much denser the rim belt is than the open forest. */
const RIM_DENSITY = 3.2;

/** How far from the camera rocks keep a collider, in metres. */
const DEFAULT_ROCK_COLLIDER_RADIUS = 90;

/** Slope above which no rock is placed. `1 - normal.y`. */
const MAX_ROCK_SLOPE = 0.55;

/** How close to the stream centreline no rock is placed, in metres. */
const ROCK_STREAM_MARGIN = 4;

export interface BoundaryOptions {
  /** Total large rocks. Defaults to `DEFAULT_ROCK_COUNT`. */
  rockCount?: number;
  /** How far from the camera rocks keep a collider, in metres. */
  colliderRadius?: number;
  /** Seed for the rock field. Defaults to the terrain's. */
  seed?: number;
}

/** One placed rock. */
export interface RockPlacement {
  shape: RockShape;
  /** Which geometry of the shape this rock uses. */
  variant: number;
  /** World position of the rock's centre. */
  x: number;
  y: number;
  z: number;
  /** Uniform scale. */
  scale: number;
  /** Rotation about +Y, radians. */
  rotation: number;
}

/**
 * The world's edge.
 *
 * Owns the four walls, the rock meshes and the rock colliders. The tree belt is
 * the forest's business - see the file header.
 */
export class BoundarySystem {
  /** The rock meshes. This is what gets added to the scene. */
  readonly group = new Group();

  private readonly physics: PhysicsWorld | null;
  private readonly terrain: Terrain;
  private readonly size: number;
  private readonly seed: number;
  private readonly colliderRadius: number;
  private readonly placements: RockPlacement[] = [];

  /** One InstancedMesh per (shape, variant). */
  private readonly meshes: InstancedMesh[] = [];

  /** Rock colliders currently in the world, keyed by placement index. */
  private readonly colliders = new Map<number, { handle: unknown; body: unknown }>();

  private readonly wallBodies: unknown[] = [];
  private readonly material: MeshStandardMaterial;
  private readonly disposables: { dispose(): void }[] = [];

  /** Where the colliders were last rebuilt for. */
  private lastColliderX = Number.NaN;
  private lastColliderZ = Number.NaN;

  constructor(terrain: Terrain, physics: PhysicsWorld | null, options: BoundaryOptions = {}) {
    this.terrain = terrain;
    this.physics = physics;
    this.size = terrain.sizeMetres;
    this.seed = options.seed ?? terrain.data.seed;
    this.colliderRadius = options.colliderRadius ?? DEFAULT_ROCK_COLLIDER_RADIUS;
    this.group.name = 'boundary';

    this.placements = this.place(options.rockCount ?? DEFAULT_ROCK_COUNT);
    this.material = this.buildMaterial();
    this.buildMeshes();
    this.buildWalls();
    // Colliders exist from the first frame, not from the first update. The
    // forest does the same, and for the same reason: a caller that builds a
    // world and never steps it - a test, a tool, a paused game - must still get
    // a world the player cannot walk out of or through.
    this.lastColliderX = 0;
    this.lastColliderZ = 0;
    this.rebuildColliders(0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* placement                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Rejection-sample the rock field.
   *
   * Density rises towards the rim, so the rocks that do the boundary work are
   * the ones that get placed. A rock is rejected on steep ground and in the
   * stream for the same reasons a tree is: a boulder balanced on a 60-degree
   * slope is not a boulder, it is a bug with a texture.
   *
   * The sampler is `createRng` - mulberry32 - and not a noise field. Simplex
   * output is neither uniform nor independent: walking a counter through it
   * produces a correlated sequence, which rejection-samples into visible
   * stripes rather than a scatter.
   */
  private place(count: number): RockPlacement[] {
    const rng = createRng((this.seed * 7919 + 0x5eed) | 0);
    const half = this.size / 2;
    const out: RockPlacement[] = [];
    // A guard, not a hope: if the density ever rejects everything the loop has
    // to end, and a world that fails to build its rocks is better than a world
    // that hangs.
    const limit = count * 400;

    for (let attempt = 0; attempt < limit && out.length < count; attempt++) {
      const x = (rng() * 2 - 1) * half;
      const z = (rng() * 2 - 1) * half;

      // Distance to the nearest wall, as a fraction of the belt width.
      const edge = Math.min(half - Math.abs(x), half - Math.abs(z));
      const belt = 1 - Math.min(1, Math.max(0, edge) / RIM_BELT_WIDTH);
      // 1 in the open forest, RIM_DENSITY in the belt. Squared so the peak is
      // sharp: a linear ramp spreads the rocks thin across the whole rim.
      const density = 1 + (RIM_DENSITY - 1) * belt * belt;

      if (rng() > density / RIM_DENSITY) continue;

      const normal = this.terrain.normalAt(x, z);
      const slope = 1 - Math.min(1, Math.max(0, normal.y));
      if (slope > MAX_ROCK_SLOPE) continue;

      const nearest = this.terrain.stream.distanceTo({ x, y: 0, z });
      if (nearest.distance < ROCK_STREAM_MARGIN) continue;

      const shape = pickRockShape(rng());
      const preset = ROCK_PRESETS[shape];
      // Rocks scale the way trees do: a little, and never by enough to change
      // which shape it is.
      const scale = 0.75 + rng() * 0.6;

      out.push({
        shape,
        variant: Math.floor(rng() * ROCK_VARIANTS) % ROCK_VARIANTS,
        x,
        // Sink the rock slightly. One resting exactly on the interpolated
        // surface shows a seam of sky under its lowest facet on any slope.
        y: this.terrain.heightAt(x, z) - preset.radius * preset.scale.y * scale * 0.22,
        z,
        scale,
        rotation: rng() * Math.PI * 2,
      });
    }

    return out;
  }

  /* ------------------------------------------------------------------ */
  /* meshes                                                             */
  /* ------------------------------------------------------------------ */

  private buildMaterial(): MeshStandardMaterial {
    // Stone: rough, no metal. Vertex colours carry the shape's own palette and
    // the per-rock tint, so the material decides nothing beyond how the light
    // lands on it.
    const material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
    });
    this.disposables.push(material);
    return material;
  }

  private buildMeshes(): void {
    const capacity = new Map<string, number>();
    for (const rock of this.placements) {
      const key = `${rock.shape}-${rock.variant}`;
      capacity.set(key, (capacity.get(key) ?? 0) + 1);
    }

    for (const shape of ROCK_SHAPES) {
      for (let variant = 0; variant < ROCK_VARIANTS; variant++) {
        const key = `${shape}-${variant}`;
        const count = capacity.get(key) ?? 0;
        // A mesh is still built for an empty bucket, so the field's shape does
        // not change with the seed and nothing downstream has to check.
        const geometry = toGeometry(generateRock(shape, this.seed, variant));
        this.disposables.push(geometry);

        const mesh = new InstancedMesh(geometry, this.material, Math.max(1, count));
        mesh.name = `boundary-rock-${key}`;
        mesh.count = 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // Unlike the forest, the rocks do not follow the camera: their
        // instances never move, so the bounding sphere Three computes from the
        // instance matrices is correct, and culling the mesh is both possible
        // and free. A rock behind the player costs nothing.
        mesh.frustumCulled = true;
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        this.group.add(mesh);
        this.meshes.push(mesh);
      }
    }

    this.writeMatrices();
  }

  /**
   * Write every rock's matrix, once.
   *
   * The rocks are static, so this runs at construction and never again. That is
   * the whole reason the field can be instanced with per-mesh culling: a mesh
   * whose matrices are rewritten every frame has a bounding sphere that is
   * stale the moment it is computed, and Three would either cull wrongly or
   * have to be told not to cull at all - which is what the forest has to do.
   */
  private writeMatrices(): void {
    const used = new Map<InstancedMesh, number>();
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const position = new Vector3();
    const scale = new Vector3();
    const axis = new Vector3(0, 1, 0);

    for (const rock of this.placements) {
      const mesh = this.meshes.find((m) => m.name === `boundary-rock-${rock.shape}-${rock.variant}`);
      if (!mesh) continue;
      const index = used.get(mesh) ?? 0;
      if (index >= mesh.count + 1 && index >= mesh.instanceMatrix.count) continue;
      used.set(mesh, index + 1);

      position.set(rock.x, rock.y, rock.z);
      quaternion.setFromAxisAngle(axis, rock.rotation);
      scale.setScalar(rock.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
    }

    for (const mesh of this.meshes) {
      mesh.count = used.get(mesh) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      // Three only computes this if it is null, and an InstancedMesh's sphere
      // has to take the instance matrices into account. Without it the mesh
      // claims the geometry's own unit sphere at the origin and is culled -
      // or not - for the wrong reason entirely.
      mesh.computeBoundingSphere();
    }
  }

  /* ------------------------------------------------------------------ */
  /* walls                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Four static cuboids, one per side, standing just inside the terrain edge.
   *
   * They are fixed bodies with no mesh, so nothing about them is ever drawn.
   * They exist so that the answer to "what happens if the player keeps walking"
   * is "they stop", rather than "they fall out of the world".
   */
  private buildWalls(): void {
    const physics = this.physics;
    if (!physics) return;

    const half = this.size / 2 - WALL_INSET;
    const halfThickness = WALL_THICKNESS / 2;
    const halfHeight = (WALL_ABOVE + WALL_BELOW) / 2;
    const centreY = (WALL_ABOVE - WALL_BELOW) / 2;

    // Each wall spans the full width of the world plus its own thickness, so
    // the four of them meet at the corners with no diagonal gap for a player
    // to squeeze through. The inner face of each sits at
    // `half - halfThickness`, which is `WALL_INSET` inside the terrain edge.
    const walls = [
      { x: 0, z: -half, hx: half + halfThickness, hz: halfThickness },
      { x: 0, z: half, hx: half + halfThickness, hz: halfThickness },
      { x: -half, z: 0, hx: halfThickness, hz: half + halfThickness },
      { x: half, z: 0, hx: halfThickness, hz: half + halfThickness },
    ];

    for (const wall of walls) {
      this.wallBodies.push(
        physics.createBoxCollider({
          halfExtents: { x: wall.hx, y: halfHeight, z: wall.hz },
          translation: { x: wall.x, y: centreY, z: wall.z },
          friction: WALL_FRICTION,
        }),
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* colliders                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Give the rocks near the camera a collider, and take it away from the rest.
   *
   * The same set difference the forest's trunks use, for the same reason: a
   * collider that is already there and still in range is left alone, so pacing
   * back and forth across the edge of the radius does not churn the broad
   * phase. Forty colliders is few enough that this could run every frame
   * without anyone noticing, but the pattern is the one the forest needs and
   * two different ones in one codebase is how they drift apart.
   */
  private rebuildColliders(cameraX: number, cameraZ: number): void {
    const physics = this.physics;
    if (!physics) return;
    const r2 = this.colliderRadius * this.colliderRadius;

    const wanted = new Set<number>();
    for (let i = 0; i < this.placements.length; i++) {
      const rock = this.placements[i];
      const dx = rock.x - cameraX;
      const dz = rock.z - cameraZ;
      if (dx * dx + dz * dz <= r2) wanted.add(i);
    }

    for (const [index, entry] of this.colliders) {
      if (!wanted.has(index)) {
        physics.removeCollider(entry.handle as never);
        this.colliders.delete(index);
      }
    }

    for (const index of wanted) {
      if (this.colliders.has(index)) continue;
      const rock = this.placements[index];
      const preset = ROCK_PRESETS[rock.shape];
      const radius = preset.colliderRadius * rock.scale;
      const halfHeight = preset.colliderHalfHeight * rock.scale;
      this.colliders.set(index, {
        handle: physics.createTrunkCollider({
          x: rock.x,
          // The capsule's centre, so its lower cap sits at the base of the
          // stone - the same convention the forest's trunks use.
          y: rock.y + radius + halfHeight,
          z: rock.z,
          halfHeight,
          radius,
        }),
        body: null,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* frame                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Called once per frame with the camera's ground position.
   *
   * The rebuild is gated on the camera having moved half the collider radius,
   * so a player pacing the boundary of the ring does not add and remove the
   * same collider on consecutive frames.
   */
  update(cameraX: number, cameraZ: number): void {
    if (!Number.isFinite(cameraX) || !Number.isFinite(cameraZ)) return;
    const dx = cameraX - this.lastColliderX;
    const dz = cameraZ - this.lastColliderZ;
    const threshold = this.colliderRadius * 0.5;
    if (dx * dx + dz * dz < threshold * threshold) return;

    this.lastColliderX = cameraX;
    this.lastColliderZ = cameraZ;
    this.rebuildColliders(cameraX, cameraZ);
  }

  /** How many rock colliders are in the world right now. */
  get colliderCount(): number {
    return this.colliders.size;
  }

  /** How many walls are standing. Four, unless physics was absent. */
  get wallCount(): number {
    return this.wallBodies.length;
  }

  /** How many triangles the whole rock field submits. */
  get triangleCount(): number {
    let total = 0;
    for (const mesh of this.meshes) {
      const index = mesh.geometry.getIndex();
      const per = index ? index.count / 3 : 0;
      total += per * mesh.count;
    }
    return total;
  }

  /** Every rock, for tests and for the debug overlay. */
  get rocks(): readonly RockPlacement[] {
    return this.placements;
  }

  addTo(parent: Object3D): void {
    parent.add(this.group);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.group);
  }

  dispose(): void {
    for (const [, entry] of this.colliders) this.physics?.removeCollider(entry.handle as never);
    this.colliders.clear();
    for (const body of this.wallBodies) {
      // The walls were created through `createBoxCollider`, so they are
      // tracked. Removing the body takes its collider with it.
      this.physics?.world.removeRigidBody(body as never);
    }
    this.wallBodies.length = 0;
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.meshes.length = 0;
    this.group.clear();
  }
}

/** Wrap a rock's MeshData in a geometry, the way the forest does. */
function toGeometry(mesh: {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('color', new BufferAttribute(mesh.colors, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
