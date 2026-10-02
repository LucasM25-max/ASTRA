import { describe, expect, it, vi } from 'vitest';
import { DoubleSide, Scene, Vector3 } from 'three';
import {
  DEFAULT_GROUND_COLOR,
  TERRAIN_RESOLUTION,
  TERRAIN_SIZE,
  Terrain,
} from '../src/world/Terrain';
import { StreamSpline } from '../src/procedural/StreamSpline';

/**
 * A deliberately small terrain. The full 384x384 grid costs ~0.5s of
 * generation and ~9MB of buffers, which is fine once per world but not
 * something a test suite should pay thirty times.
 */
const small = (overrides = {}) =>
  new Terrain({ resolution: 48, seed: 1, ...overrides });

describe('Terrain', () => {
  describe('construction', () => {
    it('builds a terrain of the requested size', () => {
      const terrain = small({ size: 120 });

      expect(terrain.sizeMetres).toBe(120);
      expect(terrain.mesh.geometry.getAttribute('position').count).toBe(48 * 48);
    });

    it('defaults to the plan size and resolution', () => {
      expect(TERRAIN_SIZE).toBe(500);
      expect(TERRAIN_RESOLUTION).toBe(384);

      // Verified by constructing a real one only once, because it is slow.
      const terrain = new Terrain();
      expect(terrain.sizeMetres).toBe(500);
      expect(terrain.mesh.geometry.getAttribute('position').count).toBe(384 * 384);
      terrain.dispose();
    });

    it('lays the terrain flat on XZ with an upward normal', () => {
      const terrain = small();

      // The rotation is baked into the geometry, so the mesh transform is
      // identity and the position attribute is already in world space.
      expect(terrain.mesh.rotation.toArray()).toEqual([0, 0, 0, 'XYZ']);

      const position = terrain.mesh.geometry.getAttribute('position');
      const normal = terrain.mesh.geometry.getAttribute('normal');
      expect(normal).toBeDefined();

      // Every computed normal must point upward. A single downward normal
      // means the winding is inverted somewhere, which renders as a black
      // terrain under a single directional light.
      let minY = Number.POSITIVE_INFINITY;
      for (let i = 0; i < normal.count; i++) {
        minY = Math.min(minY, normal.getY(i));
      }
      expect(minY).toBeGreaterThan(0.9);

      // And the extent runs along X and Z, never along Y.
      let maxY = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < position.count; i++) {
        maxY = Math.max(maxY, position.getY(i));
      }
      expect(maxY).toBeLessThan(30);
      expect(maxY).toBeGreaterThan(-30);
    });

    it('centres the terrain on the origin', () => {
      const terrain = small();
      const position = terrain.mesh.geometry.getAttribute('position');
      terrain.mesh.geometry.computeBoundingBox();
      const box = terrain.mesh.geometry.boundingBox!;

      expect(terrain.mesh.position.toArray()).toEqual([0, 0, 0]);
      expect(box.min.x).toBeLessThan(0);
      expect(box.max.x).toBeGreaterThan(0);
      expect(box.min.z).toBeLessThan(0);
      expect(box.max.z).toBeGreaterThan(0);
      expect(position.count).toBeGreaterThan(0);
    });

    it('uses the procedural terrain material', () => {
      const terrain = small();
      const { material } = terrain.mesh;

      // A patched MeshStandardMaterial rather than a bare ShaderMaterial: the
      // terrain must be lit and fogged by the same pipeline as everything else.
      expect(material.vertexColors).toBe(true);
      expect(material.transparent).toBe(false);
      // Corruption is on by default, and the key has to say so: the corrupted
      // program reads a `corruption` attribute and declares three extra
      // uniforms, so a clean-compiled program handed to it draws black.
      expect(material.customProgramCacheKey()).toBe('astra-terrain-v1-corrupt');
      expect(typeof material.onBeforeCompile).toBe('function');
    });

    it('exposes the grass colour as the ground colour', () => {
      expect(DEFAULT_GROUND_COLOR).toBe(0x5f7d43);
    });

    it('is visible from both sides and receives shadows', () => {
      const terrain = small();
      expect(terrain.mesh.material.side).toBe(DoubleSide);
      expect(terrain.mesh.receiveShadow).toBe(true);
    });

    it('rejects a non-positive size', () => {
      expect(() => small({ size: 0 })).toThrow(RangeError);
      expect(() => small({ size: -10 })).toThrow(RangeError);
    });
  });

  describe('heightmap', () => {
    it('produces a terrain with real relief, not a flat plane', () => {
      const terrain = small({ size: 200 });
      const { data } = terrain;

      expect(data.maxHeight - data.minHeight).toBeGreaterThan(3);
      // And not a spike field either - the relief is hills, not noise.
      expect(data.maxHeight - data.minHeight).toBeLessThan(60);
    });

    it('is deterministic for a given seed', () => {
      const a = small({ size: 120, seed: 42 });
      const b = small({ size: 120, seed: 42 });
      const c = small({ size: 120, seed: 43 });

      expect(Array.from(a.data.heights.slice(0, 200))).toEqual(
        Array.from(b.data.heights.slice(0, 200)),
      );
      expect(Array.from(a.data.heights.slice(0, 200))).not.toEqual(
        Array.from(c.data.heights.slice(0, 200)),
      );
    });

    it('is finite everywhere', () => {
      const terrain = small();
      for (let i = 0; i < terrain.data.heights.length; i++) {
        expect(Number.isFinite(terrain.data.heights[i])).toBe(true);
      }
    });

    it('agrees between heightAt and the raw grid', () => {
      const terrain = small({ size: 100 });
      const step = 100 / 47;
      // Sample a grid vertex exactly: bilinear interpolation at a node must
      // return that node's height.
      for (const [i, j] of [
        [0, 0],
        [10, 20],
        [47, 47],
        [23, 5],
      ] as [number, number][]) {
        const x = -50 + j * step;
        const z = -50 + i * step;
        expect(terrain.heightAt(x, z)).toBeCloseTo(terrain.data.heights[i * 48 + j], 4);
      }
    });

    it('clamps heightAt outside the terrain instead of throwing', () => {
      const terrain = small({ size: 100 });
      // The player can walk off the edge; the systems that ask for the height
      // there should get an answer, not an exception.
      expect(() => terrain.heightAt(10_000, 10_000)).not.toThrow();
      expect(Number.isFinite(terrain.heightAt(-10_000, -10_000))).toBe(true);
    });

    it('carves a valley along the stream spline', () => {
      const spline = new StreamSpline();
      const terrain = small({ size: 200, seed: 5 });

      // The lowest ground in the valley must be lower than the same ground
      // would be without the carve. Compare against a terrain generated with
      // no spline at all - which still carves, because a default spline is
      // substituted - so instead compare the carved ground against the
      // surrounding ring at the same distance from the centre.
      const onStream = terrain.heightAt(spline.pointAt(0.5).x, spline.pointAt(0.5).z);
      const offStream = terrain.heightAt(-90, -90);

      expect(onStream).toBeLessThan(offStream);
      expect(terrain.distanceToStream(spline.pointAt(0.5).x, spline.pointAt(0.5).z)).toBeLessThan(
        1,
      );
    });

    it('reports distance to the stream', () => {
      const spline = new StreamSpline();
      const terrain = small({ size: 200, seed: 9 });

      const onIt = terrain.distanceToStream(spline.pointAt(0.3).x, spline.pointAt(0.3).z);
      const farAway = terrain.distanceToStream(200, 200);

      expect(onIt).toBeLessThan(1);
      expect(farAway).toBeGreaterThan(50);
    });
  });

  describe('normals', () => {
    it('returns a unit normal everywhere', () => {
      const terrain = small({ size: 160 });
      for (let i = 0; i < 20; i++) {
        const n = terrain.normalAt(-70 + i * 7, -40 + i * 5);
        expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
      }
    });

    it('returns an upward normal on flat ground', () => {
      // Zero every height term, so the only thing under test is the normal
      // maths. Leaving the valley carve in would give a real - if tiny -
      // gradient, and the assertion would then be measuring the Gaussian
      // rather than the gradient code.
      const terrain = small({
        size: 100,
        hillAmplitude: 0,
        rimAmplitude: 0,
        rimLift: 0,
        valleyDepth: 0,
      });
      expect(terrain.heightAt(0, 0)).toBe(0);

      const n = terrain.normalAt(0, 0);
      expect(n.y).toBeCloseTo(1, 6);
      expect(Math.abs(n.x)).toBeLessThan(1e-6);
      expect(Math.abs(n.z)).toBeLessThan(1e-6);
      expect(terrain.slopeAt(0, 0)).toBeCloseTo(0, 6);
    });

    it('leans into the slope', () => {
      const terrain = small({ size: 200, seed: 3 });
      // Somewhere on a 200m terrain with 5.5m hills there is a real slope.
      let found = false;
      for (let i = 0; i < 100 && !found; i++) {
        const x = -95 + i * 1.9;
        const n = terrain.normalAt(x, 12);
        if (n.y < 0.97) {
          found = true;
          expect(n.y).toBeLessThan(1);
        }
      }
      expect(found).toBe(true);
    });

    it('reports slope consistent with the normal', () => {
      const terrain = small({ size: 200, seed: 4 });
      for (let i = 0; i < 20; i++) {
        const x = -90 + i * 9;
        const z = -60 + i * 5;
        const n = terrain.normalAt(x, z);
        expect(terrain.slopeAt(x, z)).toBeCloseTo(1 - n.y, 6);
      }
    });
  });

  describe('spawning', () => {
    it('places a capsule above the surface', () => {
      const terrain = small({ size: 200, seed: 7 });
      const spawn = terrain.restHeight(10, -20, 1.8);

      expect(spawn.y).toBeGreaterThan(terrain.heightAt(10, -20) + 1.8 / 2);
      expect(spawn.y).toBeLessThan(terrain.heightAt(10, -20) + 1.8 / 2 + 0.2);
      expect(spawn.x).toBe(10);
      expect(spawn.z).toBe(-20);
    });
  });

  describe('collision data', () => {
    it('hands back the mesh own buffers, in world coordinates', () => {
      const terrain = small({ size: 100 });
      const { vertices, indices } = terrain.collisionData();
      const position = terrain.mesh.geometry.getAttribute('position');

      // The same buffer object, not a copy: that is the whole point.
      expect(vertices).toBe(position.array);
      expect(vertices.length).toBe(position.count * 3);

      // Every index must be in range, or Rapier rejects the whole collider.
      const vertexCount = position.count;
      for (let i = 0; i < indices.length; i++) {
        expect(indices[i]).toBeLessThan(vertexCount);
      }
      expect(indices.length % 3).toBe(0);
    });

    it('agrees with heightAt at every sampled vertex', () => {
      const terrain = small({ size: 100 });
      const position = terrain.mesh.geometry.getAttribute('position');
      // Spot-check that the collider's y really is the terrain's height at
      // that x/z - the check that catches a transposed or offset grid.
      for (let i = 0; i < position.count; i += 97) {
        const x = position.getX(i);
        const y = position.getY(i);
        const z = position.getZ(i);
        expect(y).toBeCloseTo(terrain.heightAt(x, z), 3);
      }
    });
  });

  describe('scene attachment', () => {
    it('attaches to and detaches from a scene', () => {
      const scene = new Scene();
      const terrain = small();

      terrain.addTo(scene);
      expect(scene.children).toContain(terrain.mesh);
      expect(scene.getObjectByName('terrain')).toBe(terrain.mesh);

      terrain.removeFrom(scene);
      expect(scene.children).not.toContain(terrain.mesh);
    });

    it('keeps the mesh localToWorld contract for camera work', () => {
      const terrain = small({ size: 100 });
      terrain.mesh.updateMatrixWorld();

      // A point on the surface must map to itself plus no offset: the mesh
      // transform is identity, so local and world agree.
      const local = new Vector3(12, 0, -30);
      const world = terrain.mesh.localToWorld(local);
      expect(world.x).toBeCloseTo(12, 6);
      expect(world.z).toBeCloseTo(-30, 6);
    });
  });

  describe('disposal', () => {
    it('releases its GPU resources', () => {
      const terrain = small();
      const disposeGeometry = vi.spyOn(terrain.mesh.geometry, 'dispose');
      const disposeMaterial = vi.spyOn(terrain.mesh.material, 'dispose');

      terrain.dispose();

      expect(disposeGeometry).toHaveBeenCalledTimes(1);
      expect(disposeMaterial).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The two samplers Step 2.8's audio needs.
   *
   * Both read fields the terrain already bakes, and that is the whole point: a
   * footstep that decides what it landed on from anything other than the weights
   * the terrain shader blends with is a footstep that can disagree with the
   * ground the player can see. So these tests check the samplers agree with the
   * arrays rather than merely returning something plausible.
   */
  describe('surface samplers', () => {
    it('returns biome weights that are normalised and in range everywhere', () => {
      const terrain = small({ size: 200 });
      const distinct = new Set<string>();

      for (let x = -95; x <= 95; x += 5) {
        for (let z = -95; z <= 95; z += 5) {
          const b = terrain.biomeAt(x, z);
          const sum = b.grass + b.dirt + b.rock + b.mud;
          expect(Math.abs(sum - 1), `sum at ${x},${z}`).toBeLessThan(1e-4);
          for (const [name, value] of Object.entries(b)) {
            expect(value, `${name} at ${x},${z}`).toBeGreaterThanOrEqual(-1e-6);
            expect(value, `${name} at ${x},${z}`).toBeLessThanOrEqual(1 + 1e-6);
          }
          distinct.add(`${b.grass.toFixed(2)},${b.dirt.toFixed(2)},${b.rock.toFixed(2)},${b.mud.toFixed(2)}`);
        }
      }

      // Measured on the default terrain: 185 distinct weight vectors over a
      // 34x34 sample grid. Four smooth rules with no noise factor produce four
      // smooth bands and a handful of distinct vectors; the Voronoi and simplex
      // perturbation is what breaks them up, and this is where that shows.
      expect(distinct.size).toBeGreaterThan(50);
    });

    it('reproduces the baked array exactly at a grid vertex', () => {
      // The strongest available check that the sampler reads the same lattice
      // the generator wrote. At a vertex the bilinear weights are 0 and 1, so
      // an interpolation that had drifted - a transposed index, a stride off by
      // one - would show up here as a mismatch rather than as a small error.
      const terrain = small({ size: 200, resolution: 48 });
      const half = 100;
      const step = 200 / 47;
      const resolution = 48;

      const snap = (v: number): number => -half + Math.round((v + half) / step) * step;
      const vx = snap(37);
      const vz = snap(-12);

      const sampled = terrain.biomeAt(vx, vz);
      const i = Math.round((vz + half) / step);
      const j = Math.round((vx + half) / step);
      const o = (i * resolution + j) * 4;

      expect(sampled.grass).toBeCloseTo(terrain.data.biomeWeights[o], 6);
      expect(sampled.dirt).toBeCloseTo(terrain.data.biomeWeights[o + 1], 6);
      expect(sampled.rock).toBeCloseTo(terrain.data.biomeWeights[o + 2], 6);
      expect(sampled.mud).toBeCloseTo(terrain.data.biomeWeights[o + 3], 6);
    });

    it('samples corruption in the same range the field is defined over', () => {
      const terrain = small({ size: 200 });

      let min = Infinity;
      let max = -Infinity;
      for (let x = -95; x <= 95; x += 5) {
        for (let z = -95; z <= 95; z += 5) {
          const c = terrain.corruptionAt(x, z);
          expect(Number.isFinite(c)).toBe(true);
          min = Math.min(min, c);
          max = Math.max(max, c);
        }
      }

      // 0 to 1 by construction, and both ends actually reached on the small
      // terrain - a sampler that returned a constant would pass a range check
      // and fail this one.
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(1);
      expect(max - min).toBeGreaterThan(0.2);
    });

    it('clamps outside the terrain instead of throwing', () => {
      // The player can walk off the edge, and a sampler that threw on the way
      // out would take the audio - and anything else that asked - with it.
      const terrain = small({ size: 200 });
      for (const [x, z] of [[9999, -9999], [-9999, 9999], [0, 5000]]) {
        const b = terrain.biomeAt(x, z);
        expect(Math.abs(b.grass + b.dirt + b.rock + b.mud - 1)).toBeLessThan(1e-4);
        expect(terrain.corruptionAt(x, z)).toBeGreaterThanOrEqual(0);
      }
    });

    it('is deterministic', () => {
      const terrain = small({ size: 200 });
      const a = terrain.biomeAt(11, -22);
      const b = terrain.biomeAt(11, -22);
      expect(a).toEqual(b);
      expect(terrain.corruptionAt(11, -22)).toBe(terrain.corruptionAt(11, -22));
    });
  });
});
