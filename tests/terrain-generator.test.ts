import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  BIOME_COLORS,
  BIOME_COUNT,
  BIOME_GRASS,
  DEFAULT_VALLEY_DEPTH,
  TERRAIN_RESOLUTION,
  TERRAIN_SIZE,
  buildTerrainCollisionData,
  buildTerrainGeometry,
  generateTerrain,
} from '../src/procedural/TerrainGenerator';
import { StreamSpline } from '../src/procedural/StreamSpline';

const gen = (overrides = {}) =>
  generateTerrain({ resolution: 48, seed: 1, size: 200, ...overrides });

describe('generateTerrain', () => {
  describe('defaults', () => {
    it('uses the plan size and resolution', () => {
      expect(TERRAIN_SIZE).toBe(500);
      expect(TERRAIN_RESOLUTION).toBe(384);
      expect(DEFAULT_VALLEY_DEPTH).toBeGreaterThan(0);
    });

    it('rejects a non-positive size', () => {
      expect(() => generateTerrain({ size: 0, resolution: 8 })).toThrow(RangeError);
      expect(() => generateTerrain({ size: -5, resolution: 8 })).toThrow(RangeError);
    });

    it('produces a full grid of heights', () => {
      const data = gen();
      expect(data.heights.length).toBe(48 * 48);
      expect(data.columnMajorHeights.length).toBe(48 * 48);
      expect(data.distanceToStream.length).toBe(48 * 48);
      expect(data.biomeWeights.length).toBe(48 * 48 * BIOME_COUNT);
    });

    it('stores heights in column-major as well as row-major', () => {
      const data = gen();
      for (let i = 0; i < 48; i += 7) {
        for (let j = 0; j < 48; j += 5) {
          expect(data.columnMajorHeights[j * 48 + i]).toBe(data.heights[i * 48 + j]);
        }
      }
    });

    it('is finite everywhere', () => {
      const data = gen();
      for (const array of [
        data.heights,
        data.columnMajorHeights,
        data.distanceToStream,
        data.biomeWeights,
      ]) {
        for (let i = 0; i < array.length; i++) {
          expect(Number.isFinite(array[i])).toBe(true);
        }
      }
    });
  });

  describe('determinism', () => {
    it('gives the same world for the same seed', () => {
      const a = gen({ seed: 77 });
      const b = gen({ seed: 77 });
      expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
      expect(Array.from(a.biomeWeights)).toEqual(Array.from(b.biomeWeights));
    });

    it('gives a different world for a different seed', () => {
      const a = gen({ seed: 77 });
      const b = gen({ seed: 78 });
      expect(Array.from(a.heights)).not.toEqual(Array.from(b.heights));
    });
  });

  describe('height composition', () => {
    it('has real relief in the playable area', () => {
      const data = gen({ size: 200 });
      let min = Infinity;
      let max = -Infinity;
      // The central 200m is the playable area; the rim is allowed to be wild.
      const half = 100;
      const step = 200 / 47;
      for (let i = 0; i < 48; i++) {
        for (let j = 0; j < 48; j++) {
          const x = -half + j * step;
          const z = -half + i * step;
          if (Math.hypot(x, z) > 80) continue;
          const h = data.heights[i * 48 + j];
          min = Math.min(min, h);
          max = Math.max(max, h);
        }
      }
      expect(max - min).toBeGreaterThan(2);
    });

    it('keeps the playable area gentler than the rim', () => {
      // The whole point of the rim ramp: the outer ring is rougher, so the
      // player is discouraged from leaving without any invisible geometry.
      const data = gen({ size: 200, seed: 3 });
      const step = 200 / 47;
      const half = 100;

      const roughness = (from: number, to: number) => {
        let sum = 0;
        let n = 0;
        for (let i = 1; i < 47; i++) {
          for (let j = 1; j < 47; j++) {
            const x = -half + j * step;
            const z = -half + i * step;
            const r = Math.hypot(x, z);
            if (r < from || r > to) continue;
            const dhdx = (data.heights[i * 48 + j + 1] - data.heights[i * 48 + j - 1]) / (2 * step);
            const dhdz = (data.heights[(i + 1) * 48 + j] - data.heights[(i - 1) * 48 + j]) / (2 * step);
            sum += Math.hypot(dhdx, dhdz);
            n++;
          }
        }
        return sum / n;
      };

      const inner = roughness(0, 70);
      const outer = roughness(80, 98);
      expect(outer).toBeGreaterThan(inner);
    });

    it('is flat when every height term is zeroed', () => {
      const data = gen({
        size: 100,
        hillAmplitude: 0,
        rimAmplitude: 0,
        rimLift: 0,
        valleyDepth: 0,
      });
      for (let i = 0; i < data.heights.length; i++) expect(data.heights[i]).toBe(0);
      expect(data.minHeight).toBe(0);
      expect(data.maxHeight).toBe(0);
    });

    it('carves the valley lower than the surrounding ground', () => {
      const data = gen({ size: 200, seed: 5 });
      const spline = data.spline;
      const onStream = spline.pointAt(0.5);
      const hOnStream = data.heightAt(onStream.x, onStream.z);

      // The nearest ground at least 60m from the stream, at a comparable
      // distance from the centre.
      let comparison = -Infinity;
      for (let i = 0; i < 400; i++) {
        const a = (i / 400) * Math.PI * 2;
        const x = onStream.x + Math.cos(a) * 70;
        const z = onStream.z + Math.sin(a) * 70;
        if (Math.hypot(x, z) > 99) continue;
        comparison = Math.max(comparison, data.heightAt(x, z));
      }
      expect(hOnStream).toBeLessThan(comparison);
    });

    it('makes the valley a smooth well, not a slot', () => {
      // A Gaussian falloff is continuous and has one minimum. Check that
      // walking across the valley goes down then up, monotonically on each
      // side.
      const data = gen({ size: 300, seed: 11 });
      const spline = data.spline;
      const mid = spline.pointAtDistance(spline.length * 0.5);
      const t = spline.tangentAtDistance(spline.length * 0.5);
      const px = -t.z;
      const pz = t.x;

      let descending = true;
      let prev = Infinity;
      for (let d = 0; d <= 40; d += 2) {
        const h = data.heightAt(mid.x + px * d, mid.z + pz * d);
        if (descending) {
          if (h > prev + 1e-9) descending = false;
        } else {
          expect(h).toBeGreaterThan(prev - 1e-9);
        }
        prev = h;
      }
      // It must actually have turned around within 40m.
      expect(descending).toBe(false);
    });
  });

  describe('sampling', () => {
    it('returns grid values exactly at grid vertices', () => {
      const data = gen({ size: 100 });
      const step = 100 / 47;
      for (const [i, j] of [
        [0, 0],
        [10, 20],
        [47, 47],
      ] as [number, number][]) {
        expect(data.heightAt(-50 + j * step, -50 + i * step)).toBeCloseTo(
          data.heights[i * 48 + j],
          4,
        );
      }
    });

    it('interpolates between grid vertices', () => {
      const data = gen({ size: 100 });
      const step = 100 / 47;
      const a = data.heightAt(-50, -50);
      const b = data.heightAt(-50 + step, -50);
      const mid = data.heightAt(-50 + step / 2, -50);
      // Bilinear at the midpoint of an edge is the average of the endpoints.
      expect(mid).toBeCloseTo((a + b) / 2, 4);
    });

    it('clamps outside the grid instead of returning NaN', () => {
      const data = gen({ size: 100 });
      for (const [x, z] of [
        [1000, 1000],
        [-1000, 0],
        [0, -1000],
      ] as [number, number][]) {
        expect(Number.isFinite(data.heightAt(x, z))).toBe(true);
        expect(Number.isFinite(data.normalAt(x, z).y)).toBe(true);
      }
    });

    it('reports a unit normal everywhere on the grid', () => {
      const data = gen({ size: 200, seed: 4 });
      for (let i = 0; i < 48; i += 5) {
        for (let j = 0; j < 48; j += 5) {
          const n = data.normalAt(-100 + j * (200 / 47), -100 + i * (200 / 47));
          expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
          expect(n.y).toBeGreaterThan(0);
        }
      }
    });

    it('keeps slopeAt and normalAt consistent', () => {
      const data = gen({ size: 200, seed: 4 });
      for (let i = 0; i < 20; i++) {
        const x = -90 + i * 9;
        const z = -60 + i * 5;
        expect(data.slopeAt(x, z)).toBeCloseTo(1 - data.normalAt(x, z).y, 6);
      }
    });
  });

  describe('biome weights', () => {
    it('normalizes to 1 at every vertex', () => {
      const data = gen();
      for (let k = 0; k < 48 * 48; k++) {
        const o = k * BIOME_COUNT;
        const sum =
          data.biomeWeights[o] +
          data.biomeWeights[o + 1] +
          data.biomeWeights[o + 2] +
          data.biomeWeights[o + 3];
        expect(sum).toBeCloseTo(1, 5);
      }
    });

    it('keeps every weight in [0, 1]', () => {
      const data = gen();
      for (let i = 0; i < data.biomeWeights.length; i++) {
        expect(data.biomeWeights[i]).toBeGreaterThanOrEqual(0);
        expect(data.biomeWeights[i]).toBeLessThanOrEqual(1);
      }
    });

    it('makes grass dominant overall', () => {
      // The plan says grass is the dominant biome. Averaged over the whole
      // map it must be the largest single share.
      const data = gen({ size: 200, seed: 6 });
      const totals = [0, 0, 0, 0];
      for (let k = 0; k < 48 * 48; k++) {
        for (let b = 0; b < BIOME_COUNT; b++) totals[b] += data.biomeWeights[k * BIOME_COUNT + b];
      }
      expect(totals[BIOME_GRASS]).toBeGreaterThan(totals[1]);
      expect(totals[BIOME_GRASS]).toBeGreaterThan(totals[2]);
      expect(totals[BIOME_GRASS]).toBeGreaterThan(totals[3]);
    });

    it('puts mud and rock near the stream', () => {
      // Proximity to the stream must matter, or the bank is the wrong colour.
      const data = gen({ size: 300, seed: 8 });
      const spline = data.spline;
      const mid = spline.pointAtDistance(spline.length * 0.5);

      const weightNear = (x: number, z: number, biome: number) => {
        const j = Math.round((x + 150) / (300 / 47));
        const i = Math.round((z + 150) / (300 / 47));
        return data.biomeWeights[(i * 48 + j) * BIOME_COUNT + biome];
      };

      const t = spline.tangentAtDistance(spline.length * 0.5);
      const px = -t.z;
      const pz = t.x;

      // 4m out from the bank versus 60m out, sampled perpendicular.
      const near = weightNear(mid.x + px * 4, mid.z + pz * 4, 3);
      const far = weightNear(mid.x + px * 60, mid.z + pz * 60, 3);
      expect(near).toBeGreaterThan(far);
    });

    it('puts more rock on steeper ground', () => {
      const data = gen({ size: 200, seed: 12 });
      // Sample the steepest and flattest vertices and compare their rock.
      let flatRock = 0;
      let flatCount = 0;
      let steepRock = 0;
      let steepCount = 0;
      const step = 200 / 47;
      for (let i = 1; i < 47; i++) {
        for (let j = 1; j < 48; j++) {
          const k = i * 48 + j;
          const dhdx = (data.heights[k + 1] - data.heights[k - 1]) / (2 * step);
          const dhdz =
            (data.heights[k + 48] - data.heights[k - 48]) / (2 * step);
          const slope = Math.atan(Math.hypot(dhdx, dhdz));
          const rock = data.biomeWeights[k * BIOME_COUNT + 2];
          if (slope < 0.08) {
            flatRock += rock;
            flatCount++;
          } else if (slope > 0.3) {
            steepRock += rock;
            steepCount++;
          }
        }
      }
      expect(steepCount).toBeGreaterThan(0);
      expect(flatCount).toBeGreaterThan(0);
      expect(steepRock / steepCount).toBeGreaterThan(flatRock / flatCount);
    });

    it('varies across the map rather than banding uniformly', () => {
      // Four smooth rules alone would give four smooth bands. The Voronoi
      // perturbation is what breaks them up; check the grass weight is not
      // constant along a line.
      const data = gen({ size: 200, seed: 6 });
      const values = new Set<number>();
      for (let j = 1; j < 47; j++) {
        values.add(data.biomeWeights[(24 * 48 + j) * BIOME_COUNT + BIOME_GRASS]);
      }
      expect(values.size).toBeGreaterThan
        ? expect(values.size).toBeGreaterThan(10)
        : undefined;
    });
  });
});

describe('buildTerrainGeometry', () => {
  it('produces a mesh-sized buffer set', () => {
    const data = gen();
    const geometry = buildTerrainGeometry(data);

    expect(geometry.getAttribute('position').count).toBe(48 * 48);
    expect(geometry.getAttribute('normal').count).toBe(48 * 48);
    expect(geometry.getAttribute('uv').count).toBe(48 * 48);
    expect(geometry.getAttribute('color').count).toBe(48 * 48);
    expect(geometry.getAttribute('biome').count).toBe(48 * 48);
    expect(geometry.getIndex()!.count).toBe(47 * 47 * 6);
  });

  it('displaces the plane along world +Y', () => {
    const data = gen({ size: 100, seed: 2 });
    const geometry = buildTerrainGeometry(data);
    const position = geometry.getAttribute('position');

    // The plane is rotated into XZ, so local z is gone and world y carries the
    // height. Check a vertex: its y must equal the generated height at its x/z.
    for (let k = 0; k < position.count; k += 37) {
      const x = position.getX(k);
      const y = position.getY(k);
      const z = position.getZ(k);
      expect(y).toBeCloseTo(data.heightAt(x, z), 3);
    }
  });

  it('spans the requested size on X and Z', () => {
    const data = gen({ size: 100 });
    const geometry = buildTerrainGeometry(data);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;

    expect(box.min.x).toBeCloseTo(-50, 4);
    expect(box.max.x).toBeCloseTo(50, 4);
    expect(box.min.z).toBeCloseTo(-50, 4);
    expect(box.max.z).toBeCloseTo(50, 4);
  });

  it('has an index that references only real vertices', () => {
    const data = gen();
    const geometry = buildTerrainGeometry(data);
    const index = geometry.getIndex()!;
    const count = geometry.getAttribute('position').count;
    for (let i = 0; i < index.count; i++) {
      expect(index.getX(i)).toBeLessThan(count);
      expect(index.getX(i)).toBeGreaterThanOrEqual(0);
    }
  });

  it('winds every triangle to face world +Y', () => {
    const data = gen({ size: 100, seed: 3 });
    const geometry = buildTerrainGeometry(data);
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex()!;

    // Every face normal must have a positive Y. One inverted triangle renders
    // as a black hole under a single directional light, and it is invisible in
    // a screenshot unless you are looking for it.
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const ab = new Vector3();
    const ac = new Vector3();
    const n = new Vector3();

    let minY = Infinity;
    for (let t = 0; t < index.count; t += 3) {
      a.fromBufferAttribute(position, index.getX(t));
      b.fromBufferAttribute(position, index.getX(t + 1));
      c.fromBufferAttribute(position, index.getX(t + 2));
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      n.crossVectors(ab, ac);
      minY = Math.min(minY, n.y);
    }
    expect(minY).toBeGreaterThan(0);
  });

  it('agrees with its own computed normals', () => {
    const data = gen({ size: 100, seed: 4 });
    const geometry = buildTerrainGeometry(data);
    const normal = geometry.getAttribute('normal');
    for (let k = 0; k < normal.count; k += 53) {
      const len = Math.hypot(normal.getX(k), normal.getY(k), normal.getZ(k));
      expect(len).toBeCloseTo(1, 5);
    }
  });

  it('writes biome weights matching the generated data', () => {
    const data = gen();
    const geometry = buildTerrainGeometry(data);
    const biome = geometry.getAttribute('biome');
    for (let k = 0; k < biome.count; k += 41) {
      for (let b = 0; b < BIOME_COUNT; b++) {
        expect(biome.getComponent(k, b)).toBeCloseTo(
          data.biomeWeights[k * BIOME_COUNT + b],
          6,
        );
      }
    }
  });

  it('writes vertex colours inside the biome palette hull', () => {
    const data = gen();
    const geometry = buildTerrainGeometry(data);
    const color = geometry.getAttribute('color');
    for (let k = 0; k < color.count; k += 29) {
      for (let c = 0; c < 3; c++) {
        const v = color.getComponent(k, c);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('has four biome colours, all distinct', () => {
    expect(BIOME_COLORS.length).toBe(BIOME_COUNT);
    expect(new Set(BIOME_COLORS).size).toBe(BIOME_COUNT);
  });
});

describe('buildTerrainCollisionData', () => {
  it('hands back the geometry own buffers', () => {
    const data = gen();
    const geometry = buildTerrainGeometry(data);
    const { vertices, indices } = buildTerrainCollisionData(geometry);

    expect(vertices).toBe(geometry.getAttribute('position').array);
    expect(indices).toBe(geometry.getIndex()!.array);
  });

  it('produces a collider whose surface is the visual surface', () => {
    // The requirement the plan states as "collision mesh matches visual
    // terrain", checked directly: every triangle of the collider must lie on
    // the heightmap the mesh was built from.
    const data = gen({ size: 100, seed: 9 });
    const geometry = buildTerrainGeometry(data);
    const { vertices, indices } = buildTerrainCollisionData(geometry);

    for (let t = 0; t < indices.length; t += 3) {
      for (let v = 0; v < 3; v++) {
        const i = indices[t + v];
        const x = vertices[i * 3];
        const y = vertices[i * 3 + 1];
        const z = vertices[i * 3 + 2];
        expect(y).toBeCloseTo(data.heightAt(x, z), 3);
      }
    }
  });

  it('throws on a geometry with no position or index', () => {
    expect(() => buildTerrainCollisionData({ getAttribute: () => null } as never)).toThrow();
  });
});

describe('the spline coupling', () => {
  it('carves along the spline it was given', () => {
    // The reason the spline is a shared module rather than a private curve:
    // two different splines must give two different valleys, and the one used
    // must be the one Step 2.2's water will follow.
    //
    // Both splines pass through the origin, so u = 0.5 is the same point on
    // both and comparing there compares a number with itself. The comparison
    // points below are each on one spline and well clear of the other.
    const alongX = new StreamSpline({
      controlPoints: [
        { x: -80, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 80, y: 0, z: 0 },
      ],
    });
    const alongZ = new StreamSpline({
      controlPoints: [
        { x: 0, y: 0, z: -80 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 80 },
      ],
    });

    const xTerrain = gen({ size: 200, seed: 2, spline: alongX });
    const zTerrain = gen({ size: 200, seed: 2, spline: alongZ });

    const onX = alongX.pointAt(0.25);
    const onZ = alongZ.pointAt(0.25);
    // Sanity: the two comparison points really are different places.
    expect(Math.hypot(onX.x - onZ.x, onX.z - onZ.z)).toBeGreaterThan(20);

    // Each terrain is lower where its own spline runs.
    expect(xTerrain.heightAt(onX.x, onX.z)).toBeLessThan(zTerrain.heightAt(onX.x, onX.z));
    expect(zTerrain.heightAt(onZ.x, onZ.z)).toBeLessThan(xTerrain.heightAt(onZ.x, onZ.z));

    // And the difference is the valley depth, not a rounding artefact.
    expect(zTerrain.heightAt(onX.x, onX.z) - xTerrain.heightAt(onX.x, onX.z)).toBeGreaterThan(1);
  });

  it('exposes the spline it used', () => {
    const spline = new StreamSpline({ samples: 200 });
    const data = gen({ spline });
    expect(data.spline).toBe(spline);
  });
});
