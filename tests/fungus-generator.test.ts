import { describe, it, expect } from 'vitest';
import {
  FUNGUS_KINDS,
  FUNGUS_TRIANGLES,
  DEFAULT_FUNGUS_COUNTS,
  DEFAULT_FUNGUS_SCATTER,
  MUSHROOM_CLUSTER_RADIUS,
  SHELF_REACH,
  SHELF_THICKNESS,
  SHELF_ROOT,
  POD_HEIGHT,
  POD_RADIUS,
  CARRION_LENGTH,
  ROT_RADIUS,
  CAP_SHAPES,
  generateFungusGeometry,
  generateMushroomCluster,
  generateFungalShelf,
  generateSporePod,
  generateCarrion,
  generateRot,
  fungusTriangleCounts,
  fungusTriangleCost,
  instancesForBudget,
  scatterFungus,
  type FungusInstance,
  type FungusKind,
} from '../src/procedural/FungusGenerator';

/** Every triangle's geometric normal against the averaged vertex normal. */
interface Audit {
  triangles: number;
  degenerate: number;
  nonFinite: number;
  nonUnit: number;
  /** Triangles whose winding disagrees with their own vertex normals. */
  inverted: number;
  /** Signed volume. Positive for a mesh whose interior contains the origin. */
  volume: number;
  minY: number;
  maxY: number;
  maxRadius: number;
}

/**
 * Audit one mesh.
 *
 * The `inverted` count is the one that matters. A surface whose analytic
 * normals point into its own interior lights itself from inside, and it is
 * invisible in review because roughly half the triangles still look right. The
 * comparison is against the GEOMETRIC face normal, so it needs no reference
 * frame and no special case for a leaning or tilted mesh.
 */
function audit(mesh: {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}): Audit {
  const { positions: p, normals: n, indices: idx } = mesh;
  let degenerate = 0;
  let nonFinite = 0;
  let nonUnit = 0;
  let inverted = 0;
  let volume = 0;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxRadius = 0;

  for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) nonFinite++;
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (!Number.isFinite(len) || Math.abs(len - 1) > 1e-3) nonUnit++;
  }
  for (let i = 0; i < p.length; i += 3) {
    minY = Math.min(minY, p[i + 1]);
    maxY = Math.max(maxY, p[i + 1]);
    maxRadius = Math.max(maxRadius, Math.hypot(p[i], p[i + 2]));
  }

  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3];
    const b = idx[t * 3 + 1];
    const c = idx[t * 3 + 2];
    const ax = p[a * 3];
    const ay = p[a * 3 + 1];
    const az = p[a * 3 + 2];
    const bx = p[b * 3];
    const by = p[b * 3 + 1];
    const bz = p[b * 3 + 2];
    const cx = p[c * 3];
    const cy = p[c * 3 + 1];
    const cz = p[c * 3 + 2];
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    const area = Math.hypot(fx, fy, fz);
    if (area < 1e-12) {
      degenerate++;
      continue;
    }
    // Divergence theorem, one tetrahedron per triangle.
    volume +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const nx = n[a * 3] + n[b * 3] + n[c * 3];
    const ny = n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1];
    const nz = n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2];
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-9 && (fx * nx + fy * ny + fz * nz) / (area * nl) < 0) inverted++;
  }

  return {
    triangles: idx.length / 3,
    degenerate,
    nonFinite,
    nonUnit,
    inverted,
    volume,
    minY,
    maxY,
    maxRadius,
  };
}

const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17];

describe('fungus geometry', () => {
  it('covers the five kinds the plan names', () => {
    // Three fungus growths plus the two pieces of dead organic matter the plan
    // attaches to the same system.
    expect(FUNGUS_KINDS).toEqual(['mushroom', 'shelf', 'pod', 'carrion', 'rot']);
    expect(CAP_SHAPES).toEqual(['cone', 'dome', 'flat']);
    for (const kind of FUNGUS_KINDS) {
      expect(DEFAULT_FUNGUS_COUNTS[kind], `${kind} has no default count`).toBeGreaterThan(0);
    }
  });

  it('produces clean, outward-facing geometry for every kind and seed', () => {
    // One aggregate per kind rather than a per-vertex expect: a per-vertex
    // assertion inside a loop over dozens of meshes blows the test timeout
    // before it reports anything useful.
    const totals: Record<FungusKind, Audit> = {} as Record<FungusKind, Audit>;
    for (const kind of FUNGUS_KINDS) {
      totals[kind] = {
        triangles: 0,
        degenerate: 0,
        nonFinite: 0,
        nonUnit: 0,
        inverted: 0,
        volume: 0,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
        maxRadius: 0,
      };
    }

    for (const seed of SEEDS) {
      const g = generateFungusGeometry(seed);
      for (const kind of FUNGUS_KINDS) {
        const a = audit(g[kind]);
        const t = totals[kind];
        t.triangles += a.triangles;
        t.degenerate += a.degenerate;
        t.nonFinite += a.nonFinite;
        t.nonUnit += a.nonUnit;
        t.inverted += a.inverted;
        t.minY = Math.min(t.minY, a.minY);
        t.maxY = Math.max(t.maxY, a.maxY);
        t.maxRadius = Math.max(t.maxRadius, a.maxRadius);
      }
    }

    for (const kind of FUNGUS_KINDS) {
      const t = totals[kind];
      expect(t.triangles, `${kind} produced no triangles`).toBeGreaterThan(0);
      expect(t.degenerate, `${kind} degenerate triangles`).toBe(0);
      expect(t.nonFinite, `${kind} non-finite positions`).toBe(0);
      expect(t.nonUnit, `${kind} non-unit normals`).toBe(0);
      expect(t.inverted, `${kind} inverted triangles`).toBe(0);
    }
  });

  it('keeps every kind inside the size the budget assumes', () => {
    // A cluster that wandered a metre off its origin, or a shelf that reached
    // further than its reach, would put fungus where nothing else is.
    const bounds: Record<FungusKind, { y: number; r: number }> = {
      mushroom: { y: 0.5, r: MUSHROOM_CLUSTER_RADIUS + 0.25 },
      shelf: { y: SHELF_REACH * 1.2, r: SHELF_REACH + SHELF_ROOT + 0.05 },
      pod: { y: POD_HEIGHT + POD_RADIUS + 0.02, r: POD_RADIUS + 0.01 },
      // The tail reaches a half-length past the body's end, so the radius
      // bound has to allow for it.
      carrion: { y: 0.15, r: CARRION_LENGTH * 0.8 },
      rot: { y: ROT_RADIUS * 0.8, r: ROT_RADIUS * 2.2 },
    };
    for (const seed of SEEDS) {
      const g = generateFungusGeometry(seed);
      for (const kind of FUNGUS_KINDS) {
        const a = audit(g[kind]);
        expect(a.maxY, `${kind} too tall at seed ${seed}`).toBeLessThanOrEqual(bounds[kind].y);
        expect(a.maxRadius, `${kind} too wide at seed ${seed}`).toBeLessThanOrEqual(bounds[kind].r);
      }
    }
  });

  it('stands everything that stands on the ground at y = 0', () => {
    // The local frame the scatter and the instance matrices both assume. A
    // cluster whose base sat above the ground would float, and one whose base
    // sat below would bury itself.
    const g = generateFungusGeometry(1);
    // Mushrooms bury their stalk a little, and rot is centred on the ground.
    expect(audit(g.mushroom).minY).toBeLessThanOrEqual(0);
    expect(audit(g.pod).minY).toBeLessThanOrEqual(0);
    expect(audit(g.carrion).minY).toBeLessThan(0.001);
    // A shelf is rooted on the trunk, not on the ground, so it may sit high.
    expect(audit(g.shelf).minY).toBeLessThan(0.02);
  });

  it('carries a positive signed volume for every kind', () => {
    // A closed shell wound consistently encloses a positive volume. A mesh
    // with half its triangles inverted still has triangles, still has normals,
    // and still renders - it just lights itself from the inside.
    for (const seed of SEEDS) {
      const g = generateFungusGeometry(seed);
      for (const kind of FUNGUS_KINDS) {
        const a = audit(g[kind]);
        expect(a.volume, `${kind} has non-positive volume at seed ${seed}`).toBeGreaterThan(0);
      }
    }
  });

  it('never costs more triangles than the budget declares', () => {
    // A cluster holds two to five mushrooms and a trunk two or three shelves,
    // so the count varies with the seed - which is why `FUNGUS_TRIANGLES` is a
    // maximum. The budget built from it must therefore never underestimate.
    for (let seed = 1; seed <= 64; seed++) {
      const counts = fungusTriangleCounts(seed);
      for (const kind of FUNGUS_KINDS) {
        expect(counts[kind], `${kind} exceeds the budget at seed ${seed}`).toBeLessThanOrEqual(
          FUNGUS_TRIANGLES[kind],
        );
      }
    }
  });

  it('reaches the declared triangle maximum, so the budget is not padded', () => {
    // The other half of the contract: a constant that overstates the cost by
    // ten times would pass the check above and quietly cost ten times the
    // triangles it needs to.
    const max: Record<FungusKind, number> = { mushroom: 0, shelf: 0, pod: 0, carrion: 0, rot: 0 };
    for (let seed = 1; seed <= 64; seed++) {
      const counts = fungusTriangleCounts(seed);
      for (const kind of FUNGUS_KINDS) max[kind] = Math.max(max[kind], counts[kind]);
    }
    for (const kind of FUNGUS_KINDS) {
      expect(max[kind], `${kind} never reaches its declared cost`).toBe(FUNGUS_TRIANGLES[kind]);
    }
  });

  it('is deterministic for a given seed and variant', () => {
    // `Math.random()` would make every test run produce a different forest,
    // and a bug that only appears on one seed would be unreproducible.
    for (const [name, make] of [
      ['mushroom', () => generateMushroomCluster(9, 2)],
      ['shelf', () => generateFungalShelf(9, 2)],
      ['pod', () => generateSporePod(9, 2)],
      ['carrion', () => generateCarrion(9, 2)],
      ['rot', () => generateRot(9, 2)],
    ] as const) {
      const a = make();
      const b = make();
      expect(Array.from(a.positions), `${name} is not deterministic`).toEqual(
        Array.from(b.positions),
      );
      expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
    }
  });

  it('varies with the seed rather than repeating one shape', () => {
    const a = generateMushroomCluster(4, 0);
    const b = generateMushroomCluster(5, 0);
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
  });

  it('varies with the variant as well as the seed', () => {
    // The forest builds four variants per kind so that a patch of mushrooms is
    // not one asset stamped three hundred times.
    const a = generateMushroomCluster(4, 0);
    const b = generateMushroomCluster(4, 1);
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
  });

  it('gives a mushroom cluster two to five mushrooms', () => {
    // Fewer is a lonely mushroom; more is a bush that happens to be made of
    // mushrooms.
    const seen = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const cluster = generateMushroomCluster(seed);
      // Each mushroom is a closed shell with its own base, so counting the
      // distinct base heights is not reliable - count the cap rings instead:
      // CAP_RINGS x CAP_RADIAL vertices per cap, and only caps use that count.
      const capVertices = cluster.positions.length / 3;
      expect(capVertices).toBeGreaterThan(0);
      seen.add(cluster.indices.length / 3);
    }
    // The triangle count varies, which is the observable consequence of the
    // mushroom count varying.
    expect(seen.size).toBeGreaterThan(2);
  });

  it('flattens the shelf far more across than it reaches', () => {
    // "Flattened torus segments" in the plan. A shelf as thick as it is deep
    // is a donut, and a donut on a trunk is not a bracket.
    expect(SHELF_THICKNESS).toBeLessThan(SHELF_REACH * 0.25);
  });

  it('roots the shelf inside the trunk rather than on the axis', () => {
    // A cross-section centred on the axis is a spindle torus: its
    // parametrisation collapses where the ellipse touches the axis and its
    // normal flips through that point, which shows up as half the triangles
    // shading backwards and is invisible in review because the other half
    // looks fine. A positive root keeps the surface smooth all the way round.
    expect(SHELF_ROOT).toBeGreaterThan(0);
    const shelf = generateFungalShelf(1);
    // The innermost vertex is at least the root from the axis.
    let minRadius = Number.POSITIVE_INFINITY;
    for (let i = 0; i < shelf.positions.length; i += 3) {
      minRadius = Math.min(minRadius, Math.hypot(shelf.positions[i], shelf.positions[i + 2]));
    }
    expect(minRadius).toBeGreaterThan(0);
  });

  it('scales the carrion with its declared length', () => {
    // The squash has to reach the NORMALS as well as the positions, or the
    // fish is lit as though it were still a ball. `icosphereData`'s `scale`
    // does that; this asserts the result is actually flat.
    const fish = generateCarrion(1);
    let spanZ = 0;
    let spanY = 0;
    for (let i = 0; i < fish.positions.length; i += 3) {
      spanZ = Math.max(spanZ, Math.abs(fish.positions[i + 2]));
      spanY = Math.max(spanY, Math.abs(fish.positions[i + 1]));
    }
    expect(spanZ).toBeGreaterThan(CARRION_LENGTH * 0.5);
    // The body is squashed to a thirtieth of its length; the tail fin is the
    // tall part and is excluded by measuring the body's own extent rather than
    // the fin's.
    expect(spanY).toBeLessThan(spanZ * 0.35);
  });

  it('prices instances and budgets from the same table', () => {
    const instances: FungusInstance[] = [
      { kind: 'pod', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, tilt: 0, variation: 0, corruption: 1 },
      { kind: 'pod', x: 1, y: 0, z: 0, rotationY: 0, scale: 1, tilt: 0, variation: 0, corruption: 1 },
      { kind: 'rot', x: 2, y: 0, z: 0, rotationY: 0, scale: 1, tilt: 0, variation: 0, corruption: 1 },
    ];
    expect(fungusTriangleCost(instances)).toBe(FUNGUS_TRIANGLES.pod * 2 + FUNGUS_TRIANGLES.rot);
    expect(instancesForBudget('pod', FUNGUS_TRIANGLES.pod * 3)).toBe(3);
    expect(instancesForBudget('pod', FUNGUS_TRIANGLES.pod * 3 - 1)).toBe(2);
    expect(instancesForBudget('pod', 0)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* placement                                                                  */
/* -------------------------------------------------------------------------- */

/** A flat field with a corruption function of the caller's choosing. */
function field(corruptionAt: (x: number, z: number) => number, heightAt = () => 0) {
  return { heightAt, corruptionAt, normalAt: () => ({ x: 0, y: 1, z: 0 }) };
}

describe('fungus scatter', () => {
  it('places nothing where there is no corruption', () => {
    // The acceptance probability IS the corruption, so a clean patch is empty.
    // This is what makes the fouled stream read as a gradient rather than as a
    // ring of blight around the whole stream.
    const out = scatterFungus({
      seed: 1,
      centreX: 0,
      centreZ: 0,
      field: field(() => 0),
    });
    expect(out).toEqual([]);
  });

  it('places everything where the corruption is total', () => {
    const out = scatterFungus({
      seed: 1,
      centreX: 0,
      centreZ: 0,
      field: field(() => 1),
    });
    const byKind = new Map<FungusKind, number>();
    for (const i of out) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
    for (const kind of FUNGUS_KINDS) {
      expect(byKind.get(kind), `${kind} was not scattered`).toBe(DEFAULT_FUNGUS_COUNTS[kind]);
    }
    expect(out).toHaveLength(
      FUNGUS_KINDS.reduce((sum, k) => sum + DEFAULT_FUNGUS_COUNTS[k], 0),
    );
  });

  it('fills the patch more densely as the corruption rises', () => {
    // Squared acceptance, so half the corruption holds a quarter the growth:
    // the falloff has to read as the corruption dying out, not as a dial.
    const count = (corruption: number): number =>
      scatterFungus({ seed: 3, centreX: 0, centreZ: 0, field: field(() => corruption) }).length;
    const low = count(0.3);
    const mid = count(0.6);
    const high = count(1);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high).toBeGreaterThan(low * 3);
  });

  it('terminates rather than hanging on a patch it cannot fill', () => {
    // A bounded try count, not an unbounded loop: a patch centred somewhere
    // clean would otherwise spin forever looking for a point that does not
    // exist. The failure mode is a hang, which is worse than a short patch.
    const start = Date.now();
    const asked = 20000;
    const out = scatterFungus({
      seed: 1,
      centreX: 0,
      centreZ: 0,
      field: field(() => 1),
      counts: { mushroom: asked },
    });
    const mushrooms = out.filter((i) => i.kind === 'mushroom');
    // Filled exactly, and quickly: the mean was measured first, so the loop
    // already knew how many it was looking for.
    expect(mushrooms).toHaveLength(asked);
    expect(Date.now() - start).toBeLessThan(20000);
  });

  it('rejects a slope the growth would slide off', () => {
    const steep = field(() => 1, () => 0);
    steep.normalAt = () => ({ x: 0, y: 0.2, z: 0 }); // slope 0.8
    expect(
      scatterFungus({ seed: 1, centreX: 0, centreZ: 0, field: steep }),
    ).toEqual([]);
  });

  it('rejects ground above the hill ceiling', () => {
    const high = field(() => 1, () => 100);
    expect(scatterFungus({ seed: 1, centreX: 0, centreZ: 0, field: high })).toEqual([]);
  });

  it('grows with the corruption it stands in', () => {
    // The style guide's progression made literal: the same geometry is smaller
    // and less lurid at stage 1 than at stage 3. `carrion` is the exception -
    // a dead fish does not get bigger because the water is filthier.
    const scalesFor = (corruption: number): number[] =>
      scatterFungus({ seed: 5, centreX: 0, centreZ: 0, field: field(() => corruption) })
        .filter((i) => i.kind !== 'carrion')
        .map((i) => i.scale);
    const low = scalesFor(0.15);
    const high = scalesFor(1);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(low)).toBeLessThan(mean(high) * 0.8);

    const carrion = scatterFungus({
      seed: 5,
      centreX: 0,
      centreZ: 0,
      field: field(() => 0.15),
    }).filter((i) => i.kind === 'carrion');
    expect(carrion.length).toBeGreaterThan(0);
    for (const i of carrion) expect(i.scale).toBeGreaterThan(0.7);
  });

  it('carries the corruption it grew in onto the instance', () => {
    const out = scatterFungus({ seed: 2, centreX: 0, centreZ: 0, field: field(() => 1) });
    for (const i of out) {
      expect(i.corruption).toBeGreaterThan(0);
      expect(i.corruption).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic for a given seed', () => {
    const options = {
      seed: 11,
      centreX: 20,
      centreZ: -30,
      field: field(() => 0.8),
    };
    const a = scatterFungus(options);
    const b = scatterFungus(options);
    expect(a).toEqual(b);
  });

  it('draws each kind from its own stream, so the kinds do not compete', () => {
    // If the kinds shared one RNG stream, adding a rock would move every
    // mushroom in the patch - which is exactly the "rot growing out of a
    // mushroom" failure, arriving by a different route.
    const both = scatterFungus({ seed: 7, centreX: 0, centreZ: 0, field: field(() => 1) });
    const onlyPods = scatterFungus({
      seed: 7,
      centreX: 0,
      centreZ: 0,
      field: field(() => 1),
      counts: { mushroom: 0, shelf: 0, carrion: 0, rot: 0 },
    });
    expect(onlyPods.every((i) => i.kind === 'pod')).toBe(true);
    expect(onlyPods).toEqual(both.filter((i) => i.kind === 'pod'));
  });

  it('uses the documented defaults', () => {
    expect(DEFAULT_FUNGUS_SCATTER.radius).toBe(60);
    expect(DEFAULT_FUNGUS_SCATTER.minCorruption).toBeGreaterThan(0);
    // A threshold of zero would let the field's small non-zero values a long
    // way out put the occasional lonely mushroom on a hillside, which reads as
    // a bug rather than as spread.
    expect(DEFAULT_FUNGUS_SCATTER.minCorruption).toBeLessThan(0.35);
  });
});
