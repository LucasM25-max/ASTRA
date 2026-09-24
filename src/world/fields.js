/**
 * The scalar fields the whole world is composed from: smooth minimums, ramps
 * and clamps. Kept here because "smooth" is the difference between terrain and a
 * seam: everything in this sector is built by blending two analytic descriptions
 * rather than by hard edges, since a real landscape never announces where one
 * influence stops and the next starts.
 */

export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const saturate = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Cubic smoothstep on [a, b]. */
export function ramp(x, a, b) {
  if (b === a) return x >= b ? 1 : 0;
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Linear interpolation. */
export const lerp = (a, b, t) => a + (b - a) * t;

/** Map x from [a,b] to [c,d], clamped. */
export function remap(x, a, b, c, d) {
  return lerp(c, d, saturate((x - a) / (b - a)));
}

/**
 * Polynomial smooth minimum of a and b with blend radius k.
 *
 * `k` is in the same units as the values, so it can be authored in metres for
 * distances and in degrees for slopes without anything needing to know.
 */
export function smin(a, b, k) {
  const h = clamp(0.5 + 0.5 * (b - a) / k);
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Smooth maximum, the mirror image of smin. */
export function smax(a, b, k) {
  return -smin(-a, -b, k);
}

/**
 * Distance from a point to a polyline, in the plane, plus which segment it hit
 * and where along it (0..1). Every hydrology and mask question in the sector is
 * asked through this: distance to bank, on which reach, how far along the curve.
 *
 * `index` is an optional uniform grid over the segments (see `buildSegmentGrid`).
 * The world asks this question a few million times per build -- once per vertex
 * per stream, then again for every tree, boulder and route sample -- and without
 * the grid the whole sector takes minutes instead of seconds, which is the point
 * at which a check stops being run.
 */
export function distanceToPolyline(px, pz, pts, index = null) {
  let bestD2 = Infinity, bestSeg = 0, bestT = 0;
  const test = (i) => {
    const ax = pts[i][0], az = pts[i][1];
    const bx = pts[i + 1][0], bz = pts[i + 1][1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = px - (ax + dx * t), cz = pz - (az + dz * t);
    const d2 = cx * cx + cz * cz;
    if (d2 < bestD2) { bestD2 = d2; bestSeg = i; bestT = t; }
  };

  if (index) {
    let radius = 0, best = Infinity;
    for (; radius <= index.maxRadius; radius++) {
      for (let iy = index.iy0 - radius; iy <= index.iy0 + radius; iy++) {
        for (let ix = index.ix0 - radius; ix <= index.ix0 + radius; ix++) {
          if (radius > 0
            && Math.abs(ix - index.ix0) !== radius && Math.abs(iy - index.iy0) !== radius) continue;
          const cell = index.cells.get(cellKey(ix, iy));
          if (!cell) continue;
          for (let k = 0; k < cell.length; k++) test(cell[k]);
        }
      }
      best = Math.sqrt(bestD2);
      if (best <= radius * index.cell) break;              // nothing nearer can exist
    }
    return { distance: best, segment: bestSeg, t: bestT };
  }

  for (let i = 0; i < pts.length - 1; i++) test(i);
  return { distance: Math.sqrt(bestD2), segment: bestSeg, t: bestT };
}

const cellKey = (ix, iy) => ix * 73856093 ^ iy * 19349663;

/**
 * A dense uniform grid over a set of small items, as typed arrays.
 *
 * Deliberately not a Map: the height field asks this question a few million
 * times per build and per authored pass, and a hash lookup on that path is the
 * difference between a sector that compiles in eight seconds and one that takes
 * four minutes -- which is the difference between a check that gets run and one
 * that gets skipped.
 */
export function denseGrid(items, cell, { radius = 0, getR = null } = {}) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const it of items) {
    const r = (getR ? getR(it) : 0) + radius;
    minX = Math.min(minX, it.x - r); maxX = Math.max(maxX, it.x + r);
    minZ = Math.min(minZ, it.z - r); maxZ = Math.max(maxZ, it.z + r);
  }
  if (!Number.isFinite(minX)) {
    return { cell: 1, nx: 0, nz: 0, minX: 0, minZ: 0, starts: new Int32Array(1), counts: new Int32Array(1), order: new Int32Array(0) };
  }
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const counts = new Int32Array(nx * nz);
  const at = (ix, iz) => iz * nx + ix;
  const idx = (x, z) => at(Math.floor((x - minX) / cell), Math.floor((z - minZ) / cell));
  for (const it of items) {
    const c = idx(it.x, it.z);
    if (c >= 0 && c < counts.length) counts[c]++;
  }
  const starts = new Int32Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) starts[i + 1] = starts[i] + counts[i];
  const order = new Int32Array(items.length);
  const fill = new Int32Array(counts.length);
  for (let i = 0; i < items.length; i++) {
    const c = idx(items[i].x, items[i].z);
    if (c < 0 || c >= counts.length) continue;
    order[starts[c] + fill[c]++] = i;
  }
  return {
    cell, nx, nz, minX, minZ, starts, counts, order, items,
    /** Indices of items in the cell containing (x, z). */
    inCell(x, z, out) {
      const ix = Math.floor((x - this.minX) / this.cell);
      const iz = Math.floor((z - this.minZ) / this.cell);
      out.length = 0;
      if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return out;
      const c = iz * this.nx + ix;
      for (let i = this.starts[c]; i < this.starts[c + 1]; i++) out.push(this.order[i]);
      return out;
    },
    /** Indices of items in the 3x3 cells around (x, z). */
    inNeighbourhood(x, z, out) {
      return this.inRadius(x, z, this.cell, out);
    },
    /** Indices of items in cells within `radius` of (x, z). */
    inRadius(x, z, radius, out) {
      const ix = Math.floor((x - this.minX) / this.cell);
      const iz = Math.floor((z - this.minZ) / this.cell);
      const ring = Math.max(1, Math.ceil(radius / this.cell));
      out.length = 0;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          const cx = ix + dx, cz = iz + dz;
          if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) continue;
          const c = cz * this.nx + cx;
          for (let i = this.starts[c]; i < this.starts[c + 1]; i++) out.push(this.order[i]);
        }
      }
      return out;
    },
  };
}

/**
 * A uniform grid over scattered items with x/z, for "what is near me" queries.
 * Used by the scatter sources: the root-plate mounds are the same question as
 * the trees, and neither can afford to be a linear search.
 */
export function buildItemGrid(items, cell = 16, pad = 0) {
  const cells = new Map();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const r = (it.r ?? 0) + pad;
    for (let ix = Math.floor((it.x - r) / cell); ix <= Math.floor((it.x + r) / cell); ix++) {
      for (let iy = Math.floor((it.z - r) / cell); iy <= Math.floor((it.z + r) / cell); iy++) {
        const k = cellKey(ix, iy);
        let list = cells.get(k);
        if (!list) cells.set(k, list = []);
        list.push(i);
      }
    }
  }
  return { cells, cell };
}

/** Indices in the grid cells that a query point could fall in, given a radius. */
export function gridNear(grid, x, z, radius = 0) {
  const out = [];
  const seen = new Set();
  const c = grid.cell;
  for (let ix = Math.floor((x - radius) / c); ix <= Math.floor((x + radius) / c); ix++) {
    for (let iy = Math.floor((z - radius) / c); iy <= Math.floor((z + radius) / c); iy++) {
      const k = cellKey(ix, iy);
      if (seen.has(k)) continue;
      seen.add(k);
      const list = grid.cells.get(k);
      if (list) for (const i of list) out.push(i);
    }
  }
  return out;
}

/** A uniform grid over a polyline's segments, for nearest-segment queries. */
export function buildSegmentGrid(pts, cell = 12) {
  const cells = new Map();
  void cells;
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minZ = Math.min(...pts.map((p) => p[1])), maxZ = Math.max(...pts.map((p) => p[1]));
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
    const lo = [Math.min(ax, bx) - cell, Math.min(az, bz) - cell];
    const hi = [Math.max(ax, bx) + cell, Math.max(az, bz) + cell];
    for (let ix = Math.floor(lo[0] / cell); ix <= Math.floor(hi[0] / cell); ix++) {
      for (let iy = Math.floor(lo[1] / cell); iy <= Math.floor(hi[1] / cell); iy++) {
        const k = cellKey(ix, iy);
        let list = cells.get(k);
        if (!list) cells.set(k, list = []);
        list.push(i);
      }
    }
  }
  return { cells, cell, minX, maxX, minZ, maxZ, maxRadius: 6 };
}

/** The same grid, keyed for a moving query point: cheap cell addressing per call. */
export function gridQuery(grid, x, z) {
  return {
    cells: grid.cells,
    cell: grid.cell,
    maxRadius: grid.maxRadius,
    ix0: Math.floor(x / grid.cell),
    iy0: Math.floor(z / grid.cell),
  };
}

/**
 * The point on the polyline closest to `px, pz`: gives the lateral signed
 * distance the water uses to know which side of the channel you are on.
 */
export function closestOnPolyline(px, pz, pts, index = null) {
  const { segment, t } = distanceToPolyline(px, pz, pts, index);
  const ax = pts[segment][0], az = pts[segment][1];
  const bx = pts[segment + 1][0], bz = pts[segment + 1][1];
  return {
    x: ax + (bx - ax) * t,
    z: az + (bz - az) * t,
    segment,
    t,
    tangent: { x: bx - ax, z: bz - az },
  };
}
