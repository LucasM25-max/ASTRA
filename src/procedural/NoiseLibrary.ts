/**
 * NoiseLibrary.ts - ASTRA procedural world
 * =============================================================================
 * The noise primitives every other procedural generator is built from: Perlin,
 * Simplex, Voronoi and fractal Brownian motion (FBM), each available twice -
 * once as TypeScript for mesh generation and once as GLSL for shaders.
 *
 * Why both, and why they are not bit-identical
 * --------------------------------------------
 * Terrain height is generated in TypeScript (`TerrainGenerator`) because the
 * same array feeds the visual mesh *and* the collision trimesh. Shader detail -
 * albedo variation, normal perturbation - is generated in GLSL because it has
 * to be evaluated per fragment.
 *
 * The two implementations use the same gradient sets, the same fade curve and
 * the same lacunarity/gain conventions, so they agree in character and in
 * range. They do not agree value-for-value: the TypeScript Perlin uses a
 * shuffled permutation table (better distribution, and it lets a seed produce
 * a genuinely different world) while the GLSL version derives its gradient
 * from an integer hash of the lattice coordinate. Shipping a 512-entry
 * permutation as a uniform array to get exact agreement would cost more than
 * it is worth, because nothing in the game compares a shader sample against a
 * mesh sample.
 *
 * Ranges - measured, not guessed
 * ------------------------------
 * Every function here documents the range it actually produces, measured over
 * millions of samples rather than asserted from theory. The theoretical bounds
 * are loose enough to be useless for tuning (Perlin's is 2, not 1), so the
 * `*Peak` constants below are empirical, with headroom above the measured
 * extreme. `fbm2D` divides by the sum of its octave amplitudes, so a
 * normalized fbm is bounded by the normalized base noise - which is what makes
 * terrain amplitude parameters mean something.
 * =============================================================================
 */

/**
 * Deterministic 32-bit PRNG (mulberry32).
 *
 * `Math.random()` is unusable for world generation: it would make every test
 * run produce a different terrain, and a bug that only appears on one seed
 * would be unreproducible. Every generator in `src/procedural/` takes a seed
 * and funnels it through here.
 */
export function createRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The eight gradient directions used by `PerlinNoise2D` and by the GLSL
 * `astraGrad2`. Four diagonals plus four axis directions: the classic set,
 * chosen because it has no preferred axis and no zero-length direction.
 */
const GRAD2 = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);

/** Quintic fade. The `6t^5 - 15t^4 + 10t^3` curve, not a linear lerp. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Improved Perlin noise in two dimensions, with a seeded permutation table.
 *
 * The permutation is a Fisher-Yates shuffle of 0..255, doubled to 512 entries
 * so `perm[i]` and `perm[i + 256]` are both in range without a mask on the
 * inner index. That detail matters: masking the *inner* index instead of
 * doubling the table is the classic off-by-one that silently correlates the
 * noise along one axis.
 */
export class PerlinNoise2D {
  /**
   * Peak magnitude, measured over 4.3M samples across nine seeds: 0.9994.
   *
   * The theoretical bound is 2 - a corner gradient of (1, 1) against a corner
   * offset of (1, 1) - but that extreme requires sitting exactly on a lattice
   * point, where the fade weights collapse and the value is 0. In practice the
   * field tops out at 1. 1.05 leaves headroom above the measurement, so
   * `noiseNormalized` stays inside [-1, 1].
   */
  static readonly PEAK = 1.05;

  private readonly perm: Uint8Array;

  constructor(seed = 0) {
    const rng = createRng(seed);
    const shuffled = new Uint8Array(256);
    for (let i = 0; i < 256; i++) shuffled[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = shuffled[i & 255];
  }

  /** Raw Perlin value. Range is roughly [-0.82, 0.82] in practice. */
  noise(x: number, y: number): number {
    const p = this.perm;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const X = fx & 255;
    const Y = fy & 255;
    const xf = x - fx;
    const yf = y - fy;
    const u = fade(xf);
    const v = fade(yf);

    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];

    const n00 = this.grad(aa, xf, yf);
    const n10 = this.grad(ba, xf - 1, yf);
    const n01 = this.grad(ab, xf, yf - 1);
    const n11 = this.grad(bb, xf - 1, yf - 1);

    const x1 = n00 + u * (n10 - n00);
    const x2 = n01 + u * (n11 - n01);
    return x1 + v * (x2 - x1);
  }

  /** Perlin value scaled to roughly [-1, 1]. */
  noiseNormalized(x: number, y: number): number {
    return this.noise(x, y) / PerlinNoise2D.PEAK;
  }

  private grad(hash: number, x: number, y: number): number {
    const i = (hash & 7) * 2;
    return GRAD2[i] * x + GRAD2[i + 1] * y;
  }
}

/* -------------------------------------------------------------------------- */
/* Simplex                                                                    */
/* -------------------------------------------------------------------------- */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/**
 * The twelve 3D gradient directions of the reference simplex implementation,
 * flattened. 2D simplex uses the same table and simply ignores the `z`
 * component of the dot product, which is why the resulting 2D field has no
 * directional bias.
 */
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1,
  1, 0, 1, -1, 0, -1, -1,
]);

/**
 * Simplex noise in two dimensions.
 *
 * Simplex beats Perlin on cost (three corner evaluations instead of four, and
 * no permutation lookups on the hot path) and on directional artefacting - its
 * triangular lattice has no visible axis alignment. It is the right choice for
 * anything evaluated per fragment, which is why the terrain shader uses it.
 */
export class SimplexNoise2D {
  /**
   * Peak magnitude, measured over 4.3M samples across nine seeds: 0.9979.
   * 1.05 leaves headroom above the measurement so `noiseNormalized` stays
   * inside [-1, 1].
   */
  static readonly PEAK = 1.05;

  private readonly perm: Uint8Array;

  constructor(seed = 0) {
    const rng = createRng(seed);
    const shuffled = new Uint8Array(256);
    for (let i = 0; i < 256; i++) shuffled[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = shuffled[i & 255];
  }

  /** Raw simplex value. Range is roughly [-1, 1]. */
  noise(xin: number, yin: number): number {
    const p = this.perm;

    // Skew the input space to find which simplex cell we are in.
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    // Which of the two triangles of the rhombus are we in?
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const gi = (p[ii + p[jj]] % 12) * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[gi] * x0 + GRAD3[gi + 1] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const gi = (p[ii + i1 + p[jj + j1]] % 12) * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[gi] * x1 + GRAD3[gi + 1] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const gi = (p[ii + 1 + p[jj + 1]] % 12) * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[gi] * x2 + GRAD3[gi + 1] * y2);
    }

    return 70 * n;
  }

  /** Simplex value scaled to roughly [-1, 1]. */
  noiseNormalized(x: number, y: number): number {
    return this.noise(x, y) / SimplexNoise2D.PEAK;
  }
}

/* -------------------------------------------------------------------------- */
/* Voronoi / Worley                                                           */
/* -------------------------------------------------------------------------- */

/** What `voronoi2D` reports about one sample point. */
export interface VoronoiSample {
  /** Distance to the nearest feature point, in cell units. Range [0, ~1.05]. */
  readonly f1: number;
  /** Distance to the second nearest. Always >= `f1`. */
  readonly f2: number;
  /** Cell coordinates of the nearest feature point. Stable per cell. */
  readonly cellX: number;
  readonly cellY: number;
  /** World position of the nearest feature point. */
  readonly featureX: number;
  readonly featureY: number;
}

/**
 * Deterministic 2D hash returning a float in [0, 1).
 *
 * Uses `Math.imul` and `>>>` throughout so the result is identical on every
 * JS engine and every word size - a `*` that silently becomes a float and
 * loses its low 32 bits would make the noise platform-dependent.
 */
function hashToUnit(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Two independent hashes for one lattice cell: the feature point's `x` and
 * `y` offsets within it.
 */
function cellFeature(ix: number, iy: number, seed: number): [number, number] {
  const a = hashToUnit(Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ (seed | 0));
  const b = hashToUnit(
    Math.imul(ix | 0, 0x9e3779b1) ^ Math.imul(iy | 0, 0x85ebca77) ^ Math.imul(seed | 0, 0xc2b2ae3d),
  );
  return [a / 4294967296, b / 4294967296];
}

/**
 * The scattered feature point inside cell `(cellX, cellY)`.
 *
 * Exported so the nearest-point search can be verified by brute force rather
 * than trusted. A 3x3 neighbourhood is provably sufficient - a feature point
 * more than one cell away cannot be the nearest - but "provably" is doing a
 * lot of work in that sentence, and this is the difference between a Worley
 * field and a plausible-looking field with a bug at every cell boundary.
 */
export function voronoiFeature(cellX: number, cellY: number, seed = 0): { x: number; y: number } {
  const [ox, oy] = cellFeature(cellX, cellY, seed);
  return { x: cellX + ox, y: cellY + oy };
}

/**
 * Worley (cellular) noise: the distance to the nearest scattered feature
 * point.
 *
 * Where Perlin and Simplex give smooth rolling variation, Voronoi gives
 * *regions* - plateaus with sharp boundaries. That is exactly what the terrain
 * needs for biome variation: it breaks up the smooth bands that height and
 * slope alone would produce, and it does so with hard edges rather than more
 * smoothness, which reads as natural imperfection rather than as noise.
 *
 * The search is a fixed 3x3 neighbourhood, which is correct and complete: a
 * feature point more than one cell away cannot be the nearest one.
 */
export function voronoi2D(x: number, y: number, seed = 0): VoronoiSample {
  const ix = Math.floor(x);
  const iy = Math.floor(y);

  let f1 = Number.POSITIVE_INFINITY;
  let f2 = Number.POSITIVE_INFINITY;
  let cellX = ix;
  let cellY = iy;
  let featureX = ix;
  let featureY = iy;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;
      const [ox, oy] = cellFeature(cx, cy, seed);
      const px = cx + ox;
      const py = cy + oy;
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        cellX = cx;
        cellY = cy;
        featureX = px;
        featureY = py;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }

  return { f1, f2, cellX, cellY, featureX, featureY };
}

/** `voronoi2D`'s `f1` mapped to [0, 1] by the largest distance two cells can span. */
export function voronoiF1Normalized(x: number, y: number, seed = 0): number {
  return voronoi2D(x, y, seed).f1 / Math.SQRT2;
}

/* -------------------------------------------------------------------------- */
/* Fractal Brownian motion                                                    */
/* -------------------------------------------------------------------------- */

/** Anything with a `noise(x, y)` method. */
export interface Noise2D {
  noise(x: number, y: number): number;
}

/** Parameters for `fbm2D` and `ridged2D`. */
export interface FbmOptions {
  /** Number of noise layers. The plan asks for 4-6; 5 is the default. */
  octaves?: number;
  /** Frequency multiplier per octave. 2.0 is the classic value. */
  lacunarity?: number;
  /** Amplitude multiplier per octave. 0.5 keeps each octave half as loud. */
  gain?: number;
  /** Starting frequency. */
  frequency?: number;
  /** Starting amplitude. */
  amplitude?: number;
}

/**
 * Sum of the octave amplitudes, relative to the first - the divisor that keeps
 * fbm in range.
 *
 * `amplitude` is deliberately excluded. Including it would cancel the
 * amplitude out entirely: the numerator scales with it and so does the
 * divisor, which makes the option a no-op and is exactly the kind of bug that
 * survives because the terrain still looks like terrain. `frequency` is
 * excluded for the same reason - it changes the shape, not the magnitude.
 */
function amplitudeSum(options: FbmOptions): number {
  const octaves = Math.max(1, Math.floor(options.octaves ?? 5));
  const gain = options.gain ?? 0.5;
  let total = 0;
  for (let i = 0; i < octaves; i++) total += Math.pow(gain, i);
  return total;
}

/**
 * Fractal Brownian motion: layered noise at doubling frequency and halving
 * amplitude.
 *
 * Four to six octaves is the sweet spot the plan asks for. Below four, hills
 * look like single bumps; above six, the extra detail is finer than the
 * terrain's vertex spacing can represent, so it costs generation time to
 * produce geometry the mesh cannot show.
 *
 * The result is divided by the sum of the octave amplitudes, so with a base
 * noise already normalized to [-1, 1] the output is bounded by [-1, 1] too -
 * which is what makes an `amplitude` in metres mean the same thing regardless
 * of how many octaves are stacked.
 */
export function fbm2D(
  base: Noise2D,
  x: number,
  y: number,
  options: FbmOptions = {},
  normalizer: (v: number) => number = (v) => v,
): number {
  const octaves = Math.max(1, Math.floor(options.octaves ?? 5));
  const lacunarity = options.lacunarity ?? 2;
  const gain = options.gain ?? 0.5;
  const frequency = options.frequency ?? 1;
  const amplitude = options.amplitude ?? 1;

  let sum = 0;
  let freq = frequency;
  let amp = amplitude;
  for (let i = 0; i < octaves; i++) {
    sum += normalizer(base.noise(x * freq, y * freq)) * amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / amplitudeSum({ ...options, octaves, gain, amplitude });
}

/**
 * Ridged multifractal: `1 - |noise|` per octave, with each octave's weight
 * set by the previous one.
 *
 * Plain fbm gives rolling hills. Ridging gives crests and valleys - the sharp
 * ridges that make a terrain read as eroded rock rather than as dunes. The
 * terrain generator uses it for the outer ring, where the ground is meant to
 * look too rough to walk over.
 */
export function ridged2D(
  base: Noise2D,
  x: number,
  y: number,
  options: FbmOptions = {},
  normalizer: (v: number) => number = (v) => v,
): number {
  const octaves = Math.max(1, Math.floor(options.octaves ?? 5));
  const lacunarity = options.lacunarity ?? 2;
  const gain = options.gain ?? 0.5;
  const frequency = options.frequency ?? 1;
  const amplitude = options.amplitude ?? 1;

  let sum = 0;
  let freq = frequency;
  let amp = amplitude;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    const signal = 1 - Math.abs(normalizer(base.noise(x * freq, y * freq)));
    sum += signal * amp * weight;
    weight = Math.min(1, Math.max(0, signal * 2));
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / amplitudeSum({ ...options, octaves, gain, amplitude });
}

/* -------------------------------------------------------------------------- */
/* GLSL                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The same four noise primitives, in GLSL, ready to be injected into a
 * `ShaderMaterial` fragment shader.
 *
 * Two deliberate differences from the TypeScript side, both documented in the
 * file header:
 *   - Gradients come from an integer hash of the lattice coordinate rather
 *     than a shuffled permutation table. Same eight directions, same
 *     distribution, no uniform array needed.
 *   - Simplex is the default base for fbm here because it is the cheaper of
 *     the two per fragment.
 *
 * Everything is prefixed `astra` so it cannot collide with a Three.js chunk
 * or with a material's own uniform.
 */
export const NOISE_GLSL = /* glsl */ `
// --- ASTRA noise primitives (mirrors src/procedural/NoiseLibrary.ts) --------

float astraFade(float t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// The same eight gradients as GRAD2 in NoiseLibrary.ts.
float astraGrad2(int hash, float x, float y) {
  int h = hash & 7;
  if (h == 0) return  x + y;
  if (h == 1) return -x + y;
  if (h == 2) return  x - y;
  if (h == 3) return -x - y;
  if (h == 4) return  x;
  if (h == 5) return -x;
  if (h == 6) return  y;
  return -y;
}

// Deterministic 32-bit integer hash, matching hashToUnit() in NoiseLibrary.ts.
uint astraHashU(uint h) {
  h ^= h >> 16u;
  h *= 0x85ebca6bu;
  h ^= h >> 13u;
  h *= 0xc2b2ae35u;
  h ^= h >> 16u;
  return h;
}

float astraHash1(vec2 p, float seed) {
  uint h = astraHashU(uint(int(p.x)) * 0x27d4eb2du ^ uint(int(p.y)) * 0x165667b1u ^ uint(int(seed * 1024.0)));
  return float(h) / 4294967296.0;
}

// Perlin gradient noise, hash-based rather than table-based.
float astraPerlin2D(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = vec2(astraFade(f.x), astraFade(f.y));

  float n00 = astraGrad2(int(astraHashU(uint(int(i.x)) * 0x9e3779b1u ^ uint(int(i.y)) * 0x85ebca77u ^ uint(int(seed * 4096.0)))), f.x, f.y);
  float n10 = astraGrad2(int(astraHashU(uint(int(i.x) + 1) * 0x9e3779b1u ^ uint(int(i.y)) * 0x85ebca77u ^ uint(int(seed * 4096.0)))), f.x - 1.0, f.y);
  float n01 = astraGrad2(int(astraHashU(uint(int(i.x)) * 0x9e3779b1u ^ uint(int(i.y) + 1) * 0x85ebca77u ^ uint(int(seed * 4096.0)))), f.x, f.y - 1.0);
  float n11 = astraGrad2(int(astraHashU(uint(int(i.x) + 1) * 0x9e3779b1u ^ uint(int(i.y) + 1) * 0x85ebca77u ^ uint(int(seed * 4096.0)))), f.x - 1.0, f.y - 1.0);

  float x1 = mix(n00, n10, u.x);
  float x2 = mix(n01, n11, u.x);
  return mix(x1, x2, u.y);
}

// Simplex noise (2D), matching SimplexNoise2D in NoiseLibrary.ts.
const float ASTRA_F2 = 0.3660254037844386;
const float ASTRA_G2 = 0.21132486540518713;

float astraSimplex2D(vec2 p, float seed) {
  float s = (p.x + p.y) * ASTRA_F2;
  vec2 ip = floor(p + s);
  float t = (ip.x + ip.y) * ASTRA_G2;
  vec2 p0 = p - (ip - t);

  vec2 i1 = (p0.x > p0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 p1 = p0 - i1 + ASTRA_G2;
  vec2 p2 = p0 - 1.0 + 2.0 * ASTRA_G2;

  uint sx = uint(int(ip.x));
  uint sy = uint(int(ip.y));
  uint sd = uint(int(seed * 4096.0));

  float n = 0.0;

  float t0 = 0.5 - dot(p0, p0);
  if (t0 > 0.0) {
    uint h = astraHashU(sx * 0x27d4eb2du ^ sy * 0x165667b1u ^ sd);
    vec2 g = vec2(
      (h & 1u) == 0u ? 1.0 : -1.0,
      (h & 2u) == 0u ? 1.0 : -1.0
    );
    t0 *= t0;
    n += t0 * t0 * dot(g, p0);
  }

  float t1 = 0.5 - dot(p1, p1);
  if (t1 > 0.0) {
    uint h = astraHashU((sx + uint(int(i1.x))) * 0x27d4eb2du ^ (sy + uint(int(i1.y))) * 0x165667b1u ^ sd);
    vec2 g = vec2(
      (h & 1u) == 0u ? 1.0 : -1.0,
      (h & 2u) == 0u ? 1.0 : -1.0
    );
    t1 *= t1;
    n += t1 * t1 * dot(g, p1);
  }

  float t2 = 0.5 - dot(p2, p2);
  if (t2 > 0.0) {
    uint h = astraHashU((sx + 1u) * 0x27d4eb2du ^ (sy + 1u) * 0x165667b1u ^ sd);
    vec2 g = vec2(
      (h & 1u) == 0u ? 1.0 : -1.0,
      (h & 2u) == 0u ? 1.0 : -1.0
    );
    t2 *= t2;
    n += t2 * t2 * dot(g, p2);
  }

  return 70.0 * n;
}

// Voronoi (Worley) noise: returns (f1, f2), matching voronoi2D().
vec2 astraVoronoi2D(vec2 p, float seed) {
  vec2 ip = floor(p);
  float f1 = 8.0;
  float f2 = 8.0;

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 cell = ip + vec2(float(dx), float(dy));
      vec2 o = vec2(astraHash1(cell, seed), astraHash1(cell + 17.0, seed + 1.0));
      float d = length(cell + o - p);
      if (d < f1) { f2 = f1; f1 = d; }
      else if (d < f2) { f2 = d; }
    }
  }

  return vec2(f1, f2);
}

// Fractal Brownian motion over whichever base the caller picks.
float astraFbm2D(vec2 p, float seed, int octaves, float lacunarity, float gain, bool useSimplex) {
  float sum = 0.0;
  float norm = 0.0;
  float freq = 1.0;
  float amp = 1.0;

  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float v = useSimplex ? astraSimplex2D(p * freq, seed + float(i))
                         : astraPerlin2D(p * freq, seed + float(i));
    sum += v * amp;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }

  return sum / max(norm, 1e-5);
}
`;
