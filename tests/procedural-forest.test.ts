import { describe, it, expect } from 'vitest';
import {
  placeTrees,
  poissonDisk,
  forestDensityAt,
  tierTrees,
  lodForDistance,
  treesPerHectare,
  TREE_TYPES,
  TREE_TYPE_COUNTS,
  DEFAULT_FOREST_PLACEMENT,
  DEFAULT_LOD_OPTIONS,
  DEFAULT_POISSON_RADIUS,
  DEAD_BASE_PROBABILITY,
  DEAD_MAX_PROBABILITY,
  LOD_NEAR_DISTANCE,
  LOD_MEDIUM_DISTANCE,
  type ForestField,
  type TreeInstance,
} from '../src/procedural/ProceduralForest';
import { VARIANTS_PER_TYPE } from '../src/procedural/TreeGenerator';
import { generateTerrain, TERRAIN_SIZE } from '../src/procedural/TerrainGenerator';
import { StreamSpline } from '../src/procedural/StreamSpline';

/** Distance to the stream, from the spline's own nearest field. */
const DISTANCE_FIELD = new StreamSpline().nearestField(TERRAIN_SIZE, 256, 200);
function streamDistance(spline: StreamSpline, x: number, z: number): number {
  const j = Math.min(255, Math.max(0, Math.round((x + TERRAIN_SIZE / 2) / (TERRAIN_SIZE / 255))));
  const i = Math.min(255, Math.max(0, Math.round((z + TERRAIN_SIZE / 2) / (TERRAIN_SIZE / 255))));
  return DISTANCE_FIELD.distance[i * 256 + j];
  void spline;
}

/** Pollution along the stream: 0.9 upstream, 0.6 midstream, 0.2 downstream. */
function streamPollution(spline: StreamSpline, x: number, z: number): number {
  const d = streamDistance(spline, x, z);
  if (d >= 200) return 0;
  const arc = spline.distanceTo({ x, z, y: 0 }).arcLength;
  const t = arc / 485.64;
  return t < 0.34 ? 0.9 : t < 0.67 ? 0.6 : 0.2;
}

/** A flat world with a stream along z = 0 and hills to the north. */
function testField(): ForestField {
  return {
    heightAt: (x, z) => Math.abs(z) * 0.09 + Math.max(0, x) * 0.07,
    normalAt: (x, z) => {
      const dz = Math.sign(z) * 0.09;
      const dx = Math.max(0, x) > 0 ? 0.07 : 0;
      const len = Math.hypot(dx, 1, dz) || 1;
      return { x: -dx / len, y: 1 / len, z: -dz / len };
    },
    distanceToStream: (_x, z) => Math.abs(z),
    pollutionAt: (_x, z) => Math.max(0, 1 - Math.abs(z) / 60),
  };
}

/** Every pair of trees closer than `limit`, capped so a failure is readable. */
function tooClose(trees: readonly TreeInstance[], limit: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < trees.length && out.length < 5; i++) {
    for (let j = i + 1; j < trees.length && out.length < 5; j++) {
      const d = Math.hypot(trees[i].x - trees[j].x, trees[i].z - trees[j].z);
      if (d < limit) out.push(`${i}-${j} at ${d.toFixed(3)}`);
    }
  }
  return out;
}

describe('forest density', () => {
  it('is denser near the stream than far from it', () => {
    const field = testField();
    const near = forestDensityAt(0, 4, field);
    const far = forestDensityAt(0, 90, field);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });

  it('is zero inside the stream margin', () => {
    const field = testField();
    const margin = DEFAULT_FOREST_PLACEMENT.streamMargin;
    expect(forestDensityAt(0, 0, field)).toBe(0);
    expect(forestDensityAt(0, margin - 0.01, field)).toBe(0);
    expect(forestDensityAt(0, margin + 0.5, field)).toBeGreaterThan(0);
  });

  it('thins with height and reaches zero above the hill ceiling', () => {
    const field: ForestField = { heightAt: (_x, z) => z };
    const low = forestDensityAt(0, 2, field, { hillStart: 10, hillEnd: 14 });
    const mid = forestDensityAt(0, 12, field, { hillStart: 10, hillEnd: 14 });
    const top = forestDensityAt(0, 20, field, { hillStart: 10, hillEnd: 14 });
    expect(low).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
    expect(top).toBe(0);
  });

  it('is zero on a face steeper than the slope limit', () => {
    // A wall: the normal is horizontal, so the slope is 1.
    const field: ForestField = {
      heightAt: (x) => x * 10,
      normalAt: (x) => {
        const len = Math.hypot(10, 1) || 1;
        void x;
        return { x: -10 / len, y: 1 / len, z: 0 };
      },
    };
    expect(forestDensityAt(0, 0, field)).toBe(0);
  });

  it('works with only a height function', () => {
    // The slope and stream samplers are optional. Without them there is simply
    // no slope rejection and no stream boost.
    const field: ForestField = { heightAt: () => 0 };
    expect(forestDensityAt(0, 0, field)).toBe(1);
  });
});

describe('poissonDisk', () => {
  it('keeps every point inside the square', () => {
    const points = poissonDisk({
      seed: 3,
      size: 100,
      baseRadius: 5,
      field: testField(),
    });
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(-50);
      expect(p.x).toBeLessThanOrEqual(50);
      expect(p.z).toBeGreaterThanOrEqual(-50);
      expect(p.z).toBeLessThanOrEqual(50);
    }
  });

  it('never places two points closer than the mean of their radii', () => {
    // The no-overlap rule this module actually enforces. A single slot per grid
    // cell would silently lose the second of two close points and let the pair
    // stand closer than the radius allows.
    const points = poissonDisk({ seed: 5, size: 120, baseRadius: 6, field: { heightAt: () => 0 } });
    expect(points.length).toBeGreaterThan(50);
    const bad = tooClose(
      points.map((p) => ({ ...p, y: 0, type: 'oak', rotationY: 0, scale: 1, lean: 0, leanRoll: 0, variant: 0 })),
      6,
    );
    expect(bad).toEqual([]);
  });

  it('honours the position-dependent radius', () => {
    // Twice the density means half the area per point, so the radius shrinks by
    // the square root of two. A radius that ignored the density would leave the
    // gaps the stream boost was supposed to fill.
    // The baseline has no stream sampler at all, so its density is 1
    // everywhere. Comparing against a field that already carries the default
    // stream boost would measure the difference between two boosts rather than
    // the effect of having one.
    const flat: ForestField = { heightAt: () => 0 };
    const flatStream: ForestField = { heightAt: () => 0, distanceToStream: (_x, z) => Math.abs(z) };
    const plain = poissonDisk({ seed: 5, size: 120, baseRadius: 6, field: flat });
    const boosted = poissonDisk({
      seed: 5,
      size: 120,
      baseRadius: 6,
      field: flatStream,
      density: { streamDensity: 3, streamDecay: 20, streamMargin: 0 },
    });
    expect(boosted.length).toBeGreaterThan(plain.length);
  });

  it('places nothing where the density is zero', () => {
    const points = poissonDisk({
      seed: 5,
      size: 120,
      baseRadius: 6,
      field: testField(),
      density: { streamMargin: 1000 },
    });
    expect(points).toEqual([]);
  });

  it('is deterministic', () => {
    const a = poissonDisk({ seed: 9, size: 90, baseRadius: 5, field: testField() });
    const b = poissonDisk({ seed: 9, size: 90, baseRadius: 5, field: testField() });
    const c = poissonDisk({ seed: 10, size: 90, baseRadius: 5, field: testField() });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('terminates', () => {
    // Bridson's terminates on its own, but a field with no growable area at all
    // must not spin.
    const started = Date.now();
    const points = poissonDisk({ seed: 1, size: 200, baseRadius: 3, field: { heightAt: () => 500 } });
    expect(points).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('placeTrees', () => {
  const placement = placeTrees({ seed: 7, size: 120, field: testField() });

  it('places a plausible number of trees', () => {
    expect(placement.length).toBeGreaterThan(50);
    expect(placement.length).toBeLessThan(5000);
  });

  it('uses every tree type', () => {
    for (const type of TREE_TYPES) {
      expect(placement.some((t) => t.type === type), type).toBe(true);
    }
  });

  it('matches the plan type mix', () => {
    // The fractions are fixed by TREE_TYPE_COUNTS and are the same at every
    // density, so they can be checked on any field. The absolute per-hectare
    // count is checked against the real terrain below, because a small test
    // field is dominated by the stream boost and is not representative.
    const living = TREE_TYPE_COUNTS.oak + TREE_TYPE_COUNTS.deciduous + TREE_TYPE_COUNTS.sapling;
    const share = (type: TreeInstance['type']): number => {
      const ofType = placement.filter((t) => t.type === type).length;
      const alive = placement.filter((t) => t.type !== 'dead').length;
      return ofType / Math.max(1, alive);
    };
    expect(share('oak')).toBeCloseTo(TREE_TYPE_COUNTS.oak / living, 1);
    expect(share('deciduous')).toBeCloseTo(TREE_TYPE_COUNTS.deciduous / living, 1);
    expect(share('sapling')).toBeCloseTo(TREE_TYPE_COUNTS.sapling / living, 1);
    // And the dead share sits between the two bounds.
    const dead = placement.filter((t) => t.type === 'dead').length / placement.length;
    expect(dead).toBeGreaterThanOrEqual(DEAD_BASE_PROBABILITY - 0.02);
    expect(dead).toBeLessThanOrEqual(DEAD_MAX_PROBABILITY + 0.02);
  });

  it('puts every tree on the terrain and out of the stream', () => {
    const field = testField();
    for (const t of placement) {
      expect(t.y).toBeCloseTo(field.heightAt(t.x, t.z), 6);
      expect(Math.abs(t.z)).toBeGreaterThanOrEqual(DEFAULT_FOREST_PLACEMENT.streamMargin - 1e-6);
    }
  });

  it('scales every tree inside the plan 0.8 to 1.2', () => {
    for (const t of placement) {
      expect(t.scale).toBeGreaterThanOrEqual(DEFAULT_FOREST_PLACEMENT.minScale);
      expect(t.scale).toBeLessThanOrEqual(DEFAULT_FOREST_PLACEMENT.maxScale);
    }
    // And the range is actually used, not clamped to one value.
    const scales = placement.map((t) => t.scale);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.2);
  });

  it('gives every tree a rotation and a valid variant', () => {
    for (const t of placement) {
      expect(t.rotationY).toBeGreaterThanOrEqual(0);
      expect(t.rotationY).toBeLessThanOrEqual(Math.PI * 2);
      expect(t.variant).toBeGreaterThanOrEqual(0);
      expect(t.variant).toBeLessThan(VARIANTS_PER_TYPE);
      expect(Number.isInteger(t.variant)).toBe(true);
    }
    expect(new Set(placement.map((t) => t.variant)).size).toBe(VARIANTS_PER_TYPE);
  });

  it('leans every tree by no more than the maximum', () => {
    for (const t of placement) {
      expect(Math.abs(t.lean)).toBeLessThanOrEqual(DEFAULT_FOREST_PLACEMENT.maxLean + 1e-9);
      expect(t.lean).toBeGreaterThan(0);
    }
  });

  it('leans neighbouring trees in similar directions', () => {
    // The lean comes from noise sampled at the tree's own position, which is
    // what makes a wood on a windy hillside lean as a wood rather than as a
    // set of independent trees.
    const sorted = [...placement].sort((a, b) => a.z - b.z || a.x - b.x);
    let agreeing = 0;
    let pairs = 0;
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (Math.hypot(a.x - b.x, a.z - b.z) > 14) continue;
      const diff = Math.abs(Math.atan2(Math.sin(a.leanRoll - b.leanRoll), Math.cos(a.leanRoll - b.leanRoll)));
      pairs++;
      if (diff < Math.PI / 2) agreeing++;
    }
    expect(pairs).toBeGreaterThan(5);
    expect(agreeing / pairs).toBeGreaterThan(0.6);
  });

  it('raises the dead share where the stream is polluted', () => {
    const clean = placeTrees({
      seed: 7,
      size: 120,
      field: { ...testField(), pollutionAt: () => 0 },
    });
    const fouled = placeTrees({
      seed: 7,
      size: 120,
      field: { ...testField(), pollutionAt: () => 1 },
    });
    const deadShare = (trees: readonly TreeInstance[]): number =>
      trees.filter((t) => t.type === 'dead').length / trees.length;
    expect(deadShare(clean)).toBeCloseTo(DEAD_BASE_PROBABILITY, 1);
    expect(deadShare(fouled)).toBeGreaterThan(deadShare(clean) + 0.15);
    expect(deadShare(fouled)).toBeLessThanOrEqual(DEAD_MAX_PROBABILITY + 0.02);
  });

  it('never lets the dead share crowd out the living mix entirely', () => {
    const fouled = placeTrees({ seed: 7, size: 120, field: { ...testField(), pollutionAt: () => 1 } });
    // Three in ten at the very worst, so the wood still reads as a wood that is
    // dying at one end rather than as a graveyard.
    expect(fouled.some((t) => t.type === 'sapling')).toBe(true);
    expect(fouled.some((t) => t.type === 'deciduous')).toBe(true);
  });

  it('is deterministic and moves with the seed', () => {
    const a = placeTrees({ seed: 11, size: 90, field: testField() });
    const b = placeTrees({ seed: 11, size: 90, field: testField() });
    const c = placeTrees({ seed: 12, size: 90, field: testField() });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('honours a radius override', () => {
    const dense = placeTrees({ seed: 3, size: 120, field: testField(), poissonRadius: 5 });
    const sparse = placeTrees({ seed: 3, size: 120, field: testField(), poissonRadius: 9 });
    expect(dense.length).toBeGreaterThan(sparse.length);
  });

  it('places the whole forest fast enough to build once at startup', () => {
    const started = Date.now();
    placeTrees({ seed: 7, size: 500, field: testField() });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('level of detail', () => {
  const trees: TreeInstance[] = [
    { type: 'oak', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, lean: 0, leanRoll: 0, variant: 0 },
    { type: 'oak', x: 20, y: 0, z: 0, rotationY: 0, scale: 1, lean: 0, leanRoll: 0, variant: 0 },
    { type: 'oak', x: 60, y: 0, z: 0, rotationY: 0, scale: 1, lean: 0, leanRoll: 0, variant: 0 },
    { type: 'oak', x: 200, y: 0, z: 0, rotationY: 0, scale: 1, lean: 0, leanRoll: 0, variant: 0 },
  ];

  it('splits the three tiers at the plan distances', () => {
    const tiers = tierTrees(trees, 0, 0);
    expect(tiers.near).toEqual([0, 1]);
    expect(tiers.medium).toEqual([2]);
    expect(tiers.far).toEqual([3]);
  });

  it('puts the boundary distances in the near and medium tiers', () => {
    const at = (d: number): TreeInstance => ({
      type: 'oak',
      x: d,
      y: 0,
      z: 0,
      rotationY: 0,
      scale: 1,
      lean: 0,
      leanRoll: 0,
      variant: 0,
    });
    const tiers = tierTrees([at(LOD_NEAR_DISTANCE), at(LOD_NEAR_DISTANCE + 0.01), at(LOD_MEDIUM_DISTANCE), at(LOD_MEDIUM_DISTANCE + 0.01)], 0, 0);
    expect(tiers.near).toContain(0);
    expect(tiers.medium).toContain(1);
    expect(tiers.medium).toContain(2);
    expect(tiers.far).toContain(3);
  });

  it('partitions exhaustively and disjointly', () => {
    const placement = placeTrees({ seed: 4, size: 120, field: testField() });
    const tiers = tierTrees(placement, 10, -20);
    const all = [...tiers.near, ...tiers.medium, ...tiers.far];
    expect(all).toHaveLength(placement.length);
    expect(new Set(all).size).toBe(placement.length);
  });

  it('moves a tree between tiers as the camera moves', () => {
    const tiers = tierTrees(trees, 200, 0);
    // The tree at x=200 is now at the camera.
    expect(tiers.near).toContain(3);
    expect(tiers.far).toContain(0);
  });

  it('compares squared distances and takes no square root', () => {
    // The partition is identical to comparing real distances, and it removes a
    // square root per tree per call.
    const placement = placeTrees({ seed: 4, size: 120, field: testField() });
    const tiers = tierTrees(placement, 15, 25);
    for (const i of tiers.near) {
      expect(Math.hypot(placement[i].x - 15, placement[i].z - 25)).toBeLessThanOrEqual(LOD_NEAR_DISTANCE);
    }
    for (const i of tiers.medium) {
      const d = Math.hypot(placement[i].x - 15, placement[i].z - 25);
      expect(d).toBeGreaterThan(LOD_NEAR_DISTANCE);
      expect(d).toBeLessThanOrEqual(LOD_MEDIUM_DISTANCE);
    }
    for (const i of tiers.far) {
      expect(Math.hypot(placement[i].x - 15, placement[i].z - 25)).toBeGreaterThan(LOD_MEDIUM_DISTANCE);
    }
  });

  it('honours a threshold override', () => {
    // Trees at 0, 20, 60 and 200 m. With near=10 only the first is near; 20
    // and 60 fall inside 10..30 and 30..200 respectively.
    const tiers = tierTrees(trees, 0, 0, { near: 10, medium: 30 });
    expect(tiers.near).toEqual([0]);
    expect(tiers.medium).toEqual([1]);
    expect(tiers.far).toEqual([2, 3]);
  });

  it('classifies a single distance', () => {
    expect(lodForDistance(0)).toBe(0);
    expect(lodForDistance(LOD_NEAR_DISTANCE)).toBe(0);
    expect(lodForDistance(LOD_NEAR_DISTANCE + 1)).toBe(1);
    expect(lodForDistance(LOD_MEDIUM_DISTANCE)).toBe(1);
    expect(lodForDistance(LOD_MEDIUM_DISTANCE + 1)).toBe(2);
    expect(lodForDistance(1000)).toBe(2);
  });

  it('keeps the default thresholds the plan asks for', () => {
    expect(DEFAULT_LOD_OPTIONS.near).toBe(30);
    expect(DEFAULT_LOD_OPTIONS.medium).toBe(80);
  });
});

describe('density reporting', () => {
  it('reports the plan mix per hectare', () => {
    const perHa = treesPerHectare(DEFAULT_POISSON_RADIUS);
    expect(perHa.oak).toBeGreaterThan(0);
    expect(perHa.deciduous).toBeGreaterThan(perHa.oak);
    expect(perHa.sapling).toBeGreaterThan(perHa.deciduous);
    expect(perHa.dead).toBeGreaterThan(0);
    // The four must account for the whole hectare.
    const total = perHa.oak + perHa.deciduous + perHa.sapling + perHa.dead;
    expect(total).toBeCloseTo(10000 * DEFAULT_POISSON_RADIUS, 0);
  });

  it('uses the plan type counts', () => {
    // 6-10 oaks, 30-50 deciduous, 50-100 saplings per hectare. These are the
    // weights, and treesPerHectare scales them by the achieved density.
    expect(TREE_TYPE_COUNTS.oak).toBeGreaterThanOrEqual(6);
    expect(TREE_TYPE_COUNTS.oak).toBeLessThanOrEqual(10);
    expect(TREE_TYPE_COUNTS.deciduous).toBeGreaterThanOrEqual(30);
    expect(TREE_TYPE_COUNTS.deciduous).toBeLessThanOrEqual(50);
    expect(TREE_TYPE_COUNTS.sapling).toBeGreaterThanOrEqual(50);
    expect(TREE_TYPE_COUNTS.sapling).toBeLessThanOrEqual(100);
  });

  it('scales the mix linearly with density', () => {
    // Twice the density is twice the trees per hectare of every type, and the
    // dead share is a fixed fraction of the whole.
    const a = treesPerHectare(0.01);
    const b = treesPerHectare(0.02);
    expect(b.oak).toBeCloseTo(a.oak * 2, 6);
    expect(b.deciduous).toBeCloseTo(a.deciduous * 2, 6);
    expect(b.sapling).toBeCloseTo(a.sapling * 2, 6);
    expect(b.dead).toBeCloseTo(a.dead * 2, 6);
  });
});

describe('the forest on the real terrain', () => {
  it('lands in the plan per-hectare range', () => {
    // 2,150 to 4,000 trees over the 500 m world, so 86 to 160 per hectare, and
    // 6-10 oaks, 30-50 deciduous, 50-100 saplings within that. This is the
    // acceptance criterion for the whole density question, and it can only be
    // checked against the terrain the game actually ships.
    const spline = new StreamSpline();
    const terrain = generateTerrain({ seed: 7, spline });
    const field: ForestField = {
      heightAt: (x, z) => terrain.heightAt(x, z),
      normalAt: (x, z) => terrain.normalAt(x, z),
      distanceToStream: (x, z) => streamDistance(spline, x, z),
      pollutionAt: (x, z) => streamPollution(spline, x, z),
    };
    const trees = placeTrees({ seed: 7, size: TERRAIN_SIZE, field });
    const perHa = treesPerHectare(trees.length / (TERRAIN_SIZE * TERRAIN_SIZE));
    const total = perHa.oak + perHa.deciduous + perHa.sapling + perHa.dead;

    expect(total, `total ${total.toFixed(1)}/ha`).toBeGreaterThanOrEqual(86);
    expect(total, `total ${total.toFixed(1)}/ha`).toBeLessThanOrEqual(160);
    expect(perHa.oak, `oak ${perHa.oak.toFixed(1)}/ha`).toBeGreaterThanOrEqual(6);
    expect(perHa.oak, `oak ${perHa.oak.toFixed(1)}/ha`).toBeLessThanOrEqual(10);
    expect(perHa.deciduous, `deciduous ${perHa.deciduous.toFixed(1)}/ha`).toBeGreaterThanOrEqual(30);
    expect(perHa.deciduous, `deciduous ${perHa.deciduous.toFixed(1)}/ha`).toBeLessThanOrEqual(50);
    expect(perHa.sapling, `sapling ${perHa.sapling.toFixed(1)}/ha`).toBeGreaterThanOrEqual(50);
    expect(perHa.sapling, `sapling ${perHa.sapling.toFixed(1)}/ha`).toBeLessThanOrEqual(100);
  }, 120000);
});
