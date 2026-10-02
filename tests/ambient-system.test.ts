import { describe, it, expect } from 'vitest';
import {
  AmbientSystem,
  DEFAULT_AMBIENT_TUNING,
  HUM_ONSET,
  SQUELCH_ONSET,
  WATER_WADE_DEPTH,
  WIND_GUST_FLOOR,
  BIRD_BASE_RATE,
  BIRD_INTERVAL_FAR,
  BIRD_INTERVAL_NEAR,
  DEFAULT_BIRD_VARIANTS,
  DEFAULT_SQUELCH_VARIANTS,
  WILDLIFE_BASE_RATE,
  ambientMix,
  rateToGapScale,
  resolveSurface,
  scheduleShots,
  type AmbientAudioFrame,
  type AmbientTuning,
  type ShotLayerState,
} from '../src/audio/AmbientSystem';
import { createRng } from '../src/procedural/NoiseLibrary';

/** A frame with nothing in it, so each test changes exactly one thing. */
function frame(overrides: Partial<AmbientAudioFrame> = {}): AmbientAudioFrame {
  return {
    x: 0,
    y: 0,
    z: 0,
    forwardX: 0,
    forwardZ: 1,
    corruption: 0,
    gust: 0.5,
    canopy: 1,
    surface: null,
    stridePhase: 0,
    footfallInterval: 0,
    ...overrides,
  };
}

/** A fresh scheduler state with `count` variants, all due immediately. */
function layer(count = 3, overrides: Partial<ShotLayerState> = {}): ShotLayerState {
  return {
    nextAt: new Array(count).fill(0),
    azimuth: new Array(count).fill(0),
    radius: new Array(count).fill(10),
    gain: new Array(count).fill(1),
    intervalNear: 1,
    intervalFar: 3,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The mix                                                                    */
/* -------------------------------------------------------------------------- */

describe('ambientMix', () => {
  it('is silent about the corruption on clean ground', () => {
    const mix = ambientMix(frame({ corruption: 0 }));
    expect(mix.hum).toBe(0);
    expect(mix.squelchRate).toBe(0);
  });

  it('brings the hum and the squelches up with corruption, monotonically', () => {
    let lastHum = -1;
    let lastRate = -1;
    for (let c = 0; c <= 1.0001; c += 0.05) {
      const mix = ambientMix(frame({ corruption: c }));
      expect(mix.hum).toBeGreaterThanOrEqual(lastHum);
      expect(mix.squelchRate).toBeGreaterThanOrEqual(lastRate);
      lastHum = mix.hum;
      lastRate = mix.squelchRate;
    }
    expect(ambientMix(frame({ corruption: 1 })).hum).toBeCloseTo(DEFAULT_AMBIENT_TUNING.hum, 6);
    expect(ambientMix(frame({ corruption: 1 })).squelchRate).toBeGreaterThan(0);
  });

  it('thins the birds out with corruption, down to a floor but never to silence', () => {
    const clean = ambientMix(frame({ corruption: 0 })).birds;
    const rotten = ambientMix(frame({ corruption: 1 })).birds;

    expect(rotten).toBeLessThan(clean);
    // Reduced, not gone: a forest with no birds at all reads as broken rather
    // than as blighted.
    expect(rotten).toBeGreaterThan(0);
    expect(rotten).toBeLessThan(clean * 0.2);

    let last = Infinity;
    for (let c = 0; c <= 1.0001; c += 0.05) {
      const level = ambientMix(frame({ corruption: c })).birds;
      expect(level).toBeLessThanOrEqual(last);
      last = level;
    }
  });

  it('lifts the wind and the leaves with the gust', () => {
    const calm = ambientMix(frame({ gust: 0 }));
    const gusty = ambientMix(frame({ gust: 1 }));

    expect(gusty.wind).toBeGreaterThan(calm.wind);
    expect(gusty.leaves).toBeGreaterThan(calm.leaves);
    // The gust is a multiplier on the whole amplitude, so a calm moment is the
    // same wind, quieter - not a different amount of wind plus a wobble.
    expect(calm.wind / gusty.wind).toBeCloseTo(WIND_GUST_FLOOR, 6);
  });

  it('damps the wind under the canopy and raises the leaves under it', () => {
    const open = ambientMix(frame({ canopy: 0 }));
    const dense = ambientMix(frame({ canopy: 1 }));

    // The trees take the top off the wind.
    expect(dense.wind).toBeLessThan(open.wind);
    // And they are what is rustling.
    expect(dense.leaves).toBeGreaterThan(open.leaves);
  });

  it('keeps every layer inside [0, 1] across the whole parameter space', () => {
    const tuning: AmbientTuning = { ...DEFAULT_AMBIENT_TUNING };
    for (const corruption of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      for (const gust of [-1, 0, 0.5, 1, 2, Number.NaN]) {
        for (const canopy of [-1, 0, 0.5, 1, 2, Number.NaN]) {
          const mix = ambientMix(frame({ corruption, gust, canopy }), tuning);
          // The densities are in [0, 1] too, so they belong in the same sweep.
          expect(mix.birdDensity).toBeGreaterThanOrEqual(0);
          expect(mix.birdDensity).toBeLessThanOrEqual(1);
          expect(mix.wildlifeDensity).toBeGreaterThanOrEqual(0);
          expect(mix.wildlifeDensity).toBeLessThanOrEqual(1);
          for (const [name, value] of Object.entries(mix)) {
            expect(Number.isFinite(value), `${name} finite at ${corruption}/${gust}/${canopy}`).toBe(true);
            expect(value, `${name} >= 0`).toBeGreaterThanOrEqual(0);
            expect(value, `${name} <= 1`).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('honours the tuning object', () => {
    const quiet = ambientMix(frame({ corruption: 1, gust: 1 }), {
      wind: 0,
      leaves: 0,
      birds: 0,
      wildlife: 0,
      hum: 0,
      squelch: 0,
      footstep: 0,
    });
    expect(quiet.wind).toBe(0);
    expect(quiet.leaves).toBe(0);
    expect(quiet.birds).toBe(0);
    expect(quiet.hum).toBe(0);
  });

  it('has a hum onset, so clean ground is genuinely silent rather than faint', () => {
    // Below the onset there must be nothing at all. A linear ramp from zero
    // would put an audible drone under the whole forest.
    expect(ambientMix(frame({ corruption: HUM_ONSET * 0.5 })).hum).toBe(0);
    expect(ambientMix(frame({ corruption: HUM_ONSET * 1.5 })).hum).toBeGreaterThan(0);
  });

  it('has a squelch onset too', () => {
    expect(ambientMix(frame({ corruption: SQUELCH_ONSET * 0.5 })).squelchRate).toBe(0);
    expect(ambientMix(frame({ corruption: SQUELCH_ONSET * 1.5 })).squelchRate).toBeGreaterThan(0);
  });

  it('does not let the corruption hum and the birds both be loud', () => {
    // They are alternatives by design: the rot replaces the chorus. If both
    // peaked together the corrupted areas would be the loudest part of the
    // forest, which is the opposite of unsettling.
    const mix = ambientMix(frame({ corruption: 1 }));
    expect(mix.hum).toBeGreaterThan(mix.birds);
  });
});

/* -------------------------------------------------------------------------- */
/* Surface detection                                                          */
/* -------------------------------------------------------------------------- */

describe('resolveSurface', () => {
  const flat = { grass: 1, dirt: 0, rock: 0, mud: 0 };
  const dirty = { grass: 0, dirt: 1, rock: 0, mud: 0 };
  const rocky = { grass: 0, dirt: 0, rock: 1, mud: 0 };
  const muddy = { grass: 0, dirt: 0, rock: 0, mud: 1 };

  it('reads the dominant biome', () => {
    expect(resolveSurface(flat, 0)).toBe('grass');
    expect(resolveSurface(dirty, 0)).toBe('dirt');
    expect(resolveSurface(rocky, 0)).toBe('rock');
  });

  it('folds mud into dirt, because there are four surfaces and not five', () => {
    expect(resolveSurface(muddy, 0)).toBe('dirt');
    // And mud counts toward dirt when they compete.
    expect(resolveSurface({ grass: 0.4, dirt: 0, rock: 0.1, mud: 0.5 }, 0)).toBe('dirt');
  });

  it('lets water win over whatever the bank is made of', () => {
    for (const biome of [flat, dirty, rocky, muddy]) {
      expect(resolveSurface(biome, WATER_WADE_DEPTH * 4)).toBe('water');
    }
  });

  it('ignores a film of water, which is a wet surface and not a puddle', () => {
    // Exactly at the threshold is not wading; only past it is.
    expect(resolveSurface(rocky, WATER_WADE_DEPTH * 0.5)).toBe('rock');
    expect(resolveSurface(rocky, WATER_WADE_DEPTH)).toBe('rock');
    expect(resolveSurface(rocky, WATER_WADE_DEPTH * 1.01)).toBe('water');
  });

  it('treats a non-finite depth as dry rather than as deep', () => {
    // NaN > x is false, so this would silently fall through to the biome - which
    // is the right answer, but only because the comparison is written that way.
    expect(resolveSurface(rocky, Number.NaN)).toBe('rock');
    expect(resolveSurface(rocky, Number.POSITIVE_INFINITY)).toBe('water');
  });

  it('picks a surface for an all-zero biome rather than returning nothing', () => {
    // A degenerate weight vector should not produce a crash or an undefined
    // surface; grass is the safe default because it is the dominant biome.
    expect(resolveSurface({ grass: 0, dirt: 0, rock: 0, mud: 0 }, 0)).toBe('grass');
  });
});

/* -------------------------------------------------------------------------- */
/* The scheduler                                                              */
/* -------------------------------------------------------------------------- */

describe('scheduleShots', () => {
  it('fires nothing before a timer is due', () => {
    const state = layer(3, { nextAt: [10, 20, 30] });
    const fired = scheduleShots(state, 5, 0.5, 1, createRng(1));
    expect(fired).toHaveLength(0);
  });

  it('fires everything that is due', () => {
    const state = layer(3, { nextAt: [10, 20, 30] });
    const fired = scheduleShots(state, 25, 0.5, 1, createRng(1));
    expect(fired.map((f) => f.index).sort()).toEqual([0, 1]);
  });

  it('reschedules inside the scaled interval', () => {
    const state = layer(1, { nextAt: [0], intervalNear: 2, intervalFar: 6 });
    scheduleShots(state, 0, 0.5, 3, createRng(2));
    expect(state.nextAt[0]).toBeGreaterThanOrEqual(2 * 3);
    expect(state.nextAt[0]).toBeLessThanOrEqual(6 * 3);
  });

  it('stretches the gaps when a layer thins out, rather than playing quieter', () => {
    // Fewer calls means longer gaps between the ones that remain. A layer that
    // kept its spacing and merely dropped its level would sound like the same
    // forest with the volume down.
    const loud = layer(1, { nextAt: [0], intervalNear: 2, intervalFar: 6 });
    const thin = layer(1, { nextAt: [0], intervalNear: 2, intervalFar: 6 });
    scheduleShots(loud, 0, 0.5, 1, createRng(3));
    scheduleShots(thin, 0, 0.5, 5, createRng(3));
    expect(thin.nextAt[0]).toBeGreaterThan(loud.nextAt[0]);
  });

  it('fires nothing while silent, but still keeps its timers finite and near', () => {
    // The bug this guards: a silent layer that pushed its timers out by a factor
    // of a million would still have every timer in the future when it became
    // audible again, and would stay quiet forever.
    for (const gapScale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const state = layer(2, { nextAt: [0, 0], intervalNear: 2, intervalFar: 6 });
      const fired = scheduleShots(state, 0, 0.5, gapScale, createRng(4));
      expect(fired).toHaveLength(0);
      for (const t of state.nextAt) {
        expect(Number.isFinite(t)).toBe(true);
        // Unscaled, so the layer resumes at its natural spacing.
        expect(t).toBeGreaterThanOrEqual(2);
        expect(t).toBeLessThanOrEqual(6);
      }
    }
  });

  it('resumes firing once it becomes audible again', () => {
    const state = layer(2, { nextAt: [0, 0], intervalNear: 1, intervalFar: 2 });
    scheduleShots(state, 0, 0, 1, createRng(5)); // silent
    const fired = scheduleShots(state, 100, 0.5, 1, createRng(5));
    expect(fired.length).toBe(2);
  });

  it('fires nothing when the level is effectively zero', () => {
    const state = layer(2, { nextAt: [0, 0] });
    expect(scheduleShots(state, 0, 0, 1, createRng(6))).toHaveLength(0);
    expect(scheduleShots(state, 0, 0.0001, 1, createRng(6))).toHaveLength(0);
  });

  it('scales the level by the layer volume, the variant gain and the distance', () => {
    const near = layer(1, { nextAt: [0], radius: [5], gain: [1] });
    const far = layer(1, { nextAt: [0], radius: [40], gain: [1] });
    const quiet = layer(1, { nextAt: [0], radius: [5], gain: [1] });

    const a = scheduleShots(near, 0, 0.5, 1, createRng(7))[0];
    const b = scheduleShots(far, 0, 0.5, 1, createRng(7))[0];
    const c = scheduleShots(quiet, 0, 0.25, 1, createRng(7))[0];

    expect(a.level).toBeGreaterThan(b.level);
    expect(a.level).toBeGreaterThan(c.level);
    expect(c.level).toBeCloseTo(a.level / 2, 6);
  });

  it('never returns a level above 1 or a pan outside [-1, 1]', () => {
    const state = layer(20, { radius: new Array(20).fill(0), gain: new Array(20).fill(1) });
    for (const shot of scheduleShots(state, 0, 5, 1, createRng(8))) {
      expect(shot.level).toBeGreaterThan(0);
      expect(shot.level).toBeLessThanOrEqual(1);
      expect(shot.pan).toBeGreaterThanOrEqual(-1);
      expect(shot.pan).toBeLessThanOrEqual(1);
    }
  });

  it('drifts the azimuth without letting it run away', () => {
    // A bird that calls repeatedly should move across the sky. Unbounded drift
    // would eventually walk the azimuth out of the range a float represents
    // exactly, and the pan would start to quantise.
    const state = layer(1, { nextAt: [0], azimuth: [0] });
    for (let i = 0; i < 500; i++) {
      state.nextAt[0] = 0;
      scheduleShots(state, i, 0.5, 1, createRng(9));
    }
    expect(Math.abs(state.azimuth[0])).toBeLessThan(500);
    expect(Number.isFinite(state.azimuth[0])).toBe(true);
  });

  it('is deterministic in the seed', () => {
    const a = layer(4);
    const b = layer(4);
    const fa = scheduleShots(a, 0, 0.5, 1, createRng(77));
    const fb = scheduleShots(b, 0, 0.5, 1, createRng(77));
    expect(fa).toEqual(fb);
    expect(a.nextAt).toEqual(b.nextAt);
    expect(a.azimuth).toEqual(b.azimuth);
  });
});

/* -------------------------------------------------------------------------- */
/* Call rates                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The gap scale is the one piece of arithmetic here whose failure is invisible:
 * get the variant count into it wrong by a factor and every layer runs at
 * whatever rate its variant count happens to imply, with nothing to show for it
 * but a forest that is busier or emptier than it was tuned to be.
 */
describe('call rates', () => {
  it('turns a target rate into a gap scale, and silence into infinity', () => {
    expect(rateToGapScale(4, 5, 12, 0.2)).toBeCloseTo(4 / (0.2 * 8.5), 9);
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rateToGapScale(4, 5, 12, rate)).toBe(Number.POSITIVE_INFINITY);
    }
    // A layer with no variants, or with a degenerate interval, cannot fire.
    expect(rateToGapScale(0, 5, 12, 0.2)).toBe(Number.POSITIVE_INFINITY);
    expect(rateToGapScale(4, 0, 0, 0.2)).toBe(Number.POSITIVE_INFINITY);
  });

  it('actually fires at the rate it was asked for', () => {
    // The integration check: drive the real scheduler at the real gap scale and
    // count what comes out. A uniform spread over [near, far] has a mean of
    // (near + far) / 2, so the measured rate has to land on the target.
    const measure = (count: number, near: number, far: number, rate: number, seconds: number): number => {
      const state = layer(count, { nextAt: new Array(count).fill(0), intervalNear: near, intervalFar: far });
      const rng = createRng(31);
      const step = 1 / 60;
      let fires = 0;
      for (let t = 0; t < seconds; t += step) {
        fires += scheduleShots(state, t, 0.5, rateToGapScale(count, near, far, rate), rng).length;
      }
      return fires / seconds;
    };

    // 15 minutes of simulated time per measurement, which is long enough for the
    // mean to settle without making the suite slow.
    const seconds = 900;
    expect(measure(DEFAULT_BIRD_VARIANTS, BIRD_INTERVAL_NEAR, BIRD_INTERVAL_FAR, BIRD_BASE_RATE, seconds)).toBeCloseTo(
      BIRD_BASE_RATE,
      1,
    );
    expect(measure(3, 15, 40, WILDLIFE_BASE_RATE, seconds)).toBeCloseTo(WILDLIFE_BASE_RATE, 2);
    expect(measure(DEFAULT_SQUELCH_VARIANTS, 2.5, 12.5, 0.4, seconds)).toBeCloseTo(0.4, 2);
  });

  it('keeps the rate independent of how many variants there are', () => {
    // The whole point of converting the rate rather than the interval: adding a
    // seventh bird call makes the chorus busier, it does not make each bird
    // lazier by a seventh.
    const measure = (count: number): number => {
      const state = layer(count, {
        nextAt: new Array(count).fill(0),
        intervalNear: BIRD_INTERVAL_NEAR,
        intervalFar: BIRD_INTERVAL_FAR,
      });
      const rng = createRng(31);
      const step = 1 / 60;
      let fires = 0;
      for (let t = 0; t < 900; t += step) {
        fires += scheduleShots(state, t, 0.5, rateToGapScale(count, BIRD_INTERVAL_NEAR, BIRD_INTERVAL_FAR, BIRD_BASE_RATE), rng).length;
      }
      return fires / 900;
    };

    const three = measure(3);
    const nine = measure(9);
    expect(three).toBeCloseTo(BIRD_BASE_RATE, 1);
    expect(nine).toBeCloseTo(BIRD_BASE_RATE, 1);
  });

  it('reports a chorusing density that falls with corruption and with bare ground', () => {
    const dense = ambientMix(frame({ corruption: 0, canopy: 1 }));
    const open = ambientMix(frame({ corruption: 0, canopy: 0 }));
    const rotten = ambientMix(frame({ corruption: 1, canopy: 1 }));

    expect(dense.birdDensity).toBeCloseTo(1, 6);
    // A clearing has fewer birds in it than a wood does.
    expect(open.birdDensity).toBeLessThan(dense.birdDensity);
    expect(open.birdDensity).toBeGreaterThan(0);
    // And the rot thins them to a floor.
    expect(rotten.birdDensity).toBeLessThan(open.birdDensity);
    expect(rotten.birdDensity).toBeGreaterThan(0);

    // The animal layer has no canopy term: an animal calling across a clearing
    // is as audible as one calling under trees.
    expect(ambientMix(frame({ corruption: 0, canopy: 0 })).wildlifeDensity).toBeCloseTo(
      ambientMix(frame({ corruption: 0, canopy: 1 })).wildlifeDensity,
      9,
    );
    expect(ambientMix(frame({ corruption: 1 })).wildlifeDensity).toBeLessThan(
      ambientMix(frame({ corruption: 0 })).wildlifeDensity,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The system in a headless environment                                       */
/* -------------------------------------------------------------------------- */

describe('AmbientSystem without an AudioContext', () => {
  it('builds nothing and reports itself as not live', () => {
    const system = new AmbientSystem({ seed: 1 });
    expect(system.isLive).toBe(false);
    system.dispose();
  });

  it('still resolves the mix, so the arithmetic is exercised', () => {
    const system = new AmbientSystem({ seed: 1 });
    expect(system.mix.hum).toBe(0);
    system.update(0.016, frame({ corruption: 1, gust: 1 }));
    expect(system.mix.hum).toBeGreaterThan(0);
    expect(system.mix.wind).toBeGreaterThan(0);
    system.dispose();
  });

  it('survives a hostile frame without throwing or going non-finite', () => {
    const system = new AmbientSystem({ seed: 1 });
    const hostile: AmbientAudioFrame = {
      x: Number.NaN,
      y: Number.NaN,
      z: Number.NaN,
      forwardX: Number.NaN,
      forwardZ: Number.NaN,
      corruption: Number.NaN,
      gust: Number.NaN,
      canopy: Number.NaN,
      surface: 'grass',
      stridePhase: Number.NaN,
      footfallInterval: Number.NaN,
    };
    expect(() => system.update(0.016, hostile)).not.toThrow();
    for (const value of Object.values(system.mix)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    system.dispose();
  });

  it('ignores a non-finite or negative delta', () => {
    const system = new AmbientSystem({ seed: 1 });
    system.update(0.016, frame({ corruption: 1 }));
    const after = system.mix.hum;
    for (const delta of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      system.update(delta, frame({ corruption: 0 }));
      expect(system.mix.hum).toBe(after);
    }
    system.dispose();
  });

  it('is safe to dispose twice, and to dispose before any update', () => {
    const a = new AmbientSystem({ seed: 1 });
    a.dispose();
    a.dispose();
    const b = new AmbientSystem({ seed: 1 });
    b.dispose();
    expect(() => b.update(0.016, frame())).not.toThrow();
  });

  it('tracks mute and volume even with nothing playing', () => {
    const system = new AmbientSystem({ seed: 1 });
    expect(system.isMuted).toBe(false);
    system.setMuted(true);
    expect(system.isMuted).toBe(true);
    system.setMuted(false);
    expect(system.isMuted).toBe(false);

    system.setVolume(0.5);
    expect(system.volume).toBe(0.5);
    system.setVolume(5);
    expect(system.volume).toBe(1);
    system.setVolume(-1);
    expect(system.volume).toBe(0);
    system.setVolume(Number.NaN);
    expect(system.volume).toBe(0);
    system.dispose();
  });

  it('starts muted when asked', () => {
    expect(new AmbientSystem({ seed: 1, muted: true }).isMuted).toBe(true);
  });

  it('produces the same mix sequence for the same seed', () => {
    const a = new AmbientSystem({ seed: 4242 });
    const b = new AmbientSystem({ seed: 4242 });
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      const f = frame({ corruption: (i % 10) / 10, gust: (i % 7) / 7 });
      a.update(0.05, f);
      b.update(0.05, f);
      seen.push(a.mix.hum, a.mix.wind, a.mix.leaves);
    }
    for (let i = 0; i < 40; i++) {
      const f = frame({ corruption: (i % 10) / 10, gust: (i % 7) / 7 });
      b.update(0.05, f);
    }
    const again: number[] = [];
    for (let i = 0; i < 40; i++) {
      const f = frame({ corruption: (i % 10) / 10, gust: (i % 7) / 7 });
      b.update(0.05, f);
      again.push(b.mix.hum, b.mix.wind, b.mix.leaves);
    }
    expect(again).toEqual(seen);
    a.dispose();
    b.dispose();
  });
});
