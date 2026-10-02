import { describe, expect, it } from 'vitest';
import {
  ROCK_PRESETS,
  ROCK_SHAPES,
  ROCK_TRIANGLES,
  ROCK_VARIANTS,
  generateRock,
  pickRockShape,
} from '../src/procedural/RockGenerator';
import { triangleCount } from '../src/procedural/TreeGenerator';

const SHAPES = ROCK_SHAPES;
const SEEDS = [1, 2, 3, 7, 11, 42, 99];

/** Half-extents of a mesh about its own centre. */
function extentsOf(mesh: { positions: Float32Array }): {
  halfWidth: number;
  halfHeight: number;
  halfDepth: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i]);
    maxX = Math.max(maxX, mesh.positions[i]);
    minY = Math.min(minY, mesh.positions[i + 1]);
    maxY = Math.max(maxY, mesh.positions[i + 1]);
    minZ = Math.min(minZ, mesh.positions[i + 2]);
    maxZ = Math.max(maxZ, mesh.positions[i + 2]);
  }
  return {
    halfWidth: (maxX - minX) / 2,
    halfHeight: (maxY - minY) / 2,
    halfDepth: (maxZ - minZ) / 2,
  };
}

describe('rock presets', () => {
  it('covers every shape it declares', () => {
    for (const shape of SHAPES) {
      expect(ROCK_PRESETS[shape], `${shape} has no preset`).toBeTruthy();
    }
    expect(Object.keys(ROCK_PRESETS).sort()).toEqual([...SHAPES].sort());
  });

  it('gives every shape a collider that fits inside its silhouette', () => {
    // Measured, not derived from the preset: the displacement pushes vertices
    // out by `warp`, so the rock's real extent is larger than
    // `radius * scale` and only the mesh knows by how much. A collider that
    // stands proud of the stone blocks air the player can see through, and one
    // that is narrower than the stone lets them walk into its middle.
    for (const shape of SHAPES) {
      const mesh = generateRock(shape, 7, 0);
      const extents = extentsOf(mesh);
      const preset = ROCK_PRESETS[shape];

      const capsuleHalfHeight = preset.colliderHalfHeight + preset.colliderRadius;
      expect(
        capsuleHalfHeight,
        `${shape} collider is taller than the rock`,
      ).toBeLessThanOrEqual(extents.halfHeight);
      expect(preset.colliderRadius, `${shape} collider is wider than the rock`).toBeLessThanOrEqual(
        Math.min(extents.halfWidth, extents.halfDepth),
      );
      // And it is a real obstacle, not a token one.
      expect(
        preset.colliderRadius,
        `${shape} collider is too small to block anything`,
      ).toBeGreaterThan(0.3);
      // The two constraints above are what force the slab's aspect, so they
      // have to be tight rather than merely satisfied.
      expect(capsuleHalfHeight / extents.halfHeight).toBeGreaterThan(0.5);
    }
  });

  it('keeps the three silhouettes genuinely different', () => {
    // One shape repeated is a pattern. The presets differ in aspect, not just
    // in size, or a field of them reads as a repeated prop.
    const aspects = SHAPES.map((shape) => {
      const p = ROCK_PRESETS[shape];
      return (p.radius * p.scale.y) / (p.radius * p.scale.x);
    });
    const spread = Math.max(...aspects) / Math.min(...aspects);
    expect(spread).toBeGreaterThan(2);
  });

  it('declares a triangle budget each shape actually spends', () => {
    for (const shape of SHAPES) {
      for (const seed of SEEDS) {
        for (let variant = 0; variant < ROCK_VARIANTS; variant++) {
          const tris = triangleCount(generateRock(shape, seed, variant));
          expect(tris, `${shape} seed ${seed} v${variant}`).toBe(ROCK_TRIANGLES[shape]);
        }
      }
    }
  });

  it('costs under 3% of the frame budget for a whole field', () => {
    // 44 rocks is the default field. The budget is 500K.
    const field = 44 * ROCK_TRIANGLES[SHAPES[0]];
    expect(field).toBeLessThan(0.03 * 500_000);
  });
});

describe('generateRock', () => {
  it('is finite everywhere, for every shape, seed and variant', () => {
    // The lesson from the audio work: a NaN in a buffer is silent, not loud.
    // A NaN in a rock's vertices is an invisible rock, and nothing errors.
    for (const shape of SHAPES) {
      for (const seed of SEEDS) {
        for (let variant = 0; variant < ROCK_VARIANTS; variant++) {
          const mesh = generateRock(shape, seed, variant);
          for (const array of [mesh.positions, mesh.normals, mesh.colors]) {
            for (let i = 0; i < array.length; i++) {
              expect(Number.isFinite(array[i]), `${shape} ${seed} v${variant} [${i}]`).toBe(true);
            }
          }
          expect(mesh.indices.length % 3).toBe(0);
        }
      }
    }
  });

  it('produces unit normals, so the stone is lit from outside', () => {
    for (const shape of SHAPES) {
      const mesh = generateRock(shape, 7, 0);
      for (let i = 0; i < mesh.normals.length; i += 3) {
        const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
        expect(len).toBeCloseTo(1, 4);
      }
    }
  });

  it('winds every face outward, or the rock lights from the inside', () => {
    for (const shape of SHAPES) {
      const mesh = generateRock(shape, 11, 1);
      let checked = 0;
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [ia, ib, ic] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
        const ax = mesh.positions[ia * 3];
        const ay = mesh.positions[ia * 3 + 1];
        const az = mesh.positions[ia * 3 + 2];
        const e1x = mesh.positions[ib * 3] - ax;
        const e1y = mesh.positions[ib * 3 + 1] - ay;
        const e1z = mesh.positions[ib * 3 + 2] - az;
        const e2x = mesh.positions[ic * 3] - ax;
        const e2y = mesh.positions[ic * 3 + 1] - ay;
        const e2z = mesh.positions[ic * 3 + 2] - az;
        // Geometric normal of the face.
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        // It must agree with the interpolated vertex normal at the first
        // corner, which for a convex-ish displaced sphere means pointing away
        // from the centre.
        const vx = mesh.normals[ia * 3];
        const vy = mesh.normals[ia * 3 + 1];
        const vz = mesh.normals[ia * 3 + 2];
        if (nx * vx + ny * vy + nz * vz < 0) {
          throw new Error(`${shape}: face ${t / 3} is wound backwards`);
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    }
  });

  it('is deterministic per seed and different across seeds', () => {
    const a = generateRock('boulder', 7, 0);
    const b = generateRock('boulder', 7, 0);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));

    const c = generateRock('boulder', 8, 0);
    expect(Array.from(c.positions)).not.toEqual(Array.from(a.positions));
  });

  it('gives the variants of a shape different stones, not one rotated', () => {
    // A field of identical rocks is the fastest way to make a forest look
    // generated, which is the whole reason `ROCK_VARIANTS` exists.
    const seen = new Set<string>();
    for (let variant = 0; variant < ROCK_VARIANTS; variant++) {
      seen.add(Array.from(generateRock('boulder', 7, variant).positions).join(','));
    }
    expect(seen.size).toBe(ROCK_VARIANTS);
  });

  it('applies the preset scale, so a slab is flat and a standing stone is not', () => {
    for (const shape of SHAPES) {
      const mesh = generateRock(shape, 3, 0);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        minX = Math.min(minX, mesh.positions[i]);
        maxX = Math.max(maxX, mesh.positions[i]);
        minY = Math.min(minY, mesh.positions[i + 1]);
        maxY = Math.max(maxY, mesh.positions[i + 1]);
        minZ = Math.min(minZ, mesh.positions[i + 2]);
        maxZ = Math.max(maxZ, mesh.positions[i + 2]);
      }
      const width = maxX - minX;
      const height = maxY - minY;
      const depth = maxZ - minZ;
      const preset = ROCK_PRESETS[shape];
      // The displacement can push a vertex out by `warp`, so the extent is the
      // preset's scaled radius plus that. Checked as a ratio, which cancels.
      expect(width / height).toBeCloseTo(preset.scale.x / preset.scale.y, 0);
      expect(depth / height).toBeCloseTo(preset.scale.z / preset.scale.y, 0);
      if (shape === 'slab') expect(width).toBeGreaterThan(height * 2);
      if (shape === 'standing') expect(height).toBeGreaterThan(width * 1.5);
    }
  });

  it('shades the lumps differently from the flats', () => {
    // A uniform grey rock reads as a grey ball. The shading is by how far out
    // each vertex was pushed, so the surface has structure as well as the
    // silhouette.
    const mesh = generateRock('boulder', 7, 0);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < mesh.colors.length; i += 3) {
      const lum = mesh.colors[i] + mesh.colors[i + 1] + mesh.colors[i + 2];
      min = Math.min(min, lum);
      max = Math.max(max, lum);
    }
    expect(max - min).toBeGreaterThan(0.05);
  });
});

describe('pickRockShape', () => {
  it('returns a shape it knows about, for every draw', () => {
    for (let i = 0; i <= 100; i++) {
      const shape = pickRockShape(i / 100);
      expect(SHAPES).toContain(shape);
    }
  });

  it('returns the last shape at the top of the range', () => {
    // 1.0 must not fall off the end of the cumulative walk.
    expect(pickRockShape(1)).toBe(SHAPES[SHAPES.length - 1]);
    expect(pickRockShape(1.5)).toBe(SHAPES[SHAPES.length - 1]);
  });

  it('respects the weights', () => {
    // The boulder is weighted 5 of 10, so half the draws should be boulders.
    let boulders = 0;
    const draws = 10000;
    for (let i = 0; i < draws; i++) {
      if (pickRockShape(i / draws) === 'boulder') boulders++;
    }
    const expected = ROCK_PRESETS.boulder.weight / 10;
    expect(boulders / draws).toBeGreaterThan(expected - 0.05);
    expect(boulders / draws).toBeLessThan(expected + 0.05);
  });

  it('handles a zero draw', () => {
    expect(SHAPES).toContain(pickRockShape(0));
  });
});
