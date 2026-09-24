/**
 * Compile Sector 1 from the authored model into the geometry the app renders.
 *
 *   node tools/build_world.mjs            # build, write, report
 *   node tools/build_world.mjs --quiet
 *
 * The build is a compilation, not an export. Nothing in `assets/world` is edited
 * by hand and nothing is stored that cannot be re-derived: the authored vector
 * data in `src/world/geography.js` and the fields in `src/world/relief.js` are the
 * source. This turns them into
 *
 *   ground.geo     a fine mesh that hugs the corridor + a coarse silhouette
 *   water.geo      the water surface, cut where the terrain meets it
 *   standing.geo   trees, boulders, reeds and brush
 *   props.geo      the built things and the cave mouth
 *   manifest.json  collision, the traversable route, the shot list, the audit
 *
 * The waterline is not authored. It is the intersection of two fields, so the
 * river cannot fail to touch its banks, cannot flood the valley, and cannot miss
 * the pool behind the dam -- and the same is true of every reach and every reed
 * hollow. That is the one thing in a greybox worth getting structurally right,
 * because every later pass (wetness in the materials, the debris line, where reeds
 * grow, where the player can walk) reads the same comparison.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

import { writeGeo } from "./binio.mjs";
import {
  WORLD, ERY, FORK, STREAMS, ZONES, FEATURES, SHOTS, REAL, CAVE, BRIDGE_S, ROUTE,
  turbidity, FORK_AT,
} from "../src/world/geography.js";   // FORK_AT/ROUTE: the corridor and the audit line
import {
  terrainHeight, waterLevel, waterExtent, slopeDegrees, zoneOf, canopyDensity,
  fouling, ROUTE_TRAVERSAL, channelShape, caveSillElevation, HOLLOW_SOURCES,
} from "../src/world/relief.js";
import { populate, STANDS } from "../src/world/populate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets", "world");
const quiet = process.argv.includes("--quiet");

const FINE = 2.0;              // m, corridor mesh spacing
const COARSE = 10.0;           // m, distant silhouette spacing
const TILE = 40.0;             // m, the fine region's unit (and P6's stream unit)
const CORRIDOR = 54;           // m, half-width of the fine region around the water

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const say = (label, ...rest) => { if (!quiet) console.log(`${label.padEnd(28, " ")} ${rest.join("  ")}`); };
const t0 = performance.now();

/* ==================================================== per-tile field cache */

/**
 * Everything the mesh needs, sampled once per vertex per tile.
 *
 * The field queries are the whole cost of this build: terrainHeight is a
 * composition of two channel cross-sections, the hollows, the karst and the
 * relief, and it is asked a few million times if you re-derive it per attribute.
 * Sampling it once per tile and reading the arrays back is what keeps the build
 * at a few seconds -- which is the difference between a check that runs on every
 * commit and one that does not.
 */
function sampleTile(x0, z0) {
  const n = Math.round(TILE / FINE) + 2;                 // one row of overlap per side
  const baseX = Math.round(x0 / FINE) * FINE - FINE;
  const baseZ = Math.round(z0 / FINE) * FINE - FINE;
  const h = new Float32Array(n * n);
  const lvl = new Float32Array(n * n);
  const wet = new Uint8Array(n * n);
  const zone = new Uint8Array(n * n);
  const foul = new Uint8Array(n * n);
  const canopy = new Uint8Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    const z = baseZ + iz * FINE;
    for (let ix = 0; ix < n; ix++) {
      const x = baseX + ix * FINE;
      const i = iz * n + ix;
      const height = terrainHeight(x, z);
      const ext = waterExtent(x, z);
      h[i] = height;
      if (ext === null) {
        lvl[i] = NaN;
      } else {
        lvl[i] = ext.level;
        wet[i] = height < ext.level - 0.004 ? 1 : 0;
      }
      zone[i] = zoneOf(x, z).id;
      foul[i] = Math.round(clamp01(fouling(x, z)) * 255);
      canopy[i] = Math.round(clamp01(canopyDensity(x, z)) * 255);
    }
  }
  return { n, h, lvl, wet, zone, foul, canopy, baseX, baseZ };
}

/** Moisture from cached fields: height above the water, shaded by the canopy. */
function moistureOf(sample, i) {
  const lvl = sample.lvl[i];
  const above = Number.isNaN(lvl) ? 5.5 : sample.h[i] - lvl;
  const near = 1 - smoothstep(above, -0.1, 2.6);
  const shade = sample.canopy[i] / 255;
  return clamp01(0.10 + 0.86 * near + 0.24 * shade * (1 - near));
}
const smoothstep = (x, a, b) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * The greybox's colour. Greybox does not mean grey: its whole value is that it
 * makes the *structure* of the ground legible, so the waterline, the wetness, the
 * shade of the canopy and the fouling gradient are all put into the albedo, from
 * the same fields P1's materials will read. When the waterline moves, this moves
 * with it, and so will the moss -- which is the point of building it this way.
 */
function shade(x, z, sample, i) {
  const zone = ZONES[sample.zone[i]] ?? ZONES[2];
  const wet = moistureOf(sample, i);
  const foul = sample.foul[i] / 255;
  const canopy = sample.canopy[i] / 255;
  const submerged = sample.wet[i] === 1;
  let g = zone.grey;
  g *= 1 - 0.24 * canopy;
  g *= 1 - 0.20 * wet;
  if (submerged) g *= 0.60;
  g += 0.06 * (foul - 0.25) * (submerged ? 1 : 0.4);
  if (!submerged && !Number.isNaN(sample.lvl[i])) {
    /* The debris line: a band of what the water left, exactly where the ground
       passes the surface. Derived, never drawn. */
    const above = sample.h[i] - sample.lvl[i];
    g += 0.12 * Math.exp(-Math.pow(above / 0.20, 2));
  }
  g = clamp01(g);
  return [g, clamp01(g * (0.99 + 0.02 * foul)), clamp01(g * (1 - 0.07 * foul))];
}

/* ============================================================== tile picker */

function corridorTiles() {
  const { minX, maxX, minZ, maxZ } = WORLD.bounds;
  const tiles = [];
  const nx = Math.ceil((maxX - minX) / TILE), nz = Math.ceil((maxZ - minZ) / TILE);
  const wet = [
    ...[ERY, FORK].flatMap((s) => s.points.map((p) => [p[0], p[1]])),
    ...HOLLOW_SOURCES.map((o) => [o.x, o.z]),
  ];
  const cell = 40;
  const grid = new Map();
  for (const [x, z] of wet) {
    const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([x, z]);
  }
  for (let tz = 0; tz < nz; tz++) {
    for (let tx = 0; tx < nx; tx++) {
      const x0 = minX + tx * TILE, z0 = minZ + tz * TILE;
      const cx = x0 + TILE / 2, cz = z0 + TILE / 2;
      let near = Infinity;
      for (let dz = -2; dz <= 2 && near > CORRIDOR; dz++) {
        for (let dx = -2; dx <= 2 && near > CORRIDOR; dx++) {
          const list = grid.get(`${Math.floor(cx / cell) + dx},${Math.floor(cz / cell) + dz}`);
          if (!list) continue;
          for (const [px, pz] of list) near = Math.min(near, Math.hypot(cx - px, cz - pz));
        }
      }
      if (near <= CORRIDOR + TILE * 0.72) tiles.push({ tx, tz, x0, z0 });
    }
  }
  return tiles;
}

/** One sample per tile, shared by every mesh so no vertex is computed twice. */
function cachedSample(tile, cache) {
  const key = `${tile.tx},${tile.tz}`;
  let s = cache.get(key);
  if (!s) cache.set(key, s = sampleTile(tile.x0, tile.z0));
  return s;
}

/* ============================================================ ground mesh */

function buildGround(tiles, cache) {
  const pos = [], nrm = [], col = [], zoneIds = [];
  const tileKey = (x, z) => `${Math.floor((x - WORLD.bounds.minX) / TILE)},${Math.floor((z - WORLD.bounds.minZ) / TILE)}`;
  const tileSet = new Set(tiles.map((t) => `${t.tx},${t.tz}`));
  const sampleFor = (tile) => cachedSample(tile, cache);
  const indexIn = (sample, x, z) => {
    const ix = Math.round((x - sample.baseX) / FINE), iz = Math.round((z - sample.baseZ) / FINE);
    return Math.max(0, Math.min(sample.n - 1, iz)) * sample.n + Math.max(0, Math.min(sample.n - 1, ix));
  };

  let tris = 0, verts = 0;
  const emit = (a, b, c, sample) => {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (const p of [a, b, c]) {
      pos.push(p.x, p.y, p.z);
      nrm.push(nx, ny, nz);
      const i = indexIn(sample, p.x, p.z);
      const [r, g, bl] = shade(p.x, p.z, sample, i);
      col.push(r, g, bl);
      zoneIds.push(sample.zone[i]);
      verts++;
    }
    tris++;
  };

  for (const tile of tiles) {
    const sample = sampleFor(tile);
    const n = sample.n;
    /* Only the cells that actually fall inside this tile's square, so the overlap
       rows do not get emitted twice. */
    for (let iz = 0; iz < n - 1; iz++) {
      for (let ix = 0; ix < n - 1; ix++) {
        const x = sample.baseX + ix * FINE, z = sample.baseZ + iz * FINE;
        if (x < tile.x0 - 1e-6 || x >= tile.x0 + TILE - 1e-6) continue;
        if (z < tile.z0 - 1e-6 || z >= tile.z0 + TILE - 1e-6) continue;
        const p00 = { x, z, y: sample.h[iz * n + ix] };
        const p10 = { x: x + FINE, z, y: sample.h[iz * n + ix + 1] };
        const p11 = { x: x + FINE, z: z + FINE, y: sample.h[(iz + 1) * n + ix + 1] };
        const p01 = { x, z: z + FINE, y: sample.h[(iz + 1) * n + ix] };
        /* Split the quad along the shorter diagonal: two long thin triangles across
           a slope is the shape that shows up as a crease on a bank. */
        if (Math.abs(p00.y - p11.y) <= Math.abs(p10.y - p01.y)) {
          emit(p00, p10, p11, sample); emit(p00, p11, p01, sample);
        } else {
          emit(p00, p10, p01, sample); emit(p10, p11, p01, sample);
        }
      }
    }
  }

  /* Coarse: everything outside the corridor. Nothing walkable lives here; it is
     the far ground and the skyline, and it exists so no shot has to show where
     the world stops. */
  const { minX: bx, maxX, minZ: bz, maxZ } = WORLD.bounds;
  /* Aligned to the fine lattice: both spacings are multiples of 2 m, so every
     coarse vertex lands exactly on a fine one where the two regions meet, and the
     seam between resolutions is the same sample on both sides -- no crease. */
  const minX = Math.round(bx / FINE) * FINE, minZ = Math.round(bz / FINE) * FINE;
  const cnx = Math.round((maxX - minX) / COARSE), cnz = Math.round((maxZ - minZ) / COARSE);
  const ch = new Float32Array((cnx + 1) * (cnz + 1));
  for (let iz = 0; iz <= cnz; iz++) {
    for (let ix = 0; ix <= cnx; ix++) {
      const x = minX + ix * COARSE, z = minZ + iz * COARSE;
      const tile = { tx: Math.floor((x - minX) / TILE), tz: Math.floor((z - minZ) / TILE) };
      const key = `${tile.tx},${tile.tz}`;
      const s = tileSet.has(key) ? sampleFor(tiles.find((t) => `${t.tx},${t.tz}` === key)) : null;
      let y;
      if (s) {
        const i = indexIn(s, x, z);
        y = s.h[i];
      } else {
        y = terrainHeight(x, z);
      }
      ch[iz * (cnx + 1) + ix] = y;
    }
  }
  const coarseSample = {
    n: cnx + 1, h: ch,
    lvl: (() => { const a = new Float32Array((cnx + 1) * (cnz + 1)); for (let i = 0; i < a.length; i++) a[i] = NaN; return a; })(),
    wet: new Uint8Array((cnx + 1) * (cnz + 1)),
    zone: new Uint8Array((cnx + 1) * (cnz + 1)),
    canopy: new Uint8Array((cnx + 1) * (cnz + 1)),
    foul: new Uint8Array((cnx + 1) * (cnz + 1)),
    baseX: minX, baseZ: minZ,
  };
  for (let iz = 0; iz < cnz; iz++) {
    for (let ix = 0; ix < cnx; ix++) {
      const x = minX + ix * COARSE, z = minZ + iz * COARSE;
      /* Skip cells the fine mesh already made; the shared edges are the same
         samples, so the seam between the two resolutions is exact. */
      const t = `${Math.floor((x - minX) / TILE)},${Math.floor((z - minZ) / TILE)}`;
      if (tileSet.has(t)) continue;
      const idx = (gx, gz) => gz * (cnx + 1) + gx;
      const at = (gx, gz) => ({ x: minX + gx * COARSE, z: minZ + gz * COARSE, y: ch[idx(gx, gz)] });
      emit(at(ix, iz), at(ix + 1, iz), at(ix + 1, iz + 1), coarseSample);
      emit(at(ix, iz), at(ix + 1, iz + 1), at(ix, iz + 1), coarseSample);
    }
  }

  return {
    attributes: {
      position: new Float32Array(pos),
      normal: new Float32Array(nrm),
      color: new Float32Array(col),
      zone: new Uint16Array(zoneIds),
    },
    stats: { vertices: pos.length / 3, triangles: tris, fineTiles: tiles.length },
  };
}

/* ============================================================= water mesh */

/**
 * The water surface, built cell by cell on the same fine grid as the ground: a
 * fan from the polygon of wet corners and edge crossings. Because the crossings
 * are where the *terrain* reaches the *surface*, the two meshes meet exactly,
 * and the water's outline is the waterline rather than an approximation of it.
 */
function buildWater(tiles, cache) {
  const pos = [], col = [], water = [];
  let tris = 0;

  for (const tile of tiles) {
    const s = cachedSample(tile, cache);
    const n = s.n;
    const pt = (ix, iz) => {
      const i = iz * n + ix;
      return { x: s.baseX + ix * FINE, z: s.baseZ + iz * FINE, y: s.h[i], level: s.lvl[i], wet: s.wet[i] === 1, i };
    };
    for (let iz = 0; iz < n - 1; iz++) {
      for (let ix = 0; ix < n - 1; ix++) {
        const x = s.baseX + ix * FINE, z = s.baseZ + iz * FINE;
        if (x < tile.x0 - 1e-6 || x >= tile.x0 + TILE - 1e-6) continue;
        if (z < tile.z0 - 1e-6 || z >= tile.z0 + TILE - 1e-6) continue;
        const corner = [pt(ix, iz), pt(ix + 1, iz), pt(ix + 1, iz + 1), pt(ix, iz + 1)];
        if (corner.every((c) => !c.wet)) continue;
        const poly = [];
        for (let e = 0; e < 4; e++) {
          const a = corner[e], b = corner[(e + 1) % 4];
          if (a.wet) poly.push(a);
          const ha = a.y - a.level, hb = b.y - b.level;
          const inside = (v) => v < -0.004;
          if (inside(ha) !== inside(hb) && Number.isFinite(ha) && Number.isFinite(hb)) {
            const t = ha / (ha - hb);
            poly.push({
              x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t),
              y: lerp(a.y, b.y, t), level: a.level, wet: true,
            });
          }
        }
        if (poly.length < 3) continue;
        let cx = 0, cz = 0, cy = 0;
        for (const p of poly) { cx += p.x; cz += p.z; cy += p.y; }
        cx /= poly.length; cz /= poly.length; cy /= poly.length;
        const atLevel = poly[0].level;
        const centre = { x: cx, z: cz, y: cy, level: atLevel };
        for (let k = 0; k < poly.length; k++) {
          const a = poly[k], b = poly[(k + 1) % poly.length];
          for (const p of [centre, a, b]) {
            const level = Number.isFinite(p.level) ? p.level : atLevel;
            pos.push(p.x, level, p.z);
            const depth = Math.max(0, level - p.y);
            const foul = clamp01(turbidity(p.x, p.z));
            const near = nearestStream(p.x, p.z);
            const foam = near ? clamp01((near.stream.froude(near.s, { foul }) - 0.34) / 0.38) : 0;
            /* A dark, warm shallow and a pale, cold deep: the foam term is the
               white the water puts on a bar or over the weir lip. */
            const tone = 0.34 + 0.30 * smoothstep(depth, 0.05, 0.85) + 0.35 * foam;
            col.push(clamp01(tone * (1 - 0.18 * foul)), clamp01(tone * (1 - 0.06 * foul)), clamp01(tone));
            water.push(depth, foul, foam, near ? (near.stream.order === 2 ? 1 : 0) : 0);
            tris++;
          }
        }
      }
    }
  }

  return {
    attributes: {
      position: new Float32Array(pos),
      color: new Float32Array(col),
      /* x: depth, y: fouling, z: foam, w: 1 for the receiving river / 0 for the
         fork. The renderer shades with these; P1 decides wetness from them; the
         checker reads them to prove all three agree. */
      waterData: new Float32Array(water),
    },
    stats: { vertices: pos.length / 3, triangles: tris },
  };
}

function nearestStream(x, z) {
  let best = null;
  for (const stream of STREAMS) {
    const d = stream.distance(x, z);
    if (best === null || d < best.d) best = { d, stream, s: stream.project(x, z) };
  }
  return best && best.d < 120 ? best : null;
}

/* ========================================================= standing mesh */

/** A box, in world space, with an optional lean. The greybox's only solid. */
function pushBox(out, cx, cy, cz, hx, hy, hz, yaw, grey, lean = 0, leanDir = 0) {
  const corners = [
    [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1],
    [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],
  ].map(([sx, sy, sz]) => {
    let x = sx * hx, y = sy * hy, z = sz * hz;
    const shear = Math.sin(lean) * (y + hy);           // trunks lean, they do not tilt
    const rx = x + shear * Math.cos(leanDir), rz = z + shear * Math.sin(leanDir);
    const wx = rx * Math.cos(yaw) - rz * Math.sin(yaw);
    const wz = rx * Math.sin(yaw) + rz * Math.cos(yaw);
    return [cx + wx, cy + y * Math.cos(lean), cz + wz];
  });
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [2, 6, 5, 1], [0, 4, 7, 3]];
  for (const f of faces) pushQuad(out, corners[f[0]], corners[f[1]], corners[f[2]], corners[f[3]], grey);
}

function pushTriangle(out, a, b, c, grey) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  for (const p of [a, b, c]) {
    out.pos.push(p[0], p[1], p[2]);
    out.nrm.push(nx, ny, nz);
    out.col.push(grey, grey * 0.99, grey * 0.97);
  }
}
function pushQuad(out, a, b, c, d, grey) {
  pushTriangle(out, a, b, c, grey);
  pushTriangle(out, a, c, d, grey);
  out.tris += 2;
}

/**
 * Trees, boulders and ground cover.
 *
 * Each tree is a tapered bole and two offset canopy shells: one ellipsoid is the
 * unmistakable shape of a game tree, two lumpy overlapping ones are not a shape at
 * all. The lean comes from the slope it stands on and the banks it overhangs,
 * which is the cheapest thing here that a reference photograph will show you.
 */
function buildStanding(pop) {
  const out = { pos: [], nrm: [], col: [], tris: 0 };
  for (const t of pop.trees) {
    const boleTop = t.height * (t.dead ? 0.52 : 0.42);
    pushBox(out, t.x, t.y + boleTop / 2, t.z, t.bole * 0.42, boleTop / 2, t.bole * 0.42, t.rot, t.grey * 0.72, t.lean * 0.4, t.leanDir);
    if (!t.dead) {
      const cy = t.height * 0.72;
      pushBox(out, t.x, t.y + cy, t.z, t.crown * 0.50, t.crown * 0.30, t.crown * 0.50, t.rot, t.grey, t.lean, t.leanDir);
      pushBox(out, t.x + Math.cos(t.rot) * t.crown * 0.17, t.y + cy * 0.80, t.z + Math.sin(t.rot) * t.crown * 0.17,
        t.crown * 0.37, t.crown * 0.23, t.crown * 0.39, t.rot * 1.7, t.grey * 0.92, t.lean, t.leanDir);
    } else {
      for (let k = 0; k < 3; k++) {
        const a = t.rot + k * 2.1;
        pushBox(out, t.x + Math.cos(a) * 1.0, t.y + boleTop + 0.45 + k * 0.5, t.z + Math.sin(a) * 1.0,
          0.09, 0.85, 0.09, a, t.grey * 0.8, 0.45, a);
      }
    }
  }
  for (const b of pop.boulders) {
    pushBox(out, b.x, b.y + b.size * 0.42, b.z, b.size * 0.62, b.size * 0.40, b.size * 0.56,
      b.rot, b.grey, b.pitch, b.roll);
  }
  for (const gc of pop.groundCover) {
    const w = gc.width * 0.5, hh = gc.height;
    for (let k = 0; k < 2; k++) {
      const yaw = gc.rot + k * Math.PI / 2;
      const dx = Math.cos(yaw) * w, dz = Math.sin(yaw) * w;
      const lx = gc.lean * hh, lz = -gc.lean * hh * 0.4;
      const a = [gc.x - dx, gc.y, gc.z - dz], b = [gc.x + dx, gc.y, gc.z + dz];
      const c = [gc.x + dx + lx, gc.y + hh, gc.z + dz + lz], d = [gc.x - dx + lx, gc.y + hh, gc.z - dz + lz];
      pushQuad(out, a, b, c, d, gc.grey);
    }
  }
  return {
    attributes: {
      position: new Float32Array(out.pos),
      normal: new Float32Array(out.nrm),
      color: new Float32Array(out.col),
    },
    stats: {
      vertices: out.pos.length / 3, triangles: out.tris,
      trees: pop.trees.length, boulders: pop.boulders.length, groundCover: pop.groundCover.length,
    },
  };
}

/* ============================================================= props + cave */

function buildPropsAndCave(pop) {
  const out = { pos: [], nrm: [], col: [], tris: 0 };
  for (const p of pop.props) {
    const grey = p.grey ?? 0.33;
    pushBox(out, p.x, p.y, p.z, p.size.x / 2, p.size.y / 2, p.size.z / 2,
      p.yaw ?? p.rot ?? 0, grey, p.pitch ?? 0, p.roll ?? 0);
  }

  /* The mouth: piers, a lintel, a roof box, a floor, and a collar of radial
     blocks across the opening so it reads as a span rather than as a rectangle
     punched into a wall. */
  const cave = pop.cave;
  for (const w of cave.front) {
    pushBox(out, w.x, w.y, w.z, w.size.x / 2, w.size.y / 2, w.size.z / 2, w.rot, w.grey);
  }
  const r = cave.arch.width / 2;
  const segs = 16;
  for (let i = 0; i <= segs; i++) {
    const a = Math.PI * (i / segs);
    const lx = Math.cos(a) * r;
    const ly = cave.arch.springing + Math.sin(a) * (cave.crown - cave.arch.springing);
    const along = -0.9 + (i % 2) * 0.5;
    const wx = cave.sill.x + (lx * Math.cos(-cave.yaw) - along * Math.sin(-cave.yaw));
    const wz = cave.sill.z + (lx * Math.sin(-cave.yaw) + along * Math.cos(-cave.yaw));
    pushBox(out, wx, ly, wz, 0.62, 0.42, 1.2, cave.yaw, 0.63 - 0.05 * (i % 3));
  }
  return {
    attributes: {
      position: new Float32Array(out.pos),
      normal: new Float32Array(out.nrm),
      color: new Float32Array(out.col),
    },
    stats: { vertices: out.pos.length / 3, triangles: out.tris, parts: pop.props.length + segs + cave.front.length },
  };
}

/* =============================================================== collision */

function buildCollision(pop) {
  const boxes = [];
  for (const t of pop.trees) {
    boxes.push([r2(t.x), r2(t.y + 1.0), r2(t.z), r2(t.bole * 0.8), 2.0, r2(t.bole * 0.8), r3(t.rot), 1]);
  }
  for (const b of pop.boulders) {
    boxes.push([r2(b.x), r2(b.y + b.size * 0.4), r2(b.z), r2(b.size * 0.58), r2(b.size * 0.46), r2(b.size * 0.58), r3(b.rot), b.size < 1.1 ? 5 : 1]);
  }
  for (const p of pop.props) {
    if (p.flat) continue;
    const walkable = /deck|plank|step|apron/.test(p.kind ?? "") ? 2 : 0;
    boxes.push([r2(p.x), r2(p.y), r2(p.z), r2(p.size.x / 2), r2(p.size.y / 2), r2(p.size.z / 2), r3(p.yaw ?? p.rot ?? 0), 1 | walkable]);
  }
  for (const w of pop.cave.front) {
    boxes.push([r2(w.x), r2(w.y), r2(w.z), r2(w.size.x / 2), r2(w.size.y / 2), r2(w.size.z / 2), r3(w.rot), 1]);
  }
  return { cell: 16, boxes };
}

/* ==================================================================== main */

async function main() {
  if (!quiet) console.log(`\nASTRA / ${WORLD.name} — P0 greybox\n`);
  const sJoin = ERY.project(FORK.points[0][0], FORK.points[0][1]);
  say("authored", `${ERY.length.toFixed(0)} m of river · ${FORK.length.toFixed(0)} m of fork · junction at chainage ${sJoin.toFixed(0)} m`);
  say("corridor", `${ROUTE.length.toFixed(0)} m walked, ${waterLevel(FORK_AT.x, FORK_AT.z) === null ? "" : ""}${(FORK.ws(FORK.length) - ERY.ws(0)).toFixed(1)} m of climb`);

  const tiles = corridorTiles();
  if (!quiet) console.log(`      corridor tiles ${String(tiles.length).padStart(4)}   fine ${FINE} m   coarse ${COARSE} m`);

  const cache = new Map();
  const ground = buildGround(tiles, cache);
  const water = buildWater(tiles, new Map());
  const pop = populate();
  const standing = buildStanding(pop);
  const props = buildPropsAndCave(pop);

  await mkdir(outDir, { recursive: true });
  const geos = [["ground", ground], ["water", water], ["standing", standing], ["props", props]];
  const files = [];
  for (const [name, g] of geos) {
    const blocks = { [name]: { attributes: {}, stats: g.stats } };
    const data = {};
    for (const [attr, arr] of Object.entries(g.attributes)) {
      const comps = attr === "zone" ? 1 : attr === "waterData" ? 4 : 3;
      const count = arr.length / comps;
      blocks[name].attributes[attr] = { type: arr instanceof Uint16Array ? "u16" : "f32", components: comps, count };
      data[attr] = arr;
    }
    const { bytes } = await writeGeo(join(outDir, `${name}.geo`), {
      meta: { world: WORLD.name, generator: "tools/build_world.mjs", format: 1 },
      blocks, data,
    });
    files.push({ file: `${name}.geo`, bytes, block: name, stats: g.stats });
    say(`${name}.geo`, `${String(g.stats.triangles).padStart(7)} tris   ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  }

  /* The traversable route: the snapped line, with elevation, water clearance and
     slope at every sample, so the player, the camera and the audit use one line. */
  let acc = 0;
  const pts = ROUTE_TRAVERSAL.points;
  const route = pts.map((p, i) => {
    if (i) acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    const y = terrainHeight(p[0], p[1]);
    const ext = waterExtent(p[0], p[1]);
    return {
      s: r2(acc), x: r2(p[0]), z: r2(p[1]), y: r2(y),
      dry: ext === null || y > ext.level + 0.02,
      freeboard: ext === null ? null : r3(y - ext.level),
      slope: r2(slopeDegrees(p[0], p[1], 1.0)),
      zone: zoneOf(p[0], p[1]).id,
    };
  });

  const shots = SHOTS.map((shot) => {
    const c = shot.camera;
    const ground = terrainHeight(c.x, c.z);
    const level = waterLevel(c.x, c.z);
    const y = level !== null && ground < level ? level + 0.35 : ground + c.eye;
    return {
      id: shot.id, kind: shot.kind ?? "hero",
      chainage: shot.chainage !== undefined ? r2(shot.chainage) : null,
      camera: { x: r2(c.x), y: r2(y), z: r2(c.z), yaw: r3(c.yaw), pitch: r3(c.pitch), fov: c.fovDeg },
      expect: shot.expect ?? {},
      distanceToCave: r2(Math.hypot(c.x - FEATURES.caveMouth.x, c.z - FEATURES.caveMouth.z)),
    };
  });

  const contentHash = createHash("sha256");
  for (const [name, g] of geos) {
    contentHash.update(name);
    for (const arr of Object.values(g.attributes)) {
      contentHash.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    }
  }

  const bridge = channelShape(FORK.at(BRIDGE_S).x, FORK.at(BRIDGE_S).z, FORK);
  const manifest = {
    world: WORLD.name,
    encounters: WORLD.encounter,
    format: 1,
    builtAt: process.argv.includes("--stamp") ? randomUUID() : "unstamped",
    generator: "tools/build_world.mjs",
    contentHash: contentHash.digest("hex").slice(0, 16),
    bounds: WORLD.bounds,
    datum: WORLD.datum,
    files,
    zones: ZONES,
    stands: Object.fromEntries(Object.entries(STANDS).map(([k, v]) => [k, { name: v.name, height: v.height, crown: v.crown }])),
    streams: {
      ery: {
        id: "ery", length: r2(ERY.length), junctionChainage: r2(sJoin),
        wsAtVillage: r3(ERY.ws(0)), wsAtJunction: r3(ERY.ws(sJoin)), wsAtEnd: r3(ERY.ws(ERY.length)),
        bankhalf: ERY.bankfull, depth: ERY.depthAuthored, roughness: ERY.roughness,
      },
      fork: {
        id: "fork", length: r2(FORK.length),
        wsAtMouth: r3(FORK.ws(0)), wsAtCave: r3(FORK.ws(FORK.length)),
        bankhalf: FORK.bankfull, depth: FORK.depthAuthored, roughness: FORK.roughness,
        weir: { s: FORK.obstructions[0].s, rise: FORK.obstructions[0].rise },
      },
    },
    features: Object.fromEntries(Object.entries(FEATURES).map(([k, v]) => [k, {
      x: r2(v.x), z: r2(v.z), y: r2(terrainHeight(v.x, v.z)), note: v.note,
    }])),
    cave: {
      width: CAVE.width, height: CAVE.height, depth: CAVE.depth,
      bed: r3(caveSillElevation() - CAVE.springing), sill: r3(caveSillElevation()),
      ws: r3(FORK.ws(CAVE.s)), yaw: r3(FORK.at(CAVE.s).s),
    },
    bridge: { span: r2(bridge.edge * 2 + 4.8), deckClearance: r2(bridge.ws - bridge.bank), width: 1.8 },
    route,
    shots,
    collision: buildCollision(pop),
    scale: REAL,
    stats: {
      terrainTriangles: ground.stats.triangles,
      waterTriangles: water.stats.triangles,
      standingTriangles: standing.stats.triangles,
      propTriangles: props.stats.triangles,
      trees: standing.stats.trees,
      boulders: standing.stats.boulders,
      groundCover: standing.stats.groundCover,
      props: pop.props.length,
      routeLength: route.at(-1).s,
      routeWetSamples: route.filter((p) => !p.dry).length,
      worldAreaHa: r2((WORLD.bounds.maxX - WORLD.bounds.minX) * (WORLD.bounds.maxZ - WORLD.bounds.minZ) / 1e4),
      buildSeconds: r2((performance.now() - t0) / 1000),
    },
  };
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  say("manifest.json", `${(JSON.stringify(manifest, null, 2).length / 1024).toFixed(0)} KB`);
  if (!quiet) {
    console.log(`\nbuilt in ${manifest.stats.buildSeconds}s -> assets/world/`);
    console.log(`  ${manifest.stats.terrainTriangles + manifest.stats.waterTriangles + manifest.stats.standingTriangles + manifest.stats.propTriangles} triangles, `
      + `${manifest.stats.trees} trees, ${manifest.stats.groundCover} tufts, ${manifest.stats.routeLength} m of walkable corridor\n`);
  }
}

main().catch((e) => { console.error("\nbuild failed:", e?.stack ?? e); process.exit(1); });
