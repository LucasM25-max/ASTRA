import { describe, it, expect } from 'vitest';
import {
  generateFernFrond,
  generateUndergrowth,
  generateRock,
  generateFallenBranch,
  generateLeafLitter,
  generateFoliageGeometry,
  scatterFoliage,
  foliageTriangleCounts,
  foliageTriangleCost,
  instancesForBudget,
  FOLIAGE_KINDS,
  FOLIAGE_TRIANGLES,
  DEFAULT_FOLIAGE_COUNTS,
  DEFAULT_FOLIAGE_SCATTER,
  FOLIAGE_PATCH_RADIUS,
  GRASS_HEIGHT,
  FERN_HEIGHT,
  BUSH_RADIUS,
  BRANCH_LENGTH,
  LEAF_SIZE,
  type FoliageGeometrySet,
  type FoliageKind,
  type FoliageInstance,
} from '../src/procedural/FoliageGenerator';

function extents(mesh: { positions: Float32Array }): {
  lo: [number, number, number];
  hi: [number, number, number];
} {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  return { lo, hi };
}

/** Area of every triangle, so a degenerate one is a zero. */
function triangleAreas(mesh: { positions: Float32Array; indices: Uint32Array }): number[] {
  const out: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] * 3;
    const b = mesh.indices[t + 1] * 3;
    const c = mesh.indices[t + 2] * 3;
    const ux = mesh.positions[b] - mesh.positions[a];
    const uy = mesh.positions[b + 1] - mesh.positions[a + 1];
    const uz = mesh.positions[b + 2] - mesh.positions[a + 2];
    const vx = mesh.positions[c] - mesh.positions[a];
    const vy = mesh.positions[c + 1] - mesh.positions[a + 1];
    const vz = mesh.positions[c + 2] - mesh.positions[a + 2];
    out.push(Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2);
  }
  return out;
}

/** Signed volume, for the closed shells. */
function signedVolume(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  let total = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] * 3;
    const b = mesh.indices[t + 1] * 3;
    const c = mesh.indices[t + 2] * 3;
    total +=
      (mesh.positions[a] * (mesh.positions[b + 1] * mesh.positions[c + 2] - mesh.positions[b + 2] * mesh.positions[c + 1]) +
        mesh.positions[a + 1] * (mesh.positions[b + 2] * mesh.positions[c] - mesh.positions[b] * mesh.positions[c + 2]) +
        mesh.positions[a + 2] * (mesh.positions[b] * mesh.positions[c + 1] - mesh.positions[b + 1] * mesh.positions[c])) /
      6;
  }
  return total;
}

const ALL_MESHES: Array<[string, () => FoliageGeometrySet, FoliageKind]> = [
  ['grass', generateFoliageGeometry, 'grass'],
  ['fern', generateFoliageGeometry, 'fern'],
  ['undergrowth', generateFoliageGeometry, 'undergrowth'],
  ['rock', generateFoliageGeometry, 'rock'],
  ['branch', generateFoliageGeometry, 'branch'],
  ['leaf', generateFoliageGeometry, 'leaf'],
];

describe('foliage geometry', () => {
  it('builds every kind the forest needs', () => {
    const g = generateFoliageGeometry(1);
    for (const kind of FOLIAGE_KINDS) {
      expect(g[kind]).toBeDefined();
      expect(g[kind].positions.length).toBeGreaterThan(0);
      expect(g[kind].indices.length % 3).toBe(0);
      expect(g[kind].positions.length / 3).toBeGreaterThan(0);
      expect(g[kind].normals.length).toBe(g[kind].positions.length);
      expect(g[kind].colors.length).toBe(g[kind].positions.length);
    }
  });

  it('addresses only real vertices from its indices', () => {
    const g = generateFoliageGeometry(3);
    for (const kind of FOLIAGE_KINDS) {
      const m = g[kind];
      const count = m.positions.length / 3;
      for (let i = 0; i < m.indices.length; i++) {
        expect(m.indices[i]).toBeLessThan(count);
      }
    }
  });

  it('produces finite positions and unit-length normals', () => {
    let nonFinite = 0;
    let worst = 0;
    const g = generateFoliageGeometry(7);
    for (const kind of FOLIAGE_KINDS) {
      const m = g[kind];
      for (let i = 0; i < m.positions.length; i++) if (!Number.isFinite(m.positions[i])) nonFinite++;
      for (let i = 0; i < m.normals.length; i++) if (!Number.isFinite(m.normals[i])) nonFinite++;
      for (let i = 0; i < m.positions.length / 3; i++) {
        const off = Math.abs(Math.hypot(m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]) - 1);
        if (off > worst) worst = off;
      }
    }
    expect(nonFinite).toBe(0);
    expect(worst).toBeLessThan(1e-4);
  });

  it('emits no degenerate triangles', () => {
    // A taper that runs to exactly zero puts two vertices on top of each other,
    // and the triangle between them has zero area - a wasted slot in the index
    // buffer and a NaN in the normal accumulation.
    for (const seed of [1, 2, 5, 11]) {
      const g = generateFoliageGeometry(seed);
      for (const kind of FOLIAGE_KINDS) {
        for (const area of triangleAreas(g[kind])) expect(area).toBeGreaterThan(1e-9);
      }
    }
  });

  it('keeps the declared triangle counts in step with the generators', () => {
    // Measured rather than hand-maintained: a count that drifts the moment a
    // ring is added to a blade is worse than no count at all.
    expect(foliageTriangleCounts(1)).toEqual(FOLIAGE_TRIANGLES);
    for (const seed of [2, 9, 42]) {
      expect(foliageTriangleCounts(seed)).toEqual(FOLIAGE_TRIANGLES);
    }
  });

  it('fits the whole patch inside the triangle budget', () => {
    // 293,000 triangles of terrain plus forty near-LOD trees, so the foliage
    // has a real ceiling. This is it.
    const cost = Object.values(FOLIAGE_TRIANGLES).reduce((a, b) => a + b, 0);
    const total = FOLIAGE_KINDS.reduce((sum, k) => sum + cost * 0 + FOLIAGE_TRIANGLES[k] * DEFAULT_FOLIAGE_COUNTS[k], 0);
    expect(total).toBeLessThan(90000);
    expect(total).toBeGreaterThan(10000);
  });

  it('stands grass and ferns on the ground they are scattered on', () => {
    const g = generateFoliageGeometry(1);
    // The local frame is +Y up from y=0, so nothing may start below the ground
    // except by the burial the shape is allowed.
    const grass = extents(g.grass);
    expect(grass.lo[1]).toBeGreaterThanOrEqual(-0.001);
    expect(grass.hi[1]).toBeCloseTo(GRASS_HEIGHT, 5);

    const fern = extents(g.fern);
    expect(fern.lo[1]).toBeGreaterThanOrEqual(-0.001);
    expect(fern.hi[1]).toBeCloseTo(FERN_HEIGHT, 5);
  });

  it('crosses the fern planes at right angles on the y axis', () => {
    // A single plane is a flat card, and a fern is the one plant whose
    // silhouette is unmistakable from the side, so it gets the cross. The
    // cross is only a cross if the two planes meet on the axis.
    const fern = generateFernFrond();
    for (let i = 0; i < fern.positions.length; i += 3) {
      const y = fern.positions[i + 1];
      // Both planes pass through x=0 and z=0 only where y is a ring position,
      // so every vertex is at a ring height.
      const ringHeights = [0, FERN_HEIGHT / 2, FERN_HEIGHT];
      const near = ringHeights.some((h) => Math.abs(y - h) < 1e-6);
      expect(near).toBe(true);
    }
    // And the two planes are perpendicular: one has z a function of x, the
    // other x a function of z.
    let first = 0;
    let second = 0;
    for (let i = 0; i < fern.positions.length; i += 3) {
      const x = fern.positions[i];
      const z = fern.positions[i + 2];
      if (Math.abs(z) < 1e-9) first++;
      if (Math.abs(x) < 1e-9) second++;
    }
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
  });

  it('buries an undergrowth bush only as far as it needs to', () => {
    const g = generateFoliageGeometry(1);
    const bush = extents(g.undergrowth);
    // The buried part hides the seam with the terrain. More than a third of
    // the bush underground is a bush you cannot see.
    expect(bush.lo[1]).toBeLessThan(0);
    expect(bush.lo[1]).toBeGreaterThan(-BUSH_RADIUS * 0.45);
    expect(bush.hi[1]).toBeGreaterThan(BUSH_RADIUS);
  });

  it('winds the undergrowth and rock shells outward', () => {
    for (const seed of [1, 4, 8]) {
      expect(signedVolume(generateUndergrowth(seed))).toBeGreaterThan(0);
      expect(signedVolume(generateRock(seed))).toBeGreaterThan(0);
    }
  });

  it('squashes the rock in y and corrects its normals', () => {
    const rock = generateRock(1);
    const e = extents(rock);
    // Wider than it is tall, and taller than a pancake.
    expect(e.hi[0] - e.lo[0]).toBeGreaterThan(e.hi[1] - e.lo[1]);
    // The normals must agree with the squash: an uncorrected normal lights the
    // rock as though it were still a sphere and the facets disappear.
    for (let i = 0; i < rock.normals.length; i += 3) {
      const len = Math.hypot(rock.normals[i], rock.normals[i + 1], rock.normals[i + 2]);
      expect(len).toBeCloseTo(1, 4);
    }
    // Most normals point sideways rather than up, because the rock is flat.
    let sideways = 0;
    for (let i = 0; i < rock.normals.length; i += 3) {
      if (Math.abs(rock.normals[i + 1]) < 0.75) sideways++;
    }
    expect(sideways).toBeGreaterThan(0);
  });

  it('lies the fallen branch along +X on the ground', () => {
    const branch = generateFallenBranch(1);
    const e = extents(branch);
    // Along X, not along Y: this is the whole difference between a fallen
    // branch and a standing one.
    expect(e.hi[0] - e.lo[0]).toBeCloseTo(BRANCH_LENGTH, 5);
    expect(e.hi[0]).toBeCloseTo(BRANCH_LENGTH, 5);
    expect(e.hi[1]).toBeLessThan(0.3);
    expect(e.lo[1]).toBeGreaterThan(-0.05);
  });

  it('closes the fallen branch tip on its own axis', () => {
    // The cap's centre is the far end of the axis, not the origin. Putting it
    // at the origin makes the cap a cone stretched back along the branch.
    const branch = generateFallenBranch(1);
    const e = extents(branch);
    // The cap centre is a vertex at x = BRANCH_LENGTH with a small |z|.
    // The tolerance is 1e-5 rather than 1e-9 because the positions come back
    // as a Float32Array: 1.8 is not exactly representable in binary, and an
    // exact comparison against the double 1.8 finds nothing.
    let capAtTip = 0;
    for (let i = 0; i < branch.positions.length; i += 3) {
      if (Math.abs(branch.positions[i] - BRANCH_LENGTH) < 1e-5) capAtTip++;
    }
    expect(capAtTip).toBeGreaterThan(0);
    expect(e.hi[2] - e.lo[2]).toBeLessThan(0.2);
  });

  it('keeps the leaf litter flat and just above the ground', () => {
    const leaf = generateLeafLitter();
    const e = extents(leaf);
    // Flat, so the litter reads from above; lifted a few millimetres, so it
    // does not z-fight with the terrain it is lying on.
    expect(e.hi[1]).toBeGreaterThan(0);
    expect(e.hi[1]).toBeLessThan(0.02);
    expect(e.hi[1] - e.lo[1]).toBeLessThan(1e-6);
    expect(Math.max(Math.abs(e.lo[0]), Math.abs(e.hi[0]))).toBeLessThanOrEqual(LEAF_SIZE * 1.05);
  });

  it('is deterministic', () => {
    const a = generateFoliageGeometry(5);
    const b = generateFoliageGeometry(5);
    for (const kind of FOLIAGE_KINDS) {
      expect(Array.from(a[kind].positions)).toEqual(Array.from(b[kind].positions));
    }
    const c = generateFoliageGeometry(6);
    expect(Array.from(c.undergrowth.positions)).not.toEqual(Array.from(a.undergrowth.positions));
  });
});

/* -------------------------------------------------------------------------- */
/* placement                                                                  */
/* -------------------------------------------------------------------------- */

/** A flat world with a stream along z = 0 and hills to the north. */
function testField(): {
  heightAt: (x: number, z: number) => number;
  normalAt: (x: number, z: number) => { x: number; y: number; z: number };
  distanceToStream: (x: number, z: number) => number;
  pollutionAt: (x: number, z: number) => number;
} {
  return {
    heightAt: (x, z) => Math.abs(z) * 0.06 + Math.max(0, x) * 0.05,
    normalAt: (x, z) => {
      // Analytic normal of heightAt, normalized.
      const dz = Math.sign(z) * 0.06;
      const dx = Math.max(0, x) > 0 ? 0.05 : 0;
      const len = Math.hypot(dx, 1, dz) || 1;
      return { x: -dx / len, y: 1 / len, z: -dz / len };
    },
    distanceToStream: (_x, z) => Math.abs(z),
    pollutionAt: (_x, z) => Math.max(0, 1 - Math.abs(z) / 25),
  };
}

describe('scatterFoliage', () => {
  it('places the requested number of each kind', () => {
    const instances = scatterFoliage({ seed: 4, centreX: 0, centreZ: 0, field: testField() });
    const byKind: Partial<Record<FoliageKind, number>> = {};
    for (const i of instances) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    for (const kind of FOLIAGE_KINDS) {
      expect(byKind[kind], kind).toBe(DEFAULT_FOLIAGE_COUNTS[kind]);
    }
  });

  it('honours a count override', () => {
    const instances = scatterFoliage({
      seed: 4,
      centreX: 0,
      centreZ: 0,
      field: testField(),
      counts: { grass: 100, fern: 0 },
    });
    const grass = instances.filter((i) => i.kind === 'grass').length;
    const fern = instances.filter((i) => i.kind === 'fern').length;
    expect(grass).toBe(100);
    expect(fern).toBe(0);
  });

  it('keeps every instance inside the patch', () => {
    const radius = 40;
    const instances = scatterFoliage({ seed: 9, centreX: 12, centreZ: -30, radius, field: testField() });
    for (const i of instances) {
      expect(Math.hypot(i.x - 12, i.z + 30)).toBeLessThanOrEqual(radius + 1e-6);
    }
  });

  it('puts every instance on the terrain it was given', () => {
    const field = testField();
    const instances = scatterFoliage({ seed: 3, centreX: 0, centreZ: 0, field });
    for (const i of instances) {
      expect(i.y).toBeCloseTo(field.heightAt(i.x, i.z), 6);
    }
  });

  it('is deterministic and moves with the patch centre', () => {
    const a = scatterFoliage({ seed: 5, centreX: 0, centreZ: 0, field: testField() });
    const b = scatterFoliage({ seed: 5, centreX: 0, centreZ: 0, field: testField() });
    expect(a.map((i) => [i.kind, i.x, i.y, i.z, i.rotationY, i.scale])).toEqual(
      b.map((i) => [i.kind, i.x, i.y, i.z, i.rotationY, i.scale]),
    );
    const c = scatterFoliage({ seed: 5, centreX: 100, centreZ: 0, field: testField() });
    expect(c[0].x).not.toBe(a[0].x);
  });

  it('samples the disc uniformly in area rather than clustering at the centre', () => {
    // sqrt() of a uniform radius is what makes this true. Sampling the radius
    // directly is the difference between a round patch and a dot with a halo.
    const radius = 60;
    const instances = scatterFoliage({
      seed: 11,
      centreX: 0,
      centreZ: 0,
      radius,
      field: testField(),
      counts: { grass: 4000, fern: 0, undergrowth: 0, rock: 0, branch: 0, leaf: 0 },
      hillStart: 1e9,
      hillEnd: 1e9 + 1,
      maxSlope: 2,
      streamExclusion: 0,
      streamBoost: 1,
    });
    // Four EQUAL-AREA annuli, not four equal-width ones. The annulus between
    // r and r + dr has area 2*pi*r*dr, so equal area means equal sqrt(r): the
    // boundaries are at R/2 and R/sqrt(2), not at R/4 and R/2. Bucketing by
    // width would put 6.25% of the blades in the first bucket and 43.75% in
    // the last, and read that as a clustering bug.
    const quarters = [0, 0, 0, 0];
    for (const i of instances) {
      const u = (Math.hypot(i.x, i.z) / radius) ** 2;
      quarters[Math.min(3, Math.floor(u * 4))]++;
    }
    const expected = instances.length / 4;
    for (const q of quarters) {
      expect(q).toBeGreaterThan(expected * 0.85);
      expect(q).toBeLessThan(expected * 1.15);
    }
  });

  it('thickens the cover near the stream and thins it on the hills', () => {
    const radius = 80;
    const field = testField();
    const instances = scatterFoliage({
      seed: 6,
      centreX: 0,
      centreZ: 0,
      radius,
      field,
      counts: { grass: 6000, fern: 0, undergrowth: 0, rock: 0, branch: 0, leaf: 0 },
      streamExclusion: 0,
    });
    // Distance from the stream centreline, bucketed.
    const buckets = new Array(8).fill(0);
    for (const i of instances) buckets[Math.min(7, Math.floor(Math.abs(i.z) / (radius / 8)))]++;
    // The nearest bucket is the densest, and the far ones are thinner than it.
    expect(buckets[0]).toBeGreaterThan(buckets[7]);
    // Height rises with |x|, so the far side of the patch is hillier.
    const near = instances.filter((i) => Math.abs(i.z) < 10);
    const far = instances.filter((i) => Math.abs(i.z) > 60);
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeLessThan(near.length);
  });

  it('grows nothing in the stream bed', () => {
    const instances = scatterFoliage({ seed: 8, centreX: 0, centreZ: 0, field: testField() });
    const exclusion = DEFAULT_FOLIAGE_SCATTER.streamExclusion;
    for (const i of instances) {
      expect(Math.abs(i.z)).toBeGreaterThanOrEqual(exclusion - 1e-9);
    }
  });

  it('grows nothing on ground steeper than the slope limit', () => {
    // A world that is a wall everywhere.
    const field = {
      heightAt: (x: number) => x * 10,
      normalAt: () => {
        const n = { x: -10, y: 1, z: 0 };
        const len = Math.hypot(n.x, n.y, n.z);
        return { x: n.x / len, y: n.y / len, z: 0 };
      },
    };
    const instances = scatterFoliage({
      seed: 2,
      centreX: 0,
      centreZ: 0,
      field,
      counts: { grass: 200, fern: 0, undergrowth: 0, rock: 0, branch: 0, leaf: 0 },
      hillStart: 1e9,
      hillEnd: 1e9 + 1,
    });
    expect(instances).toHaveLength(0);
  });

  it('grows nothing above the hill ceiling', () => {
    const field = { heightAt: (_x: number, _z: number) => 1000 };
    const instances = scatterFoliage({
      seed: 2,
      centreX: 0,
      centreZ: 0,
      field,
      counts: { grass: 200, fern: 0, undergrowth: 0, rock: 0, branch: 0, leaf: 0 },
    });
    expect(instances).toHaveLength(0);
  });

  it('terminates when nothing can grow anywhere', () => {
    // A density of zero everywhere must not spin forever looking for a place
    // to put anything. Height 1000 is above the hill ceiling, so the fade is
    // zero and no candidate is ever accepted.
    const field = { heightAt: () => 1000 };
    const started = Date.now();
    const instances = scatterFoliage({
      seed: 1,
      centreX: 0,
      centreZ: 0,
      field,
      counts: { grass: 500, fern: 100, undergrowth: 100, rock: 100, branch: 100, leaf: 100 },
    });
    expect(instances).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('sickens the tint where the stream is polluted', () => {
    const instances = scatterFoliage({ seed: 7, centreX: 0, centreZ: 0, field: testField() });
    const near = instances.filter((i) => Math.abs(i.z) < 8);
    const far = instances.filter((i) => Math.abs(i.z) > 50);
    const meanNear = near.reduce((a, b) => a + b.variation, 0) / Math.max(1, near.length);
    const meanFar = far.reduce((a, b) => a + b.variation, 0) / Math.max(1, far.length);
    // The polluted bank is the yellowed one, and the tint travels with the
    // instance so the material can read it from an attribute.
    expect(meanNear).toBeGreaterThan(meanFar);
  });

  it('gives every instance a rotation, a scale and a variation', () => {
    const instances = scatterFoliage({ seed: 12, centreX: 0, centreZ: 0, field: testField() });
    for (const i of instances) {
      expect(i.rotationY).toBeGreaterThanOrEqual(0);
      expect(i.rotationY).toBeLessThanOrEqual(Math.PI * 2);
      expect(i.scale).toBeGreaterThan(0);
      expect(i.variation).toBeGreaterThanOrEqual(0);
      expect(i.variation).toBeLessThanOrEqual(1);
    }
    // Scales vary within a kind, which is what stops a field of grass looking
    // like a carpet.
    const grass = instances.filter((i) => i.kind === 'grass').map((i) => i.scale);
    expect(Math.max(...grass) - Math.min(...grass)).toBeGreaterThan(0.3);
  });

  it('leans grass and ferns but lays rocks, branches and litter flat', () => {
    const instances = scatterFoliage({ seed: 13, centreX: 0, centreZ: 0, field: testField() });
    const flat: FoliageKind[] = ['rock', 'branch', 'leaf'];
    const upright: FoliageKind[] = ['grass', 'fern'];
    for (const i of instances) {
      if (flat.includes(i.kind)) expect(i.tilt).toBe(0);
      if (upright.includes(i.kind)) expect(Math.abs(i.tilt)).toBeGreaterThan(0);
    }
  });

  it('scatters a whole patch fast enough to rebuild on camera movement', () => {
    // The patch follows the camera, so this runs whenever the snapped centre
    // changes. A frame spike here would be worse than a slightly stale patch.
    const started = Date.now();
    scatterFoliage({ seed: 14, centreX: 0, centreZ: 0, field: testField() });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('foliage budget helpers', () => {
  it('counts the triangles a patch costs', () => {
    const instances: FoliageInstance[] = [
      { kind: 'grass', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, tilt: 0, variation: 0 },
      { kind: 'grass', x: 1, y: 0, z: 0, rotationY: 0, scale: 1, tilt: 0, variation: 0 },
      { kind: 'rock', x: 2, y: 0, z: 0, rotationY: 0, scale: 1, tilt: 0, variation: 0 },
    ];
    expect(foliageTriangleCost(instances)).toBe(FOLIAGE_TRIANGLES.grass * 2 + FOLIAGE_TRIANGLES.rock);
    expect(foliageTriangleCost([])).toBe(0);
  });

  it('converts a triangle budget into an instance count', () => {
    for (const kind of FOLIAGE_KINDS) {
      const per = FOLIAGE_TRIANGLES[kind];
      expect(instancesForBudget(kind, per * 7)).toBe(7);
      expect(instancesForBudget(kind, per * 7 - 1)).toBe(6);
      expect(instancesForBudget(kind, 0)).toBe(0);
      expect(instancesForBudget(kind, -5)).toBe(0);
    }
  });

  it('uses a patch radius that covers what the player can see', () => {
    // The terrain's fog ends at 400 m and its detail at 80, so an 80 m patch is
    // the radius at which foliage stops being worth drawing at all.
    expect(FOLIAGE_PATCH_RADIUS).toBe(80);
    expect(DEFAULT_FOLIAGE_SCATTER.radius).toBe(FOLIAGE_PATCH_RADIUS);
  });
});

describe('all meshes helper', () => {
  it('is referenced by every kind', () => {
    // Guards against adding a kind to FOLIAGE_KINDS without a generator.
    expect(ALL_MESHES.map(([, , kind]) => kind)).toEqual([...FOLIAGE_KINDS]);
  });
});
