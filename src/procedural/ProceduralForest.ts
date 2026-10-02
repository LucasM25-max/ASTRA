/**
 * ProceduralForest.ts - ASTRA procedural world
 * =============================================================================
 * Where the trees go, and which level of detail each one is drawn at. Pure
 * data: this module never touches Three.js, never allocates a mesh and never
 * knows what a camera is beyond two numbers, so the whole placement algorithm
 * runs under Vitest in Node.
 *
 * Placement
 * ---------
 * Bridson's Poisson disk sampling, with a radius that varies by position:
 *
 *   r(x,z) = baseRadius / sqrt( density(x,z) )
 *
 * so the trees crowd together in the damp gully the stream runs through and
 * spread out on the hills. Making the radius a function of position rather
 * than rejecting samples afterwards is what keeps the spacing *natural* at
 * every density - rejection leaves the surviving points Poisson-distributed
 * only at the original radius, and the gaps it leaves behind read as a
 * clearing.
 *
 * The no-overlap test uses the mean of the two points' radii:
 *
 *   dist(p,q) >= ( r(p) + r(q) ) / 2
 *
 * Using the sum instead would halve the spacing wherever two densities meet,
 * and using the max would over-thin the sparse side. The mean is the smooth
 * compromise, and it is the only part of this file where a different choice
 * would be defensible.
 *
 * Density
 * -------
 *   stream   up to `streamDensity` times denser within `streamDecay` metres of
 *            the water, and nothing inside `streamMargin`, because a tree does
 *            not grow in a stream bed
 *   height   thinning from `hillStart` to `hillEnd`
 *   slope    nothing on a face steeper than `maxSlope`
 *
 * Type mix, per hectare, as the plan specifies:
 *
 *   oak        6 to 10     wide spread, thick trunk, dense canopy
 *   deciduous  30 to 50    moderate spread, thinner trunk
 *   sapling    50 to 100   single trunk, small canopy cluster
 *   dead       5% at rest, rising to `deadMax` with stream pollution
 *
 * The dead share is a function of the stream's pollution rather than a fixed
 * weight, which is what makes the corruption read as spreading outward from
 * the water instead of being sprinkled evenly over the map.
 *
 * Level of detail
 * ---------------
 * Three tiers, split by distance to the camera:
 *
 *   near    < 30 m   the full L-system geometry
 *   medium  30-80 m  one tapered cylinder and one canopy sphere
 *   far     > 80 m   a cross of two quads, textured with a billboard
 *
 * The trees are placed once and the camera moves, so the tiering is recomputed
 * rather than baked. `tierTrees` returns index lists, which is a pure function
 * of the placement and two numbers - and `Forest` is what turns those lists
 * into instance matrices, throttled to when the camera has actually moved.
 * =============================================================================
 */

import { createRng, SimplexNoise2D } from './NoiseLibrary';
import { VARIANTS_PER_TYPE, type TreeType } from './TreeGenerator';

export const TREE_TYPES: readonly TreeType[] = ['oak', 'deciduous', 'sapling', 'dead'];

/** Distance below which a tree is drawn with its full L-system geometry. */
export const LOD_NEAR_DISTANCE = 30;

/** Distance below which a tree is drawn as a cylinder and a canopy sphere. */
export const LOD_MEDIUM_DISTANCE = 80;

/** Trees per hectare, per type, as the plan specifies. */
export const TREE_TYPE_COUNTS: Record<TreeType, number> = {
  oak: 8,
  deciduous: 40,
  sapling: 75,
  dead: 0,
};

/** Dead-tree share with no pollution at all. A forest has some dead wood. */
export const DEAD_BASE_PROBABILITY = 0.03;

/**
 * Dead-tree share at full pollution, upstream of the stream.
 *
 * Three in ten at the very worst, not five in ten. The corruption is meant to
 * read as a wood that is dying at one end, and a majority of dead trees reads
 * as a graveyard instead - which is the failure mode the style guide's
 * "subtle to severe" progression exists to avoid.
 */
export const DEAD_MAX_PROBABILITY = 0.3;

/**
 * Poisson radius that yields the plan's density, in metres.
 *
 * Measured against the real terrain rather than guessed: at 7.0 m the default
 * field places about 3,400 trees over the 500 m world, which is 137 per
 * hectare and splits into roughly 7 oaks, 33 deciduous and 65 saplings - the
 * middle of the ranges the plan asks for.
 */
export const DEFAULT_POISSON_RADIUS = 7.0;

/** Defaults for the placement, exported so the forest and the tests agree. */
export const DEFAULT_FOREST_PLACEMENT = {
  /** Multiplier on the base density near the stream. */
  streamDensity: 2.1,
  /** Decay length of the stream's density boost, in metres. */
  streamDecay: 22,
  /** Nothing grows this close to the stream centreline. */
  streamMargin: 2.6,
  /** Height at which cover starts thinning, in metres. */
  hillStart: 10,
  /** Height at which cover is gone entirely, in metres. */
  hillEnd: 14,
  /** Slope (`1 - normal.y`) above which nothing grows. */
  maxSlope: 0.5,
  /** Per-tree uniform scale range. The plan asks for 0.8 to 1.2. */
  minScale: 0.8,
  maxScale: 1.2,
  /** Maximum lean from vertical, in radians. */
  maxLean: 0.14,
  /**
   * How much denser the forest gets against the world's boundary walls.
   *
   * The rim ramp lifts and roughens the outer ring of the terrain, and the hill
   * thinning above turns that into bare ground - so left alone the edge of the
   * world is a bald ridge with a hard cut beyond it. This term closes the
   * forest in instead: a belt `rimBeltWidth` metres deep where cover is
   * `rimDensity` times what it would otherwise be.
   *
   * It has to be a term in the density and not a separate belt of trees,
   * because a second placement pass would be a second forest: different LOD
   * distances, a different wind phase, trees popping at a different moment, and
   * a boundary the player can see.
   */
  rimDensity: 4.2,
  /** How far in from the world edge the rim belt reaches, in metres. */
  rimBeltWidth: 55,
} as const;

/* -------------------------------------------------------------------------- */
/* placement                                                                  */
/* -------------------------------------------------------------------------- */

/** The world the placement needs to know about. */
export interface ForestField {
  heightAt: (x: number, z: number) => number;
  normalAt?: (x: number, z: number) => { x: number; y: number; z: number };
  distanceToStream?: (x: number, z: number) => number;
  /**
   * Side length of the world this forest covers, in metres.
   *
   * Optional, and only read for one thing: the rim belt that closes the forest
   * in against the world's boundary walls (Step 2.9). Without it there is no
   * rim term, and a forest placed on a field with no known extent behaves
   * exactly as it did before the boundary work.
   */
  sizeMetres?: number;
  pollutionAt?: (x: number, z: number) => number;
  /**
   * 0..1 corruption intensity.
   *
   * Optional because a forest without a stream has nothing to be corrupted by,
   * and every consumer of it treats an absent sampler as zero. It is the same
   * quantity the terrain bakes into its `corruption` attribute and the same one
   * `CorruptionField` produces, so a tree, a patch of ground and a mushroom all
   * agree about how rotten a place is.
   */
  corruptionAt?: (x: number, z: number) => number;
}

/** One placed tree. Everything a renderer needs, and nothing it does not. */
export interface TreeInstance {
  type: TreeType;
  /** World position of the tree's base. */
  x: number;
  y: number;
  z: number;
  /** Rotation about the world Y axis, radians. */
  rotationY: number;
  /** Uniform scale, inside the plan's 0.8 to 1.2. */
  scale: number;
  /** Lean from vertical, radians, derived from noise so neighbours agree. */
  lean: number;
  /** Direction the lean points in, radians. */
  leanRoll: number;
  /** Which of the pre-generated variants this instance uses. */
  variant: number;
}

export interface ForestPlacementOptions {
  seed: number;
  /** Half-extent of the square the trees are placed over, in metres. */
  size: number;
  /** Centre of the square, default the origin. */
  centreX?: number;
  centreZ?: number;
  field: ForestField;
  /** Base Poisson radius before the density multiplier, in metres. */
  poissonRadius?: number;
  /** Overrides for the density and scale defaults. */
  streamDensity?: number;
  streamDecay?: number;
  streamMargin?: number;
  hillStart?: number;
  hillEnd?: number;
  maxSlope?: number;
  minScale?: number;
  maxScale?: number;
  maxLean?: number;
  /** Rim-belt multiplier and width. See `DEFAULT_FOREST_PLACEMENT`. */
  rimDensity?: number;
  rimBeltWidth?: number;
  /** Cap on the number of trees, as a guard against a pathological field. */
  maxTrees?: number;
}

/** Smoothstep, written out so the maths is local to this module. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How many times denser than the base the cover is at one point.
 *
 * Returns 0 where nothing grows, so the caller can reject outright rather than
 * having to know which of three reasons applied.
 */
export function forestDensityAt(
  x: number,
  z: number,
  field: ForestField,
  options: Partial<ForestPlacementOptions> = {},
): number {
  const o = { ...DEFAULT_FOREST_PLACEMENT, ...options };

  const h = field.heightAt(x, z);
  let d = 1 - smoothstep(o.hillStart, o.hillEnd, h);

  const normal = field.normalAt?.(x, z);
  if (normal) {
    const slope = 1 - Math.min(1, Math.max(0, normal.y));
    d *= 1 - smoothstep(o.maxSlope * 0.5, o.maxSlope, slope);
  }

  const stream = field.distanceToStream?.(x, z);
  if (stream !== undefined) {
    if (stream < o.streamMargin) return 0;
    d *= 1 + (o.streamDensity - 1) * Math.exp(-stream / o.streamDecay);
  }

  // The rim belt, last and deliberately so. It multiplies rather than returns,
  // because the belt has to beat the hill thinning above - a rim that only
  // added to whatever was left would still leave a bald ridge, which is the
  // thing it exists to prevent.
  const size = field.sizeMetres;
  if (size !== undefined && Number.isFinite(size) && size > 0) {
    const half = size / 2;
    const edge = Math.min(half - Math.abs(x), half - Math.abs(z));
    if (edge < o.rimBeltWidth) {
      const belt = 1 - Math.max(0, edge) / o.rimBeltWidth;
      d *= 1 + (o.rimDensity - 1) * belt * belt;
    }
  }

  return Math.max(0, d);
}

/**
 * Poisson radius at one point: the base radius scaled by the inverse square
 * root of the density, because density is trees per unit area and area scales
 * with the square of the spacing.
 */
function poissonRadiusAt(x: number, z: number, base: number, field: ForestField, options: Partial<ForestPlacementOptions>): number {
  const d = forestDensityAt(x, z, field, options);
  if (d <= 0) return Infinity;
  return base / Math.sqrt(d);
}

/**
 * Bridson's Poisson disk sampling over a square, with a position-dependent
 * radius.
 *
 * The background grid's cell size is the SMALLEST radius the field can
 * produce, because a cell must never be wider than the closest two points are
 * allowed to be. Sizing it from the average or the maximum silently allows
 * overlaps wherever the density rises.
 */
export function poissonDisk(options: {
  seed: number;
  size: number;
  centreX?: number;
  centreZ?: number;
  baseRadius: number;
  field: ForestField;
  /** Same partial options `forestDensityAt` takes. */
  density?: Partial<ForestPlacementOptions>;
  /** Safety cap. The algorithm terminates on its own; this bounds a bad field. */
  maxPoints?: number;
}): Array<{ x: number; z: number }> {
  const rng = createRng(options.seed | 0);
  const centreX = options.centreX ?? 0;
  const centreZ = options.centreZ ?? 0;
  const half = options.size / 2;

  // The densest possible radius sets the cell size.
  let minRadius = Infinity;
  const probes = 24;
  for (let i = 0; i < probes; i++) {
    for (let j = 0; j < probes; j++) {
      const x = centreX - half + (options.size * (i + 0.5)) / probes;
      const z = centreZ - half + (options.size * (j + 0.5)) / probes;
      const r = poissonRadiusAt(x, z, options.baseRadius, options.field, options.density ?? {});
      if (r < minRadius) minRadius = r;
    }
  }
  if (!Number.isFinite(minRadius)) return [];

  const cell = Math.max(minRadius, 0.05);
  const cols = Math.max(1, Math.ceil(options.size / cell));
  const rows = cols;
  // A LIST per cell, not one slot. Two points closer than one cell apart are
  // legal whenever the two radii involved are smaller than the cell size, and
  // with a single slot the second one overwrites the first - which makes it
  // invisible to every later neighbour test and lets the pair stand closer
  // than the radius allows.
  const grid: number[][] = Array.from({ length: cols * rows }, () => []);
  const points: Array<{ x: number; z: number }> = [];
  const active: number[] = [];
  const maxPoints = options.maxPoints ?? 200000;

  const inside = (x: number, z: number): boolean =>
    x >= centreX - half && x <= centreX + half && z >= centreZ - half && z <= centreZ + half;

  /** Can a point with radius r go here? Checks every cell the radius reaches. */
  const farEnough = (x: number, z: number, r: number): boolean => {
    const reach = Math.ceil(r / cell);
    const cx = Math.floor((x - (centreX - half)) / cell);
    const cz = Math.floor((z - (centreZ - half)) / cell);
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const gx = cx + dx;
        const gz = cz + dz;
        if (gx < 0 || gz < 0 || gx >= cols || gz >= rows) continue;
        for (const other of grid[gz * cols + gx]) {
          const p = points[other];
          const otherR = poissonRadiusAt(p.x, p.z, options.baseRadius, options.field, options.density ?? {});
          // The mean of the two radii. The sum would halve the spacing wherever
          // two densities meet; the max would over-thin the sparse side.
          if (Math.hypot(p.x - x, p.z - z) < (r + otherR) / 2) return false;
        }
      }
    }
    return true;
  };

  const push = (x: number, z: number): void => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - (centreX - half)) / cell)));
    const cz = Math.min(rows - 1, Math.max(0, Math.floor((z - (centreZ - half)) / cell)));
    grid[cz * cols + cx].push(points.length);
    points.push({ x, z });
    active.push(points.length - 1);
  };

  // Seed from the centre, then let Bridson's active list take over.
  let seeded = false;
  for (let attempt = 0; attempt < 200 && !seeded; attempt++) {
    const x = centreX + (rng() - 0.5) * options.size * 0.5;
    const z = centreZ + (rng() - 0.5) * options.size * 0.5;
    const r = poissonRadiusAt(x, z, options.baseRadius, options.field, options.density ?? {});
    if (Number.isFinite(r) && inside(x, z)) {
      push(x, z);
      seeded = true;
    }
  }
  if (!seeded) return [];

  while (active.length > 0 && points.length < maxPoints) {
    // Pick from the active list at random rather than in order: taking them in
    // order fills the domain in a spiral and leaves a visible seam.
    const pick = Math.floor(rng() * active.length);
    const index = active[pick];
    const p = points[index];
    const r = poissonRadiusAt(p.x, p.z, options.baseRadius, options.field, options.density ?? {});

    let placed = false;
    for (let k = 0; k < 30; k++) {
      const angle = rng() * Math.PI * 2;
      // Between r and 2r, never closer: a candidate nearer than r would be
      // rejected by the very point that generated it.
      const dist = r + rng() * r;
      const qx = p.x + Math.cos(angle) * dist;
      const qz = p.z + Math.sin(angle) * dist;
      if (!inside(qx, qz)) continue;
      // The candidate's own radius, not the parent's. A candidate in a
      // zero-density band - inside the stream margin, say - has an infinite
      // radius and must be rejected outright: pushing it puts a tree in the
      // water, and an infinite radius then makes every later neighbour test
      // against it fail forever.
      const qr = poissonRadiusAt(qx, qz, options.baseRadius, options.field, options.density ?? {});
      if (!Number.isFinite(qr)) continue;
      if (!farEnough(qx, qz, qr)) continue;
      push(qx, qz);
      placed = true;
      break;
    }
    if (!placed) {
      active[pick] = active[active.length - 1];
      active.pop();
    }
  }

  return points;
}

/**
 * Place the forest.
 *
 * Every tree gets a variant from the pre-generated set, a uniform scale inside
 * the plan's range, a Y rotation, and a lean taken from noise sampled at its
 * own position - so neighbouring trees lean in similar directions, the way a
 * wood on a windy hillside does, instead of each one leaning somewhere else.
 */
export function placeTrees(options: ForestPlacementOptions): TreeInstance[] {
  const o = { ...DEFAULT_FOREST_PLACEMENT, ...options };
  const rng = createRng((options.seed * 7919) | 0);
  const noise = new SimplexNoise2D((options.seed * 104729) | 0);

  const samples = poissonDisk({
    seed: options.seed,
    size: options.size,
    centreX: options.centreX,
    centreZ: options.centreZ,
    baseRadius: options.poissonRadius ?? DEFAULT_POISSON_RADIUS,
    field: options.field,
    density: options,
    maxPoints: options.maxTrees,
  });

  // Living-type weights, normalized. The dead share is applied on top, so
  // these three always sum to one and the mix the plan asks for is exact.
  const livingTotal = TREE_TYPE_COUNTS.oak + TREE_TYPE_COUNTS.deciduous + TREE_TYPE_COUNTS.sapling;
  const weights: Array<[TreeType, number]> = [
    ['oak', TREE_TYPE_COUNTS.oak / livingTotal],
    ['deciduous', TREE_TYPE_COUNTS.deciduous / livingTotal],
    ['sapling', TREE_TYPE_COUNTS.sapling / livingTotal],
  ];

  const out: TreeInstance[] = [];
  for (const p of samples) {
    const pollution = Math.min(1, Math.max(0, options.field.pollutionAt?.(p.x, p.z) ?? 0));
    const deadChance = DEAD_BASE_PROBABILITY + (DEAD_MAX_PROBABILITY - DEAD_BASE_PROBABILITY) * pollution;

    let type: TreeType = 'sapling';
    const u = rng();
    if (u < deadChance) {
      type = 'dead';
    } else {
      // Rescale into the living share, so a dead roll does not also steal from
      // the saplings.
      const v = (u - deadChance) / (1 - deadChance);
      let acc = 0;
      for (const [t, w] of weights) {
        acc += w;
        if (v <= acc) {
          type = t;
          break;
        }
      }
    }

    // Lean from noise at the tree's own position: neighbours agree in
    // direction, which is what a wood on a windy hillside looks like.
    const leanAngle = noise.noise(p.x * 0.012, p.z * 0.012) * Math.PI * 2;
    const leanAmount = o.maxLean * (0.25 + 0.75 * Math.abs(noise.noise(p.x * 0.05 + 11, p.z * 0.05 - 7)));

    out.push({
      type,
      x: p.x,
      y: options.field.heightAt(p.x, p.z),
      z: p.z,
      rotationY: rng() * Math.PI * 2,
      scale: o.minScale + rng() * (o.maxScale - o.minScale),
      lean: leanAmount,
      leanRoll: leanAngle,
      variant: Math.floor(rng() * VARIANTS_PER_TYPE) % VARIANTS_PER_TYPE,
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* level of detail                                                            */
/* -------------------------------------------------------------------------- */

/** Which level of detail one tree is drawn at. */
export type TreeLod = 0 | 1 | 2;

/** Index lists into a placement, one per LOD tier. */
export interface ForestTiers {
  /** Full L-system geometry. */
  near: number[];
  /** One tapered cylinder and one canopy sphere. */
  medium: number[];
  /** A cross of two quads with a billboard. */
  far: number[];
}

/** Default LOD split, re-exported so callers do not hard-code the numbers. */
export const DEFAULT_LOD_OPTIONS: { near: number; medium: number } = {
  near: LOD_NEAR_DISTANCE,
  medium: LOD_MEDIUM_DISTANCE,
};

/** A caller-supplied LOD split. Both thresholds are optional and in metres. */
export interface LodOptions {
  near?: number;
  medium?: number;
}

/**
 * Sort a placement into the three LOD tiers by distance to the camera.
 *
 * Pure: the same placement and the same two numbers always produce the same
 * three lists. `Forest` is what turns them into instance matrices, and it
 * throttles that to when the camera has actually moved far enough to be worth
 * the rewrite.
 *
 * The distances are squared throughout. There is no square root anywhere in
 * this function, and there does not need to be: comparing squared distances
 * against squared thresholds gives the same partition, and it removes a square
 * root per tree per call.
 */
export function tierTrees(
  trees: readonly TreeInstance[],
  cameraX: number,
  cameraZ: number,
  options: LodOptions = {},
): ForestTiers {
  const o = { ...DEFAULT_LOD_OPTIONS, ...options };
  const nearLimit = o.near * o.near;
  const mediumLimit = o.medium * o.medium;

  const tiers: ForestTiers = { near: [], medium: [], far: [] };
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    const dx = t.x - cameraX;
    const dz = t.z - cameraZ;
    const d2 = dx * dx + dz * dz;
    if (d2 <= nearLimit) tiers.near.push(i);
    else if (d2 <= mediumLimit) tiers.medium.push(i);
    else tiers.far.push(i);
  }
  return tiers;
}

/** The tier a single distance falls into. Exposed for the tests and the overlay. */
export function lodForDistance(distance: number, options: LodOptions = {}): TreeLod {
  const o = { ...DEFAULT_LOD_OPTIONS, ...options };
  if (distance <= o.near) return 0;
  if (distance <= o.medium) return 1;
  return 2;
}

/**
 * Trees per hectare the current mix produces, for a given density.
 *
 * Exported because the plan states its tree counts per hectare and this is the
 * number that has to match them.
 */
export function treesPerHectare(density: number): Record<TreeType, number> {
  const perHectare = density * 10000;
  const livingTotal = TREE_TYPE_COUNTS.oak + TREE_TYPE_COUNTS.deciduous + TREE_TYPE_COUNTS.sapling;
  // The dead share is averaged over the map; near the stream it is far higher.
  const deadShare = DEAD_BASE_PROBABILITY;
  const living = perHectare * (1 - deadShare);
  return {
    oak: (living * TREE_TYPE_COUNTS.oak) / livingTotal,
    deciduous: (living * TREE_TYPE_COUNTS.deciduous) / livingTotal,
    sapling: (living * TREE_TYPE_COUNTS.sapling) / livingTotal,
    dead: perHectare * deadShare,
  };
}
