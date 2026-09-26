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
      expect(material.customProgramCacheKey()).toBe('astra-terrain-v1');
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
});
