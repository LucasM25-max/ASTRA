import { describe, it, expect } from 'vitest';
import { StreamSpline } from '../src/procedural/StreamSpline';
import { StreamProfile, DEFAULT_POLLUTION_UPSTREAM, DEFAULT_POLLUTION_MIDSTREAM, DEFAULT_POLLUTION_DOWNSTREAM } from '../src/procedural/StreamGenerator';
import {
  CorruptionField,
  corruptionIntensity,
  corruptionStage,
  pollutionAlongStream,
  CORRUPTION_STAGES,
  DEFAULT_CORRUPTION_FIELD_OPTIONS,
  DEFAULT_CORRUPTION_FIELD_BUILD,
  DEFAULT_POLLUTION_ZONES,
  type CorruptionStage,
} from '../src/procedural/CorruptionField';

describe('pollutionAlongStream', () => {
  it('reproduces the three zones the plan names', () => {
    // The stream already owns this curve, in `StreamProfile`. Reproducing it
    // here is what lets the terrain, the trees and the fungus all agree with
    // the colour of the water they are standing next to.
    const profile = new StreamProfile(new StreamSpline(), { seed: 0 });
    const length = profile.spline.length;
    for (let i = 0; i <= 40; i++) {
      const distance = (i / 40) * length;
      expect(pollutionAlongStream(
        distance / length,
        DEFAULT_POLLUTION_ZONES.upstream,
        DEFAULT_POLLUTION_ZONES.midstream,
        DEFAULT_POLLUTION_ZONES.downstream,
      )).toBeCloseTo(profile.pollutionAtDistance(distance), 12);
    }
  });

  it('is 0.9 at the cave, 0.6 midstream and 0.2 at the village', () => {
    const at = (t: number): number =>
      pollutionAlongStream(t, DEFAULT_POLLUTION_ZONES.upstream, DEFAULT_POLLUTION_ZONES.midstream, DEFAULT_POLLUTION_ZONES.downstream);
    expect(at(0)).toBeCloseTo(DEFAULT_POLLUTION_UPSTREAM, 12);
    expect(at(0.5)).toBeCloseTo(DEFAULT_POLLUTION_MIDSTREAM, 12);
    expect(at(1)).toBeCloseTo(DEFAULT_POLLUTION_DOWNSTREAM, 12);
  });

  it('joins its zones without a kink', () => {
    // Smoothstep has zero derivative at both ends, so the rate of change is
    // continuous across the mid-stream join. A linear interpolation would put
    // a corner in the middle of the stream where the gradient suddenly
    // changes rate.
    const at = (t: number): number =>
      pollutionAlongStream(t, DEFAULT_POLLUTION_ZONES.upstream, DEFAULT_POLLUTION_ZONES.midstream, DEFAULT_POLLUTION_ZONES.downstream);
    const h = 1e-6;
    const before = (at(0.5 - h) - at(0.5 - 2 * h)) / h;
    const after = (at(0.5 + h) - at(0.5)) / h;
    expect(Math.abs(before - after)).toBeLessThan(1e-3);
  });

  it('clamps outside [0, 1] rather than extrapolating', () => {
    const at = (t: number): number =>
      pollutionAlongStream(t, DEFAULT_POLLUTION_ZONES.upstream, DEFAULT_POLLUTION_ZONES.midstream, DEFAULT_POLLUTION_ZONES.downstream);
    expect(at(-5)).toBeCloseTo(DEFAULT_POLLUTION_UPSTREAM, 12);
    expect(at(5)).toBeCloseTo(DEFAULT_POLLUTION_DOWNSTREAM, 12);
  });
});

describe('corruptionIntensity', () => {
  it('is zero in clean water', () => {
    expect(corruptionIntensity(0, 0)).toBe(0);
    // A clean stream still shows nothing at its own centre, which is the whole
    // point: the expression collapses rather than leaving a bare bank.
    expect(corruptionIntensity(0, 0, { reachMin: 100, reachMax: 100 })).toBe(0);
  });

  it('is strongest in the water and nothing beyond the reach', () => {
    const near = corruptionIntensity(0, DEFAULT_POLLUTION_ZONES.upstream);
    const bank = corruptionIntensity(5, DEFAULT_POLLUTION_ZONES.upstream);
    const far = corruptionIntensity(40, DEFAULT_POLLUTION_ZONES.upstream);
    expect(near).toBeGreaterThan(bank);
    expect(bank).toBeGreaterThan(far);
    expect(far).toBe(0);
  });

  it('widens its reach with the pollution', () => {
    // The cave end is not only more rotten, it is rotten over a larger area,
    // because there is more of the stuff to spread. A fixed reach would put a
    // hard-edged ring of identical stage-1 blight around the entire stream.
    const reachFor = (pollution: number): number => {
      const o = DEFAULT_CORRUPTION_FIELD_OPTIONS;
      const expected = o.reachMin + (o.reachMax - o.reachMin) * pollution;
      // Binary search the falloff for the last distance that is non-zero.
      let lo = 0;
      let hi = 200;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (corruptionIntensity(mid, pollution) > 0) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    expect(reachFor(DEFAULT_POLLUTION_ZONES.downstream)).toBeLessThan(
      reachFor(DEFAULT_POLLUTION_ZONES.upstream),
    );
    // And the measured reach matches the formula, to within the search's
    // resolution. `reachMax` is the reach at pollution 1, and the cave end is
    // 0.9, so its reach is 31.8 m rather than 34.
    const o = DEFAULT_CORRUPTION_FIELD_OPTIONS;
    const expected = o.reachMin + (o.reachMax - o.reachMin) * DEFAULT_POLLUTION_ZONES.upstream;
    expect(reachFor(DEFAULT_POLLUTION_ZONES.upstream)).toBeCloseTo(expected, 1);
    expect(expected).toBeLessThan(o.reachMax);
  });

  it('is convex in the pollution, so mild pollution stays mild', () => {
    const o = DEFAULT_CORRUPTION_FIELD_OPTIONS;
    const mild = corruptionIntensity(0, DEFAULT_POLLUTION_ZONES.downstream);
    const severe = corruptionIntensity(0, DEFAULT_POLLUTION_ZONES.upstream);
    // 0.2^0.75 is 0.30, not 0.2, and 0.9^0.75 is 0.92, not 0.9. What matters
    // is that the RATIO widens: the village end is lifted just enough to be
    // visible, and the cave end is left near its own value, so the two ends do
    // not converge on the same look.
    expect(mild / severe).toBeGreaterThan(
      DEFAULT_POLLUTION_ZONES.downstream / DEFAULT_POLLUTION_ZONES.upstream,
    );
    expect(Math.pow(DEFAULT_POLLUTION_ZONES.downstream, o.pollutionPower)).toBeCloseTo(0.3, 2);
    expect(Math.pow(DEFAULT_POLLUTION_ZONES.upstream, o.pollutionPower)).toBeCloseTo(0.92, 2);
    // Monotonic in the pollution, so more rotten water is never less corrupt.
    let previous = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const v = corruptionIntensity(0, p);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });

  it('stays inside [0, 1] for every input', () => {
    for (let p = 0; p <= 1.0001; p += 0.05) {
      for (let d = 0; d <= 60; d += 1.5) {
        const v = corruptionIntensity(d, p);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns zero for nonsense input rather than NaN', () => {
    expect(corruptionIntensity(-1, 0.9)).toBe(0);
    expect(corruptionIntensity(Number.NaN, 0.9)).toBe(0);
    expect(corruptionIntensity(0, Number.NaN)).toBe(0);
    expect(corruptionIntensity(0, -0.5)).toBe(0);
  });
});

describe('corruptionStage', () => {
  it('maps the plan three zones onto four bands', () => {
    // Stage 0 is clean. Stage 1 is the outer/downstream zone, stage 2 the
    // middle, stage 3 the inner zone near the cave.
    const o = DEFAULT_CORRUPTION_FIELD_OPTIONS;
    expect(corruptionStage(0)).toBe(0);
    expect(corruptionStage(o.stage1Start - 1e-6)).toBe(0);
    expect(corruptionStage(o.stage1Start)).toBe(1);
    expect(corruptionStage(o.stage2Start)).toBe(2);
    expect(corruptionStage(o.stage3Start)).toBe(3);
    expect(corruptionStage(1)).toBe(3);
  });

  it('orders its thresholds so each stage is harder to reach than the last', () => {
    // Subtle, visible, severe. Stage 1 has to be reachable or the corruption
    // would never appear at all; stage 3 has to be hard to reach or the whole
    // inner zone would look the same as the outer one.
    const o = DEFAULT_CORRUPTION_FIELD_OPTIONS;
    expect(o.stage1Start).toBeLessThan(o.stage2Start);
    expect(o.stage2Start).toBeLessThan(o.stage3Start);
    expect(o.stage3Start).toBeLessThan(1);
  });

  it('puts the three stream zones in ascending stages', () => {
    // Measured against the real curve rather than asserted by hand: the
    // village end must be stage 1, the middle stage 2, and the cave stage 3.
    const stages = new Set<CorruptionStage>();
    for (const zone of [
      DEFAULT_POLLUTION_ZONES.downstream,
      DEFAULT_POLLUTION_ZONES.midstream,
      DEFAULT_POLLUTION_ZONES.upstream,
    ]) {
      const inWater = corruptionIntensity(0, zone);
      const onBank = corruptionIntensity(6, zone);
      stages.add(corruptionStage(inWater));
      expect(corruptionStage(onBank)).toBeLessThanOrEqual(corruptionStage(inWater));
    }
    expect(stages.has(1)).toBe(true);
    expect(stages.has(2)).toBe(true);
    expect(stages.has(3)).toBe(true);
    // And they ascend with the pollution, not merely differ.
    const at = (zone: number): number => corruptionStage(corruptionIntensity(0, zone));
    expect(at(DEFAULT_POLLUTION_ZONES.downstream)).toBeLessThan(
      at(DEFAULT_POLLUTION_ZONES.midstream),
    );
    expect(at(DEFAULT_POLLUTION_ZONES.midstream)).toBeLessThan(
      at(DEFAULT_POLLUTION_ZONES.upstream),
    );
  });

  it('exposes the four stages for iteration', () => {
    expect(CORRUPTION_STAGES).toEqual([0, 1, 2, 3]);
  });
});

describe('CorruptionField', () => {
  const spline = new StreamSpline({ seed: 7 });
  const field = new CorruptionField(spline, { size: 500 });

  it('agrees with the stream profile on the water', () => {
    // The same spline, the same three zones, the same curve: the corruption
    // field must not disagree with the water it is measuring.
    const profile = new StreamProfile(spline, { seed: 7 });
    for (let i = 0; i <= 20; i++) {
      const distance = (i / 20) * spline.length;
      const p = spline.pointAtDistance(distance);
      expect(field.pollutionAt(p.x, p.z)).toBeCloseTo(
        profile.pollutionAtDistance(distance),
        // The field is a 256-lattice over 500 m, so about two metres. The
        // pollution curve is smooth, so a two-metre error in position is a
        // small error in value.
        1,
      );
    }
  });

  it('is zero a long way from the stream', () => {
    // Beyond the field's influence the corruption is zero, which is what keeps
    // the village end of the stream from poisoning the far bank.
    let found = false;
    for (let x = -240; x <= 240 && !found; x += 20) {
      for (let z = -240; z <= 240 && !found; z += 20) {
        if (field.corruptionAt(x, z) > 0) found = true;
      }
    }
    expect(found).toBe(true);
    // A corner of the map is far from any part of the stream.
    expect(field.corruptionAt(240, 240)).toBe(0);
  });

  it('composes the distance and pollution fields exactly', () => {
    // The field is `corruptionIntensity(distance, pollution)` and nothing
    // else. Asserting the composition is what catches a field that silently
    // re-derives one of its inputs and drifts from the curve the terrain and
    // the trees are using.
    for (let x = -180; x <= 180; x += 17) {
      for (let z = -180; z <= 180; z += 17) {
        const expected = corruptionIntensity(field.distanceAt(x, z), field.pollutionAt(x, z));
        expect(field.corruptionAt(x, z)).toBeCloseTo(expected, 12);
      }
    }
  });

  it('leaves clean ground the overwhelming majority, and severe ground the rarest', () => {
    // The property the "subtle, visible, severe" rule actually asks for. Note
    // what is NOT asserted: that stage 1 covers more ground than stage 2. It
    // does not, and it should not - the mid-stream zone carries a wider reach
    // than the village end, because there is more of the stuff to spread. What
    // has to hold is that clean ground dominates and that stage 3 is the
    // rarest thing in the world.
    const area = new Map<CorruptionStage, number>();
    for (const stage of CORRUPTION_STAGES) area.set(stage, 0);
    let total = 0;
    for (let x = -200; x <= 200; x += 4) {
      for (let z = -200; z <= 200; z += 4) {
        area.set(field.stageAt(x, z), (area.get(field.stageAt(x, z)) ?? 0) + 1);
        total++;
      }
    }
    const [clean, one, two, three] = CORRUPTION_STAGES.map((s) => area.get(s) ?? 0);
    expect(clean).toBeGreaterThan(one + two + three);
    expect(three).toBeLessThan(two);
    expect(three).toBeLessThan(one);
    // Every stage actually appears. A stage with no ground under it is a zone
    // the plan describes and the game never draws.
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(0);
    expect(three).toBeGreaterThan(0);
    // And clean ground is the large majority, not a bare majority.
    expect(clean / total).toBeGreaterThan(0.6);
  });

  it('gets worse the further upstream the player walks', () => {
    // The whole story of the fouled stream in one assertion: the water cleans
    // up as it flows away from the cave. Measured along the spline, so it is
    // the stream's own progression and not an artefact of where the samples
    // happened to land.
    const means: number[] = [];
    for (let i = 0; i < 10; i++) {
      const from = (i / 10) * spline.length;
      const to = ((i + 1) / 10) * spline.length;
      let sum = 0;
      let n = 0;
      for (let d = from; d < to; d += 2) {
        const p = spline.pointAtDistance(d);
        sum += field.corruptionAt(p.x, p.z);
        n++;
      }
      means.push(sum / Math.max(n, 1));
    }
    for (let i = 1; i < means.length; i++) {
      expect(means[i], `segment ${i} is not cleaner than segment ${i - 1}`).toBeLessThanOrEqual(
        means[i - 1] + 1e-9,
      );
    }
    // The cave end is severe and the village end is mild, and the gap is wide
    // enough to see.
    expect(means[0]).toBeGreaterThan(0.7);
    expect(means[means.length - 1]).toBeLessThan(0.5);
  });


  it('thins out with distance from the water', () => {
    // Binned by distance rather than walked along a ray: the stream meanders,
    // so a ray from a point on it can run along the bank and even approach
    // another bend. Grouping by distance removes the geometry from the
    // question and asks only about the falloff.
    const bins = new Map<number, { sum: number; n: number }>();
    for (let x = -200; x <= 200; x += 3) {
      for (let z = -200; z <= 200; z += 3) {
        const d = field.distanceAt(x, z);
        if (d >= DEFAULT_CORRUPTION_FIELD_BUILD.maxInfluence) continue;
        const bucket = Math.min(9, Math.floor(d / 4));
        const entry = bins.get(bucket) ?? { sum: 0, n: 0 };
        entry.sum += field.corruptionAt(x, z);
        entry.n++;
        bins.set(bucket, entry);
      }
    }
    const means = [...bins.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v.sum / Math.max(v.n, 1));
    for (let i = 1; i < means.length; i++) {
      expect(means[i], `bin ${i} is not thinner than bin ${i - 1}`).toBeLessThanOrEqual(
        means[i - 1] + 1e-9,
      );
    }
    // And the outermost bin is clean.
    expect(means[means.length - 1]).toBe(0);
  });

  it('reaches stage 3 somewhere in the world', () => {
    // The plan's inner zone: "enormous fungal structures, twisted trees,
    // glowing spores, unnatural lighting". If nothing in the world reaches
    // stage 3, none of that is ever drawn.
    let stage3 = 0;
    for (let x = -200; x <= 200; x += 4) {
      for (let z = -200; z <= 200; z += 4) {
        if (field.stageAt(x, z) === 3) stage3++;
      }
    }
    expect(stage3).toBeGreaterThan(0);
  });

  it('covers a minority of the world in visible corruption', () => {
    // "Subtle, visible, severe, gradual". If most of the map were corrupted
    // there would be no contrast left, and the fouled stream would stop being
    // a place the player travels to.
    let corrupted = 0;
    let total = 0;
    for (let x = -200; x <= 200; x += 8) {
      for (let z = -200; z <= 200; z += 8) {
        total++;
        if (field.corruptionAt(x, z) >= DEFAULT_CORRUPTION_FIELD_OPTIONS.stage1Start) corrupted++;
      }
    }
    expect(corrupted / total).toBeGreaterThan(0.01);
    expect(corrupted / total).toBeLessThan(0.35);
  });

  it('answers outside the terrain without throwing', () => {
    // The player can walk off the edge, and the systems that ask this question
    // should get an answer rather than an exception.
    expect(field.corruptionAt(1e6, -1e6)).toBe(0);
    expect(field.stageAt(Number.NaN, 0)).toBe(0);
    expect(field.distanceAt(-1e6, 1e6)).toBeGreaterThan(0);
  });

  it('uses a finer lattice than the forest placement field', () => {
    // The corruption reach is tens of metres, so a coarse lattice would blur
    // the bank - and the bank is where the player notices.
    expect(DEFAULT_CORRUPTION_FIELD_BUILD.resolution).toBeGreaterThanOrEqual(256);
    expect(field.step).toBeLessThan(2.5);
  });
});
