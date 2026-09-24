/**
 * Phase P1, Task 1.1: the tiling PBR material library.
 *
 * Five calibrated material sets (PLAN 5.2) -- Flanaess loam, alluvial gravel,
 * bedded karst limestone, blighted sludge, riparian turf -- each as three maps:
 * sRGB albedo, tangent-space normal, and a packed roughness/height/AO map.
 *
 * They are synthesised at load, not shipped as images. Three reasons: the repo
 * deploys as static files with no build step, so a 200 MB texture payload is
 * not on the table; every map must tile seamlessly, which generated noise does
 * by construction; and the checker can regenerate any texel and audit it,
 * which it cannot do with a JPEG. The synthesis is deterministic (integer
 * hashes, seeded lattices), so every client renders the same ground.
 *
 * The pixel generators are pure -- no DOM, no THREE -- so tools/check_p1.mjs
 * can exercise them in node. Only `buildMaterialLibrary` touches three.js,
 * wrapping the bytes in DataTextures.
 */

import * as THREE from "three";
import { MATERIALS, P1, materialById } from "./splat.js";

/* ------------------------------------------------------- deterministic hash */

/**
 * Integer lattice hash, bit-exact on every platform. Returns 0..1.
 * imul wraps at 32 bits identically everywhere, which is the whole point:
 * sin/fract hashes drift in the last ulp between engines.
 */
function hash2(ix, iy, seed) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263)
    + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* ------------------------------------------------------------- tiled noise */

/** Square lattice of random values, `period` on a side. */
function grid(period, seed) {
  const g = new Float32Array(period * period);
  for (let y = 0; y < period; y++) {
    for (let x = 0; x < period; x++) g[y * period + x] = hash2(x, y, seed);
  }
  return g;
}

/** Rectangular lattice: anisotropic features (grass blades, slime streaks). */
function gridR(px, py, seed) {
  const g = new Float32Array(px * py);
  for (let y = 0; y < py; y++) {
    for (let x = 0; x < px; x++) g[y * px + x] = hash2(x, y, seed);
  }
  return { g, px, py };
}

const fade = (t) => t * t * (3 - 2 * t);

function sampleGrid(g, period, u, v) {
  const x = u * period, y = v * period;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const xa = ((x0 % period) + period) % period;
  const ya = ((y0 % period) + period) % period;
  const xb = (xa + 1) % period, yb = (ya + 1) % period;
  const a = g[ya * period + xa], b = g[ya * period + xb];
  const c = g[yb * period + xa], d = g[yb * period + xb];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function sampleGridR(G, u, v) {
  const x = u * G.px, y = v * G.py;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const xa = ((x0 % G.px) + G.px) % G.px;
  const ya = ((y0 % G.py) + G.py) % G.py;
  const xb = (xa + 1) % G.px, yb = (ya + 1) % G.py;
  const a = G.g[ya * G.px + xa], b = G.g[ya * G.px + xb];
  const c = G.g[yb * G.px + xa], d = G.g[yb * G.px + xb];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/**
 * Render one noise octave to a full-size map. Every generator pre-renders its
 * octaves once and then runs a single arithmetic pixel loop, which is what
 * keeps a 512 px library build near a second instead of near a minute.
 * `xform` optionally remaps (u, v) first -- stretched coordinates stay seamless
 * as long as the remap wraps an integer number of times.
 */
function renderOctave(size, period, seed, xform = null) {
  const g = grid(period, seed);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      let u = x / size, w = v;
      if (xform) [u, w] = xform(u, w);
      out[y * size + x] = sampleGrid(g, period, u, w);
    }
  }
  return out;
}

function renderOctaveR(size, px, py, seed) {
  const G = gridR(px, py, seed);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) out[y * size + x] = sampleGridR(G, x / size, v);
  }
  return out;
}

/** Weighted sum of rendered octave maps, normalised to 0..1. */
function combine(size, ...layers) {
  const out = new Float32Array(size * size);
  let norm = 0;
  for (const [, amp] of layers) norm += amp;
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (const [map, amp] of layers) s += map[i] * amp;
    out[i] = s / norm;
  }
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

function toSRGB(l) {
  const c = clamp01(l);
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/* ------------------------------------------------------- map finalisation */

/**
 * Height, albedo, roughness and AO fields in, three packed byte maps out.
 * Normals come from the heightfield (wrapped central differences), so the
 * normal map and the height-blend channel can never disagree.
 */
function finalize(size, f, normalStrength) {
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const normal = new Uint8Array(n * 4);
  const pack = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    albedo[i * 4] = toSRGB(f.r[i]);
    albedo[i * 4 + 1] = toSRGB(f.g[i]);
    albedo[i * 4 + 2] = toSRGB(f.b[i]);
    albedo[i * 4 + 3] = 255;
    pack[i * 4] = Math.round(clamp01(f.rough[i]) * 255);
    pack[i * 4 + 1] = Math.round(clamp01(f.h[i]) * 255);
    pack[i * 4 + 2] = Math.round(clamp01(f.ao[i]) * 255);
    pack[i * 4 + 3] = 255;
  }
  for (let y = 0; y < size; y++) {
    const yu = ((y - 1 + size) % size) * size;
    const yd = ((y + 1) % size) * size;
    const yc = y * size;
    for (let x = 0; x < size; x++) {
      const xl = yc + ((x - 1 + size) % size);
      const xr = yc + ((x + 1) % size);
      const nx = (f.h[xl] - f.h[xr]) * normalStrength;
      const ny = (f.h[yu + x] - f.h[yd + x]) * normalStrength;
      const len = Math.hypot(nx, ny, 1);
      const i = (yc + x) * 4;
      normal[i] = Math.round((nx / len * 0.5 + 0.5) * 255);
      normal[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      normal[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      normal[i + 3] = 255;
    }
  }
  return { albedo, normal, pack };
}

const blank = (size) => ({
  r: new Float32Array(size * size),
  g: new Float32Array(size * size),
  b: new Float32Array(size * size),
  h: new Float32Array(size * size),
  rough: new Float32Array(size * size),
  ao: new Float32Array(size * size),
});

/* ------------------------------------------------- A: loam & forest litter */

function generateLoam(size, seed) {
  const f = blank(size);
  const mottle = combine(size,
    [renderOctave(size, 4, seed + 1), 1],
    [renderOctave(size, 8, seed + 2), 0.5],
    [renderOctave(size, 16, seed + 3), 0.25],
    [renderOctave(size, 32, seed + 4), 0.125]);
  const grain = renderOctave(size, 128, seed + 5);
  const mossM = renderOctave(size, 6, seed + 6);
  const C = 64; // leaf-litter cells across the tile
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const m = mottle[i];
      let r = lerp(0.055, 0.115, m);
      let g = lerp(0.036, 0.075, m);
      let b = lerp(0.020, 0.038, m);
      let h = 0.25 + 0.45 * m + 0.08 * grain[i];
      let rough = 0.90 + 0.08 * (grain[i] - 0.5) * 2;

      // Fallen leaves: rotated ellipses over a wrapped 3x3 cell neighbourhood,
      // so a flake crossing the tile edge continues on the other side.
      const cx = Math.floor(u * C), cy = Math.floor(v * C);
      let flakeK = 0, flakeTone = 1, twig = false;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const ncx = (((cx + ox) % C) + C) % C;
          const ncy = (((cy + oy) % C) + C) % C;
          const pick = hash2(ncx, ncy, seed + 11);
          if (pick >= 0.12) continue;
          const jx = hash2(ncx, ncy, seed + 12) - 0.5;
          const jy = hash2(ncx, ncy, seed + 13) - 0.5;
          const dx = u * C - (cx + ox + 0.5 + jx * 0.5);
          const dy = v * C - (cy + oy + 0.5 + jy * 0.5);
          if (pick < 0.09) {
            const a = hash2(ncx, ncy, seed + 14) * Math.PI;
            const ca = Math.cos(a), sa = Math.sin(a);
            const rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;
            const e = (rx / 0.34) * (rx / 0.34) + (ry / 0.17) * (ry / 0.17);
            if (e < 1 && 1 - e > flakeK) {
              flakeK = 1 - e;
              flakeTone = 0.75 + 0.5 * hash2(ncx, ncy, seed + 15);
            }
          } else if (Math.hypot(dx, dy) < 0.13) {
            twig = true;
          }
        }
      }
      if (flakeK > 0) {
        r = lerp(r, 0.20 * flakeTone, flakeK);
        g = lerp(g, 0.11 * flakeTone, flakeK);
        b = lerp(b, 0.045 * flakeTone, flakeK);
        h += 0.22 * flakeK;
        rough -= 0.05 * flakeK;
      } else if (twig) {
        r = lerp(r, 0.030, 0.8); g = lerp(g, 0.022, 0.8); b = lerp(b, 0.014, 0.8);
        h += 0.08;
      }

      const moss = smoothstep(0.60, 0.72, mossM[i]);
      r = lerp(r, 0.09, moss * 0.55);
      g = lerp(g, 0.13, moss * 0.55);
      b = lerp(b, 0.028, moss * 0.55);

      const sp = 0.92 + 0.16 * grain[i];
      f.r[i] = r * sp; f.g[i] = g * sp; f.b[i] = b * sp;
      f.h[i] = clamp01(h);
      f.rough[i] = clamp01(rough);
      f.ao[i] = 0.72 + 0.28 * clamp01(h);
    }
  }
  return f;
}

/* ------------------------------------------------- B: alluvial gravel */

const PEBBLES = [
  [0.25, 0.24, 0.22], [0.30, 0.24, 0.15], [0.17, 0.18, 0.20],
  [0.38, 0.36, 0.30], [0.20, 0.14, 0.09], [0.10, 0.10, 0.11],
];

function generateGravel(size, seed) {
  const f = blank(size);
  const speckle = renderOctave(size, 96, seed + 21);
  const G = Math.max(4, Math.round(size / 20)); // pebble cells across
  for (let y = 0; y < size; y++) {
    const cv = (y / size) * G;
    const cy0 = Math.floor(cv);
    for (let x = 0; x < size; x++) {
      const cu = (x / size) * G;
      const cx0 = Math.floor(cu);
      const i = y * size + x;
      // Nearest jittered pebble centre over wrapped 3x3 neighbourhood.
      let d1 = Infinity, bx = 0, by = 0, ndx = 0, ndy = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = (((cx0 + ox) % G) + G) % G;
          const ny = (((cy0 + oy) % G) + G) % G;
          const px = cx0 + ox + 0.15 + 0.70 * hash2(nx, ny, seed + 22);
          const py = cy0 + oy + 0.15 + 0.70 * hash2(nx, ny, seed + 23);
          const d = (cu - px) * (cu - px) + (cv - py) * (cv - py);
          if (d < d1) { d1 = d; bx = nx; by = ny; ndx = cu - px; ndy = cv - py; }
        }
      }
      const radius = 0.36 + 0.20 * hash2(bx, by, seed + 24);
      const aspect = 0.72 + 0.56 * hash2(bx, by, seed + 28);
      const ang = hash2(bx, by, seed + 29) * Math.PI;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const ex = (ndx * ca - ndy * sa) / aspect, ey = ndx * sa + ndy * ca;
      const dome = clamp01(1 - Math.sqrt(ex * ex + ey * ey) / radius);
      const domeH = Math.pow(dome, 0.65);
      const gap = smoothstep(0.0, 0.12, dome);
      const pal = PEBBLES[Math.floor(hash2(bx, by, seed + 25) * PEBBLES.length) % PEBBLES.length];
      const tone = 0.85 + 0.30 * hash2(bx, by, seed + 26);
      const sp = 0.90 + 0.20 * speckle[i];
      f.r[i] = lerp(0.10, pal[0] * tone, gap) * sp;
      f.g[i] = lerp(0.08, pal[1] * tone, gap) * sp;
      f.b[i] = lerp(0.055, pal[2] * tone, gap) * sp;
      f.h[i] = clamp01(0.06 + 0.88 * domeH + 0.03 * speckle[i]);
      f.rough[i] = lerp(0.92, 0.55 + 0.25 * hash2(bx, by, seed + 27), gap);
      f.ao[i] = 0.45 + 0.55 * smoothstep(0, 0.6, domeH);
    }
  }
  return f;
}

/* ------------------------------------------------- C: bedded karst limestone */

function generateLimestone(size, seed) {
  const f = blank(size);
  const warp = combine(size,
    [renderOctave(size, 4, seed + 31), 1],
    [renderOctave(size, 8, seed + 32), 0.5],
    [renderOctave(size, 16, seed + 33), 0.25]);
  const mottle = combine(size,
    [renderOctave(size, 6, seed + 34), 1],
    [renderOctave(size, 12, seed + 35), 0.5],
    [renderOctave(size, 24, seed + 36), 0.25],
    [renderOctave(size, 48, seed + 37), 0.125]);
  const lichM = renderOctave(size, 5, seed + 38);
  // Vertical fissures and calcite veins: ridged fields stretched along v.
  const frac3 = (u, v) => [(3 * u) % 1, v];
  const frac6 = (u, v) => [(6 * u + 0.37) % 1, v];
  const fiss = combine(size,
    [renderOctave(size, 8, seed + 39, frac3), 0.6],
    [renderOctave(size, 16, seed + 40, frac6), 0.4]);
  const vein = combine(size,
    [renderOctave(size, 6, seed + 41, frac3), 0.6],
    [renderOctave(size, 12, seed + 42, frac6), 0.4]);
  const NB = 12; // strata bands; divides any texture size we use
  const bandH = size / NB;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const yy = v * size + (warp[i] - 0.5) * 2 * size * 0.03;
      const by = yy / bandH;
      const band = ((Math.floor(by) % NB) + NB) % NB;
      const frac = by - Math.floor(by);
      const bandTone = 0.80 + 0.28 * hash2(band, 7, seed + 43);
      const dEdge = Math.min(frac, 1 - frac) * bandH;
      const joint = 1 - smoothstep(1.5, 6.5, dEdge);

      const m = mottle[i];
      let r = 0.43 * bandTone * (0.80 + 0.40 * m);
      let g = 0.43 * bandTone * (0.80 + 0.40 * m);
      let b = 0.41 * bandTone * (0.80 + 0.40 * m);
      let h = 0.52 + 0.30 * (m - 0.5);

      const ridge = 1 - Math.abs(fiss[i] * 2 - 1);
      const crack = smoothstep(0.935, 0.99, ridge);
      r = lerp(r, 0.10, crack * 0.8);
      g = lerp(g, 0.10, crack * 0.8);
      b = lerp(b, 0.095, crack * 0.8);
      h -= 0.45 * crack;

      const ridge2 = 1 - Math.abs(vein[i] * 2 - 1);
      const calcite = smoothstep(0.95, 0.992, ridge2) * (1 - crack);
      r = lerp(r, 0.62, calcite * 0.7);
      g = lerp(g, 0.60, calcite * 0.7);
      b = lerp(b, 0.55, calcite * 0.7);
      h += 0.05 * calcite;

      const lich = smoothstep(0.62, 0.74, lichM[i]);
      r = lerp(r, 0.28, lich * 0.45);
      g = lerp(g, 0.30, lich * 0.45);
      b = lerp(b, 0.19, lich * 0.45);

      const jd = 1 - 0.50 * joint;
      f.r[i] = r * jd; f.g[i] = g * jd; f.b[i] = b * jd;
      f.h[i] = clamp01(h - 0.30 * joint);
      f.rough[i] = clamp01(0.80 + 0.10 * (m - 0.5) * 2 + 0.05 * lich);
      f.ao[i] = clamp01(0.95 - 0.35 * joint - 0.45 * crack);
    }
  }
  return f;
}

/* ------------------------------------------------- D: blighted necrotic mire */

function generateSludge(size, seed) {
  const f = blank(size);
  const blotch = combine(size,
    [renderOctave(size, 5, seed + 51), 1],
    [renderOctave(size, 10, seed + 52), 0.5],
    [renderOctave(size, 20, seed + 53), 0.25]);
  const poolM = combine(size,
    [renderOctave(size, 7, seed + 54), 1],
    [renderOctave(size, 14, seed + 55), 0.5],
    [renderOctave(size, 28, seed + 56), 0.25]);
  const necrosisM = renderOctave(size, 9, seed + 57);
  const streak = combine(size,
    [renderOctaveR(size, 6, 40, seed + 58), 0.55],
    [renderOctaveR(size, 12, 90, seed + 59), 0.45]);
  for (let i = 0; i < size * size; i++) {
    const bl = blotch[i];
    let r = lerp(0.045, 0.15, smoothstep(0.45, 0.65, bl));
    let g = lerp(0.038, 0.09, smoothstep(0.45, 0.65, bl));
    let b = lerp(0.022, 0.030, smoothstep(0.45, 0.65, bl));

    const strand = smoothstep(0.60, 0.85, streak[i]) * smoothstep(0.4, 0.6, bl);
    r = lerp(r, 0.20, strand * 0.45);
    g = lerp(g, 0.18, strand * 0.45);
    b = lerp(b, 0.040, strand * 0.45);

    const necrosis = smoothstep(0.70, 0.82, necrosisM[i]);
    r = lerp(r, 0.018, necrosis * 0.85);
    g = lerp(g, 0.016, necrosis * 0.85);
    b = lerp(b, 0.013, necrosis * 0.85);

    const pool = smoothstep(0.58, 0.74, poolM[i]);
    r = lerp(r, 0.035, pool * 0.8);
    g = lerp(g, 0.033, pool * 0.8);
    b = lerp(b, 0.020, pool * 0.8);

    f.r[i] = r; f.g[i] = g; f.b[i] = b;
    f.h[i] = clamp01(0.30 + 0.25 * (bl - 0.5) * 2 + 0.10 * strand - 0.18 * pool);
    f.rough[i] = clamp01(0.55 - 0.43 * pool + 0.25 * necrosis + 0.10 * strand);
    f.ao[i] = 0.80 + 0.20 * clamp01(f.h[i] * 2);
  }
  return f;
}

/* ------------------------------------------------- E: riparian sedge turf */

function generateTurf(size, seed) {
  const f = blank(size);
  const soilM = renderOctave(size, 9, seed + 61);
  const blade = renderOctaveR(size, 150, 30, seed + 62);
  const bladeHue = renderOctaveR(size, 75, 15, seed + 63);
  const grain = renderOctave(size, 128, seed + 64);
  const C = 64; // gold-fleck cells
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const b = smoothstep(0.35, 0.65, blade[i]);
      const hue = bladeHue[i];
      let r = lerp(0.030, 0.11 + 0.05 * hue, b);
      let g = lerp(0.045, 0.145 + 0.025 * hue, b);
      let bl = lerp(0.014, 0.035, b);

      const soil = 1 - smoothstep(0.38, 0.52, soilM[i]);
      r = lerp(r, 0.07, soil);
      g = lerp(g, 0.048, soil);
      bl = lerp(bl, 0.028, soil);

      const cx = Math.floor(u * C), cy = Math.floor(v * C);
      if (hash2(cx, cy, seed + 65) < 0.05) {
        const jx = hash2(cx, cy, seed + 66), jy = hash2(cx, cy, seed + 67);
        if (Math.hypot(u * C - cx - jx, v * C - cy - jy) < 0.16) {
          r = lerp(r, 0.32, 0.7); g = lerp(g, 0.29, 0.7); bl = lerp(bl, 0.06, 0.7);
        }
      }

      const sp = 0.90 + 0.20 * grain[i];
      f.r[i] = r * sp; f.g[i] = g * sp; f.b[i] = bl * sp;
      f.h[i] = clamp01(0.15 + 0.65 * b * (1 - soil) + 0.05 * grain[i]);
      f.rough[i] = 0.93;
      f.ao[i] = 0.70 + 0.30 * clamp01(f.h[i]);
    }
  }
  return f;
}

/* ------------------------------------------------- micro-detail (near field) */

function generateDetail(size, seed) {
  const n = size * size;
  const grain = combine(size,
    [renderOctave(size, 48, seed + 71), 1],
    [renderOctave(size, 96, seed + 72), 0.6],
    [renderOctave(size, 192, seed + 73), 0.3]);
  const mh = combine(size,
    [renderOctave(size, 64, seed + 74), 1],
    [renderOctave(size, 128, seed + 75), 0.5]);
  const out = new Uint8Array(n * 4);
  for (let y = 0; y < size; y++) {
    const yu = ((y - 1 + size) % size) * size;
    const yd = ((y + 1) % size) * size;
    const yc = y * size;
    for (let x = 0; x < size; x++) {
      const i = yc + x;
      const hl = mh[yc + ((x - 1 + size) % size)];
      const hr = mh[yc + ((x + 1) % size)];
      const hu = mh[yu + x], hd = mh[yd + x];
      const nx = (hl - hr) * 2.2, nz = (hu - hd) * 2.2;
      out[i * 4] = Math.round(clamp01(0.5 + (grain[i] - 0.5) * 0.55) * 255);
      out[i * 4 + 1] = Math.round(clamp01(nx * 0.5 + 0.5) * 255);
      out[i * 4 + 2] = Math.round(clamp01(nz * 0.5 + 0.5) * 255);
      out[i * 4 + 3] = Math.round(clamp01(mh[i]) * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ API */

const GENERATORS = {
  loam: generateLoam,
  gravel: generateGravel,
  limestone: generateLimestone,
  sludge: generateSludge,
  turf: generateTurf,
};

/**
 * Raw pixel bytes for one material set at any (square) size. Pure: the same
 * inputs give the same bytes, on any platform with 32-bit imul.
 */
export function generateMaterialPixels(id, size = P1.textureSize) {
  const material = materialById[id];
  if (!material) throw new Error(`unknown P1 material: ${id}`);
  const fields = GENERATORS[id](size, material.seed);
  return finalize(size, fields, material.normalStrength);
}

/** Raw micro-detail bytes. R = grain, G/B = micro-normal xz, A = height. */
export function generateDetailPixels(size = P1.detailSize) {
  return generateDetail(size, 0xde7a11);
}

function toTexture(data, size, { srgb, anisotropy }) {
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The full library as GPU textures: five sets of albedo/normal/pack plus the
 * near-field micro-detail. Synchronous and deterministic; ~a second at 512 px
 * on a desktop core, faster after (the world builds it once).
 */
export function buildMaterialLibrary({ size = P1.textureSize, anisotropy = 8 } = {}) {
  const maps = {};
  for (const material of MATERIALS) {
    const px = generateMaterialPixels(material.id, size);
    maps[material.id] = {
      albedo: toTexture(px.albedo, size, { srgb: true, anisotropy }),
      normal: toTexture(px.normal, size, { srgb: false, anisotropy }),
      pack: toTexture(px.pack, size, { srgb: false, anisotropy }),
    };
  }
  return {
    maps,
    detail: toTexture(generateDetailPixels(size), size, { srgb: false, anisotropy: 4 }),
    size,
    anisotropy,
  };
}

export { MATERIALS };
