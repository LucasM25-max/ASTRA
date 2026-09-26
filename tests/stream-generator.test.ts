import { describe, expect, it } from 'vitest';
import { StreamSpline } from '../src/procedural/StreamSpline';
import {
  BANK_MARGIN,
  BANK_PLATEAU,
  BANK_RISE,
  DEFAULT_STREAM_DEPTH,
  DEFAULT_STREAM_SEGMENTS,
  DEFAULT_STREAM_WIDTH_SEGMENTS,
  MAX_STREAM_HALF_WIDTH,
  MIN_STREAM_HALF_WIDTH,
  StreamProfile,
  generateStream,
  type StreamData,
} from '../src/procedural/StreamGenerator';

/** A straight spline, so "across the flow" has an unambiguous direction. */
const straight = new StreamSpline({
  controlPoints: [
    { x: 0, y: 0, z: 0 },
    { x: 50, y: 0, z: 0 },
    { x: 100, y: 0, z: 0 },
  ],
  samples: 400,
});

/** A gentle curve, so the arc length is not the same as the chord. */
const curved = new StreamSpline({
  controlPoints: [
    { x: 0, y: 0, z: 0 },
    { x: 40, y: 0, z: 0 },
    { x: 60, y: 0, z: 30 },
    { x: 90, y: 0, z: 60 },
  ],
  samples: 600,
});

/**
 * A flat ground at `y = 0`, which makes the designed cross-section's arithmetic
 * exactly checkable: the bed lands at `-drop`, the surface at `-drop + depth`.
 */
const flatGround = (): number => 0;

/**
 * A stream as wide as it can be, with no width noise.
 *
 * The flat bed stops `t * BANK_RISE` short of the water's edge, and a stream
 * narrower than that has no flat bed at all - its whole width is the climb. The
 * default width is close enough to that floor that the noise decides whether a
 * bed exists, which makes any test that needs one a coin flip. Pinning the width
 * to the maximum with no variation makes the bed 0.3 m wide and the arithmetic
 * exact.
 */
function wideProfile(): StreamProfile {
  return new StreamProfile(straight, {
    width: MAX_STREAM_HALF_WIDTH,
    widthVariation: 0,
  });
}

describe('StreamProfile', () => {
  describe('width', () => {
    it('stays inside the documented range over the whole spline', () => {
      const profile = new StreamProfile(straight);
      for (let i = 0; i <= 200; i++) {
        const hw = profile.halfWidthAtDistance((i / 200) * straight.length);
        expect(hw).toBeGreaterThanOrEqual(MIN_STREAM_HALF_WIDTH - 1e-9);
        expect(hw).toBeLessThanOrEqual(MAX_STREAM_HALF_WIDTH + 1e-9);
      }
    });

    it('actually varies along the stream', () => {
      const profile = new StreamProfile(straight);
      const widths = new Set<string>();
      for (let i = 0; i <= 100; i++) {
        widths.add(profile.halfWidthAtDistance((i / 100) * straight.length).toFixed(4));
      }
      // A constant width would mean the noise was not reaching the profile.
      expect(widths.size).toBeGreaterThan(20);
    });

    it('gives the same answer for a distance and for the matching u', () => {
      const profile = new StreamProfile(straight);
      const a = straight.length * 0.37;
      expect(profile.halfWidthAt(0.37)).toBeCloseTo(profile.halfWidthAtDistance(a), 12);
    });

    it('clamps a distance past either end', () => {
      const profile = new StreamProfile(straight);
      expect(profile.halfWidthAtDistance(-50)).toBeCloseTo(profile.halfWidthAtDistance(0), 12);
      expect(profile.halfWidthAtDistance(straight.length * 2)).toBeCloseTo(
        profile.halfWidthAtDistance(straight.length),
        12,
      );
    });
  });

  describe('bed and ribbon half-width', () => {
    it('puts the ribbon past the water and the water past the bed', () => {
      const profile = new StreamProfile(straight);
      for (let i = 0; i <= 50; i++) {
        const a = (i / 50) * straight.length;
        const bed = profile.bedHalfWidthAtDistance(a);
        const water = profile.halfWidthAtDistance(a);
        const ribbon = profile.ribbonHalfWidthAtDistance(a);

        expect(ribbon).toBeCloseTo(bed + BANK_RISE + BANK_PLATEAU, 12);
        // The bed is never wider than the water, and the ribbon always reaches
        // past it - otherwise the shoreline would have nothing to fade into.
        expect(bed).toBeLessThanOrEqual(water + 1e-9);
        expect(ribbon).toBeGreaterThanOrEqual(water);
      }
    });

    it('cannot make the stream narrower than the rise band allows', () => {
      // A stream whose half-width is below `t * BANK_RISE` would need a negative
      // flat bed. The clamp is what keeps that from happening, and the
      // consequence - the narrowest possible stream - is the point of the test.
      const profile = new StreamProfile(straight, { width: MIN_STREAM_HALF_WIDTH });
      const a = straight.length / 2;
      expect(profile.bedHalfWidthAtDistance(a)).toBeGreaterThanOrEqual(0);
      expect(profile.ribbonHalfWidthAtDistance(a)).toBeGreaterThan(
        profile.halfWidthAtDistance(a),
      );
    });

    it('renders the narrowest stream at the floor the rise band sets', () => {
      // Past the clamp the bed is zero wide and the whole channel is the climb,
      // so every stream narrower than `t * BANK_RISE` comes out the same width.
      // That floor is what the terrain grid can show: a narrower channel would
      // be under one cell across, and the water would float in it.
      const narrow = new StreamProfile(straight, {
        width: MIN_STREAM_HALF_WIDTH,
        widthVariation: 0,
      });
      const a = straight.length / 2;
      expect(narrow.bedHalfWidthAtDistance(a)).toBeCloseTo(0, 12);
      const hw = narrow.halfWidthAtDistance(a);
      // Still water at the nominal half-width, because the climb only gets up to
      // the surface further out than the stream claims to be.
      expect(narrow.depthAtAcross(a, hw)).toBeGreaterThan(0);
      // And it does run out - past the floor the ground is above the water.
      expect(narrow.depthAtAcross(a, hw + 1.5)).toBeLessThan(0);
    });
  });

  describe('surface height', () => {
    it('sits exactly `depth` above flat ground', () => {
      const profile = new StreamProfile(straight);
      const surface = profile.surfaceHeightAtDistance(straight.length / 2, flatGround);
      expect(surface).toBeCloseTo(DEFAULT_STREAM_DEPTH, 12);
    });

    it('is level across the cross-section', () => {
      // The whole point of the design: every vertex in a row shares one height.
      const data = generateStream({
        spline: straight,
        heightAt: flatGround,
        segments: 24,
        widthSegments: 7,
      });
      const y = data.vertices[1];
      for (let w = 0; w < 7; w++) {
        expect(data.vertices[w * 3 + 1]).toBeCloseTo(y, 12);
      }
    });

    it('is `depth` above the *lowest* ground, not the ground under the spline', () => {
      // A dip to one side must not lift the whole surface, and a rise to one
      // side must not sink it. The lowest sample wins, which is what makes the
      // height exactly readable off the flat bed.
      const profile = wideProfile();
      // The spline runs along +X, so the direction across the flow is +Z. The
      // step sits under the spline, and the flat bed is wide enough that the
      // samples the profile takes reach both sides of it.
      const ground = (_x: number, z: number): number => (z < 0 ? -0.4 : 0.2);
      expect(profile.surfaceHeightAtDistance(25, ground)).toBeCloseTo(
        -0.4 + DEFAULT_STREAM_DEPTH,
        12,
      );
    });

    it('is the same for a distance and for the matching u', () => {
      const profile = new StreamProfile(straight);
      expect(profile.surfaceHeightAt(0.5, flatGround)).toBeCloseTo(
        profile.surfaceHeightAtDistance(straight.length * 0.5, flatGround),
        12,
      );
    });
  });

  describe('depth across the flow', () => {
    it('is the full depth on the flat bed', () => {
      const profile = new StreamProfile(straight);
      expect(profile.depthAtAcross(25, 0)).toBeCloseTo(DEFAULT_STREAM_DEPTH, 12);
    });

    it('reaches zero where the ground climbs through the surface', () => {
      // This is the shoreline, and the plan's width is measured to it: the
      // crossing has to land at the stream's nominal half-width.
      const profile = wideProfile();
      const at = profile.halfWidthAtDistance(25);
      const depth = profile.depthAtAcross(25, at);
      expect(Math.abs(depth)).toBeLessThan(0.02);
    });

    it('goes negative past the shoreline, where the ground is above the water', () => {
      const profile = wideProfile();
      expect(profile.depthAtAcross(25, profile.halfWidthAtDistance(25) + 0.5)).toBeLessThan(0);
    });

    it('clears the water surface by the bank margin at the ribbon edge', () => {
      const profile = new StreamProfile(straight);
      const a = straight.length * 0.4;
      const edge = profile.depthAtAcross(a, profile.ribbonHalfWidthAtDistance(a));
      expect(edge).toBeCloseTo(-BANK_MARGIN, 10);
    });
  });

  describe('pollution', () => {
    it('matches the three zones the plan names', () => {
      const profile = new StreamProfile(straight);
      // u = 0 is the cave end and u = 1 the village end.
      expect(profile.pollutionAt(0)).toBeCloseTo(0.9, 6);
      expect(profile.pollutionAt(0.5)).toBeCloseTo(0.6, 6);
      expect(profile.pollutionAt(1)).toBeCloseTo(0.2, 6);
    });

    it('is monotonic downstream', () => {
      const profile = new StreamProfile(straight);
      let previous = Infinity;
      for (let i = 0; i <= 100; i++) {
        const p = profile.pollutionAtDistance((i / 100) * straight.length);
        expect(p).toBeLessThanOrEqual(previous + 1e-9);
        previous = p;
      }
    });

    it('stays inside 0 to 1 everywhere', () => {
      const profile = new StreamProfile(straight);
      for (let i = 0; i <= 200; i++) {
        const p = profile.pollutionAtDistance((i / 200) * straight.length);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    });

    it('has no corner where the zones meet', () => {
      // Smoothstep has zero derivative at both ends, so the gradient is
      // continuous at u = 0.5. A linear blend would put a visible kink in the
      // middle of the stream.
      const profile = new StreamProfile(straight);
      const h = 1e-4;
      const before = (profile.pollutionAtDistance(0.5 * straight.length - h) -
        profile.pollutionAtDistance(0.5 * straight.length - 2 * h)) /
        h;
      const after = (profile.pollutionAtDistance(0.5 * straight.length + h) -
        profile.pollutionAtDistance(0.5 * straight.length)) /
        h;
      expect(before).toBeCloseTo(after, 3);
    });

    it('moves smoothly rather than stepping', () => {
      const profile = new StreamProfile(straight);
      let biggest = 0;
      for (let i = 1; i <= 100; i++) {
        const a0 = ((i - 1) / 100) * straight.length;
        const a1 = (i / 100) * straight.length;
        biggest = Math.max(biggest, Math.abs(profile.pollutionAtDistance(a1) - profile.pollutionAtDistance(a0)));
      }
      expect(biggest).toBeLessThan
        (0.1);
    });
  });
});

describe('generateStream', () => {
  it('builds a ribbon of the advertised size', () => {
    const data = generateStream({
      spline: straight,
      heightAt: flatGround,
      segments: 32,
      widthSegments: 6,
    });
    expect(data.segments).toBe(32);
    expect(data.widthSegments).toBe(6);
    expect(data.vertices.length).toBe(33 * 6 * 3);
    expect(data.indices.length).toBe(32 * 5 * 6);
    expect(data.flow.length).toBe(33 * 6 * 2);
    expect(data.depths.length).toBe(33 * 6);
    expect(data.pollution.length).toBe(33 * 6);
  });

  it('requires a height sampler', () => {
    expect(() => generateStream({ spline: straight })).toThrow(TypeError);
  });

  it('puts every vertex of a cross-section at one height', () => {
    const data = generateStream({
      spline: straight,
      heightAt: flatGround,
      segments: 16,
      widthSegments: 8,
    });
    for (let i = 0; i <= 16; i++) {
      const y = data.vertices[i * 8 * 3 + 1];
      for (let w = 1; w < 8; w++) {
        expect(data.vertices[(i * 8 + w) * 3 + 1]).toBeCloseTo(y, 10);
      }
    }
  });

  it('walks the spline in even steps of arc length', () => {
    // The flow attribute is what the shader scrolls along, so its spacing is
    // what makes the flow travel at a constant rate rather than surging.
    const data = generateStream({ spline: curved, heightAt: flatGround, segments: 40 });
    const step = curved.length / 40;
    for (let i = 0; i <= 40; i++) {
      expect(data.flow[i * data.widthSegments * 2]).toBeCloseTo(i * step, 4);
    }
  });

  it('keeps the flow direction pointing downstream', () => {
    // The tangent is a unit vector in XZ, so consecutive cross-sections advance
    // along it. Asserting this catches a normal computed from the wrong axis,
    // which would put the ribbon across the stream instead of along it.
    const data = generateStream({ spline: straight, heightAt: flatGround, segments: 12 });
    const a = data.flow[0];
    const b = data.flow[data.widthSegments * 2];
    expect(b).toBeGreaterThan(a);
  });

  it('clamps the depth attribute at zero', () => {
    const data = generateStream({
      spline: straight,
      heightAt: flatGround,
      segments: 8,
      widthSegments: 5,
    });
    for (let v = 0; v < data.depths.length; v++) {
      expect(data.depths[v]).toBeGreaterThanOrEqual(0);
      expect(data.depths[v]).toBeLessThanOrEqual(DEFAULT_STREAM_DEPTH + 1e-9);
    }
  });

  it('varies the pollution along the stream, and only along it', () => {
    const data = generateStream({
      spline: straight,
      heightAt: flatGround,
      segments: 20,
      widthSegments: 4,
    });
    const first = data.pollution[0];
    const last = data.pollution[20 * 4];
    expect(last).toBeLessThan(first);
    for (let i = 0; i <= 20; i++) {
      const row = data.pollution[i * 4];
      for (let w = 1; w < 4; w++) {
        expect(data.pollution[i * 4 + w]).toBeCloseTo(row, 12);
      }
    }
  });

  it('indexes the ribbon without gaps or overlaps', () => {
    const data = generateStream({
      spline: straight,
      heightAt: flatGround,
      segments: 6,
      widthSegments: 4,
    });
    const seen = new Set<number>();
    for (let k = 0; k < data.indices.length; k++) {
      expect(data.indices[k]).toBeLessThan(data.vertices.length / 3);
      seen.add(data.indices[k]);
    }
    // Every vertex is used, and the index buffer has no index out of range.
    expect(seen.size).toBe(data.vertices.length / 3);
  });

  it('answers queries about a world position', () => {
    const data = generateStream({
      spline: straight,
      heightAt: flatGround,
      segments: 40,
    });
    const onCentre = data.query(25, 0, flatGround);
    expect(onCentre.distance).toBeLessThan
      (0.01);
    expect(onCentre.halfWidth).toBeGreaterThan(MIN_STREAM_HALF_WIDTH);
    expect(onCentre.surfaceY).toBeCloseTo(DEFAULT_STREAM_DEPTH, 6);

    const farAway = data.query(25, 500, flatGround);
    expect(farAway.distance).toBeGreaterThan(100);
  });

  it('knows what is water and what is bank', () => {
    const data = generateStream({
      spline: straight,
      heightAt: flatGround,
      segments: 40,
    });
    const hw = data.profile.halfWidthAtDistance(data.length / 2);
    expect(data.isWaterAt(25, hw * 0.5, flatGround)).toBe(true);
    expect(data.isWaterAt(25, hw + 1, flatGround)).toBe(false);
  });

  it('reports submersion only over water and only below the surface', () => {
    const data = generateStream({
      spline: straight,
      heightAt: flatGround,
      segments: 40,
    });
    const surface = data.profile.surfaceHeightAtDistance(data.length / 2, flatGround);
    expect(data.submersionAt(25, 0, surface - 0.2, flatGround)).toBeCloseTo(0.2, 6);
    expect(data.submersionAt(25, 0, surface + 0.2, flatGround)).toBe(0);
    expect(data.submersionAt(25, 900, surface - 0.2, flatGround)).toBe(0);
  });

  it('exposes the ribbon half-width, which is wider than the water', () => {
    const data = generateStream({ spline: straight, heightAt: flatGround });
    const ribbon = data.bankReachAt(0.5);
    expect(ribbon).toBeGreaterThan(data.profile.halfWidthAt(0.5));
    expect(ribbon).toBeCloseTo(data.profile.ribbonHalfWidthAtDistance(data.length * 0.5), 12);
  });

  it('uses the documented defaults', () => {
    const data = generateStream({ spline: straight, heightAt: flatGround });
    expect(data.segments).toBe(DEFAULT_STREAM_SEGMENTS);
    expect(data.widthSegments).toBe(DEFAULT_STREAM_WIDTH_SEGMENTS);
    expect(data.length).toBeCloseTo(straight.length, 9);
  });

  it('agrees with itself across two builds from the same seed', () => {
    const a = generateStream({ spline: straight, heightAt: flatGround, seed: 7 });
    const b = generateStream({ spline: straight, heightAt: flatGround, seed: 7 });
    expect(Array.from(a.vertices)).toEqual(Array.from(b.vertices));
    expect(Array.from(a.flow)).toEqual(Array.from(b.flow));
  });
});

describe('StreamProfile on a designed channel', () => {
  /**
   * These are the tests that failed for three attempts, and they are the ones
   * that matter: the water and the terrain have to agree, or the stream floats.
   */
  describe('agreement with the terrain', () => {
    /**
     * The channel the terrain generator carves, evaluated at one cross-section.
     *
     * Mirrors `TerrainGenerator.carveStreamChannel`: a flat bed out to
     * `bedHalfWidth`, a smoothstep climb that clears the surface by the bank
     * margin, then a flat shelf out to the ribbon's edge.
     */
    function channelGround(a: number, profile: StreamProfile, level: number): (x: number, z: number) => number {
      const flatTo = profile.bedHalfWidthAtDistance(a);
      const bankTop = flatTo + BANK_RISE;
      const climb = profile.depth + BANK_MARGIN;
      // The spline runs along +X, so the distance across the flow is |Z|.
      return (_x: number, z: number): number => {
        const d = Math.abs(z);
        if (d >= bankTop) return level + climb;
        const t = Math.min(1, Math.max(0, (d - flatTo) / (bankTop - flatTo)));
        const eased = t * t * (3 - 2 * t);
        return level + climb * eased;
      };
    }

    it('reads its own height back exactly off a flat bed', () => {
      // The reason the bed is flat: there is no gradient under the ribbon for a
      // grid's bilinear interpolation to get wrong, so the surface the shader
      // uses and the surface the geometry was built with are the same number.
      const profile = wideProfile();
      const a = straight.length * 0.3;
      const level = -1;
      const ground = channelGround(a, profile, level);
      const surface = profile.surfaceHeightAtDistance(a, ground);
      expect(surface).toBeCloseTo(level + DEFAULT_STREAM_DEPTH, 12);
    });

    it('buries the ribbon edge in its own channel', () => {
      // The failure this guards: the water's edge floating above the bank.
      const profile = wideProfile();
      const a = straight.length * 0.3;
      const level = -1;
      const ground = channelGround(a, profile, level);
      const surface = profile.surfaceHeightAtDistance(a, ground);
      const edge = ground(0, profile.ribbonHalfWidthAtDistance(a));
      expect(surface - edge).toBeLessThan(0);
    });

    it('puts the shoreline exactly at the stream nominal width', () => {
      const profile = wideProfile();
      const a = straight.length * 0.3;
      const level = -1;
      const ground = channelGround(a, profile, level);
      const surface = profile.surfaceHeightAtDistance(a, ground);
      const hw = profile.halfWidthAtDistance(a);
      // Where the ground crosses the surface is where the water visibly ends.
      expect(surface - ground(0, hw)).toBeCloseTo(0, 2);
    });

    it('keeps the water above the bed everywhere inside the stream', () => {
      const profile = wideProfile();
      const a = straight.length * 0.3;
      const level = -1;
      const ground = channelGround(a, profile, level);
      const surface = profile.surfaceHeightAtDistance(a, ground);
      for (let i = 0; i < 20; i++) {
        const d = (i / 20) * profile.halfWidthAtDistance(a);
        expect(surface - ground(0, d)).toBeGreaterThan(0);
      }
      // At the nominal width the ground has climbed level with the surface, so
      // the depth there is zero rather than negative - that is the shoreline.
      expect(surface - ground(0, profile.halfWidthAtDistance(a))).toBeCloseTo(0, 9);
    });
  });
});

/** The default stream, for the integration checks below. */
function defaultStream(): StreamData {
  return generateStream({ spline: new StreamSpline(), heightAt: flatGround, segments: 64 });
}

describe('the default stream', () => {
  it('follows the default spline from end to end', () => {
    const data = defaultStream();
    expect(data.spline.length).toBeGreaterThan(400);
    const start = data.spline.pointAtDistance(0);
    const end = data.spline.pointAtDistance(data.length);
    const first = data.vertices[0];
    const last = data.vertices[(data.vertices.length / 3 - 1) * 3];
    expect(Math.hypot(first - start.x, data.vertices[2] - start.z)).toBeLessThan(
      data.bankReachAt(0) + 0.001,
    );
    expect(Math.hypot(last - end.x, data.vertices[data.vertices.length - 1] - end.z)).toBeLessThan(
      data.bankReachAt(1) + 0.001,
    );
  });

  it('spans a width the plan calls for', () => {
    const data = defaultStream();
    const widths: number[] = [];
    for (let i = 0; i <= data.segments; i++) {
      const a = (i / data.segments) * data.length;
      widths.push(2 * data.profile.halfWidthAtDistance(a));
    }
    const min = Math.min(...widths);
    const max = Math.max(...widths);
    // 1 to 3 metres, with a little slack at each end for the noise.
    expect(min).toBeGreaterThan(0.9);
    expect(max).toBeLessThan(3.2);
    expect(max - min).toBeGreaterThan(0.3);
  });

  it('is deeper in the middle than at the edges', () => {
    const data = defaultStream();
    let edgeTotal = 0;
    let middleTotal = 0;
    const mid = Math.floor(data.widthSegments / 2);
    for (let i = 0; i <= data.segments; i++) {
      edgeTotal += data.depths[i * data.widthSegments];
      middleTotal += data.depths[i * data.widthSegments + mid];
    }
    expect(middleTotal).toBeGreaterThan(edgeTotal);
  });

  it('carries the pollution gradient from the cave to the village', () => {
    const data = defaultStream();
    expect(data.pollution[0]).toBeCloseTo(0.9, 6);
    expect(data.pollution[data.pollution.length - 1]).toBeCloseTo(0.2, 6);
  });
});
