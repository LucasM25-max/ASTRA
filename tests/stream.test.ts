import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, Points } from 'three';
import { StreamSpline } from '../src/procedural/StreamSpline';
import { generateTerrain } from '../src/procedural/TerrainGenerator';
import { DEFAULT_STREAM_DEPTH, generateStream } from '../src/procedural/StreamGenerator';
import { Stream } from '../src/world/Stream';

/**
 * A terrain with the same cell size as production.
 *
 * 250 m over 192 vertices is a 1.304 m cell, exactly what the default 500 m /
 * 384 vertex world uses. That matters more than it looks: the channel carve
 * spreads its bank rise over one cell wide, so a coarser grid cannot represent
 * the channel and the water's edge floats. Testing against a 2.5 m grid would
 * be testing a world the game never builds.
 *
 * The spline has to be the same one the stream is built on. The channel is
 * carved along whatever spline the terrain was given, so a stream on a different
 * path runs through uncarved ground and floats - which is exactly what happened
 * the first time this test was written, and it looked like a bug in the carve.
 */
const PROBE_SIZE = 250;
const PROBE_RESOLUTION = 192;

/**
 * A spline that actually fits inside the test world.
 *
 * The default spline runs 485 m from one corner of a 500 m map to the other. A
 * test terrain has to be smaller than that to be worth building, so the default
 * spline would run clean out of it - and a stream measured against ground it is
 * not on measures nothing.
 */
const probeSpline = new StreamSpline({
  controlPoints: [
    { x: -85, y: 0, z: 62 },
    { x: -45, y: 0, z: 35 },
    { x: 0, y: 0, z: 5 },
    { x: 45, y: 0, z: -30 },
    { x: 85, y: 0, z: -62 },
  ],
  samples: 600,
});

/** A terrain with the production cell size, carved along `spline`. */
function smallTerrain(seed = 3, spline: StreamSpline = probeSpline) {
  return generateTerrain({
    size: PROBE_SIZE,
    resolution: PROBE_RESOLUTION,
    seed,
    spline,
  });
}

/** A straight spline, so "across the flow" is unambiguous. */
const straight = new StreamSpline({
  controlPoints: [
    { x: 0, y: 0, z: 0 },
    { x: 40, y: 0, z: 0 },
    { x: 80, y: 0, z: 0 },
  ],
  samples: 300,
});

function buildStream(
  options: { seed?: number; moteCount?: number } = {},
): { stream: Stream; heightAt: (x: number, z: number) => number } {
  const terrain = smallTerrain(options.seed ?? 3);
  const heightAt = (x: number, z: number): number => terrain.heightAt(x, z);
  const stream = new Stream({
    spline: probeSpline,
    heightAt,
    seed: options.seed ?? 3,
    moteCount: options.moteCount,
    stream: { segments: 96 },
  });
  return { stream, heightAt };
}

let current: Stream[] = [];
function track(stream: Stream): Stream {
  current.push(stream);
  return stream;
}
afterEach(() => {
  for (const s of current) s.dispose();
  current = [];
});

describe('Stream', () => {
  describe('construction', () => {
    it('builds a water mesh carrying the custom attributes', () => {
      const { stream } = buildStream();
      track(stream);
      const geometry = stream.mesh.geometry;
      expect(geometry.getAttribute('astraFlow')).toBeDefined();
      expect(geometry.getAttribute('astraDepth')).toBeDefined();
      expect(geometry.getAttribute('astraPollution')).toBeDefined();
      expect(geometry.getAttribute('position')).toBeDefined();
      expect(geometry.getIndex()).not.toBeNull();
    });

    it('gives the mesh a bounding sphere, so culling does not measure it', () => {
      const { stream } = buildStream();
      track(stream);
      expect(stream.mesh.geometry.boundingSphere).not.toBeNull();
    });

    it('names its meshes, so the debug overlay can find them', () => {
      const { stream } = buildStream();
      track(stream);
      expect(stream.mesh.name).toBe('stream-water');
      expect(stream.motes?.name).toBe('stream-motes');
    });

    it('builds motes by default and none when asked not to', () => {
      const withMotes = buildStream();
      track(withMotes.stream);
      expect(withMotes.stream.motes).toBeInstanceOf(Points);

      const without = buildStream({ moteCount: 0 });
      track(without.stream);
      expect(without.stream.motes).toBeNull();
    });

    it('never builds audio when none is asked for', () => {
      // There is no AudioContext in Node, and a stream must be constructible
      // without one - the world scene tests build a whole world here.
      const { stream } = buildStream();
      track(stream);
      expect(stream.sound).toBeNull();
    });

    it('exposes the spline and the profile it was built from', () => {
      const { stream } = buildStream();
      track(stream);
      expect(stream.spline).toBeInstanceOf(StreamSpline);
      expect(stream.profile).toBe(stream.data.profile);
      expect(stream.length).toBeCloseTo(stream.spline.length, 9);
    });
  });

  describe('queries', () => {
    it('answers everything about a point on the water', () => {
      const { stream } = buildStream();
      track(stream);
      const a = stream.length * 0.5;
      const p = stream.spline.pointAtDistance(a);
      const q = stream.query(p.x, p.z);

      expect(q.distance).toBeLessThan(0.01);
      expect(q.arcLength).toBeCloseTo(a, 0);
      expect(q.halfWidth).toBeGreaterThan(0.5);
      expect(Number.isFinite(q.surfaceY)).toBe(true);
      expect(q.pollution).toBeGreaterThan(0);
      expect(q.pollution).toBeLessThan(1);
    });

    it('knows what is water and what is bank', () => {
      const { stream } = buildStream();
      track(stream);
      const a = stream.length * 0.5;
      const p = stream.spline.pointAtDistance(a);
      const n = stream.profile.normalAtDistance(a);
      const hw = stream.profile.halfWidthAtDistance(a);

      expect(stream.isWaterAt(p.x + n.x * hw * 0.5, p.z + n.z * hw * 0.5)).toBe(true);
      expect(stream.isWaterAt(p.x + n.x * (hw + 2), p.z + n.z * (hw + 2))).toBe(false);
    });

    it('reports the surface height at a world position', () => {
      const { stream, heightAt } = buildStream();
      track(stream);
      const a = stream.length * 0.25;
      const p = stream.spline.pointAtDistance(a);
      const expected = stream.profile.surfaceHeightAtDistance(a, heightAt);
      expect(stream.surfaceYAt(p.x, p.z)).toBeCloseTo(expected, 6);
    });

    it('reports pollution at a world position', () => {
      const { stream } = buildStream();
      track(stream);
      const near = stream.spline.pointAtDistance(0);
      const far = stream.spline.pointAtDistance(stream.length);
      expect(stream.pollutionAt(near.x, near.z)).toBeGreaterThan(
        stream.pollutionAt(far.x, far.z),
      );
    });

    it('measures submersion from the feet, not the body centre', () => {
      // The classic bug: a 1.8 m capsule in 0.3 m of water has its centre 0.9 m
      // above the surface, so asking the centre reports "not in the water".
      const { stream } = buildStream();
      track(stream);
      const a = stream.length * 0.5;
      const p = stream.spline.pointAtDistance(a);
      const surface = stream.surfaceYAt(p.x, p.z);

      expect(stream.submersionAt(p.x, p.z, surface - 0.3)).toBeCloseTo(0.3, 6);
      expect(stream.submersionAt(p.x, p.z, surface + 1.2)).toBe(0);
      expect(stream.submersionAt(p.x, p.z, surface - 0.3)).toBeLessThanOrEqual(
        DEFAULT_STREAM_DEPTH + 1e-9,
      );
    });
  });

  describe('the motes', () => {
    it('start scattered along the whole stream', () => {
      const { stream } = buildStream({ moteCount: 40 });
      track(stream);
      const positions = stream.motes?.geometry.getAttribute('position');
      expect(positions).toBeDefined();
      expect(positions?.count).toBe(40);

      const xs: number[] = [];
      for (let i = 0; i < 40; i++) xs.push(positions?.getX(i) ?? 0);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(10);
    });

    it('carry a colour attribute, which is how they fade in and out', () => {
      const { stream } = buildStream({ moteCount: 12 });
      track(stream);
      const colors = stream.motes?.geometry.getAttribute('color');
      expect(colors).toBeDefined();
      expect(colors?.count).toBe(12);
    });

    it('move downstream when advanced', () => {
      const { stream } = buildStream({ moteCount: 30 });
      track(stream);
      const before = Float32Array.from(
        stream.motes?.geometry.getAttribute('position').array as Float32Array,
      );

      stream.update(1, { x: 0, y: 5, z: 0 });

      const after = stream.motes?.geometry.getAttribute('position').array as Float32Array;
      let moved = 0;
      for (let i = 0; i < after.length; i++) {
        if (Math.abs(after[i] - before[i]) > 1e-4) moved++;
      }
      expect(moved).toBeGreaterThan(0);
    });

    it('stay on the water surface, not under it', () => {
      const { stream } = buildStream({ moteCount: 20 });
      track(stream);
      stream.update(0.5, { x: 0, y: 5, z: 0 });
      const positions = stream.motes?.geometry.getAttribute('position');
      for (let i = 0; i < 20; i++) {
        const x = positions?.getX(i) ?? 0;
        const y = positions?.getY(i) ?? 0;
        const z = positions?.getZ(i) ?? 0;
        const surface = stream.surfaceYAt(x, z);
        // A mote rides just above the surface. Below it would be invisible
        // through the water, and far above it would read as a firefly.
        expect(y).toBeGreaterThan(surface - 0.05);
        expect(y).toBeLessThan(surface + 0.2);
      }
    });

    it('recycles a mote that runs off the downstream end', () => {
      const { stream } = buildStream({ moteCount: 5 });
      track(stream);
      // Far longer than the stream takes to traverse at 0.5 m/s.
      stream.update(stream.length / 0.5 + 2, { x: 0, y: 5, z: 0 });
      const positions = stream.motes?.geometry.getAttribute('position');
      for (let i = 0; i < 5; i++) {
        const x = positions?.getX(i) ?? 0;
        const z = positions?.getZ(i) ?? 0;
        // Somewhere along the stream, not flung off the end of the world.
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(z)).toBe(true);
        expect(stream.query(x, z).distance).toBeLessThan(
          stream.profile.halfWidthAtDistance(stream.query(x, z).arcLength) + 1,
        );
      }
    });

    it('is a no-op with no motes at all', () => {
      const { stream } = buildStream({ moteCount: 0 });
      track(stream);
      expect(() => stream.update(1, { x: 0, y: 5, z: 0 })).not.toThrow();
    });
  });

  describe('the flow animation', () => {
    it('advances the shader time uniform', () => {
      const { stream } = buildStream({ moteCount: 0 });
      track(stream);
      // `onBeforeCompile` has not run in Node, so there is no uniform object
      // yet - which is exactly why advancing it must not throw.
      expect(() => stream.update(0.5, { x: 0, y: 5, z: 0 })).not.toThrow();
      expect(() => stream.update(0.5, { x: 0, y: 5, z: 0 })).not.toThrow();
    });

    it('ignores a negative or non-finite delta', () => {
      const { stream } = buildStream({ moteCount: 0 });
      track(stream);
      expect(() => stream.update(-1, { x: 0, y: 5, z: 0 })).not.toThrow();
      expect(() => stream.update(Number.NaN, { x: 0, y: 5, z: 0 })).not.toThrow();
    });
  });

  describe('scene membership and teardown', () => {
    it('attaches and detaches from a parent', () => {
      const { stream } = buildStream();
      track(stream);
      const parent = new Object3D();
      stream.addTo(parent);
      expect(parent.children).toContain(stream.mesh);
      expect(parent.children).toContain(stream.motes);

      stream.removeFrom(parent);
      expect(parent.children).not.toContain(stream.mesh);
      expect(parent.children).not.toContain(stream.motes);
    });

    it('is idempotent on dispose', () => {
      const { stream } = buildStream();
      stream.dispose();
      expect(() => stream.dispose()).not.toThrow();
    });

    it('stops updating once disposed', () => {
      const { stream } = buildStream({ moteCount: 10 });
      stream.dispose();
      expect(() => stream.update(1, { x: 0, y: 5, z: 0 })).not.toThrow();
    });
  });
});

describe('Stream against the real terrain', () => {
  /**
   * The integration check that mattered most while this was being built: the
   * water has to sit inside the channel the terrain carved, with its edge buried
   * in the bank. Every earlier attempt passed its unit tests and floated.
   */
  it('buries the ribbon edge in the ground along the whole stream', () => {
    const terrain = smallTerrain(11);
    const heightAt = (x: number, z: number): number => terrain.heightAt(x, z);
    const stream = new Stream({
      spline: probeSpline,
      heightAt,
      seed: 11,
      moteCount: 0,
      stream: { segments: 192 },
    });
    track(stream);

    const positions = stream.mesh.geometry.getAttribute('position');
    const ws = stream.data.widthSegments;
    // The *largest* gap, so the worst case is the one that decides. Starting at
    // +Infinity would make the comparison never fire and the test pass for the
    // wrong reason.
    let worst = -Infinity;
    let where = '';
    for (let i = 0; i <= stream.data.segments; i++) {
      for (const w of [0, ws - 1]) {
        const v = i * ws + w;
        const gap =
          positions.getY(v) - heightAt(positions.getX(v), positions.getZ(v));
        if (gap > worst) {
          worst = gap;
          where = `arc ${((i / stream.data.segments) * stream.length).toFixed(0)}m`;
        }
      }
    }
    // Positive would mean the water's edge is floating above the bank.
    expect(worst, `worst edge gap at ${where}`).toBeLessThan(0);
  });

  it('keeps the water surface at the depth it was designed for', () => {
    const terrain = smallTerrain(11);
    const heightAt = (x: number, z: number): number => terrain.heightAt(x, z);
    const stream = new Stream({
      spline: probeSpline,
      heightAt,
      seed: 11,
      moteCount: 0,
      stream: { segments: 96 },
    });
    track(stream);

    const depths: number[] = [];
    for (let i = 0; i <= 60; i++) {
      const a = (i / 60) * stream.length;
      const p = stream.spline.pointAtDistance(a);
      // Measured at one arc position, on purpose. `surfaceYAt(x, z)` has to find
      // the nearest point on the spline first, and on a curved spline that is
      // not exactly the point the caller started from - so mixing the two would
      // compare a surface at one arc position against ground at another, and
      // report a depth error that is really a lookup error.
      const surface = stream.profile.surfaceHeightAtDistance(a, heightAt);
      depths.push(surface - heightAt(p.x, p.z));
    }
    const min = Math.min(...depths);
    const max = Math.max(...depths);
    // The bed is flat, so the centre depth is the designed depth everywhere,
    // give or take the sampling the profile does.
    expect(min).toBeGreaterThan(DEFAULT_STREAM_DEPTH * 0.8);
    expect(max).toBeLessThanOrEqual(DEFAULT_STREAM_DEPTH + 1e-6);
  });

  it('agrees with the terrain about which spline it follows', () => {
    const terrain = smallTerrain(5);
    const stream = new Stream({
      spline: probeSpline,
      heightAt: (x, z) => terrain.heightAt(x, z),
      seed: 5,
      moteCount: 0,
      stream: { segments: 32 },
    });
    track(stream);
    expect(stream.spline).toBe(probeSpline);
  });

  it('is reproducible from the same seed', () => {
    const build = (): Float32Array => {
      const terrain = smallTerrain(7);
      const stream = new Stream({
        spline: probeSpline,
        heightAt: (x, z) => terrain.heightAt(x, z),
        seed: 7,
        moteCount: 0,
        stream: { segments: 32 },
      });
      const out = Float32Array.from(stream.mesh.geometry.getAttribute('position').array);
      stream.dispose();
      return out;
    };
    expect(Array.from(build())).toEqual(Array.from(build()));
  });
});

describe('generateStream with a straight spline', () => {
  it('puts the ribbon square across a straight stream', () => {
    // A straight spline along +X has its flow across +Z, so a cross-section is a
    // line of constant X. Getting this wrong means the ribbon runs along the
    // stream instead of across it, and the water is a long thin sheet.
    const data = generateStream({ spline: straight, heightAt: () => 0, segments: 8 });
    const ws = data.widthSegments;
    for (let i = 0; i <= 8; i++) {
      const x = data.vertices[i * ws * 3];
      for (let w = 1; w < ws; w++) {
        expect(data.vertices[(i * ws + w) * 3]).toBeCloseTo(x, 6);
      }
    }
    // And the vertices do spread in Z.
    const zs: number[] = [];
    for (let w = 0; w < ws; w++) zs.push(data.vertices[w * 3 + 2]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(1);
  });
});
