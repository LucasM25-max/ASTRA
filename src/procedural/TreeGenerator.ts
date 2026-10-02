/**
 * TreeGenerator.ts - ASTRA procedural world
 * =============================================================================
 * Trees, built from code. Nothing here imports Three.js: the output is typed
 * arrays (`MeshData`), exactly like `TerrainGenerator`, so the whole thing runs
 * in Node and can be asserted on without a GPU.
 *
 * What the plan asks for, and where it lives
 * ------------------------------------------
 *   L-system branching      `grow()` below. A stochastic context-free rewrite
 *                           with 3-4 iterations, so a trunk becomes a small
 *                           tree and not a stick with leaves on it.
 *   tapered cylinders       `appendBranch()`. Every segment is a cylinder that
 *                           narrows from its base radius to its tip radius,
 *                           with its vertices pushed along the radial
 *                           direction by noise so no two sides match.
 *   noise displacement      one `SimplexNoise2D` per tree, sampled in (arc
 *                           length, angle) space so the displacement runs
 *                           *along* a branch rather than across the mesh's
 *                           arbitrary UV layout.
 *   canopy                  `appendCluster()`: a handful of subdivided
 *                           icosahedrons scattered inside a sphere, each one
 *                           displaced by noise. Icospheres rather than UV
 *                           spheres because a UV sphere poles into visible
 *                           seams at the top and bottom of every blob.
 *   four tree types         `TREE_PRESETS`, which is only L-system parameters.
 *                           Oak, deciduous, sapling and dead differ by
 *                           iteration count, spread, trunk radius, canopy
 *                           radius and colour - not by code path.
 *
 * Why one geometry per variant rather than per tree
 * -------------------------------------------------
 * A forest of ~3,500 trees cannot carry 3,500 unique geometries. Instead
 * `VARIANTS_PER_TYPE` distinct geometries are generated per type and the
 * instances are spread across them, so the eye sees several different trees
 * of each kind while the GPU sees one draw call per (type, variant, LOD).
 *
 * Cost
 * ----
 * A near-LOD oak is ~150 branch segments at 6 radial divisions plus ~20 canopy
 * blobs: roughly 2,000 triangles. That is only ever drawn for trees inside
 * `LOD_NEAR` metres of the camera, which is a couple of dozen at a time. The
 * medium LOD is one cylinder and one icosphere; the far LOD is a textured
 * cross of two quads. See `ProceduralForest`.
 * =============================================================================
 */

import { SimplexNoise2D, createRng } from './NoiseLibrary';

/** The four tree types the plan names, each a different set of parameters. */
export type TreeType = 'oak' | 'deciduous' | 'sapling' | 'dead';

/** A triangle mesh as flat typed arrays, ready for a `BufferGeometry`. */
export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array;
  /** xyz per vertex, unit length. */
  normals: Float32Array;
  /** rgb per vertex, 0..1. Multiplied into the material's own colour. */
  colors: Float32Array;
  /** Triangle corners, three per face. */
  indices: Uint32Array;
}

/** The two halves of a tree, because they take different materials. */
export interface TreeGeometry {
  /** Trunk and branches: bark. */
  bark: MeshData;
  /** Canopy clusters: leaves. */
  canopy: MeshData;
}

/** L-system and canopy parameters. One preset per tree type. */
export interface TreePreset {
  /** Rewrite depth. The plan asks for 3-4. */
  iterations: number;
  /** Trunk length in metres, before the lean. */
  trunkLength: number;
  /** Trunk radius at the base, in metres. */
  trunkRadius: number;
  /** Child length as a fraction of its parent's. */
  lengthFalloff: number;
  /** Child base radius as a fraction of its parent's. */
  radiusFalloff: number;
  /** Main limbs the trunk splits into. Wider spread than `children`. */
  mainLimbs: number;
  /** Branches per tip above the first split. */
  children: number;
  /**
   * Angle a child branch leaves its parent at, in radians: 0 keeps growing
   * straight up the parent axis, PI/2 leaves it horizontal. A wide-spread oak
   * therefore wants a large number and an upright sapling a small one.
   */
  spread: number;
  /** Rotation around the parent axis between siblings, radians. */
  roll: number;
  /** Chance a tip also continues straight on, 0 to 1. */
  continuation: number;
  /** How hard children are pulled back toward +Y, 0 to 1. */
  upBias: number;
  /** Trunk lean away from vertical, radians. */
  lean: number;
  /** Radius of the sphere the canopy clusters are scattered in, metres. */
  canopyRadius: number;
  /** Icospheres per cluster. */
  canopyBlobs: number;
  /** Radius of one blob, metres. */
  blobRadius: number;
  /** Subdivisions per icosphere. 1 is 80 faces, 2 is 320. */
  blobDetail: number;
  /** How far noise pushes a branch vertex, as a fraction of its radius. */
  branchWarp: number;
  /** How far noise pushes a canopy vertex, as a fraction of blob radius. */
  canopyWarp: number;
  /** Height of the whole tree, metres. Used for the LOD and the collider. */
  height: number;
  /** Radius of the trunk collider at the base, metres. */
  colliderRadius: number;
}

/**
 * The four presets.
 *
 * The counts the plan attaches to them (oaks 6-10, deciduous 30-50, saplings
 * 50-100 per area) are *placement* numbers and live in `ProceduralForest`;
 * these are the shape numbers.
 */
export const TREE_PRESETS: Record<TreeType, TreePreset> = {
  oak: {
    iterations: 4,
    mainLimbs: 3,
    trunkLength: 2.2,
    trunkRadius: 0.42,
    lengthFalloff: 0.74,
    radiusFalloff: 0.66,
    children: 2,
    spread: 1.25,
    roll: 2.399963,
    continuation: 0.5,
    upBias: 0.55,
    lean: 0.06,
    canopyRadius: 3.1,
    canopyBlobs: 7,
    blobRadius: 1.15,
    blobDetail: 2,
    branchWarp: 0.16,
    canopyWarp: 0.22,
    height: 10.1,
    colliderRadius: 0.42,
  },
  deciduous: {
    iterations: 4,
    mainLimbs: 3,
    trunkLength: 1.75,
    trunkRadius: 0.22,
    lengthFalloff: 0.72,
    radiusFalloff: 0.62,
    children: 3,
    spread: 1.15,
    roll: 2.094395,
    continuation: 0.4,
    upBias: 0.62,
    lean: 0.09,
    canopyRadius: 2.2,
    canopyBlobs: 5,
    blobRadius: 0.82,
    blobDetail: 2,
    branchWarp: 0.18,
    canopyWarp: 0.24,
    height: 7.5,
    colliderRadius: 0.24,
  },
  sapling: {
    iterations: 3,
    mainLimbs: 2,
    trunkLength: 1.0,
    trunkRadius: 0.075,
    lengthFalloff: 0.7,
    radiusFalloff: 0.6,
    children: 2,
    spread: 0.78,
    roll: 1.570796,
    continuation: 0.15,
    upBias: 0.7,
    lean: 0.12,
    canopyRadius: 0.85,
    canopyBlobs: 3,
    blobRadius: 0.42,
    blobDetail: 1,
    branchWarp: 0.2,
    canopyWarp: 0.26,
    height: 3.3,
    colliderRadius: 0.09,
  },
  dead: {
    // A dead tree is a deciduous tree that stopped caring: same skeleton, one
    // fewer blob of canopy, no leaves on the lower branches, grey wood and a
    // few fungal clusters where the branches fork.
    iterations: 3,
    mainLimbs: 2,
    trunkLength: 1.65,
    trunkRadius: 0.19,
    lengthFalloff: 0.78,
    radiusFalloff: 0.64,
    children: 2,
    spread: 1.35,
    roll: 1.884956,
    continuation: 0.5,
    upBias: 0.25,
    lean: 0.16,
    canopyRadius: 1.1,
    canopyBlobs: 2,
    blobRadius: 0.5,
    blobDetail: 2,
    branchWarp: 0.24,
    canopyWarp: 0.3,
    height: 5.6,
    colliderRadius: 0.2,
  },
};

/** Radial divisions around a branch. Six reads as round and costs 12 tris. */
const BRANCH_RADIAL_SEGMENTS = 6;

/**
 * Rings along a branch, including both ends.
 *
 * Two, not three. A branch is a straight tapered tube - `appendBranch` puts
 * every ring on the line `base + dir * length * t` and perturbs only the
 * radius - so the curve of a tree comes from chaining child branches, never
 * from bending inside one. The third ring therefore bought exactly one extra
 * sample of the radius noise along a tube a few centimetres across, thirty
 * metres from the camera, at the cost of a second band of quads: 30 triangles
 * per branch instead of 18.
 *
 * That difference is the near LOD's whole budget. A tree runs to the 140
 * segment ceiling, so the bark was 4,200 triangles and a deciduous tree 5,800
 * all told; a forest holds ~59 of them inside the 30 m near radius, which is
 * 342,000 triangles - most of a 500K frame on wood. At two rings the same
 * tree, with the same branches in the same places at the same lengths and
 * radii, costs 2,520 and the near tier comes in around 105,000. No silhouette
 * changes: what a tree looks like against the sky is decided by where its
 * branches are, and none of that moved.
 */
const BRANCH_RINGS = 2;

/** No branch points more than this far below horizontal. */
const MIN_BRANCH_DROP = -0.12;

/**
 * Hard ceiling on branch segments per tree.
 *
 * A stochastic rewrite with 3 children and a 0.45 continuation chance has an
 * expected 3.45 children per node, so four iterations is ~150 segments - but
 * the variance is enormous and the tail runs to several hundred. The ceiling
 * keeps the worst case bounded and the vertex budget predictable; a tree that
 * hits it simply stops branching, which reads as a windsnipped tree.
 */
export const MAX_BRANCH_SEGMENTS = 140;

/** How many distinct geometries are generated per tree type. */
export const VARIANTS_PER_TYPE = 4;

/** Grey, for dead wood. Multiplied under the bark material's colour ramp. */
const DEAD_BARK_COLOR: [number, number, number] = [0.5, 0.49, 0.47];

/** Sickly green-purple, for the fungal clusters on a dead tree. */
const FUNGUS_COLOR: [number, number, number] = [0.42, 0.5, 0.32];

/** Vertex colour for living bark: white, so the material's ramp shows through. */
const LIVING_BARK_COLOR: [number, number, number] = [1, 1, 1];

/**
 * A growable triangle mesh.
 *
 * Positions, normals and colours are pushed into plain arrays and packed once
 * at the end. That is deliberately not an optimisation: it keeps `appendBranch`
 * free to emit vertices in whatever order is convenient, and it means a tree is
 * one allocation per buffer rather than one per segment.
 */
class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Push one vertex. */
  vertex(x: number, y: number, z: number, r: number, g: number, b: number): number {
    this.positions.push(x, y, z);
    this.colors.push(r, g, b);
    return this.vertexCount - 1;
  }

  /** Push one triangle from vertex indices. */
  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** Smooth vertex normals, averaged over every face that touches a vertex. */
  build(): MeshData {
    const count = this.vertexCount;
    const positions = new Float32Array(this.positions);
    const normals = new Float32Array(count * 3);

    for (let i = 0; i < this.indices.length; i += 3) {
      const a = this.indices[i] * 3;
      const b = this.indices[i + 1] * 3;
      const c = this.indices[i + 2] * 3;

      const e1x = positions[b] - positions[a];
      const e1y = positions[b + 1] - positions[a + 1];
      const e1z = positions[b + 2] - positions[a + 2];
      const e2x = positions[c] - positions[a];
      const e2y = positions[c + 1] - positions[a + 1];
      const e2z = positions[c + 2] - positions[a + 2];

      // Cross product, not normalized: the area weighting is what makes the
      // average correct, and normalizing here would give every face equal say.
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;

      normals[a] += nx;
      normals[a + 1] += ny;
      normals[a + 2] += nz;
      normals[b] += nx;
      normals[b + 1] += ny;
      normals[b + 2] += nz;
      normals[c] += nx;
      normals[c + 1] += ny;
      normals[c + 2] += nz;
    }

    for (let i = 0; i < normals.length; i += 3) {
      const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
      // A vertex no face touches, or one whose faces cancel, has no normal.
      // Substituting a unit vector there would be a silent lie; leaving it at
      // zero lets the shader's fallback handle it.
      if (len > 1e-9) {
        normals[i] /= len;
        normals[i + 1] /= len;
        normals[i + 2] /= len;
      }
    }

    return {
      positions,
      normals,
      colors: new Float32Array(this.colors),
      indices: new Uint32Array(this.indices),
    };
  }
}

/** Unit vector along +Y. The bias every branch is pulled toward. */
const UP = { x: 0, y: 1, z: 0 };

/** Any unit vector perpendicular to `d`. */
function perpendicular(d: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  // Pick the axis least aligned with d, so the cross product is well
  // conditioned. Crossing with the near-parallel axis is the classic way to
  // get a garbage perpendicular from rounding.
  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);
  let helper = { x: 1, y: 0, z: 0 };
  if (ay <= ax && ay <= az) helper = { x: 0, y: 1, z: 0 };
  else if (az <= ax && az <= ay) helper = { x: 0, y: 0, z: 1 };

  const x = d.y * helper.z - d.z * helper.y;
  const y = d.z * helper.x - d.x * helper.z;
  const z = d.x * helper.y - d.y * helper.x;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

/** Rotate `v` around unit `axis` by `angle` radians (Rodrigues). */
function rotateAround(
  v: { x: number; y: number; z: number },
  axis: { x: number; y: number; z: number },
  angle: number,
): { x: number; y: number; z: number } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = v.x * axis.x + v.y * axis.y + v.z * axis.z;
  const cx = axis.y * v.z - axis.z * v.y;
  const cy = axis.z * v.x - axis.x * v.z;
  const cz = axis.x * v.y - axis.y * v.x;
  return {
    x: v.x * c + cx * s + axis.x * dot * (1 - c),
    y: v.y * c + cy * s + axis.y * dot * (1 - c),
    z: v.z * c + cz * s + axis.z * dot * (1 - c),
  };
}

/** Normalize, leaving a zero vector alone rather than producing NaN. */
function normalize(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Append a tapered cylinder from `base` along `dir`.
 *
 * The taper is linear in the ring parameter, and the warp is sampled in
 * (arc length, angle) so it runs along the branch. Sampling in (x, y, z)
 * instead would make the warp change wherever the branch happens to point,
 * which shows up as a seam that slides when the tree leans.
 */
function appendBranch(
  mesh: MeshBuilder,
  base: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  length: number,
  radiusBase: number,
  radiusTip: number,
  warp: number,
  noise: SimplexNoise2D,
  color: [number, number, number],
): void {
  const u = perpendicular(dir);
  const v = {
    x: dir.y * u.z - dir.z * u.y,
    y: dir.z * u.x - dir.x * u.z,
    z: dir.x * u.y - dir.y * u.x,
  };

  const rings = BRANCH_RINGS;
  const radial = BRANCH_RADIAL_SEGMENTS;
  // One row of vertex indices per ring, so the quad loop can find its corners.
  const grid: number[][] = [];

  for (let ring = 0; ring < rings; ring++) {
    const t = ring / (rings - 1);
    const radius = radiusBase + (radiusTip - radiusBase) * t;
    const centre = {
      x: base.x + dir.x * length * t,
      y: base.y + dir.y * length * t,
      z: base.z + dir.z * length * t,
    };
    const row: number[] = [];

    for (let s = 0; s < radial; s++) {
      const angle = (s / radial) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      // Radial direction at this vertex, before the warp.
      const rx = u.x * cos + v.x * sin;
      const ry = u.y * cos + v.y * sin;
      const rz = u.z * cos + v.z * sin;

      const w =
        noise.noise(centre.y * 1.7 + angle * 0.6, centre.x * 1.7 + centre.z * 1.7) * warp;
      const r = Math.max(radius * 0.25, radius + w * radius);

      row.push(
        mesh.vertex(
          centre.x + rx * r,
          centre.y + ry * r,
          centre.z + rz * r,
          color[0],
          color[1],
          color[2],
        ),
      );
    }
    grid.push(row);
  }

  for (let ring = 0; ring < rings - 1; ring++) {
    for (let s = 0; s < radial; s++) {
      const s1 = (s + 1) % radial;
      const a = grid[ring][s];
      const b = grid[ring][s1];
      const c = grid[ring + 1][s];
      const d = grid[ring + 1][s1];
      // Wound so the face normal points outward from the branch axis. Getting
      // this backwards is invisible in a bounding box and in a triangle count,
      // and lights the whole tree from the inside.
      mesh.triangle(a, b, c);
      mesh.triangle(b, d, c);
    }
  }

  // Cap the tip. The base is buried inside its parent, so it is left open:
  // capping it would put a disc of vertices inside the trunk where nothing can
  // see them, and every one of them costs a normal computation.
  const tipRing = grid[rings - 1];
  const tipCentre = {
    x: base.x + dir.x * length,
    y: base.y + dir.y * length,
    z: base.z + dir.z * length,
  };
  const tipIndex = mesh.vertex(
    tipCentre.x,
    tipCentre.y,
    tipCentre.z,
    color[0],
    color[1],
    color[2],
  );
  for (let s = 0; s < radial; s++) {
    mesh.triangle(tipRing[s], tipRing[(s + 1) % radial], tipIndex);
  }
}

/** The 12 corners of a unit icosahedron. */
const ICO_VERTICES: ReadonlyArray<readonly [number, number, number]> = [
  [-1, 1.618034, 0],
  [1, 1.618034, 0],
  [-1, -1.618034, 0],
  [1, -1.618034, 0],
  [0, -1, 1.618034],
  [0, 1, 1.618034],
  [0, -1, -1.618034],
  [0, 1, -1.618034],
  [1.618034, 0, -1],
  [1.618034, 0, 1],
  [-1.618034, 0, -1],
  [-1.618034, 0, 1],
];

/** The 20 faces of a unit icosahedron, as corner triples. */
const ICO_FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

/**
 * Append a subdivided, noise-displaced icosphere.
 *
 * Subdivision projects every new corner onto the unit sphere before
 * normalizing, so the result stays spherical instead of developing the flat
 * facets a naive midpoint split produces.
 */
function appendIcosphere(
  mesh: MeshBuilder,
  centre: { x: number; y: number; z: number },
  radius: number,
  detail: number,
  warp: number,
  noise: SimplexNoise2D,
  color: [number, number, number],
  colorTip: [number, number, number] | null,
): void {
  // Normalized up front: the raw icosahedron above is written with a golden
  // ratio edge, not a unit edge, and every later step assumes unit length.
  let corners: Array<[number, number, number]> = ICO_VERTICES.map((v) => {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  });
  let faces: Array<[number, number, number]> = ICO_FACES.map((f) => [f[0], f[1], f[2]]);

  for (let d = 0; d < detail; d++) {
    // Midpoints must be CACHED per edge and the old corners must be KEPT. An
    // uncached midpoint is created once per adjacent face, so two halves of a
    // shared edge end up as two different vertices and the sphere stops being
    // a sphere. A dropped corner array points the new faces at the midpoints
    // of the previous level instead of at the corners they were named after.
    const next: Array<[number, number, number]> = corners.map((c) => [c[0], c[1], c[2]]);
    const nextFaces: Array<[number, number, number]> = [];
    const cache = new Map<number, number>();
    const mid = (p: number, q: number): number => {
      const key = Math.min(p, q) * 100000 + Math.max(p, q);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const pa = corners[p];
      const qa = corners[q];
      const x = (pa[0] + qa[0]) / 2;
      const y = (pa[1] + qa[1]) / 2;
      const z = (pa[2] + qa[2]) / 2;
      const len = Math.hypot(x, y, z) || 1;
      next.push([x / len, y / len, z / len]);
      cache.set(key, next.length - 1);
      return next.length - 1;
    };
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      nextFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    corners = next;
    faces = nextFaces;
  }

  // The blob's vertices are appended to a mesh that already holds everything
  // drawn before it, so its base index is the mesh's vertex count, NOT the
  // blob's own corner count. Using the corner count points every blob after
  // the first at vertices belonging to an earlier blob, which is invisible
  // until the normals come out NaN and the edge counts come out above two.
  const base = mesh.vertexCount;
  for (const [x, y, z] of corners) {
    // Sampled on the blob's own surface, so two blobs at different centres
    // warp differently instead of all sharing one lumpy template.
    const wx = centre.x * 0.8 + x * 2.2 + y * 0.6;
    const wz = centre.z * 0.8 + z * 2.2 + y * 1.1;
    const w = noise.noise(wx, wz) * warp;
    const r = Math.max(radius * 0.3, radius * (1 + w));
    const t = Math.max(0, Math.min(1, (y + 1) / 2));
    const cr = color[0] + (colorTip ? (colorTip[0] - color[0]) * t : 0);
    const cg = color[1] + (colorTip ? (colorTip[1] - color[1]) * t : 0);
    const cb = color[2] + (colorTip ? (colorTip[2] - color[2]) * t : 0);
    mesh.vertex(centre.x + x * r, centre.y + y * r, centre.z + z * r, cr, cg, cb);
  }

  for (const [a, b, c] of faces) {
    mesh.triangle(base + a, base + b, base + c);
  }
}

/**
 * Where the crown sits: the centroid of the top third of the branch tips,
 * lifted a little so the blobs straddle the ends rather than starting at them.
 */
function canopyAnchor(
  tips: ReadonlyArray<{ x: number; y: number; z: number }>,
  preset: TreePreset,
): { x: number; y: number; z: number } {
  if (tips.length === 0) {
    return { x: 0, y: preset.trunkLength, z: 0 };
  }
  const sorted = [...tips].sort((a, b) => b.y - a.y);
  const take = Math.max(1, Math.ceil(sorted.length / 3));
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < take; i++) {
    x += sorted[i].x;
    y += sorted[i].y;
    z += sorted[i].z;
  }
  return { x: x / take, y: y / take + preset.canopyRadius * 0.3, z: z / take };
}

/** A scattered cluster of canopy blobs. */
function appendCluster(
  mesh: MeshBuilder,
  centre: { x: number; y: number; z: number },
  radius: number,
  blobs: number,
  blobRadius: number,
  detail: number,
  warp: number,
  noise: SimplexNoise2D,
  rng: () => number,
  colorLow: [number, number, number],
  colorHigh: [number, number, number],
): void {
  for (let i = 0; i < blobs; i++) {
    // Rejection-free: sample a direction, then a radius, then squash toward a
    // sphere. The cube-root is what makes the distribution uniform in volume
    // rather than clustered at the centre the way radius^2 sampling does.
    const theta = rng() * Math.PI * 2;
    const phi = Math.acos(2 * rng() - 1);
    const r = radius * Math.cbrt(rng());
    const cx = centre.x + r * Math.sin(phi) * Math.cos(theta);
    const cz = centre.z + r * Math.sin(phi) * Math.sin(theta);
    // Squashed in y and floored a little below the centre: a crown that hangs
    // to the ground reads as a weeping willow, and a crown that floats above
    // the branches reads as a lollipop.
    const cy = Math.max(centre.y - radius * 0.4, centre.y + r * Math.cos(phi) * 0.7);
    const scale = 0.65 + rng() * 0.6;
    appendIcosphere(mesh, { x: cx, y: cy, z: cz }, blobRadius * scale, detail, warp, noise, colorLow, colorHigh);
  }
}

/** State threaded through the rewrite. */
interface GrowState {
  readonly mesh: MeshBuilder;
  readonly canopy: MeshBuilder;
  readonly noise: SimplexNoise2D;
  readonly rng: () => number;
  readonly preset: TreePreset;
  readonly barkColor: [number, number, number];
  readonly fungusColor: [number, number, number];
  segments: number;
  tips: Array<{ x: number; y: number; z: number }>;
}

/**
 * One production of the L-system.
 *
 * Emits the branch itself, then either recurses or, at maximum depth, records
 * the tip as a canopy anchor. A continuation child is rolled with the parent's
 * own axis so it grows on out of the top of the branch rather than veering off
 * sideways, which is what makes a trunk read as a trunk.
 */
function grow(
  state: GrowState,
  depth: number,
  base: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  length: number,
  radius: number,
): void {
  if (state.segments >= MAX_BRANCH_SEGMENTS) return;

  state.segments++;
  const tip = {
    x: base.x + dir.x * length,
    y: base.y + dir.y * length,
    z: base.z + dir.z * length,
  };
  const tipRadius = Math.max(0.008, radius * state.preset.radiusFalloff);

  appendBranch(
    state.mesh,
    base,
    dir,
    length,
    radius,
    tipRadius,
    state.preset.branchWarp,
    state.noise,
    state.barkColor,
  );

  if (depth >= state.preset.iterations) {
    state.tips.push(tip);
    return;
  }

  const u = perpendicular(dir);
  // The trunk splits into more limbs than a branch does: that is the whole
  // difference between an oak's wide spread and a sapling's single stem, and it
  // is why mainLimbs and children are separate numbers.
  const count = depth === 0 ? state.preset.mainLimbs : state.preset.children;
  const rollStep = (Math.PI * 2) / count;

  for (let i = 0; i < count; i++) {
    // Roll plus a per-sibling jitter, so the branches do not all sit in one
    // plane. A fixed roll of 2*PI/n is exactly the case that makes three
    // branches look like a three-pointed star.
    const roll = rollStep * i + state.rng() * 0.9;
    const off = state.preset.spread * (0.7 + state.rng() * 0.6);
    // Rotating the perpendicular TOWARD the parent axis by `off` is what makes
    // a branch leave at an angle rather than at a right angle. The sine and
    // cosine of that one angle are the whole of the rotation.
    const side = rotateAround(dir, u, roll);
    let childDir = {
      x: side.x * Math.cos(off) + dir.x * Math.sin(off),
      y: side.y * Math.cos(off) + dir.y * Math.sin(off),
      z: side.z * Math.cos(off) + dir.z * Math.sin(off),
    };
    // No branch may point far enough down to leave the ground. A branch that
    // ends below y = 0 is a branch inside a hill, and on a heightmap that is a
    // branch inside the terrain for most of the world.
    if (childDir.y < MIN_BRANCH_DROP) childDir.y = MIN_BRANCH_DROP;
    childDir = normalize({
      x: childDir.x,
      y: childDir.y + state.preset.upBias * 0.3,
      z: childDir.z,
    });

    grow(
      state,
      depth + 1,
      tip,
      childDir,
      length * state.preset.lengthFalloff * (0.85 + state.rng() * 0.3),
      tipRadius,
    );
  }

  if (state.rng() < state.preset.continuation) {
    const wobble = rotateAround(dir, u, state.rng() * 0.6);
    grow(
      state,
      depth + 1,
      tip,
      normalize({
        x: wobble.x + UP.x * 0.12,
        y: wobble.y + UP.y * 0.12,
        z: wobble.z + UP.z * 0.12,
      }),
      length * state.preset.lengthFalloff * 0.92,
      tipRadius,
    );
  }
}

/**
 * Build one tree.
 *
 * `seed` selects both the noise field and the stochastic rewrite, so the same
 * seed always gives the same tree. `variant` is folded in as well, which is
 * what makes the variants of a type genuinely different trees rather than the
 * same tree re-rolled.
 */
export function generateTree(
  type: TreeType,
  seed: number,
  variant = 0,
  presetOverride?: Partial<TreePreset>,
): TreeGeometry {
  const preset: TreePreset = { ...TREE_PRESETS[type], ...presetOverride };
  const treeSeed = (seed * 7919 + variant * 104729) | 0;
  const rng = createRng(treeSeed);
  const noise = new SimplexNoise2D(treeSeed ^ 0x5f3a);

  const barkColor: [number, number, number] =
    type === 'dead' ? [...DEAD_BARK_COLOR] : [...LIVING_BARK_COLOR];

  const state: GrowState = {
    mesh: new MeshBuilder(),
    canopy: new MeshBuilder(),
    noise,
    rng,
    preset,
    barkColor,
    fungusColor: FUNGUS_COLOR,
    segments: 0,
    tips: [],
  };

  // The trunk leans away from vertical by a seeded amount, so no two trees
  // stand quite straight.
  const lean = preset.lean * (0.4 + rng());
  const leanRoll = rng() * Math.PI * 2;
  const trunkDir = normalize({
    x: Math.sin(lean) * Math.cos(leanRoll),
    y: Math.cos(lean),
    z: Math.sin(lean) * Math.sin(leanRoll),
  });

  grow(state, 0, { x: 0, y: 0, z: 0 }, trunkDir, preset.trunkLength, preset.trunkRadius);

  // ONE canopy per tree, anchored at the top. Hanging a full cluster on every
  // surviving tip multiplies the triangle count by the branch count: an oak
  // grew 268,800 canopy triangles, which is the terrain's budget on its own.
  // Taking the top third of the tips as the anchor is what makes the crown
  // sit over the crown and the bare lower branches stay bare.
  const blobScale = type === 'dead' ? 0.6 : 1;
  const anchor = canopyAnchor(state.tips, preset);
  appendCluster(
    state.canopy,
    anchor,
    preset.canopyRadius,
    Math.max(1, Math.round(preset.canopyBlobs * blobScale)),
    preset.blobRadius,
    preset.blobDetail,
    preset.canopyWarp,
    noise,
    rng,
    LEAF_LOW,
    LEAF_HIGH,
  );

  // Fungal clusters on dead trees: small cones and spheres at the forks. They
  // ride in the bark buffer and carry their own vertex colour, so they cost no
  // extra draw call and no extra material. The full FungusGenerator - shelves,
  // spore pods, emissive growths - is Step 2.4; this is only the dead tree's
  // own share of it.
  if (type === 'dead') {
    const clusters = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < clusters; i++) {
      const tip = state.tips.length > 0 ? state.tips[Math.floor(rng() * state.tips.length)] : { x: 0, y: 1, z: 0 };
      const cx = tip.x + (rng() - 0.5) * 0.5;
      const cy = tip.y - rng() * 0.4;
      const cz = tip.z + (rng() - 0.5) * 0.5;
      appendIcosphere(
        state.mesh,
        { x: cx, y: cy, z: cz },
        0.07 + rng() * 0.07,
        1,
        0.3,
        noise,
        state.fungusColor,
        null,
      );
    }
  }

  return { bark: state.mesh.build(), canopy: state.canopy.build() };
}

/**
 * One displaced icosphere as a standalone mesh.
 *
 * Exported because `FoliageGenerator` needs the same shape for its undergrowth
 * and its rocks. A second copy of the subdivision in that module would be a
 * second place for the corner-count and edge-cache bugs to live.
 */
export function icosphereData(options: {
  centre: { x: number; y: number; z: number };
  radius: number;
  detail: number;
  warp: number;
  noise: SimplexNoise2D;
  color: [number, number, number];
  colorTip: [number, number, number] | null;
  /** Non-uniform scale applied after the displacement. Optional. */
  scale?: { x: number; y: number; z: number };
}): MeshData {
  const mesh = new MeshBuilder();
  appendIcosphere(
    mesh,
    options.centre,
    options.radius,
    options.detail,
    options.warp,
    options.noise,
    options.color,
    options.colorTip,
  );
  const built = mesh.build();
  if (options.scale) {
    // Applied to the positions AND the normals, because a squash that leaves
    // the normals alone lights the rock as though it were still a sphere.
    for (let i = 0; i < built.positions.length; i += 3) {
      built.positions[i] *= options.scale.x;
      built.positions[i + 1] *= options.scale.y;
      built.positions[i + 2] *= options.scale.z;
    }
    for (let i = 0; i < built.normals.length; i += 3) {
      built.normals[i] *= options.scale.x;
      built.normals[i + 1] *= options.scale.y;
      built.normals[i + 2] *= options.scale.z;
    }
    for (let i = 0; i < built.normals.length; i += 3) {
      const len = Math.hypot(built.normals[i], built.normals[i + 1], built.normals[i + 2]);
      if (len > 1e-9) {
        built.normals[i] /= len;
        built.normals[i + 1] /= len;
        built.normals[i + 2] /= len;
      }
    }
  }
  return built;
}

/** Leaf colour at the bottom of a blob: deeper, more saturated green. */
const LEAF_LOW: [number, number, number] = [0.14, 0.26, 0.1];

/** Leaf colour at the top of a blob: yellow-green, catching the light. */
const LEAF_HIGH: [number, number, number] = [0.52, 0.55, 0.18];

/**
 * The medium LOD: one tapered trunk and one canopy sphere.
 *
 * This is the plan's "simplified trunk + single canopy sphere", and it is
 * deliberately not a reduced L-system. A three-iteration tree simplified to
 * one cylinder and one sphere looks like a lollipop, which is exactly what a
 * 30-80 m tree should look like - the silhouette is what survives at that
 * distance, not the branching.
 */
export function generateSimplifiedTree(type: TreeType, seed: number, variant = 0): TreeGeometry {
  const preset = TREE_PRESETS[type];
  const treeSeed = (seed * 7919 + variant * 104729) | 0;
  const rng = createRng(treeSeed);
  const noise = new SimplexNoise2D(treeSeed ^ 0x5f3a);

  const bark = new MeshBuilder();
  const canopy = new MeshBuilder();
  const barkColor: [number, number, number] =
    type === 'dead' ? [...DEAD_BARK_COLOR] : [...LIVING_BARK_COLOR];

  const lean = preset.lean * (0.4 + rng());
  const leanRoll = rng() * Math.PI * 2;
  const trunkDir = normalize({
    x: Math.sin(lean) * Math.cos(leanRoll),
    y: Math.cos(lean),
    z: Math.sin(lean) * Math.sin(leanRoll),
  });

  const trunkLength = preset.height * 0.55;
  appendBranch(
    bark,
    { x: 0, y: 0, z: 0 },
    trunkDir,
    trunkLength,
    preset.trunkRadius,
    preset.trunkRadius * 0.45,
    preset.branchWarp * 0.6,
    noise,
    barkColor,
  );

  const blobScale = type === 'dead' ? 0.55 : 1;
  appendIcosphere(
    canopy,
    {
      x: trunkDir.x * trunkLength,
      y: trunkDir.y * trunkLength + preset.canopyRadius * 0.45,
      z: trunkDir.z * trunkLength,
    },
    preset.canopyRadius * blobScale,
    // One icosphere stands in for the whole crown, so its tessellation is
    // budgeted against the crown's size rather than fixed: a sapling's crown
    // is a fifth of an oak's and does not need a fifth of its triangles.
    preset.canopyRadius > 1.5 ? 2 : 1,
    preset.canopyWarp,
    noise,
    LEAF_LOW,
    LEAF_HIGH,
  );

  if (type === 'dead') {
    appendIcosphere(
      bark,
      { x: trunkDir.x * trunkLength * 0.7, y: trunkDir.y * trunkLength * 0.7, z: trunkDir.z * trunkLength * 0.7 },
      0.12,
      1,
      0.3,
      noise,
      FUNGUS_COLOR,
      null,
    );
  }

  return { bark: bark.build(), canopy: canopy.build() };
}

/** A procedurally drawn tree silhouette for the far LOD. */
export interface BillboardTexture {
  width: number;
  height: number;
  /** RGBA, row-major from the top. */
  data: Uint8Array;
}

/**
 * Draw one tree type's silhouette into an RGBA buffer.
 *
 * The far LOD is a cross of two quads, and a flat-coloured cross looks like a
 * cross. This gives it a trunk, a canopy blob and an alpha edge, all from
 * analytic ellipses - no texture file, and the same seed always draws the same
 * tree. The colour ramp matches the leaf material's so a tree that pops from
 * far to near does not change hue.
 */
export function generateBillboard(type: TreeType, seed: number): BillboardTexture {
  const preset = TREE_PRESETS[type];
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const rng = createRng((seed * 7919 + type.length * 33) | 0);

  // Trunk and canopy as rectangles and ellipses in UV space. The canopy is a
  // few overlapping ellipses rather than one, because a single ellipse is the
  // shape that most reads as "a green oval" rather than "leaves".
  const trunkHalf = 0.045 + preset.colliderRadius * 0.12;
  const canopyCx = 0.5 + (rng() - 0.5) * 0.1;
  const canopyCy = 0.34 + (rng() - 0.5) * 0.08;
  const canopyRx = 0.2 + preset.canopyRadius * 0.045;
  const canopyRy = 0.19 + preset.canopyRadius * 0.04;
  const blobs = type === 'dead' ? 2 : 5;
  const blobSeed = createRng((seed * 131 + type.length * 7) | 0);
  // Drawn ONCE, before the pixel loop. Generating the blob offsets inside the
  // loop advances the generator on every pixel, which turns the crown into
  // per-pixel noise instead of five overlapping ellipses.
  const blobShapes: Array<{ bx: number; by: number; rx: number; ry: number }> = [];
  for (let i = 0; i < blobs; i++) {
    blobShapes.push({
      bx: canopyCx + (blobSeed() - 0.5) * canopyRx * 1.1,
      by: canopyCy + (blobSeed() - 0.5) * canopyRy * 1.0,
      rx: canopyRx * (0.45 + blobSeed() * 0.6),
      ry: canopyRy * (0.45 + blobSeed() * 0.6),
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const k = (y * size + x) * 4;

      // Trunk: a slightly tapering column from the bottom of the texture up to
      // where the canopy starts.
      const trunkTop = canopyCy + canopyRy * 0.55;
      let alpha = 0;
      let r = 0;
      let g = 0;
      let b = 0;

      if (v > trunkTop) {
        const t = (v - trunkTop) / (1 - trunkTop);
        const half = trunkHalf * (1 - t * 0.55);
        const d = Math.abs(u - 0.5);
        if (d < half) {
          const shade = 0.42 + t * 0.2;
          alpha = 1;
          r = shade * (type === 'dead' ? 0.62 : 0.42);
          g = shade * (type === 'dead' ? 0.6 : 0.33);
          b = shade * (type === 'dead' ? 0.55 : 0.24);
        }
      }

      // Canopy: overlapping ellipses, each shaded by how high inside it sits.
      for (const blob of blobShapes) {
        const { bx, by, rx, ry } = blob;
        const dx = (u - bx) / rx;
        const dy = (v - by) / ry;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // A soft edge rather than a hard one: the billboard is alpha-tested,
          // and a hard edge at 64px turns into visible stair-stepping the
          // moment the camera moves.
          const edge = 1 - Math.min(1, Math.max(0, (Math.sqrt(d2) - 0.72) / 0.28));
          if (edge > alpha) {
            const height = Math.min(1, Math.max(0, (canopyCy + ry - v) / (2 * ry)));
            const lr = LEAF_LOW[0] + (LEAF_HIGH[0] - LEAF_LOW[0]) * height;
            const lg = LEAF_LOW[1] + (LEAF_HIGH[1] - LEAF_LOW[1]) * height;
            const lb = LEAF_LOW[2] + (LEAF_HIGH[2] - LEAF_LOW[2]) * height;
            const grey = type === 'dead' ? 0.45 : 1;
            alpha = edge;
            r = lr * grey;
            g = lg * grey;
            b = lb * grey;
          }
        }
      }

      data[k] = Math.round(Math.min(1, Math.max(0, r)) * 255);
      data[k + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
      data[k + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
      data[k + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
    }
  }

  return { width: size, height: size, data };
}

/** Number of triangles in a mesh. Exposed for the vertex-budget tests. */
export function triangleCount(mesh: MeshData): number {
  return mesh.indices.length / 3;
}

/** Number of vertices in a mesh. Exposed for the vertex-budget tests. */
export function vertexCount(mesh: MeshData): number {
  return mesh.positions.length / 3;
}
