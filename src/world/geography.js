/**
 * The authored geography of Sector 1: "The First Fork" and "Journey Upstream".
 *
 * This file is the whole of the world's *data*. It is vector data on purpose --
 * stream centrelines with chainage, bankfull widths, water-surface elevations,
 * zones, the route, the shot list -- so that geometry can be compiled from it
 * (tools/build_world.mjs) and, more importantly, *audited* against it
 * (tools/check_world.mjs). Nothing here is a texture, a mesh or an artist's
 * guess about a dimension; every number is the authored truth that the checker
 * measures the built world against.
 *
 * Coordinate frame (metres, right-handed, three.js' Y-up):
 *   x  increases eastward, upstream
 *   z  increases northward, so the wood on the river's SOUTH bank is at z < 0
 *   y  is elevation in metres above the village datum
 *
 * The setting is the Great Wold / Nyr Ewa border country of the Flanaess -- a
 * temperate river valley on a Greyhawk-like world, not anywhere on Earth. So:
 * no Earth species are named in the model, no Earth fauna, no Earth geology
 * lecture. What is borrowed is only the physics of how a lowland stream and a
 * wooded floodplain behave, because that part is not cultural.
 */

import { clamp, ramp, lerp, remap, closestOnPolyline, distanceToPolyline, buildSegmentGrid, gridQuery } from "./fields.js";

/* ======================================================== the world extent */

export const WORLD = {
  name: "sector01-the-fouled-stream",
  encounter: ["The First Fork", "Journey Upstream"],
  /* The walkable corridor is a single unbroken route from the village water
     meadow to the cave mouth. These extents cover it plus a 260 m skirt, so no
     shot has to show where the world ends. */
  bounds: { minX: -150, maxX: 1620, minZ: -800, maxZ: 300 },
  /** Elevation datum: the village wellhead, so all heights are absolute. */
  datum: 89.0,
  /** One mile, in metres -- the authored distance from the village to the fork. */
  MILE: 1609.344,
  seed: 0x5eed01,
};

/* ================================================================= streams */

/** Catmull-Rom through control points, so a hand-authored line stays smooth. */
function spline(points, perSegment = 24) {
  const out = [];
  const at = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let j = 0; j < perSegment; j++) {
      const t = j / perSegment, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
          + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
          + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(points.at(-1));
  return out;
}

/** Accumulated chainage (metres along the line) for a polyline. */
function chainageTable(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) {
    s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return s;
}

/**
 * A stream: its centreline, and the hydraulics that describe it.
 *
 * `wsNormal` is the water surface as it would lie without downstream
 * obstruction; `ws` adds backwater. The channel bed is always carved from
 * `wsNormal`, so a raised surface floods rather than lifts the ground.
 */
class Stream {
  constructor({ id, name, control, bankfull, depth, roughness, wsAt, wsSpan, wsDrop,
    wsExponent, valleyRise, valleyWidth, bendScale, upperRoughness, order }) {
    this.id = id;
    this.name = name;
    this.order = order;                       // 1 = tributary, 2 = receiving river
    this.points = spline(control, 24);
    this.s = chainageTable(this.points);
    this.length = this.s.at(-1);
    /* Per-segment frames, so `at` is a lookup rather than a scan, and a uniform
       chainage grid, so it is a lookup at O(1). Both matter: the height field is
       asked this question once per vertex, per stream, per build, and again for
       every tree and route sample. */
    this.segs = [];
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i], b = this.points[i + 1];
      const tx = b[0] - a[0], tz = b[1] - a[1];
      const len = Math.hypot(tx, tz) || 1;
      this.segs.push({ ax: a[0], az: a[1], tx: tx / len, tz: tz / len, nx: -tz / len, nz: tx / len, len });
    }
    /* Segment search grid and a chainage bin table, both dense. `at` and
       `project` are the two hottest calls in the whole world model: one per
       vertex per stream for the mesh, and again for every tree, boulder and
       route sample, so they are O(1) table reads rather than searches. */
    this.index = (() => {
      const cell = 14;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of this.points) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
      }
      const nx = Math.ceil((maxX - minX) / cell) + 1, nz = Math.ceil((maxZ - minZ) / cell) + 1;
      const counts = new Int32Array(nx * nz), starts = new Int32Array(nx * nz + 1);
      const idx = (x, z) => Math.floor((z - minZ) / cell) * nx + Math.floor((x - minX) / cell);
      for (let i = 0; i < this.points.length - 1; i++) {
        const a = this.points[i], b = this.points[i + 1];
        const lo = [Math.min(a[0], b[0]) - cell, Math.min(a[1], b[1]) - cell];
        const hi = [Math.max(a[0], b[0]) + cell, Math.max(a[1], b[1]) + cell];
        for (let gx = Math.floor((lo[0] - minX) / cell); gx <= Math.floor((hi[0] - minX) / cell); gx++) {
          for (let gz = Math.floor((lo[1] - minZ) / cell); gz <= Math.floor((hi[1] - minZ) / cell); gz++) {
            if (gx < 0 || gz < 0 || gx >= nx || gz >= nz) continue;
            counts[gz * nx + gx]++;
          }
        }
      }
      for (let i = 0; i < counts.length; i++) starts[i + 1] = starts[i] + counts[i];
      const order = new Int32Array(starts[counts.length]);
      const fill = new Int32Array(counts.length);
      for (let i = 0; i < this.points.length - 1; i++) {
        const a = this.points[i], b = this.points[i + 1];
        const lo = [Math.min(a[0], b[0]) - cell, Math.min(a[1], b[1]) - cell];
        const hi = [Math.max(a[0], b[0]) + cell, Math.max(a[1], b[1]) + cell];
        for (let gx = Math.floor((lo[0] - minX) / cell); gx <= Math.floor((hi[0] - minX) / cell); gx++) {
          for (let gz = Math.floor((lo[1] - minZ) / cell); gz <= Math.floor((hi[1] - minZ) / cell); gz++) {
            if (gx < 0 || gz < 0 || gx >= nx || gz >= nz) continue;
            const c = gz * nx + gx;
            order[starts[c] + fill[c]++] = i;
          }
        }
      }
      void idx;
      return { cell, nx, nz, minX, minZ, starts, order, points: this.points };
    })();
    this.binSize = 8;
    const nBins = Math.ceil(this.length / this.binSize) + 2;
    this.binCounts = new Int32Array(nBins + 1);
    for (let i = 0; i < this.segs.length; i++) {
      const b = Math.min(nBins - 1, Math.floor(this.s[i] / this.binSize));
      this.binCounts[b + 1]++;
    }
    for (let i = 0; i < nBins; i++) this.binCounts[i + 1] += this.binCounts[i];
    this.binOrder = new Int32Array(this.segs.length);
    const filled = new Int32Array(nBins);
    for (let i = 0; i < this.segs.length; i++) {
      const b = Math.min(nBins - 1, Math.floor(this.s[i] / this.binSize));
      this.binOrder[this.binCounts[b] + filled[b]++] = i;
    }
    void buildSegmentGrid;
    this.bankfull = bankfull;                 // half-width at bankfull, m, start -> end
    this.depthAuthored = depth;               // mean depth at the thalweg, m
    this.roughness = roughness;               // Manning n: bed material + weed
    this.wsAt = wsAt;                         // surface elevation at the anchor
    this.wsFrom = 0;                          // chainage the profile is pinned to
    this.wsSpan = wsSpan;
    this.wsDrop = wsDrop;
    this.wsExponent = wsExponent;
    this.valleyRise = valleyRise;             // how fast the floodplain climbs away
    this.valleyWidth = valleyWidth;           // start of the valley shoulder, m
    this.bendScale = bendScale;               // bend sharpness -> bar/cut-bank strength
    this.upperRoughness = upperRoughness ?? 1;      // boulder/cascade roughness upstream
    this.blocked = [];                        // chainages that must not be walked into
  }

  /**
   * Position and frame at a chainage. lat > 0 is to the SOUTH/right of the flow
   * direction, which is the wooded side wherever it matters.
   */
  at(s) {
    s = clamp(s, 0, this.length);
    const nBins = this.binCounts.length - 1;
    let lo = -1;
    for (let b = Math.min(nBins - 1, Math.floor(s / this.binSize)); b >= 0 && lo < 0; b--) {
      for (let k = this.binCounts[b]; k < this.binCounts[b + 1]; k++) {
        const i = this.binOrder[k];
        if (this.s[i + 1] >= s) { lo = i; break; }
      }
    }
    if (lo < 0) lo = 0;
    const seg = this.segs[lo];
    const t = clamp((s - this.s[lo]) / (seg.len || 1), 0, 1);
    return {
      s,
      x: seg.ax + seg.tx * seg.len * t,
      z: seg.az + seg.tz * seg.len * t,
      tx: seg.tx, tz: seg.tz, nx: seg.nx, nz: seg.nz,
    };
  }

  /** Plan curvature at a chainage (+ = turning left), in 1/m. */
  curvature(s) {
    const h = 12;
    const a = this.at(Math.max(0, s - h)), b = this.at(s), c = this.at(Math.min(this.length, s + h));
    const cross = a.tx * b.tz - a.tz * b.tx + b.tx * c.tz - b.tz * c.tx;
    const turn = Math.asin(clamp(cross, -1, 1));
    return turn / (2 * h);
  }

  /**
   * The nearest point on the centreline: chainage, distance and frame at once.
   *
   * Every field in the sector -- relief, water, zones, fouling, canopy, moisture
   * -- asks this same question for the same point within microseconds of the
   * others, so the answer is memoised per stream. The guard is exact: the cache
   * only serves the point it was computed for, and a caller that needs a frame at
   * a chainage it supplies itself (the `s` argument) bypasses it. Without this the
   * mesh build spends most of its time re-finding the same nearest segment, and a
   * build that takes four minutes is a build nobody re-runs.
   */
  query(x, z) {
    if (x === this._qx && z === this._qz) return this._q;
    const hit = this.nearest(x, z);
    const seg = this.segs[hit.segment];
    const s = this.s[hit.segment] + hit.t * seg.len;
    const px = seg.ax + seg.tx * seg.len * hit.t;
    const pz = seg.az + seg.tz * seg.len * hit.t;
    const lat = (x - px) * seg.nx + (z - pz) * seg.nz;
    const out = {
      s, distance: hit.distance, lat, absLat: Math.abs(lat),
      x: px, z: pz, tx: seg.tx, tz: seg.tz, nx: seg.nx, nz: seg.nz,
    };
    this._qx = x; this._qz = z; this._q = out;
    return out;
  }

  /**
   * Nearest centreline segment, via the stream's own dense search grid. This is
   * the only search the model does; everything else is a table read after it.
   */
  nearest(x, z) {
    const g = this.index;
    const ix = Math.floor((x - g.minX) / g.cell), iz = Math.floor((z - g.minZ) / g.cell);
    let bestD2 = Infinity, bestSeg = 0, bestT = 0;
    const pts = g.points;
    for (let ring = 0; ring < 6; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const cx = ix + dx, cz = iz + dz;
          if (cx < 0 || cz < 0 || cx >= g.nx || cz >= g.nz) continue;
          const c = cz * g.nx + cx;
          for (let k = g.starts[c]; k < g.starts[c + 1]; k++) {
            const i = g.order[k];
            const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
            const sx = bx - ax, sz = bz - az;
            const len2 = sx * sx + sz * sz || 1;
            let t = ((x - ax) * sx + (z - az) * sz) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = x - (ax + sx * t), qz = z - (az + sz * t);
            const d2 = qx * qx + qz * qz;
            if (d2 < bestD2) { bestD2 = d2; bestSeg = i; bestT = t; }
          }
        }
      }
      if (Math.sqrt(bestD2) <= ring * g.cell) break;
    }
    if (!Number.isFinite(bestD2)) {
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
        const sx = bx - ax, sz = bz - az;
        const len2 = sx * sx + sz * sz || 1;
        let t = ((x - ax) * sx + (z - az) * sz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = x - (ax + sx * t), qz = z - (az + sz * t);
        const d2 = qx * qx + qz * qz;
        if (d2 < bestD2) { bestD2 = d2; bestSeg = i; bestT = t; }
      }
    }
    return { distance: Math.sqrt(bestD2), segment: bestSeg, t: bestT };
  }

  /** Chainage of the nearest point on the centreline, for lateral questions. */
  project(x, z) { return this.query(x, z).s; }

  /** Signed lateral offset from the centreline (m), + = south/right of flow. */
  lateral(x, z, s = null) {
    if (s === null) { const q = this.query(x, z); return { lat: q.lat, distance: q.distance, frame: q }; }
    const f = this.at(s);
    const lat = (x - f.x) * f.nx + (z - f.z) * f.nz;
    return { lat, distance: Math.abs(lat), frame: f };
  }

  /** Nearest-centreline distance, without the frame: the cheap form. */
  distance(x, z) { return this.query(x, z).distance; }

  /** Frame at a chainage, or at the nearest point when none is given. */
  frame(x, z, s = null) { return s === null ? this.query(x, z) : this.at(s); }

  /**
   * Normal water-surface elevation at chainage s (m above datum).
   *
   * The profile is authored from its ANCHOR, which is the confluence for both
   * streams: `wsAt` is the surface there, and the drop is measured away from it.
   * Pinning both streams to one agreed elevation is what makes the junction
   * exactly level -- the surface cannot disagree with itself at the fork, which
   * is the one place a wrong number is instantly visible.
   */
  wsNormal(s) {
    if (this.id === "ery") {
      if (s <= this.wsFrom) {
        const span = Math.max(1, this.wsSpan);
        const u = clamp((this.wsFrom - s) / span, 0, 1);
        return this.wsAt + this.wsDrop * Math.pow(u, this.wsExponent);
      } else {
        const remaining = Math.max(1, this.length - this.wsFrom);
        const u = clamp((s - this.wsFrom) / remaining, 0, 1);
        const upstreamClimb = 0.65;
        return this.wsAt + upstreamClimb * Math.pow(u, 1.05);
      }
    }
    const span = Math.max(1, this.wsSpan);
    const u = clamp(Math.abs(s - this.wsFrom) / span, 0, 1);
    return this.wsAt + this.wsDrop * Math.pow(u, this.wsExponent);
  }

  /**
   * Backwater: the surface rises above normal where something holds the water
   * back. Authored per obstruction, exponential decay upstream, as a real
   * drawdown curve does.
   */
  backwater(s) {
    /* A pool cannot exist where the stream is already down at the level of the
       river it falls into, so the drawdown is pinned to nothing at the junction.
       The result is the real shape: a flat pool behind the jam, easing back to
       normal profile, and a small step where the fork drops onto the shingle. */
    const atMouth = ramp(s, -6, 34);   // 0 at the junction, 1 from 34 m up
    let rise = 0;
    for (const d of this.obstructions) {
      /* Held up to `rise` immediately above the obstruction, easing out over
         `decay` metres upstream; below it, nothing. */
      if (s > d.s) rise = Math.max(rise, d.rise * Math.exp(-(s - d.s) / d.decay));
      else rise = Math.max(rise, d.rise * (1 - ramp(s - d.s, 0, 25)));
    }
    return rise * atMouth;
  }

  ws(s) { return this.wsNormal(s) + this.backwater(s); }

  /** Normal flow depth at the thalweg: shoals upstream, deepens downstream. */
  normalDepth(s) {
    const u = clamp(s / this.length, 0, 1);
    return lerp(this.depthAuthored[0], this.depthAuthored[1], Math.pow(u, 0.8));
  }

  /**
   * The depth of water actually lying in the channel: the bed is carved from the
   * normal profile, so where something holds the water up the reach is deeper.
   * That single distinction is what makes a dam pool flood its banks instead of
   * lifting the whole valley.
   */
  depth(s) { return Math.max(0.06, this.ws(s) - this.bed(s)); }

  /** Bankfull half-width (m) at chainage s. */
  bankhalf(s) {
    const u = clamp(s / this.length, 0, 1);
    return lerp(this.bankfull[0], this.bankfull[1], u);
  }

  /** Bed elevation: the carved channel bottom at the thalweg. */
  bed(s) { return this.wsNormal(s) - this.normalDepth(s); }

  /**
   * Thalweg position across the channel. In a meander the deepest line hugs the
   * outside of every bend and the inside silts up; deriving the offset from
   * curvature is what makes the pool-and-ripple rhythm look right instead of
   * like a symmetric trough.
   */
  thalweg(s) {
    const k = this.curvature(s);
    return clamp(-k * this.bankhalf(s) * 11 * this.bendScale, -0.42, 0.42) * this.bankhalf(s);
  }

  /** Velocity from Manning, with n rising where the channel is choked. */
  velocity(s, { foul = 0 } = {}) {
    const d = this.depth(s);
    const a = Math.max(0, s - 14), b = Math.min(this.length, s + 14);
    const grade = Math.abs((this.ws(b) - this.ws(a)) / Math.max(1, b - a));
    /* n rises with weed and debris (foul), and again in the boulder-clogged upper
       reach: a steep headwater is not a rapid, it is full of stuff to trip over.
       This is why the survey and the walk agree on how fast the water moves. */
    const n = this.roughness * (1 + 0.85 * foul) * this.roughnessAt(s);
    /* Wide shallow channel, so the hydraulic radius is the depth. */
    return (1.486 / n) * Math.pow(d, 2 / 3) * Math.sqrt(grade);
  }

  /** Bed roughness multiplier by chainage (1 = the authored value). */
  roughnessAt(s) {
    if (!this.upperRoughness) return 1;
    return 1 + (this.upperRoughness - 1) * ramp(this.progress(s), 0.55, 0.95);
  }

  /** Froude number: the subgrid criterion the foam and the debris lines use. */
  froude(s, opts) {
    const v = this.velocity(s, opts);
    return v / Math.sqrt(9.81 * Math.max(0.05, this.depth(s)));
  }

  /** Where along the whole length, 0..1. */
  progress(s) { return clamp(s / this.length, 0, 1); }

  /** True where the channel still exists: past the head it stops being a trough. */
  influence(s) {
    return 1 - ramp(s - this.length, 0, 26) - ramp(-14 - s, 0, 14);
}
}

/**
 * The river High Ery stands on, running eastward past the sector. Control points
 * are authored at real spacing: this reach meanders with ~55 m amplitude and a
 * ~230 m wavelength, which is what a stream of this size does on a floodplain of
 * this slope.
 */
export const ERY = new Stream({
  id: "ery",
  name: "the river below the fork",
  order: 2,
  control: [
    [-160, -20], [-40, -14], [80, -34], [200, -4], [300, 30], [410, 6],
    [520, -26], [620, -4], [700, 34], [790, 40],
  ],
  bankfull: [9.5, 13.0],
  depth: [0.45, 1.30],
  roughness: 0.075,   // gravel bed, weed, fallen wood: a real lowland river is not smooth
  wsAt: 89.10,          // re-pinned to the confluence below
  wsSpan: 1.0,
  wsDrop: 0,
  wsExponent: 1.0,
  valleyRise: 5.6,
  valleyWidth: 78,
  bendScale: 1.0,
});

/**
 * The First Fork: the stream that comes in from the little wood on the south
 * side, and that the party follows up into the trees. It gains 11.4 m over its
 * length, which is why the wood sits on higher ground than the river meadow.
 */
export const FORK = new Stream({
  id: "fork",
  name: "the First Fork",
  order: 1,
  control: [
    [626, 4], [690, -14], [760, -38], [836, -58], [908, -70], [980, -66],
    [1052, -78], [1124, -106], [1196, -152], [1262, -208], [1312, -262], [1348, -312],
  ],
  bankfull: [3.7, 2.5],
  depth: [0.24, 0.70],
  roughness: 0.10,
  wsAt: 92.15,          // the confluence elevation, which both streams share
  wsSpan: 1.0,
  wsDrop: 0,
  wsExponent: 1.5,
  valleyRise: 3.1,
  valleyWidth: 34,
  bendScale: 1.35,
  upperRoughness: 1.80,
});

/* Both surfaces are pinned to the elevation at the junction: the fork rises away
   from it, the river falls away from it, and neither can drift out of agreement
   with the other. The drops are authored in metres over the whole reach, from
   survey-style reasoning: a lowland river 3.05 m over its mile of this sector, a
   headwater stream 11.35 m over its 848 m -- which is why the wood sits on higher
   ground than the village meadow, and why the walk upstream gets noticeably
   steeper as it goes. */
const CONFLUENCE_WS = 92.15;
{
  const sJoin = ERY.project(FORK.points[0][0], FORK.points[0][1]);
  ERY.wsAt = CONFLUENCE_WS;
  ERY.wsFrom = sJoin;
  ERY.wsSpan = sJoin;                     // the whole of the river's surveyed drop
  ERY.wsDrop = -3.05;                     // downstream: the surface falls
  ERY.wsExponent = 1.05;                  // slightly concave: flatter near the village
  FORK.wsAt = CONFLUENCE_WS;
  FORK.wsFrom = 0;
  FORK.wsSpan = FORK.length;
  FORK.wsDrop = 11.35;
  FORK.wsExponent = 1.5;                  // convex: steeper in the upper reach
}

export const STREAMS = [ERY, FORK];
export const streamById = Object.fromEntries(STREAMS.map((s) => [s.id, s]));

/** Chainage of the confluence, on each stream. */
export const FORK_AT = {
  onFork: 0,
  onEry: ERY.project(FORK.points[0][0], FORK.points[0][1]),
  x: FORK.points[0][0],
  z: FORK.points[0][1],
};

/* Two chainages several things refer to: the crossing, and the dam. */
export const BRIDGE_S = 25;
export const WEIR_S = 250;

/**
 * In-channel obstructions, and the reaches the route must not walk into. The
 * weir is a wedge of alder and mud -- a real thing a beaver or a poacher leaves
 * behind -- and it is what holds the carr wet for 180 m downstream of it.
 */
FORK.obstructions = [{ id: "weir", s: WEIR_S, rise: 0.32, decay: 140 }];
ERY.obstructions = [];
FORK.blocked = [{ id: "weir", s: WEIR_S, lat: [-4.5, 4.5] }];
ERY.blocked = [];

/* ================================================================== zones */

/**
 * Zones are not painted: each one is a distance/chainage test, so they agree
 * with the hydrology they are named after and cannot drift from it. `id` order
 * is fixed and is what the mesh's zone attribute stores.
 */
export const ZONES = [
  { id: 0, name: "village meadow", grey: 0.735, canopy: 0.04, density: 3 },
  { id: 1, name: "river bank", grey: 0.685, canopy: 0.16, density: 22 },
  { id: 2, name: "flood terrace", grey: 0.700, canopy: 0.10, density: 9 },
  { id: 3, name: "fork shingle", grey: 0.660, canopy: 0.05, density: 6 },
  { id: 4, name: "the carr", grey: 0.575, canopy: 0.74, density: 96 },
  { id: 5, name: "journey upstream", grey: 0.545, canopy: 0.86, density: 124 },
  { id: 6, name: "limestone bench", grey: 0.790, canopy: 0.34, density: 44 },
  { id: 7, name: "cave threshold", grey: 0.815, canopy: 0.22, density: 30 },
  { id: 8, name: "channel", grey: 0.470, canopy: 0.00, density: 0 },
  { id: 9, name: "wood edge", grey: 0.615, canopy: 0.52, density: 60 },
];

/** Elevation the ground climbs to in each zone, relative to the water surface. */
export function zoneAt(x, z) {
  const dE = distanceToPolyline(x, z, ERY.points);
  const dF = distanceToPolyline(x, z, FORK.points);
  const sE = ERY.project(x, z), sF = FORK.project(x, z);
  const wE = ERY.bankhalf(sE), wF = FORK.bankhalf(sF);
  const bankE = dE.distance - wE, bankF = dF.distance - wF;
  if (bankE < 1.2 || bankF < 1.2) return ZONES[8];

  const dCave = Math.hypot(x - FEATURES.caveMouth.x, z - FEATURES.caveMouth.z);
  if (dCave < 68) return ZONES[7];
  if (sF > 640 && dF.distance < 150) return ZONES[6];
  if (sF > 120 && dF.distance < 125) return ZONES[5];
  if ((sF > 60 && sF < 420 && dF.distance < 105)
    || (sF <= 60 && Math.hypot(x - FORK_AT.x, z - FORK_AT.z) < 92 && z < FORK_AT.z)) return ZONES[4];
  if (Math.hypot(x - FORK_AT.x, z - FORK_AT.z) < 74 && dF.distance < 46) return ZONES[3];
  if (dF.distance < 46) return ZONES[9];
  if (dE.distance < 40) return ZONES[1];
  if (dE.distance < 185 && sE < 480) return ZONES[0];
  if (Math.hypot(x - FORK_AT.x, z - FORK_AT.z) < 150) return ZONES[9];
  return dE.distance < dF.distance ? ZONES[2] : ZONES[9];
}

/* ============================================================== fouling */

/**
 * How fouled the water is, 0 = clean to 1 = the mouth of the cave.
 *
 * Modelled as a plume, not as a paint-over: the tributary carries turbidity that
 * relaxes slightly downstream, and at the junction it disperses across the river
 * as a mixing zone of finite length. Getting this wrong is what makes "polluted
 * stream" look like a shader, so it is derived from the two flows instead:
 * the river's momentum (Q_r v_r) is what resists the fork's plume, which is why
 * the dirty water stays on the south side for 120 m rather than turning green
 * everywhere at once.
 */
export function turbidity(x, z) {
  const dF = distanceToPolyline(x, z, FORK.points);
  const sF = FORK.project(x, z);
  const latF = FORK.lateral(x, z, sF).lat;
  const dE = distanceToPolyline(x, z, ERY.points);
  const sE = ERY.project(x, z);
  const latE = ERY.lateral(x, z, sE).lat;

  /* In the fork: worst at the cave, easing to the mouth, worse near the surface
     films on the slack inside of bends. */
  if (dF.distance < 46 && sF > -14) {
    const along = remap(sF, 0, FORK.length, 0.74, 1.0);
    const across = ramp(dF.distance, FORK.bankhalf(sF) * 1.1, 40);
    const slack = 1 + 0.14 * Math.abs(Math.sin(FORK.curvature(sF) * 40));
    return clamp(along * slack - 0.06 * across * 0, 0, 1);
  }

  /* Downstream of the junction: the plume hugs the south bank and dilutes. */
  const below = clamp((FORK_AT.onEry - sE) / 210, 0, 1);
  if (dE.distance < 60 && sE < FORK_AT.onEry + 6) {
    const width = lerp(7, ERY.bankhalf(sE) * 1.5, below);
    const south = clamp(-latE, 0, 99);                       // south side of the river
    const across = ramp(south - width, 0, width * 0.9);
    const dilution = lerp(0.82, 0.05, Math.pow(below, 0.8));
    return clamp(dilution * (1 - across), 0, 1);
  }

  /* Overbank: what the flood left on the banks, following the same plume. */
  const deposit = ramp(46 - Math.min(dF.distance, dE.distance), 0, 30) * 0.34;
  return clamp(deposit * (sF > 60 || sE < FORK_AT.onEry ? 1 : 0.2), 0, 1);
}

/**
 * Wetness, 0..1. A field, not a shader input: a stone 3 m from the water is damp
 * because the field says so, and the same rule drives moss, debris, mud and the
 * darkening in the greybox so nothing can disagree about where the water is.
 */
export function wetness(x, z, h) {
  const ws = waterSurfaceAt(x, z);
  if (ws === null) {
    const d = Math.min(distanceToPolyline(x, z, ERY.points).distance,
      distanceToPolyline(x, z, FORK.points).distance);
    return ramp(28 - d, 0, 22) * 0.42;
  }
  const above = h - ws;
  return clamp(1 - ramp(above, -0.05, 1.5) * 0.94, 0, 1);
}

/* ================================================================ profiles */

/** Water surface elevation at a point, or null if it is dry land. */
export function waterSurfaceAt(x, z) {
  let best = null;
  for (const stream of STREAMS) {
    const s = stream.project(x, z);
    const lat = stream.lateral(x, z, s).lat;
    const ws = stream.ws(s);
    /* Channel: full width. The river also keeps a thin sheet over the bar tail
       and the fork keeps its backwater pool, both of which come out of the
       terrain comparison in relief.js rather than from here. */
    const reach = stream.bankhalf(s) * 1.06;
    if (Math.abs(lat) < reach) {
      const edge = ramp(Math.abs(lat) / reach, 0.82, 1.0);
      const surf = ws - 0.02 * edge;
      if (best === null || surf > best) best = surf;
    }
  }
  return best;
}

/** The elevation the water surface would have at the nearest point of a stream. */
export function waterSurfaceNear(x, z) {
  let best = { ws: -Infinity, stream: null, s: 0 };
  for (const stream of STREAMS) {
    const s = stream.project(x, z);
    const ws = stream.ws(s);
    if (ws > best.ws) best = { ws, stream, s };
  }
  return best;
}

/* ======================================================== authored points */

/**
 * Named features. The shot list asserts against these, so a feature that moves
 * in the model moves in the audit too.
 */
export const FEATURES = {
  meadowEdge: { x: -20, z: 24, note: "the last of the grazing, where the towpath leaves the village" },
  towpath: { x: 300, z: 14, note: "the worn line along the north bank" },
  deadStand: { x: 470, z: 34, note: "blown and beetle-ravaged alders where the canopy opens" },
  confluence: { x: FORK_AT.x, z: FORK_AT.z, note: "THE FIRST FORK: the junction, and the hero image of the sector" },
  forkPool: { x: 660, z: -14, note: "the deep pool the fork's mouth builds against the river" },
  shingleBeach: { x: 690, z: -30, note: "the gravel bar at the junction" },
  bridge: { x: 0, z: 0, note: "the plank footbridge over the fork" },
  weir: { x: 0, z: 0, note: "the alder-and-mud dam, and its pool" },
  carrHollow: { x: 900, z: -150, note: "the wet hollow: standing water, reed, peat" },
  landing: { x: 210, z: -18, note: "the rotting landing stage below the village" },
  ford: { x: 0, z: 0, note: "the gravel crossing over the fork" },
  bench: { x: 1180, z: -100, note: "the limestone step the wood climbs on to" },
  caveMouth: { x: 0, z: 0, note: "the cave the stream spills out of" },
};

/* Positions that must agree with the streams are derived, not typed. */
{
  const f = FORK.at(BRIDGE_S);
  FEATURES.bridge.x = f.x; FEATURES.bridge.z = f.z;
  const weir = FORK.at(WEIR_S);
  FEATURES.weir.x = weir.x; FEATURES.weir.z = weir.z;
  const ford = FORK.at(12);
  FEATURES.ford.x = ford.x; FEATURES.ford.z = ford.z;
  const cave = FORK.at(FORK.length - 10);
  FEATURES.caveMouth.x = cave.x; FEATURES.caveMouth.z = cave.z;
  const bench = FORK.at(FORK.length * 0.78);
  FEATURES.bench.x = bench.x; FEATURES.bench.z = bench.z;
  FEATURES.landing.x = ERY.at(205).x; FEATURES.landing.z = ERY.at(205).z - ERY.bankhalf(205) - 3;
}

/* =================================================================== cave */

/**
 * The threshold of the cave, as the world sees it from outside. The interior is
 * P0-out-of-scope; the mouth is not, because it is the destination of every
 * sightline in the second half of the sector.
 */
export const CAVE = {
  /** Chainage on the fork where the stream goes in / comes out. */
  s: FORK.length - 10,
  /** Arch: 8.6 m wide, 4.1 m high at the crown, springing 0.35 m above the bed. */
  width: 8.6, height: 4.1, springing: 0.35,
  depth: 34,
  /** The rock the mouth is cut into. */
  buttress: { rise: 6.4, radius: 26, along: 15 },
  get position() { const f = FORK.at(this.s); return { x: f.x, z: f.z, frame: f }; },
};

/* ================================================================== route */

/**
 * The route the player walks: authored as (stream, chainage, lateral) waypoints,
 * so it can never be authored wrong about the water. The path is then splined in
 * world space for a natural line, because real paths curve for their own reasons.
 */
/* Waypoints are authored as offsets FROM the junction and as chainages ALONG the
   fork, so the route keeps its meaning when the centrelines are re-tweaked: it is
   the towpath out of the village, a turn round the fork apex, the footbridge,
   then the south bank all the way up to the cave. */
const ROUTE_SPANS = (() => {
  const j = FORK_AT.onEry;
  return [
    ["ery", Math.max(4, j - 786), 16.5],
    ["ery", j - 620, 16.5], ["ery", j - 440, 16.0], ["ery", j - 260, 15.5], ["ery", j - 110, 15.0],
    ["ery", j - 26, 14.0],
    ["fork", 10, 7.5],
    ["fork", BRIDGE_S, 0],
    ["fork", 45, -7.5],
    ["fork", 120, -8.0], ["fork", 230, -8.0], ["fork", 340, -7.5], ["fork", 460, -7.5],
    ["fork", 580, -7.0], ["fork", 700, -6.5], ["fork", 780, -6.0],
    ["fork", FORK.length - 18, -5.0],
  ];
})();

export const ROUTE_WAYPOINTS = ROUTE_SPANS.map(([id, s, lat]) => {
  const stream = streamById[id];
  const f = stream.at(s);
  return { x: f.x + f.nx * lat, z: f.z + f.nz * lat, stream: id, s, lat };
});

/** The route as a dense polyline with chainage, sampled through a spline. */
export const ROUTE = (() => {
  const pts = spline(ROUTE_WAYPOINTS.map((p) => [p.x, p.z]), 10);
  const s = chainageTable(pts);
  return {
    points: pts,
    s,
    length: s.at(-1),
    /** Position and unit tangent at a chainage along the route. */
    at(sTarget) {
      const clamped = clamp(sTarget, 0, this.length);
      let lo = 0, hi = this.s.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (this.s[mid] <= clamped) lo = mid; else hi = mid;
      }
      const span = this.s[hi] - this.s[lo] || 1;
      const t = (clamped - this.s[lo]) / span;
      const a = this.points[lo], b = this.points[hi];
      return {
        x: lerp(a[0], b[0], t), z: lerp(a[1], b[1], t),
        tx: (b[0] - a[0]) / span, tz: (b[1] - a[1]) / span,
        s: clamped,
      };
    },
    /** Chainage of the closest point on the route. */
    project(x, z) {
      const hit = closestOnPolyline(x, z, this.points);
      return lerp(this.s[hit.segment], this.s[hit.segment + 1], hit.t);
    },
  };
})();

/* ========================================================= the shot list */

/**
 * 23 fixed checkpoints: 19 evenly spaced along the route and 4 composed hero
 * views. They are the acceptance rig -- tools/check_world.mjs ray-marches every
 * one of them and fails on framing, occlusion, canopy openness and any shot that
 * can see the edge of the world.
 */
export const CAMERA = { eye: 1.7, pitch: -0.055, fovDeg: 44, aspect: 16 / 9 };

export const SHOTS = (() => {
  const shots = [];
  const count = 19;
  for (let i = 0; i < count; i++) {
    const s = remap(i, 0, count - 1, 18, ROUTE.length - 6);
    const p = ROUTE.at(s);
    const yaw = Math.atan2(p.tx, p.tz);
    shots.push({
      id: `route.${String(i).padStart(2, "0")}`,
      chainage: s,
      kind: "route",
      camera: { x: p.x, z: p.z, eye: CAMERA.eye, yaw, pitch: CAMERA.pitch, fovDeg: CAMERA.fovDeg },
      expect: i > 12 ? { caveVisible: true } : {},
    });
  }
  const fork = FORK.at(0);
  const hero = [
    {
      id: "hero.confluence.northbank",
      camera: { x: fork.x - 6, z: fork.z + 44, eye: 1.7, yaw: Math.atan2(fork.x - (fork.x - 6), fork.z - (fork.z + 44)) + Math.PI, pitch: -0.10, fovDeg: 44 },
      expect: { confluenceVisible: true, waterFraction: [0.05, 0.55] },
    },
    {
      id: "hero.confluence.upstream",
      camera: { x: FORK_AT.x + 62, z: FORK_AT.z - 34, eye: 1.7, yaw: Math.atan2(FORK_AT.x + 62 - FORK_AT.x, FORK_AT.z - 34 - FORK_AT.z) + Math.PI, pitch: -0.09, fovDeg: 44 },
      expect: { confluenceVisible: true },
    },
    {
      id: "hero.bridge",
      camera: { x: FEATURES.bridge.x + 26, z: FEATURES.bridge.z + 24, eye: 1.7, yaw: Math.atan2(FEATURES.bridge.x + 26 - FEATURES.bridge.x, FEATURES.bridge.z + 24 - FEATURES.bridge.z) + Math.PI, pitch: -0.13, fovDeg: 44 },
      expect: { bridgeVisible: true, waterFraction: [0.04, 0.6] },
    },
    {
      id: "hero.cavemouth.approach",
      camera: { x: FEATURES.caveMouth.x - 46, z: FEATURES.caveMouth.z - 30, eye: 1.7,
        yaw: Math.atan2(FEATURES.caveMouth.x - (FEATURES.caveMouth.x - 46), FEATURES.caveMouth.z - (FEATURES.caveMouth.z - 30)) + Math.PI,
        pitch: 0.045, fovDeg: 44 },
      expect: { caveVisible: true },
    },
  ];
  return shots.concat(hero);
})();

/* ============================================================ real scale */

/**
 * The scale audit table: every dimension the world is allowed to be wrong about,
 * and by how much. The checker measures the built geometry against this and
 * fails on a mismatch, because a handrail at hip height ends photorealism faster
 * than low-resolution textures do.
 */
export const REAL = {
  "route: village to fork": { value: 800, tolerance: 0.22, units: "m", note: "the walk from the village edge to the junction" },
  "corridor: village to cave": { value: 1560, tolerance: 0.16, units: "m", note: "the whole walkable sector, just under a mile" },
  "river bankfull width": { value: [19.0, 26.0], units: "m", note: "10 m to 13 m half-width" },
  "river mean depth": { value: [0.45, 1.30], units: "m" },
  "fork bankfull width": { value: [5.0, 7.4], units: "m" },
  "fork mean depth": { value: [0.24, 0.70], units: "m" },
  "stream velocity": { value: [0.15, 1.2], units: "m/s", note: "Manning, with n raised where choked" },
  "Froude number": { value: [0.0, 0.8], note: "subcritical throughout: no white water but for the weir" },
  "drop, village to cave": { value: 14.41, tolerance: 0.05, units: "m" },
  "footbridge deck": { value: 1.8, tolerance: 0.02, units: "m", note: "clear width; planks 0.24 m, span 6.4 m" },
  "footbridge handrail": { value: 1.0, tolerance: 0.03, units: "m", note: "top rail above the deck" },
  "stile step": { value: 0.36, tolerance: 0.02, units: "m", note: "four rise, never more than five" },
  "fence rail": { value: 1.15, tolerance: 0.03, units: "m" },
  "punt length": { value: 4.6, tolerance: 0.05, units: "m" },
  "cave arch width": { value: 8.6, tolerance: 0.02, units: "m" },
  "cave arch crown": { value: 4.1, tolerance: 0.02, units: "m" },
  "floodplain relief": { value: 14.41, tolerance: 0.10, units: "m", note: "whole sector" },
  "max walkable slope": { value: 19.0, tolerance: 0.0, units: "deg", note: "on the route" },
  "canopy openness, meadow": { value: [0.80, 1.0], units: "fraction" },
  "canopy openness, journey upstream": { value: [0.05, 0.42], units: "fraction" },
};

/* =============================================================== helpers */

/** Bankfull half-width and thalweg at a point, for relief.js and for checks. */
export function channelAt(x, z) {
  let best = null;
  for (const stream of STREAMS) {
    const s = stream.project(x, z);
    const lat = stream.lateral(x, z, s).lat;
    const w = stream.bankhalf(s);
    const score = Math.abs(lat) - w;
    if (best === null || score < best.score) {
      best = { stream, s, lat, w, score, bed: stream.bed(s), depth: stream.depth(s), ws: stream.ws(s), foul: turbidity(x, z) };
    }
  }
  return best;
}

/** Elevation of the bed at a point (only meaningful near a channel). */
export function bedAt(x, z) { return channelAt(x, z).bed; }

export { ramp, remap, lerp, clamp };
