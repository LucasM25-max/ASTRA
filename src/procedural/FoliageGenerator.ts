/**
 * FoliageGenerator.ts - ASTRA procedural world
 * =============================================================================
 * Everything that grows on the forest floor rather than out of it: grass,
 * ferns, undergrowth, rocks, fallen branches and scattered leaves. Pure
 * typed-array geometry and pure placement data, with no Three.js import, so
 * the whole module runs under Vitest in Node.
 *
 * The local frame every generator here writes into
 * ------------------------------------------------
 *   +Y   up the blade, the frond, the stem - the direction wind travels
 *   +X   across the blade, so a blade's width is |x|
 *   y=0  the ground the instance stands on
 *
 * `FoliageMaterial.ts` reads that convention through two uniforms,
 * `uFoliageHeight` and `uFoliageWidth`, rather than through a UV set: the
 * wind weight is `position.y / uFoliageHeight` and the leaf shape is
 * `|position.x| / uFoliageWidth`. It keeps `MeshData` free of a field only
 * foliage would ever set.
 *
 * Why these shapes
 * ----------------
 *   grass       a flat tapered ribbon, four rings. A ribbon is invisible
 *               edge-on, which is why the material is double-sided and the
 *               scatter gives every blade its own rotation: six thousand of
 *               them at random angles never present an edge to the camera.
 *   ferns       two crossed tapered planes. A single plane is a flat card, and
 *               a fern is the one plant whose silhouette is unmistakable from
 *               the side, so it gets the cross.
 *   undergrowth two displaced icospheres, low and wide. A bush is a lump, and
 *               a lump is a sphere with noise pushed into it.
 *   rocks       one heavily displaced icosphere at the coarsest subdivision,
 *               so the facets stay facets. A smooth rock reads as a egg.
 *   branches    a tapered cylinder lying down, warped the same way a tree's
 *               branch is.
 *   leaves      two flat triangles, horizontal. Scattered on the floor they
 *               are litter; at any other angle they are a shimmering speckle.
 *
 * Placement
 * ---------
 * `scatterFoliage` rejection-samples a disc. The acceptance probability is a
 * product of three fades - stream proximity, height and slope - so the cover
 * is thick in the damp gully the stream runs through and thins out on the
 * hills and the steep banks, which is what the plan asks for. Everything is
 * driven by one seeded RNG, so the same patch regenerates identically when the
 * camera walks back to it.
 * =============================================================================
 */

import { createRng, SimplexNoise2D } from './NoiseLibrary';
import type { MeshData } from './TreeGenerator';
import { icosphereData } from './TreeGenerator';

export type FoliageKind = 'grass' | 'fern' | 'undergrowth' | 'rock' | 'branch' | 'leaf';

/** Every kind, in the order the forest builds its meshes. */
export const FOLIAGE_KINDS: readonly FoliageKind[] = ['grass', 'fern', 'undergrowth', 'rock', 'branch', 'leaf'];

/** Radius of the camera-following foliage patch, in metres. */
export const FOLIAGE_PATCH_RADIUS = 80;

/** Rings along a grass blade, including the base and the tip. */
const BLADE_RINGS = 4;

/** Half the width of a grass blade at its base, in metres. */
const BLADE_WIDTH = 0.028;

/** Height of a grass blade at scale 1, in metres. */
export const GRASS_HEIGHT = 0.55;

/** Height of a fern frond at scale 1, in metres. */
export const FERN_HEIGHT = 0.8;

/** Width of a fern frond at its widest, in metres. */
export const FERN_WIDTH = 0.34;

/** Half-width of an undergrowth bush at scale 1, in metres. */
export const BUSH_RADIUS = 0.55;

/** Radius of a small rock at scale 1, in metres. */
export const ROCK_RADIUS = 0.28;

/** Length of a fallen branch at scale 1, in metres. */
export const BRANCH_LENGTH = 1.8;

/** Size of one scattered leaf, in metres. */
export const LEAF_SIZE = 0.12;

/**
 * Triangles each kind costs per instance.
 *
 * These are the numbers the vertex budget is built from, so they are measured
 * from the generators rather than written down: `foliageTriangleCounts()` runs
 * the generators once and reports what they actually produced, and a test
 * asserts the two agree. A hand-maintained count drifts the moment a ring is
 * added to a blade.
 */
export const FOLIAGE_TRIANGLES: Record<FoliageKind, number> = {
  grass: 6,
  fern: 8,
  undergrowth: 160,
  rock: 20,
  branch: 42,
  leaf: 2,
};

/** Triangles the generators actually produce. Used to check `FOLIAGE_TRIANGLES`. */
export function foliageTriangleCounts(seed = 1): Record<FoliageKind, number> {
  const g = generateFoliageGeometry(seed);
  return {
    grass: g.grass.indices.length / 3,
    fern: g.fern.indices.length / 3,
    undergrowth: g.undergrowth.indices.length / 3,
    rock: g.rock.indices.length / 3,
    branch: g.branch.indices.length / 3,
    leaf: g.leaf.indices.length / 3,
  };
}

/** Instances of each kind in one 80 m patch. */
export const DEFAULT_FOLIAGE_COUNTS: Record<FoliageKind, number> = {
  grass: 6000,
  fern: 500,
  undergrowth: 150,
  rock: 150,
  branch: 40,
  leaf: 2500,
};

/* -------------------------------------------------------------------------- */
/* geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A flat tapered blade of grass standing in the local XY plane.
 *
 * The width tapers to a hair rather than to zero: a zero-width tip ring puts
 * two vertices on top of each other, and the triangle between them has zero
 * area. A degenerate triangle costs a slot in the index buffer and produces a
 * NaN in the normal accumulation, so the taper stops short.
 */
export function generateGrassBlade(): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Bend and lean, so no two blades are the same flat ribbon. Both are curves
  // in t rather than constants: a constant lean is a shear, and a sheared
  // blade looks stamped.
  const bend = 0.22;
  const lean = 0.1;

  const grid: number[][] = [];
  for (let ring = 0; ring < BLADE_RINGS; ring++) {
    const t = ring / (BLADE_RINGS - 1);
    // Width falls off faster than linearly: a grass blade is a sliver for most
    // of its length and only wide where it meets the ground.
    const half = BLADE_WIDTH * Math.pow(1 - t, 0.7) + BLADE_WIDTH * 0.05;
    const cx = bend * t * t * GRASS_HEIGHT;
    const y = t * GRASS_HEIGHT;
    const cz = -lean * t * t * GRASS_HEIGHT;
    const row: number[] = [];
    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? -1 : 1;
      positions.push(cx + s * half, y, cz);
      // The blade is a ribbon, so its whole surface shares one normal. The
      // material is double-sided and Three flips this per face.
      normals.push(0, 0, 1);
      colors.push(1, 1, 1);
      row.push(positions.length / 3 - 1);
    }
    grid.push(row);
  }

  // One quad per band. A band has only two vertices per ring, so looping over
  // the two sides as well would emit every triangle twice - which doubles the
  // index count, halves the frame rate, and looks completely fine.
  for (let ring = 0; ring < BLADE_RINGS - 1; ring++) {
    const a = grid[ring][0];
    const b = grid[ring][1];
    const c = grid[ring + 1][0];
    const d = grid[ring + 1][1];
    indices.push(a, b, c, b, d, c);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}

/**
 * A fern frond: two tapered planes crossed at right angles.
 *
 * Each plane tapers to a point at the top and is widest a third of the way up,
 * which is the shape of a frond rather than of a leaf. The pinnae are not in
 * the geometry at all - they are the alpha mask in `FoliageMaterial`, because
 * modelling them would cost hundreds of triangles to reproduce what one noise
 * lookup does.
 */
export function generateFernFrond(): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Widest a third of the way up, pointed at the top, narrow at the base. The
  // floor matters: sin(pi) is exactly zero at the tip, and a zero-width tip
  // ring puts two vertices on top of each other, so the last band of the plane
  // would be a zero-area triangle.
  const halfAt = (t: number): number =>
    Math.max(
      FERN_WIDTH * 0.02,
      FERN_WIDTH * 0.5 * Math.sin(Math.PI * Math.pow(t, 0.72)) * (0.35 + 0.65 * t),
    );

  const RINGS = 3;
  for (let plane = 0; plane < 2; plane++) {
    const angle = plane * (Math.PI / 2);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const row: number[] = [];
    for (let ring = 0; ring < RINGS; ring++) {
      const t = ring / (RINGS - 1);
      const h = halfAt(t);
      for (let side = 0; side < 2; side++) {
        const s = side === 0 ? -1 : 1;
        // Rotated into the plane's own frame; z is a function of the same half
        // width, so the two planes cross on the y axis exactly.
        positions.push(s * h * cos, t * FERN_HEIGHT, s * h * sin);
        normals.push(0, 0, 1);
        colors.push(1, 1, 1);
        row.push(positions.length / 3 - 1);
      }
    }
    for (let ring = 0; ring < RINGS - 1; ring++) {
      const a = row[ring * 2];
      const b = row[ring * 2 + 1];
      const c = row[(ring + 1) * 2];
      const d = row[(ring + 1) * 2 + 1];
      indices.push(a, b, c, b, d, c);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}

/**
 * Undergrowth: two displaced icospheres, low and wide, so the cluster reads as
 * a bush rather than as a ball.
 */
export function generateUndergrowth(seed: number): MeshData {
  const noise = new SimplexNoise2D((seed * 7919) | 0);
  const rng = createRng((seed * 104729) | 0);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let blob = 0; blob < 2; blob++) {
    const mesh = icosphereData({
      centre: {
        x: (rng() - 0.5) * BUSH_RADIUS * 0.7,
        // Raised well above the base. A bush is meant to sit IN the ground -
        // the buried part is what hides the seam where it meets the terrain -
        // but only by enough to do that, not by a third of its height.
        y: BUSH_RADIUS * (0.72 + rng() * 0.16),
        z: (rng() - 0.5) * BUSH_RADIUS * 0.7,
      },
      radius: BUSH_RADIUS * (blob === 0 ? 0.95 : 0.68),
      detail: 1,
      warp: 0.3,
      noise,
      color: [1, 1, 1],
      colorTip: null,
    });
    appendMesh(positions, normals, colors, indices, mesh);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}

/**
 * A small rock: one icosphere at the coarsest subdivision, displaced hard.
 *
 * Detail 0 rather than detail 1 because the facets are the point. A rock with
 * a smooth silhouette reads as a pebble, and a pebble at this scale reads as a
 * bug.
 */
export function generateRock(seed: number): MeshData {
  const noise = new SimplexNoise2D((seed * 6151) | 0);
  // Squashed in y, so it sits on the ground instead of hovering as a sphere.
  // The squash goes through icosphereData's `scale`, which also corrects the
  // normals: squashing the positions alone lights the rock as though it were
  // still a sphere, and the facets disappear.
  return icosphereData({
    centre: { x: 0, y: ROCK_RADIUS * 0.6, z: 0 },
    radius: ROCK_RADIUS,
    detail: 0,
    warp: 0.42,
    noise,
    color: [1, 1, 1],
    colorTip: null,
    scale: { x: 1.15, y: 0.62, z: 1.0 },
  });
}

/**
 * A fallen branch: a tapered cylinder lying along local +X, warped the same
 * way a living branch is so it does not read as a rolled tube.
 */
export function generateFallenBranch(seed: number): MeshData {
  const noise = new SimplexNoise2D((seed * 3571) | 0);
  const rings = 4;
  const radial = 6;
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const baseRadius = 0.075;
  const tipRadius = 0.022;
  const grid: number[][] = [];

  for (let ring = 0; ring < rings; ring++) {
    const t = ring / (rings - 1);
    const radius = baseRadius + (tipRadius - baseRadius) * t;
    const cx = t * BRANCH_LENGTH;
    // The axis rides a gentle wave, so a fallen branch lies on the ground with
    // a dip in the middle rather than as a straight line.
    const cy = radius + Math.sin(t * 2.2) * 0.03;
    const row: number[] = [];
    for (let s = 0; s < radial; s++) {
      const angle = (s / radial) * Math.PI * 2;
      // A circle in the local YZ plane, which is what makes the cylinder lie
      // along +X rather than stand up along +Y.
      const w = noise.noise(cx * 2.0 + angle * 0.6, cy * 2.0) * 0.16;
      const r = Math.max(radius * 0.3, radius + w * radius);
      positions.push(cx, cy + Math.cos(angle) * r, Math.sin(angle) * r);
      normals.push(0, Math.cos(angle), Math.sin(angle));
      colors.push(1, 1, 1);
      row.push(positions.length / 3 - 1);
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
      indices.push(a, b, c, b, d, c);
    }
  }
  // The cap closes the far end. Its centre is the far end of the axis, which
  // is where the last ring's vertices are arranged around - not the origin.
  const tipRing = grid[rings - 1];
  const tipIndex = positions.length / 3;
  const tipY = baseRadius + Math.sin(2.2) * 0.03;
  positions.push(BRANCH_LENGTH, tipY, 0);
  normals.push(1, 0, 0);
  colors.push(1, 1, 1);
  for (let s = 0; s < radial; s++) indices.push(tipRing[s], tipRing[(s + 1) % radial], tipIndex);

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}

/**
 * A scattered leaf: two horizontal triangles, slightly overlapping, so the
 * litter reads as a flat shape from above and as a sliver from the side.
 */
export function generateLeafLitter(): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let tri = 0; tri < 2; tri++) {
    const base = positions.length / 3;
    const roll = tri * 1.1;
    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const shape: Array<[number, number]> = [
      [0, 0],
      [LEAF_SIZE, LEAF_SIZE * 0.22],
      [LEAF_SIZE * 0.42, LEAF_SIZE * 0.78],
    ];
    for (const [x, z] of shape) {
      positions.push(x * cos - z * sin, 0.004, x * sin + z * cos);
      normals.push(0, 1, 0);
      colors.push(1, 1, 1);
    }
    indices.push(base, base + 1, base + 2);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}

/** Concatenate one mesh into flat arrays, offsetting its indices. */
function appendMesh(
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
  mesh: MeshData,
): void {
  const base = positions.length / 3;
  for (let i = 0; i < mesh.positions.length; i++) positions.push(mesh.positions[i]);
  for (let i = 0; i < mesh.normals.length; i++) normals.push(mesh.normals[i]);
  for (let i = 0; i < mesh.colors.length; i++) colors.push(mesh.colors[i]);
  for (let i = 0; i < mesh.indices.length; i++) indices.push(mesh.indices[i] + base);
}

/** Every geometry the forest needs, generated once and shared by all instances. */
export interface FoliageGeometrySet {
  grass: MeshData;
  fern: MeshData;
  undergrowth: MeshData;
  rock: MeshData;
  branch: MeshData;
  leaf: MeshData;
}

/**
 * Build every foliage mesh.
 *
 * Called once at startup, not per frame: the meshes are shared by an
 * `InstancedMesh`, so the per-instance cost is a matrix and nothing else.
 */
export function generateFoliageGeometry(seed = 1): FoliageGeometrySet {
  return {
    grass: generateGrassBlade(),
    fern: generateFernFrond(),
    undergrowth: generateUndergrowth(seed),
    rock: generateRock(seed),
    branch: generateFallenBranch(seed),
    leaf: generateLeafLitter(),
  };
}

/* -------------------------------------------------------------------------- */
/* placement                                                                  */
/* -------------------------------------------------------------------------- */

/** One instance of one kind of foliage. */
export interface FoliageInstance {
  kind: FoliageKind;
  /** World position of the instance's origin, which is its base on the ground. */
  x: number;
  y: number;
  z: number;
  /** Rotation about the world Y axis, radians. */
  rotationY: number;
  /** Uniform scale, already including the per-instance variation. */
  scale: number;
  /** Extra lean away from vertical, radians. Grass and ferns lean; rocks do not. */
  tilt: number;
  /** 0..1 colour variation, for the per-instance tint attribute. */
  variation: number;
}

/**
 * The world the scatter needs to know about.
 *
 * Samplers rather than a terrain object, so this module stays free of any
 * dependency on `Terrain` and can be tested against a height function alone.
 */
export interface FoliageField {
  heightAt: (x: number, z: number) => number;
  /** Surface normal, unit length. Optional: without it, no slope rejection. */
  normalAt?: (x: number, z: number) => { x: number; y: number; z: number };
  /** Distance to the stream centreline, in metres. Optional. */
  distanceToStream?: (x: number, z: number) => number;
  /** 0..1 stream pollution. Optional: it drives the sickly tint near the water. */
  pollutionAt?: (x: number, z: number) => number;
}

export interface FoliageScatterOptions {
  seed: number;
  /** Centre of the patch in world XZ. */
  centreX: number;
  centreZ: number;
  /** Radius of the patch, in metres. */
  radius?: number;
  field: FoliageField;
  counts?: Partial<Record<FoliageKind, number>>;
  /** Height at which cover starts thinning, in metres. */
  hillStart?: number;
  /** Height at which cover is gone entirely, in metres. */
  hillEnd?: number;
  /** Slope (`1 - normal.y`) above which nothing grows. */
  maxSlope?: number;
  /** Distance from the stream centreline inside which nothing grows. */
  streamExclusion?: number;
  /** How much the stream's proximity multiplies the base density. */
  streamBoost?: number;
  /** Decay length of the stream's proximity boost, in metres. */
  streamDecay?: number;
}

/** Defaults for the scatter, exported so the forest and the tests agree. */
export const DEFAULT_FOLIAGE_SCATTER = {
  radius: FOLIAGE_PATCH_RADIUS,
  hillStart: 6,
  hillEnd: 16,
  maxSlope: 0.55,
  streamExclusion: 2.2,
  streamBoost: 1.6,
  streamDecay: 14,
} as const;

/** Smoothstep, written out rather than imported so the maths is local. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Scatter one patch of foliage.
 *
 * Rejection sampling against a density built from three fades:
 *
 *   stream   up to `streamBoost` times denser within `streamDecay` metres of
 *            the water, and nothing at all inside `streamExclusion`, because
 *            grass does not grow in a stream bed
 *   height   thinning from `hillStart` to `hillEnd`, so the hills are bare and
 *            the gully the stream runs through is thick
 *   slope    nothing on a face steeper than `maxSlope`
 *
 * Every kind is scattered independently, so a rock is not competing with a
 * blade of grass for the same point - which would show up as grass growing out
 * of a rock.
 */
export function scatterFoliage(options: FoliageScatterOptions): FoliageInstance[] {
  const o = { ...DEFAULT_FOLIAGE_SCATTER, ...options };
  const rng = createRng(options.seed | 0);
  const counts = { ...DEFAULT_FOLIAGE_COUNTS, ...options.counts };
  const out: FoliageInstance[] = [];

  // How dense the cover is at one point, as a multiple of the base density.
  const densityAt = (x: number, z: number): number => {
    const h = options.field.heightAt(x, z);
    let d = 1 - smoothstep(o.hillStart, o.hillEnd, h);

    const normal = options.field.normalAt?.(x, z);
    if (normal) {
      const slope = 1 - Math.min(1, Math.max(0, normal.y));
      d *= 1 - smoothstep(o.maxSlope * 0.55, o.maxSlope, slope);
    }

    const stream = options.field.distanceToStream?.(x, z);
    if (stream !== undefined) {
      if (stream < o.streamExclusion) return 0;
      // The boost decays with distance, and the exclusion already removed the
      // bed, so this only ever thickens the bank.
      d *= 1 + (o.streamBoost - 1) * Math.exp(-stream / o.streamDecay);
    }
    return Math.max(0, d);
  };

  // One candidate point inside the disc. sqrt() of a uniform radius is what
  // makes the sampling uniform in AREA rather than clustered at the centre,
  // which is the difference between a round patch and a dot with a halo.
  const samplePoint = (): { x: number; z: number } => {
    const r = o.radius * Math.sqrt(rng());
    const a = rng() * Math.PI * 2;
    return { x: options.centreX + r * Math.cos(a), z: options.centreZ + r * Math.sin(a) };
  };

  for (const kind of FOLIAGE_KINDS) {
    const wanted = Math.max(0, Math.round(counts[kind]));
    if (wanted === 0) continue;

    // Bounded attempts: a patch with a density of zero everywhere would
    // otherwise spin forever looking for a place to put anything.
    const maxAttempts = wanted * 40 + 200;
    let placed = 0;
    for (let attempt = 0; attempt < maxAttempts && placed < wanted; attempt++) {
      const p = samplePoint();
      const d = densityAt(p.x, p.z);
      if (d <= 0) continue;
      if (rng() > Math.min(1, d)) continue;

      const y = options.field.heightAt(p.x, p.z);
      const pollution = options.field.pollutionAt?.(p.x, p.z) ?? 0;

      out.push({
        kind,
        x: p.x,
        y,
        z: p.z,
        rotationY: rng() * Math.PI * 2,
        scale: scaleFor(kind, rng),
        // Grass and ferns lean; rocks and litter lie flat. A leaning rock is a
        // rock that has been knocked over, and there are a lot of them.
        tilt: kind === 'rock' || kind === 'branch' || kind === 'leaf' ? 0 : (rng() - 0.5) * 0.5,
        variation: rng(),
      });
      // Sickly foliage near the polluted stream: the tint travels with the
      // instance, so the bank yellows the way the dead trees grey out.
      if (pollution > 0.35) out[out.length - 1].variation = 0.5 + rng() * 0.5;
      placed++;
    }
  }

  return out;
}

/** Per-instance scale range, per kind. */
function scaleFor(kind: FoliageKind, rng: () => number): number {
  switch (kind) {
    case 'grass':
      // A wide range is what stops a field of grass looking like a carpet:
      // one blade twice the height of its neighbours reads as a tussock.
      return 0.55 + rng() * 0.9;
    case 'fern':
      return 0.7 + rng() * 0.7;
    case 'undergrowth':
      return 0.6 + rng() * 0.8;
    case 'rock':
      return 0.5 + rng() * 1.1;
    case 'branch':
      return 0.7 + rng() * 0.7;
    case 'leaf':
      return 0.8 + rng() * 0.6;
  }
}

/** Instance count for one kind, given a target triangle budget. */
export function instancesForBudget(kind: FoliageKind, budget: number): number {
  return Math.max(0, Math.floor(budget / FOLIAGE_TRIANGLES[kind]));
}

/** Triangles one patch of foliage costs, given its instances. */
export function foliageTriangleCost(instances: readonly FoliageInstance[]): number {
  let total = 0;
  for (const i of instances) total += FOLIAGE_TRIANGLES[i.kind];
  return total;
}
