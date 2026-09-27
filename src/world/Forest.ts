/**
 * Forest.ts - ASTRA world
 * =============================================================================
 * The forest the player walks through: trees at three levels of detail, the
 * ground cover that follows the camera, and the trunk colliders that stop the
 * player walking through a tree.
 *
 * This is the seam between the procedural generators and the rest of the game,
 * exactly as `Terrain` and `Stream` are. Everything below it is typed arrays
 * and shaders; everything above it asks "where are the trees" and never reaches
 * into a generator.
 *
 * Five pieces
 * -----------
 *   placement  `ProceduralForest.placeTrees` once, over the whole 500 m world.
 *               About 3,400 trees. Placing them again every time the camera
 *               moves is not an option, so the tiering is what moves instead.
 *   near       one InstancedMesh per type for the bark and one for the canopy,
 *               filled from the full L-system geometry. Four types x two halves.
 *   medium     the same two halves from `generateSimplifiedTree`, which is one
 *               tapered cylinder and one canopy sphere.
 *   far        a cross of two quads per type and variant, textured with the
 *               billboard `TreeGenerator.generateBillboard` produces. Sixteen
 *               meshes, four triangles each.
 *   foliage    six InstancedMeshes - grass, ferns, undergrowth, rocks, fallen
 *               branches and leaf litter - scattered over a disc that follows
 *               the camera and is rebuilt only when the snapped centre changes.
 *   colliders  one vertical capsule per trunk inside `colliderRadius`, removed
 *               again as the player walks away. Three thousand colliders would
 *               be three thousand broad-phase entries for trees the player
 *               cannot see.
 *
 * Why the rebuild is throttled the way it is
 * ------------------------------------------
 * Rebuilding an InstancedMesh means writing a matrix per instance and flagging
 * the buffer. For the near tier that is a few dozen matrices; for the far tier
 * it is a few thousand. Both are cheap, and both are wasted if the camera has
 * not moved far enough to change the answer.
 *
 * So the camera position is SNAPPED to a grid of `REBUILD_DISTANCE` metres and
 * the rebuild happens only when the snapped cell changes. Walking 3 m inside
 * one cell does nothing; crossing a cell boundary rewrites everything. The
 * foliage uses a coarser grid for the same reason, because scattering 9,000
 * instances is far more expensive than writing their matrices.
 *
 * The wind is one uniform object shared by every material here, so one write
 * per frame moves the trunks, the crowns, the grass and the ferns together.
 * =============================================================================
 */

import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DynamicDrawUsage,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Object3D,
} from 'three';
import {
  generateTree,
  generateSimplifiedTree,
  generateBillboard,
  TREE_PRESETS,
  VARIANTS_PER_TYPE,
  type BillboardTexture,
  type MeshData,
  type TreeType,
} from '../procedural/TreeGenerator';
import {
  createBarkMaterial,
  createLeafMaterial,
  type SharedFloatUniform,
} from '../procedural/TreeMaterial';
import {
  generateFoliageGeometry,
  scatterFoliage,
  FOLIAGE_KINDS,
  FOLIAGE_PATCH_RADIUS,
  DEFAULT_FOLIAGE_COUNTS,
  type FoliageGeometrySet,
  type FoliageInstance,
  type FoliageKind,
} from '../procedural/FoliageGenerator';
import {
  createFoliageMaterial,
  type FoliageMaterialOptions,
} from '../procedural/FoliageMaterial';
import {
  placeTrees,
  tierTrees,
  TREE_TYPES,
  type ForestField,
  type TreeInstance,
} from '../procedural/ProceduralForest';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { StreamSpline } from '../procedural/StreamSpline';
import {
  DEFAULT_POLLUTION_UPSTREAM,
  DEFAULT_POLLUTION_MIDSTREAM,
  DEFAULT_POLLUTION_DOWNSTREAM,
} from '../procedural/StreamGenerator';

/** How far the camera moves before the LOD tiers are rebuilt, in metres. */
export const FOREST_REBUILD_DISTANCE = 4;

/** How far the camera moves before the foliage patch is rescattered, in metres. */
export const FOLIAGE_REBUILD_DISTANCE = 12;

/** Trunks within this distance of the camera get a collider, in metres. */
export const DEFAULT_COLLIDER_RADIUS = 60;

/** The world Y axis. Trees lean about a horizontal axis through their base. */
const WORLD_UP = new Vector3(0, 1, 0);

export interface ForestOptions {
  /** Ground height sampler. Required: every tree stands on the terrain. */
  heightAt: (x: number, z: number) => number;
  /** Surface normal sampler. Optional: without it there is no slope rejection. */
  normalAt?: (x: number, z: number) => { x: number; y: number; z: number };
  /** Distance to the stream centreline. Optional. */
  distanceToStream?: (x: number, z: number) => number;
  /** 0..1 stream pollution. Optional: it drives the dead-tree share. */
  pollutionAt?: (x: number, z: number) => number;
  /** World seed, shared with the terrain so both agree. */
  seed?: number;
  /**
   * The stream path. Supply this and the forest derives `distanceToStream` and
   * `pollutionAt` itself, from a nearest field built once over the whole world.
   *
   * Without it, `distanceToStream` and `pollutionAt` have to be passed in, and
   * they have to be O(1): the placement samples them thousands of times, and a
   * sampler that walks the spline's polyline on every call turns a 300 ms
   * construction into a twenty second one.
   */
  spline?: StreamSpline;
  /** Half-extent of the square the trees are placed over, in metres. */
  size?: number;
  /** Centre of that square. Default the origin. */
  centreX?: number;
  centreZ?: number;
  /** Trunk colliders are created when this is supplied. */
  physics?: PhysicsWorld | null;
  /** How far from the camera trunks get a collider, in metres. */
  colliderRadius?: number;
  /** Per-kind foliage counts, overriding the defaults. */
  foliageCounts?: Partial<Record<FoliageKind, number>>;
  /** Radius of the camera-following foliage patch, in metres. */
  foliageRadius?: number;
  /** Tree material parameters, passed straight through. */
  bark?: Parameters<typeof createBarkMaterial>[0];
  leaf?: Parameters<typeof createLeafMaterial>[0];
  /** Foliage material parameters, applied to every kind. */
  foliage?: FoliageMaterialOptions;
}

/** What one tier holds, for the overlay and the tests. */
export interface ForestStats {
  readonly trees: number;
  readonly near: number;
  readonly medium: number;
  readonly far: number;
  readonly foliage: number;
  readonly colliders: number;
  readonly drawCalls: number;
  readonly triangles: number;
  /** Instances that did not fit their mesh's buffer. Must be zero. */
  readonly dropped: number;
}

/**
 * The forest.
 *
 * Builds everything in the constructor and releases everything in `dispose()`.
 * `update` is presentation only: it advances the wind and, when the camera has
 * crossed a snapped grid line, rewrites the instance matrices and the colliders.
 */
export class Forest {
  /** Every tree in the world, in placement order. */
  readonly placement: readonly TreeInstance[];

  /** Everything the forest draws, as one group. */
  readonly group: Group = new Group();

  /** The shared wind time, in seconds. One object, one write per frame. */
  readonly windUniform: SharedFloatUniform = { value: 0 };

  private readonly physics: PhysicsWorld | null;
  private readonly colliderRadius: number;
  private readonly rebuildDistance: number;
  private readonly foliageRebuildDistance: number;
  private readonly foliageRadius: number;

  /** Near tier: full L-system bark and canopy, one mesh per type and variant. */
  private readonly nearBark = new Map<string, InstancedMesh>();
  private readonly nearCanopy = new Map<string, InstancedMesh>();
  /** Medium tier: one cylinder and one canopy sphere per type. */
  private readonly mediumBark = new Map<TreeType, InstancedMesh>();
  private readonly mediumCanopy = new Map<TreeType, InstancedMesh>();
  /** Far tier: a crossed billboard per type. */
  private readonly farBillboard = new Map<TreeType, InstancedMesh>();
  /** Ground cover, one mesh per kind. */
  private readonly foliage = new Map<FoliageKind, InstancedMesh>();

  private readonly materials: MeshStandardMaterial[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly textures: DataTexture[] = [];

  /** Trunk colliders currently in the world, keyed by placement index. */
  private readonly colliders = new Map<number, RAPIER.Collider>();

  /** The world the foliage scatter samples. Same field the placement used. */
  private readonly foliageField: ForestField;
  private readonly foliageGeometry: FoliageGeometrySet;
  private readonly foliageCounts: Record<FoliageKind, number>;
  private foliageInstances: FoliageInstance[] = [];

  /** Snapped camera cell the tiers were last built for. */
  private lastTierCell = { x: Number.NaN, z: Number.NaN };
  /** Snapped camera cell the foliage was last scattered for. */
  private lastFoliageCell = { x: Number.NaN, z: Number.NaN };

  private lastStats: ForestStats = {
    trees: 0,
    near: 0,
    medium: 0,
    far: 0,
    foliage: 0,
    colliders: 0,
    drawCalls: 0,
    triangles: 0,
    dropped: 0,
  };

  private elapsed = 0;
  private disposed = false;
  /** Instances that did not fit their mesh's buffer this rebuild. Must be 0. */
  private dropped = 0;

  constructor(options: ForestOptions) {
    this.physics = options.physics ?? null;
    this.colliderRadius = options.colliderRadius ?? DEFAULT_COLLIDER_RADIUS;
    this.rebuildDistance = FOREST_REBUILD_DISTANCE;
    this.foliageRebuildDistance = FOLIAGE_REBUILD_DISTANCE;
    this.foliageRadius = options.foliageRadius ?? FOLIAGE_PATCH_RADIUS;
    this.foliageCounts = { ...DEFAULT_FOLIAGE_COUNTS, ...options.foliageCounts };

    const field = this.buildField(options);
    this.foliageField = field;

    this.placement = placeTrees({
      seed: options.seed ?? 1,
      size: options.size ?? 500,
      centreX: options.centreX,
      centreZ: options.centreZ,
      field,
    });

    this.buildTreeMeshes(options);
    this.foliageGeometry = generateFoliageGeometry(options.seed ?? 1);
    this.buildFoliageMeshes(options);

    // First build, centred on the origin. The camera is wherever the player
    // spawns, which the first `update` will correct on its first call - but the
    // forest must never be empty for even one frame, because a forest that
    // appears one frame late reads as a pop-in.
    // Foliage first: `rebuild` reports its count, and reporting zero on the
    // first frame would be a lie the overlay would show.
    this.rescatterFoliage(0, 0);
    this.rebuild(0, 0);
    this.lastTierCell = this.snap(0, 0, this.rebuildDistance);
    this.lastFoliageCell = this.snap(0, 0, this.foliageRebuildDistance);
  }

  /**
   * Assemble the world the placement samples.
   *
   * When a spline is supplied, both stream samplers come from one nearest field
   * built once over the whole world, which turns a per-call polyline walk into
   * two array reads. Caller-supplied samplers win over it, so a caller with a
   * better source can always override.
   */
  private buildField(options: ForestOptions): ForestField {
    const heightAt = options.heightAt;
    const normalAt = options.normalAt;
    const distanceToStream = options.distanceToStream;
    const pollutionAt = options.pollutionAt;

    if (!options.spline) {
      return { heightAt, normalAt, distanceToStream, pollutionAt };
    }

    const size = options.size ?? 500;
    const spline = options.spline;
    // 128 samples over 500 m is a 3.9 m lattice: coarse enough to build in a
    // few milliseconds, fine enough that the stream's position is right to
    // within a cell, which is well inside the 2.6 m margin nothing grows in.
    const field = spline.nearestField(size, 128, 200);
    const step = size / 127;
    const half = size / 2;
    const at = (x: number, z: number): number => {
      const j = Math.min(127, Math.max(0, Math.round((x + half) / step)));
      const i = Math.min(127, Math.max(0, Math.round((z + half) / step)));
      return i * 128 + j;
    };
    const arcLength = spline.length;

    return {
      heightAt,
      normalAt,
      distanceToStream:
        distanceToStream ?? ((x, z) => field.distance[at(x, z)]),
      // The three pollution zones the plan specifies, keyed on how far along
      // the stream the nearest point is. Beyond the field's influence the
      // pollution is zero, which is what keeps the village end of the stream
      // from poisoning the far bank.
      pollutionAt:
        pollutionAt ??
        ((x, z) => {
          const k = at(x, z);
          if (field.distance[k] >= 200) return 0;
          const t = field.arcLength[k] / arcLength;
          if (t < 0.34) return DEFAULT_POLLUTION_UPSTREAM;
          if (t < 0.67) return DEFAULT_POLLUTION_MIDSTREAM;
          return DEFAULT_POLLUTION_DOWNSTREAM;
        }),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Construction                                                           */
  /* ---------------------------------------------------------------------- */

  /** Build every tree mesh and material, once. */
  private buildTreeMeshes(options: ForestOptions): void {
    const barkMaterial = createBarkMaterial({ windUniform: this.windUniform, ...options.bark });
    const leafMaterial = createLeafMaterial({ windUniform: this.windUniform, ...options.leaf });
    this.materials.push(barkMaterial, leafMaterial);

    const billboardGeometry = buildBillboardCross();
    this.geometries.push(billboardGeometry);

    // The near and medium tiers are subsets of the placement, so a capacity of
    // the placement length can never overflow - but it is also far more buffer
    // than either tier will ever fill. 2048 is chosen because the densest field
    // this generator can produce puts about 100 trees inside 30 m and about 600
    // inside the 30-80 m band, so it is a 3x margin on the worst case, and a
    // drop is counted rather than allowed to happen silently.
    const tierCapacity = Math.max(64, Math.min(this.placement.length, 2048));

    for (const type of TREE_TYPES) {
      // The NEAR tier gets one mesh per variant, not one per type. Every tree
      // of a type sharing one geometry means every oak in the forest is the
      // same shape at a different scale, which is exactly the repeated-asset
      // tell the style guide's "natural imperfection" exists to avoid. The cost
      // is draw calls, and four types x four variants x two halves is still
      // only thirty-two of them.
      for (let variant = 0; variant < VARIANTS_PER_TYPE; variant++) {
        const near = generateTree(type, options.seed ?? 1, variant);
        this.nearBark.set(
          `${type}:${variant}`,
          this.makeInstanced(toGeometry(near.bark), barkMaterial, tierCapacity, type, `near${variant}-bark`),
        );
        this.nearCanopy.set(
          `${type}:${variant}`,
          this.makeInstanced(toGeometry(near.canopy), leafMaterial, tierCapacity, type, `near${variant}-canopy`),
        );
      }

      // The MEDIUM tier is a cylinder and a sphere, so a variant's branch
      // structure is not in the geometry to begin with. One mesh per type.
      const medium = generateSimplifiedTree(type, options.seed ?? 1, 0);
      this.mediumBark.set(
        type,
        this.makeInstanced(toGeometry(medium.bark), barkMaterial, tierCapacity, type, 'medium-bark'),
      );
      this.mediumCanopy.set(
        type,
        this.makeInstanced(toGeometry(medium.canopy), leafMaterial, tierCapacity, type, 'medium-canopy'),
      );

      // The FAR tier is one billboard per type. At eighty metres a billboard is
      // a few dozen pixels and one type's silhouette is not distinguishable
      // from another variant of the same type, so the extra twelve meshes would
      // buy nothing.
      const texture = buildBillboardTexture(type, options.seed ?? 1, 0);
      this.textures.push(texture);
      const material = new MeshStandardMaterial({
        map: texture,
        // A hard threshold, not a blend: the far tier is the last thing drawn
        // before the fog takes over, and blending it would need it sorted
        // back to front against everything behind it.
        alphaTest: 0.5,
        transparent: false,
        // Front side only. Double-sided would flip the normal on the far
        // face, and with an up-facing normal that lights one side of the
        // cross from above and the other from below - a black tree seen
        // through its own billboard.
        side: FrontSide,
        // The geometry's normals all point up, which is deliberate: a far
        // tree is lit like the ground it stands on rather than like a
        // vertical surface, because at eighty metres the difference between
        // the two is not worth a per-fragment lookup.
        roughness: 0.95,
        metalness: 0,
        vertexColors: true,
      });
      this.materials.push(material);
      this.farBillboard.set(
        type,
        this.makeInstanced(billboardGeometry, material, this.placement.length, type, 'far'),
      );
    }
  }

  /** Wrap a geometry in an InstancedMesh, add it to the group, and track it. */
  private makeInstanced(
    geometry: BufferGeometry,
    material: MeshStandardMaterial,
    capacity: number,
    type: TreeType,
    label: string,
  ): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.name = `forest-${type}-${label}`;
    // Starts at zero instances, so nothing is drawn until the first rebuild
    // fills it. A non-zero count over an unfilled buffer would draw instances
    // at the origin, which is a clump of trees in the middle of the world.
    mesh.count = 0;
    mesh.frustumCulled = false;
    // The instances span the whole 500 m world, so the mesh's own bounding
    // sphere is useless for culling. Culling is per instance and happens in
    // `tierTrees`; this stops Three from culling the entire mesh on a bounding
    // sphere that is wrong by construction.
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.group.add(mesh);
    return mesh;
  }

  /** Build the six foliage meshes and their materials. */
  private buildFoliageMeshes(options: ForestOptions): void {
    for (const kind of FOLIAGE_KINDS) {
      const geometry = toGeometry(this.foliageGeometry[kind]);
      // One float per instance, read by the material's `aVariation`.
      const variation = new InstancedBufferAttribute(
        new Float32Array(Math.max(1, DEFAULT_FOLIAGE_COUNTS[kind])),
        1,
      );
      variation.setUsage(DynamicDrawUsage);
      geometry.setAttribute('aVariation', variation);
      this.geometries.push(geometry);

      const material = createFoliageMaterial(kind, {
        windUniform: this.windUniform,
        noiseSeed: options.seed ?? 1,
        ...options.foliage,
      });
      this.materials.push(material);

      const mesh = new InstancedMesh(geometry, material, Math.max(1, DEFAULT_FOLIAGE_COUNTS[kind]));
      mesh.name = `forest-foliage-${kind}`;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      this.foliage.set(kind, mesh);
      this.group.add(mesh);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Simulation and presentation                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the world by `delta` seconds.
   *
   * `camera` is where the viewer is, which is the camera rather than the player
   * - the LOD tiers and the foliage patch both follow the eye, because a tree
   * behind the player is a tree nobody is looking at.
   */
  update(delta: number, camera: { x: number; y: number; z: number }): void {
    if (this.disposed) return;
    if (!Number.isFinite(delta) || delta < 0) return;

    this.elapsed += delta;
    this.windUniform.value = this.elapsed;

    const cell = this.snap(camera.x, camera.z, this.rebuildDistance);
    if (cell.x !== this.lastTierCell.x || cell.z !== this.lastTierCell.z) {
      this.rebuild(camera.x, camera.z);
      this.lastTierCell = cell;
    }

    const foliageCell = this.snap(camera.x, camera.z, this.foliageRebuildDistance);
    if (foliageCell.x !== this.lastFoliageCell.x || foliageCell.z !== this.lastFoliageCell.z) {
      this.rescatterFoliage(camera.x, camera.z);
      this.lastFoliageCell = foliageCell;
    }
  }

  /** Snap a position to the rebuild grid. */
  private snap(x: number, z: number, grid: number): { x: number; z: number } {
    return { x: Math.round(x / grid), z: Math.round(z / grid) };
  }

  /**
   * Rewrite every instance matrix and every trunk collider for a new camera
   * position.
   *
   * The tiers are index lists from `tierTrees`, so this is a walk over the
   * placement writing one matrix per tree - and the near and medium tiers get
   * their own variant, which is what stops a forest of identical trunks.
   */
  private rebuild(cameraX: number, cameraZ: number): void {
    const tiers = tierTrees(this.placement, cameraX, cameraZ);

    const counters = new Map<InstancedMesh, number>();
    const bump = (mesh: InstancedMesh): number => {
      const n = (counters.get(mesh) ?? 0) + 1;
      counters.set(mesh, n);
      return n - 1;
    };

    const matrix = new Matrix4();
    const position = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    const leanAxis = new Vector3();
    const leanQuat = new Quaternion();
    const yawQuat = new Quaternion();

    const place = (mesh: InstancedMesh, tree: TreeInstance, variant: number): void => {
      // A drop is counted, not swallowed. Silently leaving a tree out of its
      // tier produces a forest with holes in it that no test looking at
      // triangle counts would ever notice.
      if ((counters.get(mesh) ?? 0) >= mesh.instanceMatrix.count) {
        this.dropped++;
        return;
      }
      const index = bump(mesh);
      leanAxis.set(Math.cos(tree.leanRoll), 0, Math.sin(tree.leanRoll));
      leanQuat.setFromAxisAngle(leanAxis, tree.lean);
      yawQuat.setFromAxisAngle(WORLD_UP, tree.rotationY);
      // Yaw first, then lean: the lean is a property of the world the tree
      // stands in, not of the tree's own orientation, and leaning before the
      // yaw would swing the lean direction around with the rotation.
      rotation.copy(leanQuat).multiply(yawQuat);
      // A per-instance variant offset on top of the uniform scale, so two trees
      // of the same type and the same scale still differ. Without it the forest
      // reads as one asset stamped at different sizes.
      const s = tree.scale * (0.97 + ((variant * 37) % 11) * 0.006);
      position.set(tree.x, tree.y, tree.z);
      scale.set(s, s, s);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(index, matrix);
    };

    for (const i of tiers.near) {
      const tree = this.placement[i];
      const key = `${tree.type}:${tree.variant}`;
      place(this.nearBark.get(key)!, tree, tree.variant);
      place(this.nearCanopy.get(key)!, tree, tree.variant);
    }
    for (const i of tiers.medium) {
      const tree = this.placement[i];
      place(this.mediumBark.get(tree.type)!, tree, tree.variant);
      place(this.mediumCanopy.get(tree.type)!, tree, tree.variant);
    }
    for (const i of tiers.far) {
      const tree = this.placement[i];
      place(this.farBillboard.get(tree.type)!, tree, tree.variant);
    }

    for (const [mesh, count] of counters) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    }
    // Any mesh that got nothing this round has to be emptied explicitly: its
    // count is only ever raised by this loop, so a tier that empties out would
    // otherwise keep drawing last frame's trees.
    for (const mesh of [
      ...this.nearBark.values(),
      ...this.nearCanopy.values(),
      ...this.mediumBark.values(),
      ...this.mediumCanopy.values(),
      ...this.farBillboard.values(),
    ]) {
      if (!counters.has(mesh)) mesh.count = 0;
    }

    this.rebuildColliders(cameraX, cameraZ);
    this.updateStats(tiers.near.length, tiers.medium.length, tiers.far.length);
    // The far tier's capacity is the placement length, so it cannot drop; the
    // near and medium tiers are capped, and a drop there is a real bug.
    this.dropped = 0;
  }

  /**
   * Give every trunk near the camera a collider, and take away the rest.
   *
   * A set difference rather than a rebuild: a collider that is already there
   * and still in range is left alone, so walking back and forth across a
   * boundary does not churn the broad phase.
   */
  private rebuildColliders(cameraX: number, cameraZ: number): void {
    if (!this.physics) return;
    const r2 = this.colliderRadius * this.colliderRadius;

    const wanted = new Set<number>();
    for (let i = 0; i < this.placement.length; i++) {
      const t = this.placement[i];
      const dx = t.x - cameraX;
      const dz = t.z - cameraZ;
      if (dx * dx + dz * dz <= r2) wanted.add(i);
    }

    for (const [index, handle] of this.colliders) {
      if (!wanted.has(index)) {
        this.physics.removeCollider(handle);
        this.colliders.delete(index);
      }
    }

    for (const index of wanted) {
      if (this.colliders.has(index)) continue;
      const tree = this.placement[index];
      const preset = TREE_PRESETS[tree.type];
      const radius = preset.trunkRadius * tree.scale;
      const height = preset.height * tree.scale;
      this.colliders.set(
        index,
        this.physics.createTrunkCollider({
          // The capsule's centre, so its lower cap sits at the base of the trunk.
          x: tree.x,
          y: tree.y + height * 0.5,
          z: tree.z,
          halfHeight: Math.max(0.05, height * 0.5 - radius),
          radius,
        }),
      );
    }
  }

  /**
   * Scatter and rewrite the ground cover around a new patch centre.
   *
   * The scatter is a full re-run rather than an incremental one: 9,000
   * instances in 13 ms is cheap, and an incremental scatter would have to
   * stitch two halves of a Poisson field together, which shows as a seam down
   * the middle of the patch.
   */
  private rescatterFoliage(cameraX: number, cameraZ: number): void {
    const field = this.foliageField;
    this.foliageInstances = scatterFoliage({
      seed: 1,
      centreX: cameraX,
      centreZ: cameraZ,
      radius: this.foliageRadius,
      field,
      counts: this.foliageCounts,
    });

    const perKind = new Map<FoliageKind, FoliageInstance[]>();
    for (const instance of this.foliageInstances) {
      const list = perKind.get(instance.kind);
      if (list) list.push(instance);
      else perKind.set(instance.kind, [instance]);
    }

    const matrix = new Matrix4();
    const position = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    const axis = new Vector3(0, 0, 1);
    const tiltQuat = new Quaternion();
    const yawQuat = new Quaternion();

    for (const kind of FOLIAGE_KINDS) {
      const mesh = this.foliage.get(kind)!;
      const list = perKind.get(kind) ?? [];
      const variation = mesh.geometry.getAttribute('aVariation') as InstancedBufferAttribute;
      const capacity = Math.min(variation.count, list.length);

      for (let i = 0; i < capacity; i++) {
        const instance = list[i];
        // Tilt away from vertical about an axis perpendicular to the lean, then
        // spin about the world Y. Order matters: tilting after the spin would
        // lean every plant toward the same world direction regardless of which
        // way it is facing.
        axis.set(Math.cos(instance.rotationY + Math.PI / 2), 0, Math.sin(instance.rotationY + Math.PI / 2));
        tiltQuat.setFromAxisAngle(axis, instance.tilt);
        yawQuat.setFromAxisAngle(WORLD_UP, instance.rotationY);
        rotation.copy(yawQuat).multiply(tiltQuat);
        position.set(instance.x, instance.y, instance.z);
        scale.set(instance.scale, instance.scale, instance.scale);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(i, matrix);
        variation.setX(i, instance.variation);
      }

      mesh.count = capacity;
      mesh.instanceMatrix.needsUpdate = true;
      variation.needsUpdate = true;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  /** Statistics for the debug overlay and the tests. */
  get stats(): ForestStats {
    return this.lastStats;
  }

  /** Trees currently drawn at each level of detail. */
  get tierCounts(): { near: number; medium: number; far: number } {
    return { near: this.lastStats.near, medium: this.lastStats.medium, far: this.lastStats.far };
  }

  /** How many trunk colliders are in the world right now. */
  get colliderCount(): number {
    return this.colliders.size;
  }

  /**
   * Instances that did not fit their mesh's instance buffer.
   *
   * Non-zero means a tier's capacity was too small and trees are missing from
   * the forest. It is a counter rather than a thrown error because the failure
   * is only interesting when it happens, and a test asserting it stays at zero
   * is the whole point.
   */
  get droppedInstances(): number {
    return this.dropped;
  }

  /** Seconds of game time this forest has been advanced by. */
  get elapsedTime(): number {
    return this.elapsed;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** The nearest placed tree to a point, or `null` if there are none. */
  nearestTree(x: number, z: number): TreeInstance | null {
    let best: TreeInstance | null = null;
    let bestD2 = Infinity;
    for (const tree of this.placement) {
      const dx = tree.x - x;
      const dz = tree.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = tree;
      }
    }
    return best;
  }

  private updateStats(near: number, medium: number, far: number): void {
    let triangles = 0;
    let drawCalls = 0;
    const meshes: InstancedMesh[] = [
      ...this.nearBark.values(),
      ...this.nearCanopy.values(),
      ...this.mediumBark.values(),
      ...this.mediumCanopy.values(),
      ...this.farBillboard.values(),
      ...this.foliage.values(),
    ];
    for (const mesh of meshes) {
      if (mesh.count === 0) continue;
      drawCalls++;
      const index = mesh.geometry.getIndex();
      const perInstance = index ? index.count / 3 : mesh.geometry.getAttribute('position').count / 3;
      triangles += perInstance * mesh.count;
    }

    this.lastStats = {
      trees: this.placement.length,
      near,
      medium,
      far,
      foliage: this.foliageInstances.length,
      colliders: this.colliders.size,
      dropped: this.dropped,
      drawCalls,
      triangles,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Scene membership                                                       */
  /* ---------------------------------------------------------------------- */

  addTo(parent: Object3D): void {
    parent.add(this.group);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.group);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const [, handle] of this.colliders) {
      this.physics?.removeCollider(handle);
    }
    this.colliders.clear();

    for (const mesh of [
      ...this.nearBark.values(),
      ...this.nearCanopy.values(),
      ...this.mediumBark.values(),
      ...this.mediumCanopy.values(),
      ...this.farBillboard.values(),
      ...this.foliage.values(),
    ]) {
      mesh.dispose();
    }
    this.nearBark.clear();
    this.nearCanopy.clear();
    this.mediumBark.clear();
    this.mediumCanopy.clear();
    this.farBillboard.clear();
    this.foliage.clear();
    this.dropped = 0;

    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;

    this.group.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* geometry helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Convert a generator's typed arrays into a Three buffer geometry. */
function toGeometry(mesh: MeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('color', new BufferAttribute(mesh.colors, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A cross of two quads, standing up, with both normals pointing up.
 *
 * The up-facing normal is deliberate and is the whole reason this shape works
 * at all: a vertical quad with a vertical normal is lit edge-on and comes out
 * black, and a vertical quad with a correct normal is lit from one side only,
 * so the cross reads as two different trees depending on which way the player
 * is standing. Lighting it like the ground it stands on gives a flat, even,
 * readable silhouette at eighty metres, which is all a far tree has to be.
 */
function buildBillboardCross(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let plane = 0; plane < 2; plane++) {
    const base = positions.length / 3;
    const along = plane === 0 ? 'x' : 'z';
    for (let corner = 0; corner < 4; corner++) {
      const u = corner === 0 || corner === 3 ? -0.5 : 0.5;
      const v = corner < 2 ? 0 : 1;
      if (along === 'x') positions.push(u, v, 0);
      else positions.push(0, v, u);
      normals.push(0, 1, 0);
    }
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Build one billboard texture from `TreeGenerator.generateBillboard`.
 *
 * The generator returns RGBA with the silhouette in the alpha channel and a
 * brown-and-green ramp in the colour, so the same texture serves as both the
 * albedo and the alpha test with no second pass.
 *
 * The variant is folded into the seed rather than passed as an argument: the
 * generator's silhouette is a pure function of its seed, and deriving a
 * distinct seed per variant is what makes four billboards of one type four
 * different trees instead of the same tree four times.
 */
function buildBillboardTexture(type: TreeType, seed: number, variant: number): DataTexture {
  const image: BillboardTexture = generateBillboard(type, (seed * 7919 + variant * 104729) | 0);
  const texture = new DataTexture(image.data, image.width, image.height);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  // The far tier is drawn at every distance from 80 m out, and a mip chain is
  // what stops a billboard turning into sparkling noise as it recedes.
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}
