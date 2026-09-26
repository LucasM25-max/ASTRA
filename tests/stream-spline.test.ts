import { describe, expect, it } from 'vitest';
import { DEFAULT_STREAM_CONTROL_POINTS, StreamSpline } from '../src/procedural/StreamSpline';

/** A small, hand-checkable spline: four points on a straight line. */
const straightLine = new StreamSpline({
  controlPoints: [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 20, y: 0, z: 0 },
    { x: 30, y: 0, z: 0 },
  ],
  samples: 300,
});

/** A right-angle corner, so the arc length is exactly known. */
const corner = new StreamSpline({
  controlPoints: [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 0, z: 10 },
  ],
  samples: 600,
});

describe('StreamSpline', () => {
  describe('construction', () => {
    it('defaults to the standard sweep', () => {
      const spline = new StreamSpline();
      expect(spline.controlPoints).toBe(DEFAULT_STREAM_CONTROL_POINTS);
      expect(spline.controlPoints.length).toBeGreaterThanOrEqual(4);
    });

    it('rejects fewer than two control points', () => {
      expect(() => new StreamSpline({ controlPoints: [{ x: 0, y: 0, z: 0 }] })).toThrow(RangeError);
      expect(() => new StreamSpline({ controlPoints: [] })).toThrow(RangeError);
    });

    it('has a positive length', () => {
      expect(straightLine.length).toBeGreaterThan(0);
      expect(new StreamSpline().length).toBeGreaterThan(100);
    });

    it('is deterministic', () => {
      const a = new StreamSpline({ samples: 100 });
      const b = new StreamSpline({ samples: 100 });
      expect(a.length).toBe(b.length);
      expect(a.pointAt(0.5)).toEqual(b.pointAt(0.5));
    });
  });

  describe('pointAt', () => {
    it('passes through its control points', () => {
      // The defining property of an interpolating spline.
      const spline = new StreamSpline();
      const n = spline.controlPoints.length;
      for (let i = 0; i < n; i++) {
        const p = spline.pointAt(i / (n - 1));
        const c = spline.controlPoints[i];
        expect(p.x).toBeCloseTo(c.x, 6);
        expect(p.z).toBeCloseTo(c.z, 6);
      }
    });

    it('starts at the first control point and ends at the last', () => {
      const spline = new StreamSpline();
      expect(spline.pointAt(0)).toEqual(spline.controlPoints[0]);
      expect(spline.pointAt(1).x).toBeCloseTo(spline.controlPoints[spline.controlPoints.length - 1].x, 6);
      expect(spline.pointAt(1).z).toBeCloseTo(spline.controlPoints[spline.controlPoints.length - 1].z, 6);
    });

    it('clamps out-of-range parameters', () => {
      expect(splinePointAt(straightLine, -1)).toEqual(splinePointAt(straightLine, 0));
      expect(splinePointAt(straightLine, 5)).toEqual(splinePointAt(straightLine, 1));
    });

    it('stays near the control point bounding box', () => {
      // Catmull-Rom overshoots slightly at tight corners, but not wildly.
      // This catches a basis function with the wrong sign, which sends the
      // curve off toward infinity instead of merely bulging.
      const spline = new StreamSpline();
      const pts = spline.controlPoints;
      const minX = Math.min(...pts.map((p) => p.x));
      const maxX = Math.max(...pts.map((p) => p.x));
      const minZ = Math.min(...pts.map((p) => p.z));
      const maxZ = Math.max(...pts.map((p) => p.z));
      const spanX = maxX - minX;
      const spanZ = maxZ - minZ;

      for (let i = 0; i <= 200; i++) {
        const p = spline.pointAt(i / 200);
        expect(p.x).toBeGreaterThan(minX - spanX * 0.1);
        expect(p.x).toBeLessThan(maxX + spanX * 0.1);
        expect(p.z).toBeGreaterThan(minZ - spanZ * 0.1);
        expect(p.z).toBeLessThan(maxZ + spanZ * 0.1);
      }
    });
  });

  describe('arc length', () => {
    it('measures a straight line exactly', () => {
      expect(straightLine.length).toBeCloseTo(30, 1);
    });

    it('measures a corner as slightly longer than the two legs', () => {
      // Catmull-Rom rounds a corner rather than tracing it: it passes through
      // the corner point, but it arrives and leaves along tangents that are
      // not the legs, so the path bulges. 20.4 against a true 20 is that
      // bulge - asserting an exact 20 here would be asserting an interpolation
      // scheme this spline does not use.
      expect(corner.length).toBeGreaterThan(20);
      expect(corner.length).toBeLessThan(21);
      // And it is nowhere near the straight-line distance between the ends.
      expect(corner.length).toBeGreaterThan(Math.hypot(10, 10));
    });

    it('places pointAtDistance at the right arc length', () => {
      for (const d of [0, 5, 10, 15, 20, 25, 30]) {
        const p = straightLine.pointAtDistance(d);
        expect(Math.hypot(p.x, p.z)).toBeCloseTo(d, 0);
      }
    });

    it('agrees with pointAt at the endpoints', () => {
      const spline = new StreamSpline();
      expect(spline.pointAtDistance(0)).toEqual(spline.pointAt(0));
      const end = spline.pointAtDistance(spline.length);
      const last = spline.pointAt(1);
      expect(end.x).toBeCloseTo(last.x, 3);
      expect(end.z).toBeCloseTo(last.z, 3);
    });

    it('clamps out-of-range distances', () => {
      expect(straightLine.pointAtDistance(-10)).toEqual(straightLine.pointAtDistance(0));
      const beyond = straightLine.pointAtDistance(straightLine.length + 100);
      const end = straightLine.pointAtDistance(straightLine.length);
      expect(beyond).toEqual(end);
    });

    it('is monotonic in distance', () => {
      // Walking forward must always move forward along the curve.
      const spline = new StreamSpline();
      let prev = -1;
      for (let i = 0; i <= 200; i++) {
        const d = (i / 200) * spline.length;
        const p = spline.pointAtDistance(d);
        const along = spline.distanceTo(p).arcLength;
        expect(along).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = along;
      }
    });
  });

  describe('tangentAtDistance', () => {
    it('is a unit vector', () => {
      const spline = new StreamSpline();
      for (let i = 0; i <= 50; i++) {
        const t = spline.tangentAtDistance((i / 50) * spline.length);
        expect(Math.hypot(t.x, t.z)).toBeCloseTo(1, 6);
      }
    });

    it('points along +x on a straight east-running line', () => {
      const t = straightLine.tangentAtDistance(15);
      expect(t.x).toBeCloseTo(1, 6);
      expect(t.z).toBeCloseTo(0, 6);
    });

    it('agrees with the direction of travel', () => {
      const spline = new StreamSpline();
      const d = spline.length * 0.4;
      const a = spline.pointAtDistance(d - 0.01);
      const b = spline.pointAtDistance(d + 0.01);
      const t = spline.tangentAtDistance(d);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      expect(t.x).toBeCloseTo(dx / len, 2);
      expect(t.z).toBeCloseTo(dz / len, 2);
    });
  });

  describe('distanceTo', () => {
    it('is zero on the spline', () => {
      const spline = new StreamSpline();
      for (let i = 0; i <= 40; i++) {
        const p = spline.pointAt(i / 40);
        expect(spline.distanceTo(p).distance).toBeLessThan(0.01);
      }
    });

    it('is the perpendicular distance off the spline', () => {
      // A point 7m off a straight east-running line is 7m from it, and the
      // closest point is straight across.
      const q = { x: 15, y: 0, z: 7 };
      const nearest = straightLine.distanceTo(q);
      expect(nearest.distance).toBeCloseTo(7, 1);
      expect(nearest.point.x).toBeCloseTo(15, 1);
      expect(nearest.point.z).toBeCloseTo(0, 1);
      expect(nearest.arcLength).toBeCloseTo(15, 1);
    });

    it('reports an arcLength consistent with the returned point', () => {
      const spline = new StreamSpline();
      for (let i = 1; i < 30; i++) {
        const q = { x: i * 6 - 90, y: 0, z: -i * 3 + 40 };
        const n = spline.distanceTo(q);
        const atLength = spline.pointAtDistance(n.arcLength);
        expect(Math.hypot(atLength.x - n.point.x, atLength.z - n.point.z)).toBeLessThan(0.05);
      }
    });

    it('is symmetric about the spline', () => {
      const spline = new StreamSpline();
      const mid = spline.pointAtDistance(spline.length * 0.5);
      const t = spline.tangentAtDistance(spline.length * 0.5);
      // Offset perpendicular to the tangent, both ways.
      const px = -t.z;
      const pz = t.x;
      const a = spline.distanceTo({ x: mid.x + px * 5, y: 0, z: mid.z + pz * 5 }).distance;
      const b = spline.distanceTo({ x: mid.x - px * 5, y: 0, z: mid.z - pz * 5 }).distance;
      expect(a).toBeCloseTo(b, 1);
    });

    it('grows as the query point moves away', () => {
      const spline = new StreamSpline();
      const base = spline.pointAtDistance(spline.length * 0.3);
      const t = spline.tangentAtDistance(spline.length * 0.3);
      let prev = -1;
      for (let d = 0; d <= 60; d += 5) {
        const px = -t.z;
        const pz = t.x;
        const dist = spline.distanceTo({ x: base.x + px * d, y: 0, z: base.z + pz * d }).distance;
        expect(dist).toBeGreaterThan(prev);
        prev = dist;
      }
    });
  });

  describe('distanceField', () => {
    it('covers the whole grid', () => {
      const field = straightLine.distanceField(100, 32, 90);
      expect(field.length).toBe(32 * 32);
      for (let i = 0; i < field.length; i++) {
        expect(Number.isFinite(field[i])).toBe(true);
        expect(field[i]).toBeGreaterThanOrEqual(0);
      }
    });

    it('matches distanceTo at every grid point', () => {
      // The field is built by a windowed stamp, not a per-point search. This
      // is the check that the windowing is exact rather than approximate.
      const spline = new StreamSpline({ samples: 400 });
      const size = 200;
      const res = 40;
      const field = spline.distanceField(size, res, 90);
      const step = size / (res - 1);
      const half = size / 2;

      for (let i = 0; i < res; i += 3) {
        for (let j = 0; j < res; j += 3) {
          const x = -half + j * step;
          const z = -half + i * step;
          const exact = spline.distanceTo({ x, y: 0, z }).distance;
          // Beyond the influence radius the field is clamped, which is fine -
          // nothing downstream reads those values.
          if (exact < 80) {
            expect(field[i * res + j]).toBeCloseTo(exact, 1);
          }
        }
      }
    });

    it('is zero along the spline', () => {
      const spline = new StreamSpline({ samples: 400 });
      const size = 400;
      const res = 60;
      const field = spline.distanceField(size, res, 90);
      const step = size / (res - 1);
      const half = size / 2;

      let zeroish = 0;
      for (let s = 0; s <= 200; s++) {
        const p = spline.pointAt(s / 200);
        const j = Math.round((p.x + half) / step);
        const i = Math.round((p.z + half) / step);
        if (i < 0 || i >= res || j < 0 || j >= res) continue;
        if (field[i * res + j] < step) zeroish++;
      }
      expect(zeroish).toBeGreaterThan(180);
    });

    it('rejects a non-positive size', () => {
      expect(() => straightLine.distanceField(0, 32)).toThrow(RangeError);
      expect(() => straightLine.distanceField(-5, 32)).toThrow(RangeError);
    });

    it('clamps beyond the influence radius', () => {
      // Points far from the spline are clamped to `maxInfluence`, which is
      // correct: a Gaussian of this width contributes nothing there, and
      // reporting a real distance would cost the walk that produces it.
      const field = straightLine.distanceField(400, 32, 20);
      const far = field[0];
      expect(far).toBe(20);
    });
  });

  describe('the default sweep', () => {
    it('stays inside a 500m terrain', () => {
      const spline = new StreamSpline();
      for (let i = 0; i <= 100; i++) {
        const p = spline.pointAt(i / 100);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(250);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(250);
      }
    });

    it('crosses the playable area', () => {
      // The valley has to run through the middle 200m, or there is nothing to
      // walk along.
      const spline = new StreamSpline();
      let inside = 0;
      for (let i = 0; i <= 200; i++) {
        const p = spline.pointAt(i / 200);
        if (Math.abs(p.x) <= 100 && Math.abs(p.z) <= 100) inside++;
      }
      expect(inside).toBeGreaterThan(20);
    });

    it('is long enough to be a stream', () => {
      expect(new StreamSpline().length).toBeGreaterThan(300);
    });
  });
});

function splinePointAt(spline: StreamSpline, u: number) {
  return spline.pointAt(u);
}
