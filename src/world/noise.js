/**
 * Deterministic value noise.
 *
 * The whole world is derived from functions like these rather than from painted
 * maps, and every one of them is seeded and pure: the same authored inputs must
 * always produce byte-identical geometry, which is what lets tools/check_world.mjs
 * hold the result to numbers.
 *
 * Value noise (rather than gradient noise) because it is trivially reproducible
 * across languages and platforms: no float ordering differences, no LUT.
 *
 * The tables are built once from a fixed xorshift sequence, so they are the same
 * on every platform -- and because the hot path is a couple of array reads rather
 * than a handful of multiplies, the height field can be asked a few million times
 * per build in seconds. That is not a micro-optimisation for its own sake: a check
 * that takes four minutes is a check that does not get run.
 */

const PERM = new Uint8Array(512);
const GRAD = new Float32Array(4096);
{
  let a = 0x1234abcd, b = 0x9e3779b9;
  const next = () => {
    a ^= a << 13; a |= 0; b ^= b >>> 9; b |= 0;
    const t = (a + b) | 0;
    return (t >>> 0) / 4294967296;
  };
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {                    // Fisher-Yates, seeded
    const j = (next() * (i + 1)) | 0;
    const t = base[i]; base[i] = base[j]; base[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = base[i & 255];
  for (let i = 0; i < 4096; i++) GRAD[i] = next() * 2 - 1;
}

/** A stable value in -1..1 for a lattice point and a seed. */
function lattice(ix, iy, seed) {
  const u = (ix + 512) & 255, v = (iy + 512) & 255;
  return GRAD[(PERM[(PERM[u] + v) & 255] * 16 + (seed & 15)) & 4095];
}

function lattice3(ix, iy, iz, seed) {
  const u = (ix + 512) & 255, v = (iy + 512) & 255, w = (iz + 512) & 255;
  const h = PERM[(PERM[(PERM[u] + v) & 255] + w) & 255];
  return GRAD[(h * 16 + (seed & 15)) & 4095];
}

/** Smoothstep -- the only interpolant used here, so the field is C1. */
function fade(t) {
  return t * t * (3 - 2 * t);
}

/** 2D value noise on a unit lattice, -1 .. 1. */
export function noise2(x, y, seed = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const a = lattice(x0, y0, seed), b = lattice(x0 + 1, y0, seed);
  const c = lattice(x0, y0 + 1, seed), d = lattice(x0 + 1, y0 + 1, seed);
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** 3D value noise on a unit lattice, -1 .. 1. Used for rock and mound lumps. */
export function noise3(x, y, z, seed = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = fade(x - x0), fy = fade(y - y0), fz = fade(z - z0);
  let out = 0;
  for (let dz = 0; dz < 2; dz++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        out += w * lattice3(x0 + dx, y0 + dy, z0 + dz, seed);
      }
    }
  }
  return out;
}

/**
 * Fractal Brownian motion: octave sums of noise, each doubling of frequency
 * halving the amplitude. Real terrain relief sits near this spectrum, which is
 * why it reads as ground rather than as a texture.
 */
export function fbm2(x, y, { octaves = 4, lacunarity = 2.0, gain = 0.5, seed = 0 } = {}) {
  let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(fx, fy, seed + o * 101);
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / norm;                            // -1 .. 1
}

/**
 * A reproducible uniform stream of numbers. xorshift32: tiny, no dependencies,
 * and identical everywhere, which matters because the authored scatter has to be
 * re-derivable by the checker from the seed alone.
 */
export function makeRandom(seed = 1) {
  let s = (seed | 0) || 0x9e3779b9;
  return function next() {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return (s >>> 0) / 4294967296;
  };
}

/** A stable pair of offsets for a lattice cell: jitter that never moves. */
export function cellJitter(ix, iy, seed) {
  return [lattice(ix, iy, seed) * 0.5, lattice(ix + 97, iy - 31, seed) * 0.5];
}
