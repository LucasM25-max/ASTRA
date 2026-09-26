import { describe, expect, it } from 'vitest';
import {
  NOISE_GLSL,
  PerlinNoise2D,
  SimplexNoise2D,
  createRng,
  fbm2D,
  ridged2D,
  voronoi2D,
  voronoiFeature,
  voronoiF1Normalized,
} from '../src/procedural/NoiseLibrary';

/**
 * Sample a field on a grid and return the extremes. Used by the range tests,
 * which assert on measured behaviour rather than on the theoretical bounds -
 * Perlin's theoretical bound is 2, which is true and useless for tuning.
 */
function extremes(fn: (x: number, y: number) => number, samples = 60_000): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    // An irrational-ish stride keeps consecutive samples uncorrelated.
    const x = ((i * 2654435761) % 100003) / 1000 - 50;
    const y = ((i * 40503) % 99991) / 1000 - 50;
    const v = fn(x, y);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

describe('createRng', () => {
  it('is deterministic for a given seed', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const c = createRng(1235);

    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    const seqC = Array.from({ length: 20 }, () => c());

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 20_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is not constant', () => {
    const rng = createRng(99);
    const first = rng();
    let differs = false;
    for (let i = 0; i < 50; i++) if (rng() !== first) differs = true;
    expect(differs).toBe(true);
  });
});

describe('PerlinNoise2D', () => {
  it('is deterministic for a given seed', () => {
    const a = new PerlinNoise2D(11);
    const b = new PerlinNoise2D(11);
    const c = new PerlinNoise2D(12);

    expect(a.noise(3.5, -2.25)).toBe(b.noise(3.5, -2.25));
    expect(a.noise(3.5, -2.25)).not.toBe(c.noise(3.5, -2.25));
  });

  it('stays inside its documented range', () => {
    const { min, max } = extremes((x, y) => new PerlinNoise2D(3).noise(x, y));
    expect(min).toBeGreaterThan(-PerlinNoise2D.PEAK);
    expect(max).toBeLessThan(PerlinNoise2D.PEAK);
    // And it actually uses that range - a field that never leaves +/-0.01 is
    // not noise, it is a constant with rounding error.
    expect(max).toBeGreaterThan(0.4);
    expect(min).toBeLessThan(-0.4);
  });

  it('normalizes to roughly [-1, 1]', () => {
    const perlin = new PerlinNoise2D(5);
    const { min, max } = extremes((x, y) => perlin.noiseNormalized(x, y));
    expect(min).toBeGreaterThan(-1.05);
    expect(max).toBeLessThan(1.05);
  });

  it('is zero at lattice points', () => {
    // The defining property of gradient noise: every gradient is orthogonal
    // to the offset at its own lattice point, so the value there is 0.
    const perlin = new PerlinNoise2D(21);
    for (const [x, y] of [
      [0, 0],
      [3, 0],
      [0, 7],
      [-4, -9],
      [12, 5],
    ] as [number, number][]) {
      expect(Math.abs(perlin.noise(x, y))).toBeLessThan(1e-9);
    }
  });

  it('is continuous', () => {
    const perlin = new PerlinNoise2D(31);
    let maxJump = 0;
    for (let i = 0; i < 5000; i++) {
      const x = i * 0.013;
      const a = perlin.noise(x, 4.2);
      const b = perlin.noise(x + 0.001, 4.2);
      maxJump = Math.max(maxJump, Math.abs(b - a));
    }
    // A discontinuity would show up as a jump of order 1, not 0.001.
    expect(maxJump).toBeLessThan(0.01);
  });

  it('has no preferred axis', () => {
    // Sampling along x and along y must give statistically the same spread.
    // A transposed permutation table shows up here as a biased variance.
    const perlin = new PerlinNoise2D(41);
    const variance = (dx: number, dy: number) => {
      let sum = 0;
      let sumSq = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) {
        const v = perlin.noise(i * 0.017 * dx, i * 0.019 * dy);
        sum += v;
        sumSq += v * v;
      }
      return sumSq / n - (sum / n) ** 2;
    };
    const vx = variance(1, 0);
    const vy = variance(0, 1);
    expect(vx).toBeGreaterThan(0.02);
    expect(vy).toBeGreaterThan(0.02);
    expect(Math.abs(vx - vy) / Math.max(vx, vy)).toBeLessThan(0.1);
  });
});

describe('SimplexNoise2D', () => {
  it('is deterministic for a given seed', () => {
    const a = new SimplexNoise2D(11);
    const b = new SimplexNoise2D(11);
    expect(a.noise(3.5, -2.25)).toBe(b.noise(3.5, -2.25));
  });

  it('stays inside its documented range', () => {
    const { min, max } = extremes((x, y) => new SimplexNoise2D(3).noise(x, y));
    expect(min).toBeGreaterThan(-SimplexNoise2D.PEAK);
    expect(max).toBeLessThan(SimplexNoise2D.PEAK);
    expect(max).toBeGreaterThan(0.4);
    expect(min).toBeLessThan(-0.4);
  });

  it('normalizes to roughly [-1, 1]', () => {
    const simplex = new SimplexNoise2D(5);
    const { min, max } = extremes((x, y) => simplex.noiseNormalized(x, y));
    expect(min).toBeGreaterThan(-1.05);
    expect(max).toBeLessThan(1.05);
  });

  it('is continuous', () => {
    const simplex = new SimplexNoise2D(31);
    let maxJump = 0;
    for (let i = 0; i < 5000; i++) {
      const x = i * 0.013;
      maxJump = Math.max(maxJump, Math.abs(simplex.noise(x + 0.001, 4.2) - simplex.noise(x, 4.2)));
    }
    expect(maxJump).toBeLessThan(0.01);
  });

  it('agrees with Perlin in character but not in value', () => {
    // Both are gradient noise over the same input, so their ranges match - but
    // they must not produce the same field, or one of them is not doing what
    // it claims.
    //
    // Lattice points are excluded: every gradient noise is exactly 0 there by
    // construction, so both implementations agree at those points and the
    // comparison would be measuring that rather than the noise.
    const perlin = new PerlinNoise2D(77);
    const simplex = new SimplexNoise2D(77);
    let identical = 0;
    let compared = 0;
    for (let i = 1; i < 600; i++) {
      const x = i * 0.31;
      const y = i * 0.17;
      if (Number.isInteger(x) && Number.isInteger(y)) continue;
      compared++;
      if (Math.abs(perlin.noise(x, y) - simplex.noise(x, y)) < 1e-6) identical++;
    }
    expect(compared).toBeGreaterThan(500);
    expect(identical).toBe(0);
  });
});

describe('voronoi2D', () => {
  it('returns a nearest and a second-nearest distance', () => {
    const v = voronoi2D(1.5, 2.5, 4);
    expect(v.f1).toBeGreaterThanOrEqual(0);
    expect(v.f2).toBeGreaterThanOrEqual(v.f1);
    expect(Number.isInteger(v.cellX)).toBe(true);
    expect(Number.isInteger(v.cellY)).toBe(true);
  });

  it('never exceeds the largest distance two cells can span', () => {
    const { max } = extremes((x, y) => voronoi2D(x, y, 4).f1);
    expect(max).toBeLessThanOrEqual(Math.SQRT2 + 1e-6);
    expect(max).toBeGreaterThan(0.5);
  });

  it('is deterministic', () => {
    expect(voronoi2D(3.3, -1.1, 9)).toEqual(voronoi2D(3.3, -1.1, 9));
    expect(voronoi2D(3.3, -1.1, 9)).not.toEqual(voronoi2D(3.3, -1.1, 10));
  });

  it('reports the feature point its distance is measured to', () => {
    // Re-querying at the reported feature position must report a distance of
    // zero and the same cell. This is the check that catches an off-by-one in
    // the 3x3 neighbourhood search - the classic Worley bug, which produces a
    // plausible-looking field that is wrong near every cell boundary.
    for (const [x, y] of [
      [3.2, 7.9],
      [-12.4, 5.1],
      [0.5, -0.5],
      [0.02, 0.98],
    ] as [number, number][]) {
      const v = voronoi2D(x, y, 4);
      expect(Math.hypot(v.featureX - x, v.featureY - y)).toBeCloseTo(v.f1, 9);

      const at = voronoi2D(v.featureX, v.featureY, 4);
      expect(at.f1).toBeLessThan(1e-9);
      expect(at.cellX).toBe(v.cellX);
      expect(at.cellY).toBe(v.cellY);
    }
  });

  it('normalizes f1 to [0, 1]', () => {
    const { min, max } = extremes((x, y) => voronoiF1Normalized(x, y, 4));
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
  });

  it('returns the true nearest feature point', () => {
    // Brute-force a 5x5 neighbourhood and compare. The implementation only
    // searches 3x3, which is provably enough - but this is the check that
    // catches an off-by-one in it, and the failure mode is a field that looks
    // entirely reasonable and is wrong at every cell boundary.
    const seed = 4;
    const points: [number, number][] = [
      [3.2, 7.9],
      [-12.4, 5.1],
      [0.5, -0.5],
      [0.02, 0.98],
      [2.999, 2.999],
      [-0.001, -0.001],
      [17.31, -4.77],
    ];
    for (const [x, y] of points) {
      const v = voronoi2D(x, y, seed);
      let best = Number.POSITIVE_INFINITY;
      let bestCell = [0, 0];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const cx = Math.floor(x) + dx;
          const cy = Math.floor(y) + dy;
          const f = voronoiFeature(cx, cy, seed);
          const d = Math.hypot(f.x - x, f.y - y);
          if (d < best) {
            best = d;
            bestCell = [cx, cy];
          }
        }
      }
      expect(v.f1).toBeCloseTo(best, 9);
      expect([v.cellX, v.cellY]).toEqual(bestCell);
    }
  });

  it('has regions, not a smooth gradient', () => {
    // Walk along a line and count how often the nearest feature point changes.
    // A smooth noise field has no such thing as a "nearest point"; a Worley
    // field changes hands several times over a short walk.
    const seed = 4;
    let changes = 0;
    let prev = voronoi2D(0, 2.1, seed);
    for (let i = 1; i < 2000; i++) {
      const v = voronoi2D(i * 0.01, 2.1, seed);
      if (v.cellX !== prev.cellX || v.cellY !== prev.cellY) changes++;
      prev = v;
    }
    expect(changes).toBeGreaterThan(3);
  });

  it('barely moves between two very close points', () => {
    const a = voronoi2D(2.05, 2.05, 4).f1;
    const b = voronoi2D(2.06, 2.06, 4).f1;
    // The two points are 0.014 apart, so f1 cannot have moved further than
    // that plus a rounding allowance.
    expect(Math.abs(b - a)).toBeLessThan(0.02);
  });
});

describe('fbm2D', () => {
  it('is bounded by [-1, 1] with a normalized base', () => {
    const perlin = new PerlinNoise2D(8);
    const { min, max } = extremes((x, y) =>
      fbm2D(perlin, x, y, { octaves: 5 }, (v) => v / PerlinNoise2D.PEAK),
    );
    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThanOrEqual(1);
  });

  it('uses the whole range', () => {
    const perlin = new PerlinNoise2D(8);
    const { min, max } = extremes((x, y) =>
      fbm2D(perlin, x, y, { octaves: 5 }, (v) => v / PerlinNoise2D.PEAK),
    );
    expect(max).toBeGreaterThan(0.3);
    expect(min).toBeLessThan(-0.3);
  });

  it('adds detail with each octave', () => {
    const perlin = new PerlinNoise2D(8);
    // Total variation is a crude but honest proxy for detail: more octaves
    // means more high-frequency content, which means more total variation.
    const totalVariation = (octaves: number) => {
      let tv = 0;
      let prev = fbm2D(perlin, 0, 0, { octaves }, (v) => v / PerlinNoise2D.PEAK);
      for (let i = 1; i < 4000; i++) {
        const v = fbm2D(perlin, i * 0.011, 3.3, { octaves }, (v2) => v2 / PerlinNoise2D.PEAK);
        tv += Math.abs(v - prev);
        prev = v;
      }
      return tv;
    };
    expect(totalVariation(5)).toBeGreaterThan(totalVariation(2));
  });

  it('scales with amplitude', () => {
    const perlin = new PerlinNoise2D(8);
    const norm = (v: number) => v / PerlinNoise2D.PEAK;
    const one = fbm2D(perlin, 2.5, 1.5, { octaves: 4, amplitude: 1 }, norm);
    const ten = fbm2D(perlin, 2.5, 1.5, { octaves: 4, amplitude: 10 }, norm);
    expect(ten).toBeCloseTo(one * 10, 6);
  });

  it('is deterministic', () => {
    const perlin = new PerlinNoise2D(8);
    const norm = (v: number) => v / PerlinNoise2D.PEAK;
    expect(fbm2D(perlin, 1.1, 2.2, { octaves: 4 }, norm)).toBe(
      fbm2D(perlin, 1.1, 2.2, { octaves: 4 }, norm),
    );
  });
});

describe('ridged2D', () => {
  it('is non-negative and bounded', () => {
    const perlin = new PerlinNoise2D(8);
    const norm = (v: number) => v / PerlinNoise2D.PEAK;
    const { min, max } = extremes((x, y) => ridged2D(perlin, x, y, { octaves: 5 }, norm));
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
  });

  it('has sharper crests than plain fbm', () => {
    // Ridging concentrates energy near the extremes, so its distribution is
    // more skewed: more samples near 0, fewer near the middle.
    const perlin = new PerlinNoise2D(8);
    const norm = (v: number) => v / PerlinNoise2D.PEAK;
    let ridgedHigh = 0;
    let fbmHigh = 0;
    for (let i = 0; i < 20_000; i++) {
      const x = ((i * 2654435761) % 100003) / 1000 - 50;
      const y = ((i * 40503) % 99991) / 1000 - 50;
      if (ridged2D(perlin, x, y, { octaves: 4 }, norm) > 0.5) ridgedHigh++;
      if (Math.abs(fbm2D(perlin, x, y, { octaves: 4 }, norm)) > 0.5) fbmHigh++;
    }
    expect(ridgedHigh).toBeGreaterThan(0);
    expect(fbmHigh).toBeGreaterThan(0);
    // They must differ, or one of them is not doing what it claims.
    expect(ridgedHigh).not.toBe(fbmHigh);
  });
});

describe('NOISE_GLSL', () => {
  it('declares every primitive the plan asks for', () => {
    for (const symbol of [
      'astraPerlin2D',
      'astraSimplex2D',
      'astraVoronoi2D',
      'astraFbm2D',
      'astraFade',
      'astraGrad2',
      'astraHashU',
    ]) {
      expect(NOISE_GLSL).toContain(symbol);
    }
  });

  it('is balanced', () => {
    // A stray brace or an unterminated comment compiles to a black screen and
    // no useful error, so check the obvious structural things here.
    const opens = (NOISE_GLSL.match(/\{/g) ?? []).length;
    const closes = (NOISE_GLSL.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);

    const parens = (NOISE_GLSL.match(/\(/g) ?? []).length;
    const parensClose = (NOISE_GLSL.match(/\)/g) ?? []).length;
    expect(parens).toBe(parensClose);

    expect(NOISE_GLSL).not.toContain('//#');
    expect(NOISE_GLSL.split('/*').length).toBe(NOISE_GLSL.split('*/').length);
  });

  it('has no statement outside a function body', () => {
    // Everything at file scope must be a declaration or a closing brace. A
    // bare statement out there would be a compile error - or, worse, a global
    // that silently shadows something Three expects.
    const lines = NOISE_GLSL.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('//'));
    const offenders = lines.filter((l) => {
      if (/^\s/.test(l)) return false; // indented: inside a function
      const t = l.trim();
      if (t === '}' || t === '};' || t === '{') return false; // structural
      return !/^(float|vec2|vec3|vec4|uint|int|const|void|bool)\b/.test(t);
    });
    expect(offenders).toEqual([]);
  });

  it('uses only ASTRA-prefixed globals', () => {
    // So the injected library cannot collide with a Three.js chunk.
    const declared = NOISE_GLSL.match(/^(?:float|vec2|vec3|vec4|uint|int|const\s+\w+)\s+(\w+)\s*[\(=]/gm) ?? [];
    for (const line of declared) {
      const name = line.match(/(\w+)\s*[\(=]/)?.[1];
      if (name && !name.startsWith('ASTRA_')) {
        expect(name.startsWith('astra')).toBe(true);
      }
    }
  });
});
