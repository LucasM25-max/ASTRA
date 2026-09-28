import { describe, expect, it, vi } from 'vitest';
import { Color, PointLight } from 'three';
import {
  DEFAULT_DAY_LENGTH,
  DEFAULT_MAX_ELEVATION,
  DEFAULT_TUTORIAL_HOUR,
  HEMI_GROUND_BASE,
  DayNightCycle,
  HOURS_PER_DAY,
  SKY_LADDER,
  type SkyKeyframe,
  directionFrom,
  sampleSkyAt,
  sunPlacement,
  wrapHour,
  type SkySample,
} from '../src/renderer/DayNightCycle';
import { LightingSystem } from '../src/renderer/LightingSystem';
import { SkySystem } from '../src/renderer/SkySystem';

/** Hours to sweep, including the ones nothing special happens at. */
const HOURS = [0, 1, 3, 5, 6, 7, 9.5, 12, 15, 18, 19, 20, 21, 23];

describe('wrapHour', () => {
  it('wraps into [0, 24) and keeps NaN out of the clock', () => {
    expect(wrapHour(0)).toBe(0);
    expect(wrapHour(23.999)).toBeCloseTo(23.999, 6);
    expect(wrapHour(24)).toBe(0);
    expect(wrapHour(25)).toBe(1);
    expect(wrapHour(-1)).toBe(23);
    expect(wrapHour(-25)).toBe(23);
    // A non-finite hour would poison every colour derived from it, so it falls
    // back to the tutorial hour rather than propagating NaN into the frame.
    expect(wrapHour(Number.NaN)).toBe(DEFAULT_TUTORIAL_HOUR);
    expect(wrapHour(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TUTORIAL_HOUR);
  });
});

describe('sunPlacement', () => {
  it('puts the sun on the horizon at sunrise and sunset', () => {
    expect(sunPlacement(6).elevation).toBeCloseTo(0, 10);
    expect(sunPlacement(18).elevation).toBeCloseTo(0, 10);
  });

  it('peaks at noon at the configured maximum elevation', () => {
    const noon = sunPlacement(12);
    expect(noon.elevation).toBeCloseTo(DEFAULT_MAX_ELEVATION * (Math.PI / 180), 10);
  });

  it('goes NEGATIVE at night, which is what lets the moon rise', () => {
    // A max(0, ...) clamp here would park the sun on the horizon all night and
    // the night would have no light source of its own.
    expect(sunPlacement(0).elevation).toBeLessThan(0);
    expect(sunPlacement(3).elevation).toBeLessThan(0);
    expect(sunPlacement(21).elevation).toBeLessThan(0);
    expect(sunPlacement(0).elevation).toBeCloseTo(-sunPlacement(12).elevation, 10);
  });

  it('sweeps from east to west, so shadows swing rather than spin', () => {
    const sunrise = sunPlacement(6).azimuth;
    const noon = sunPlacement(12).azimuth;
    const sunset = sunPlacement(18).azimuth;
    expect(sunrise).toBeCloseTo(0, 10);
    expect(noon).toBeCloseTo(Math.PI / 2, 10);
    expect(sunset).toBeCloseTo(Math.PI, 10);
  });

  it('honours a different peak elevation', () => {
    expect(sunPlacement(12, 30).elevation).toBeCloseTo(30 * (Math.PI / 180), 10);
  });
});

describe('directionFrom', () => {
  it('returns a unit vector', () => {
    for (const hour of HOURS) {
      const { elevation, azimuth } = sunPlacement(hour);
      const d = directionFrom(elevation, azimuth);
      expect(d.length()).toBeCloseTo(1, 10);
    }
  });

  it('points due east at sunrise and due west at sunset', () => {
    const dawn = directionFrom(...(Object.values(sunPlacement(6)) as [number, number]));
    expect(dawn.x).toBeCloseTo(1, 10);
    expect(dawn.z).toBeCloseTo(0, 10);

    const dusk = directionFrom(...(Object.values(sunPlacement(18)) as [number, number]));
    expect(dusk.x).toBeCloseTo(-1, 10);
    expect(dusk.z).toBeCloseTo(0, 10);
  });

  it('is straight up only when the elevation is 90 degrees', () => {
    const up = directionFrom(Math.PI / 2, 0);
    expect(up.y).toBeCloseTo(1, 10);
    expect(up.x).toBeCloseTo(0, 10);
    expect(up.z).toBeCloseTo(0, 10);
  });

  it('never returns a zero vector, which normalize() would leave undefined', () => {
    for (const hour of HOURS) {
      const { elevation, azimuth } = sunPlacement(hour);
      expect(directionFrom(elevation, azimuth).length()).toBeGreaterThan(0.5);
    }
  });
});

describe('sampleSkyAt', () => {
  it('is finite at every hour of the day', () => {
    for (let h = 0; h < HOURS_PER_DAY; h += 0.25) {
      const s = sampleSkyAt(h);
      const values = [
        s.sunElevation,
        s.sunAzimuth,
        s.sunDirection.x,
        s.sunDirection.y,
        s.sunDirection.z,
        s.moonDirection.x,
        s.moonDirection.y,
        s.moonDirection.z,
        s.sunIntensity,
        s.ambientIntensity,
        s.hemiIntensity,
        s.starOpacity,
        s.moonOpacity,
        s.cloudOpacity,
        s.sunDiscOpacity,
      ];
      for (const v of values) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('reproduces the Step 2.5 rig at the tutorial hour', () => {
    // The world was lit, tuned and visually verified against the Step 2.5 rig:
    // sun 0xfff1d6 @ 2.6, ambient 0xa8bdd4 @ 0.9, hemi 0xbcd4ea/0x5c6b3a @ 0.55,
    // haze 0xc6d2d6. If the cycle does not land within a hair of that at the
    // tutorial's fixed hour, the step has silently changed the look of the game.
    const s = sampleSkyAt(DEFAULT_TUTORIAL_HOUR);
    expect(s.sunColor).toBeGreaterThanOrEqual(0xffedcc);
    expect(s.sunColor).toBeLessThanOrEqual(0xfff6e8);
    expect(s.sunIntensity).toBeGreaterThan(2.5);
    expect(s.sunIntensity).toBeLessThan(3.0);
    expect(s.ambientColor).toBeGreaterThanOrEqual(0xa0b6ce);
    expect(s.ambientColor).toBeLessThanOrEqual(0xb0c4da);
    expect(s.ambientIntensity).toBeGreaterThan(0.85);
    expect(s.ambientIntensity).toBeLessThan(1.0);
    expect(s.hemiIntensity).toBeGreaterThan(0.5);
    expect(s.hemiIntensity).toBeLessThan(0.62);
    expect(s.hazeColor).toBeGreaterThanOrEqual(0xbecfd9);
    expect(s.hazeColor).toBeLessThanOrEqual(0xcdd8e0);
    // Late morning: high enough to light the floor, low enough for long shadows.
    expect(s.sunElevation).toBeGreaterThan(35 * (Math.PI / 180));
    expect(s.sunElevation).toBeLessThan(55 * (Math.PI / 180));
  });

  it('keeps the sun and the fill warm and cool the way the style guide asks', () => {
    // "Warm sun, cool shadows": the sun's colour must be warmer (more red
    // relative to blue) than the ambient that fills the shadows, at every hour
    // where the sun is up. Getting this backwards is the single most damaging
    // lighting mistake available, and it is invisible in a unit test that only
    // checks numbers are finite.
    for (const hour of [6.5, 8, 9.5, 12, 15, 17.5]) {
      const s = sampleSkyAt(hour);
      const sun = new Color(s.sunColor);
      const ambient = new Color(s.ambientColor);
      expect(sun.r - sun.b).toBeGreaterThan(ambient.r - ambient.b);
    }
  });

  it('brightens the sun to noon and dims it after', () => {
    // The sun climbs to noon and descends afterwards, so the intensity is
    // unimodal, not monotonic. Asserting monotonic increase across the whole day
    // is asserting the sun is brightest at sunset.
    const morning = [6, 8, 10, 12].map((h) => sampleSkyAt(h).sunIntensity);
    const evening = [12, 14, 16, 18].map((h) => sampleSkyAt(h).sunIntensity);
    for (let i = 1; i < morning.length; i++) {
      expect(morning[i]).toBeGreaterThan(morning[i - 1]);
    }
    for (let i = 1; i < evening.length; i++) {
      expect(evening[i]).toBeLessThan(evening[i - 1]);
    }
    // And noon is the peak of the whole day.
    const noon = sampleSkyAt(12).sunIntensity;
    for (let h = 0; h < HOURS_PER_DAY; h += 0.5) {
      expect(sampleSkyAt(h).sunIntensity).toBeLessThanOrEqual(noon + 1e-9);
    }
  });

  it('warms the horizon at golden hour and cools it at noon', () => {
    const noon = new Color(sampleSkyAt(12).horizonColor);
    const golden = new Color(sampleSkyAt(17.5).horizonColor);
    // Golden hour's horizon is warmer (higher red-to-blue ratio) than noon's.
    expect(golden.r / golden.b).toBeGreaterThan(noon.r / noon.b);
  });

  it('has no stars in daylight and a full sky of them at night', () => {
    expect(sampleSkyAt(12).starOpacity).toBe(0);
    expect(sampleSkyAt(3).starOpacity).toBeGreaterThan(0.9);
    // Monotonic through dusk, so the stars fade in rather than popping.
    let previous = -1;
    for (const hour of [12, 16, 18, 19, 20, 21, 23]) {
      const stars = sampleSkyAt(hour).starOpacity;
      expect(stars).toBeGreaterThanOrEqual(previous);
      previous = stars;
    }
  });

  it('never has the sun disc up at night', () => {
    expect(sampleSkyAt(3).sunDiscOpacity).toBeLessThan(0.05);
    expect(sampleSkyAt(12).sunDiscOpacity).toBeGreaterThan(0.9);
  });

  it('keeps exactly one of the sun and the moon above the horizon', () => {
    for (const hour of HOURS) {
      const s = sampleSkyAt(hour);
      const sunUp = s.sunDirection.y > 0;
      const moonUp = s.moonDirection.y > 0;
      expect(sunUp !== moonUp).toBe(true);
      // And the one that is up is the one that is visible.
      if (moonUp) expect(s.moonOpacity).toBeGreaterThan(0);
    }
  });

  it('dims the sun intensity to nothing at night', () => {
    expect(sampleSkyAt(0).sunIntensity).toBe(0);
    // But the ambient never reaches zero: a fully black frame is unreadable, and
    // a world with no fill light at all has no shadows to read.
    expect(sampleSkyAt(0).ambientIntensity).toBeGreaterThan(0.05);
  });

  it('never produces a negative intensity', () => {
    for (let h = 0; h < HOURS_PER_DAY; h += 0.5) {
      const s = sampleSkyAt(h);
      expect(s.sunIntensity).toBeGreaterThanOrEqual(0);
      expect(s.ambientIntensity).toBeGreaterThanOrEqual(0);
      expect(s.hemiIntensity).toBeGreaterThanOrEqual(0);
    }
  });

  it('derives the hemisphere ground bounce from the haze, not a keyframe', () => {
    // The bounce light off the ground has been through the same air the fog is
    // made of, so it must warm when the haze warms. A separately keyframed
    // ground colour is how the two end up disagreeing at golden hour - warm light
    // from above, green bounce from below, and a shadow that reads as two
    // different times of day at once.
    //
    // Asserted by recomputing the blend rather than by checking that the colour
    // "looks warm": the derivation IS the contract, so that is what is checked.
    for (const hour of [6, 9.5, 12, 16, 17.5, 18, 19, 21, 3]) {
      const s = sampleSkyAt(hour);
      const expected = new Color(HEMI_GROUND_BASE)
        .lerp(new Color(s.hazeColor), 0.35)
        .getHex();
      expect(s.hemiGroundColor).toBe(expected);
    }
    // And it stays recognisably the earthy green of Step 2.5 rather than becoming
    // a copy of the haze - the style guide's restrained palette has to survive
    // the whole cycle.
    for (const hour of [8, 9.5, 12, 16]) {
      const ground = new Color(sampleSkyAt(hour).hemiGroundColor);
      expect(ground.g).toBeGreaterThan(ground.r);
      expect(ground.g).toBeGreaterThan(ground.b);
    }
  });

  it('never leaves the range the ladder itself spans', () => {
    // THE seam test. A bug where the interpolation runs past a rung - `t` outside
    // [0,1] - produces values the ladder never contained, and the tell is exact:
    // a sun intensity of -1.19 at midnight, from extrapolating past a rung whose
    // intensity is already 0. Every sampled value must therefore sit inside the
    // min/max of the rungs, at every hour.
    //
    // The ladder's keys and the sample's are not the same names, so the mapping
    // is stated once rather than assumed.
    const numeric: [keyof SkyKeyframe, keyof SkySample][] = [
      ['sunIntensity', 'sunIntensity'],
      ['ambientIntensity', 'ambientIntensity'],
      ['hemiIntensity', 'hemiIntensity'],
      ['starOpacity', 'starOpacity'],
      ['moonOpacity', 'moonOpacity'],
      ['cloudOpacity', 'cloudOpacity'],
      ['sunDisc', 'sunDiscOpacity'],
    ];
    const colours: [keyof SkyKeyframe, keyof SkySample][] = [
      ['zenith', 'zenithColor'],
      ['horizon', 'horizonColor'],
      ['haze', 'hazeColor'],
      ['sun', 'sunColor'],
      ['ambient', 'ambientColor'],
      ['hemiSky', 'hemiSkyColor'],
    ];

    for (let h = 0; h < HOURS_PER_DAY; h += 0.05) {
      const sample = sampleSkyAt(h);
      for (const [ladderKey, sampleKey] of numeric) {
        const values = SKY_LADDER.map((rung) => rung[ladderKey] as number);
        expect(sample[sampleKey] as number).toBeGreaterThanOrEqual(Math.min(...values) - 1e-9);
        expect(sample[sampleKey] as number).toBeLessThanOrEqual(Math.max(...values) + 1e-9);
      }
      // Colours are checked in LINEAR space, not as sRGB hex. `lerpHex`
      // interpolates linearly and then converts back to 8-bit, and that round
      // trip is not exactly invertible - so a lerp at t=0 can legitimately land
      // one byte off the rung it started from. Comparing the hex would fail on
      // rounding, not on a bug; comparing the linear channels cannot, because
      // interpolation between two points in linear space is exact and monotone.
      for (const [ladderKey, sampleKey] of colours) {
        const channels = SKY_LADDER.map((rung) => new Color(rung[ladderKey] as number));
        const here = new Color(sample[sampleKey] as number);
        for (const ch of ['r', 'g', 'b'] as const) {
          const lo = Math.min(...channels.map((c) => c[ch]));
          const hi = Math.max(...channels.map((c) => c[ch]));
          expect(here[ch]).toBeGreaterThanOrEqual(lo - 1e-6);
          expect(here[ch]).toBeLessThanOrEqual(hi + 1e-6);
        }
      }
    }
  });

  it('moves smoothly enough that no frame pops', () => {
    // A seam shows up as a step far larger than the ladder can legitimately
    // produce. The bound is DERIVED rather than guessed, because the dawn ramp is
    // genuinely steep - the sun's red channel climbs from 0.26 to 1.0 across the
    // -12 to -5 degree rungs, and the elevation sweeps that in well under half an
    // hour - so any fixed threshold is either too loose to catch a seam or too
    // tight to pass.
    //
    // The steepest rung, in linear units per degree of elevation, times the most
    // elevation a step can cover, is the worst a correct sampler can do.
    const step = 0.1;
    const maxElevationPerHour = DEFAULT_MAX_ELEVATION * (Math.PI / 180) * (Math.PI / 12);
    const degreesPerStep = (maxElevationPerHour * step * 180) / Math.PI;

    const colourKeys: [keyof SkyKeyframe, keyof SkySample][] = [
      ['zenith', 'zenithColor'],
      ['horizon', 'horizonColor'],
      ['haze', 'hazeColor'],
      ['sun', 'sunColor'],
    ];
    let worstColour = 0;
    for (let i = 0; i < SKY_LADDER.length - 1; i++) {
      const a = SKY_LADDER[i];
      const b = SKY_LADDER[i + 1];
      const degrees = a.elevation - b.elevation;
      if (degrees <= 0) continue;
      for (const [key] of colourKeys) {
        const ca = new Color(a[key] as number);
        const cb = new Color(b[key] as number);
        const perDegree = Math.max(
          Math.abs(ca.r - cb.r),
          Math.abs(ca.g - cb.g),
          Math.abs(ca.b - cb.b),
        ) / degrees;
        worstColour = Math.max(worstColour, perDegree * degreesPerStep);
      }
    }
    // The same derivation for the scalar rungs. The sun's intensity is the
    // steepest of them - 1.3 down to 0.35 across the five degrees either side of
    // sunset - which at 15.7 degrees an hour is a 0.30 step in six minutes. A
    // hardcoded 0.25 there is asserting the sunset is slower than it is.
    let worstScalar = 0;
    for (let i = 0; i < SKY_LADDER.length - 1; i++) {
      const a = SKY_LADDER[i];
      const b = SKY_LADDER[i + 1];
      const degrees = a.elevation - b.elevation;
      if (degrees <= 0) continue;
      for (const key of ['sunIntensity', 'ambientIntensity', 'starOpacity'] as const) {
        const perDegree = Math.abs((a[key] as number) - (b[key] as number)) / degrees;
        worstScalar = Math.max(worstScalar, perDegree * degreesPerStep);
      }
    }

    // 25% headroom over the theoretical worst. A seam from a broken
    // interpolation is several times this, not a quarter more.
    const colourBound = worstColour * 1.25;
    const scalarBound = worstScalar * 1.25;
    expect(colourBound).toBeGreaterThan(0);
    expect(scalarBound).toBeGreaterThan(0);

    let previous = sampleSkyAt(0);
    for (let h = step; h <= HOURS_PER_DAY; h += step) {
      const current = sampleSkyAt(h);
      for (const [, sampleKey] of colourKeys) {
        const a = new Color(previous[sampleKey] as number);
        const b = new Color(current[sampleKey] as number);
        expect(Math.abs(a.r - b.r)).toBeLessThan(colourBound);
        expect(Math.abs(a.g - b.g)).toBeLessThan(colourBound);
        expect(Math.abs(a.b - b.b)).toBeLessThan(colourBound);
      }
      for (const key of ['sunIntensity', 'ambientIntensity', 'starOpacity'] as const) {
        expect(Math.abs(previous[key] - current[key])).toBeLessThan(scalarBound);
      }
      previous = current;
    }
  });

  it('lands exactly on a rung at the top of the ladder', () => {
    // At the maximum elevation the sample IS the top rung, with no interpolation
    // at all. If it were off by even a rounding step, the whole day would be
    // shifted by a fraction of a rung.
    const noon = sampleSkyAt(12);
    expect(noon.sunIntensity).toBe(SKY_LADDER[0].sunIntensity);
    expect(noon.zenithColor).toBe(SKY_LADDER[0].zenith);
    expect(noon.hazeColor).toBe(SKY_LADDER[0].haze);
  });
});

describe('DayNightCycle', () => {
  it('starts paused at the tutorial hour', () => {
    const cycle = new DayNightCycle();
    expect(cycle.paused).toBe(true);
    expect(cycle.hour).toBe(DEFAULT_TUTORIAL_HOUR);
  });

  it('does not advance while paused', () => {
    const cycle = new DayNightCycle();
    cycle.update(600);
    expect(cycle.hour).toBe(DEFAULT_TUTORIAL_HOUR);
  });

  it('advances once resumed, and wraps at midnight', () => {
    const cycle = new DayNightCycle({ hour: 23, paused: false, dayLength: 24 });
    // One hour of game time per second of a 24-second day.
    cycle.update(1);
    expect(cycle.hour).toBeCloseTo(0, 6);
    cycle.update(1);
    expect(cycle.hour).toBeCloseTo(1, 6);
  });

  it('ignores zero, negative and non-finite deltas', () => {
    const cycle = new DayNightCycle({ hour: 10, paused: false });
    cycle.update(0);
    cycle.update(-5);
    cycle.update(Number.NaN);
    cycle.update(Number.POSITIVE_INFINITY);
    expect(cycle.hour).toBe(10);
  });

  it('re-samples and pushes to both targets when the hour changes', () => {
    const cycle = new DayNightCycle({ hour: 12, paused: false });
    const sky = { applySkyState: vi.fn() };
    const lighting = { applySkyState: vi.fn() };
    cycle.attachSky(sky);
    cycle.attachLighting(lighting);
    sky.applySkyState.mockClear();
    lighting.applySkyState.mockClear();

    cycle.hour = 18;

    expect(sky.applySkyState).toHaveBeenCalledTimes(1);
    expect(lighting.applySkyState).toHaveBeenCalledTimes(1);
    expect(cycle.sample.sunIntensity).toBeLessThan(sampleSkyAt(12).sunIntensity);
  });

  it('reports the haze change exactly when the colour actually changes', () => {
    const cycle = new DayNightCycle({ hour: 12, paused: false });
    const seen: number[] = [];
    cycle.onHazeChange = (c) => seen.push(c);
    // Hour 14, not 13: at 13 the interpolated haze rounds back to the same 8-bit
    // byte it had at 12, so nothing actually changed and a correctly-behaving
    // cycle rightly says nothing. Asserting a change there is asserting the
    // rounding is coarser than it is.
    cycle.hour = 14;
    expect(seen).toEqual([cycle.hazeColor]);
    // Setting the same hour again must not fire a spurious change.
    cycle.hour = 14;
    expect(seen).toHaveLength(1);
    // And an hour that genuinely changes the colour fires again.
    cycle.hour = 18;
    expect(seen).toHaveLength(2);
  });

  it('hands the attached targets the sample it already has, without re-sampling', () => {
    const cycle = new DayNightCycle({ hour: 12 });
    const sky = { applySkyState: vi.fn() };
    cycle.attachSky(sky);
    expect(sky.applySkyState).toHaveBeenCalledWith(cycle.sample);
  });

  it('survives a null target', () => {
    const cycle = new DayNightCycle();
    expect(() => cycle.attachSky(null)).not.toThrow();
    expect(() => cycle.attachLighting(null)).not.toThrow();
    expect(() => cycle.hour = 15).not.toThrow();
  });

  it('accepts hh:mm through setTime', () => {
    const cycle = new DayNightCycle();
    cycle.setTime(6, 30);
    expect(cycle.hour).toBeCloseTo(6.5, 10);
  });

  it('can be paused and resumed', () => {
    const cycle = new DayNightCycle({ hour: 12, paused: false });
    cycle.pause();
    cycle.update(1000);
    expect(cycle.hour).toBe(12);
    cycle.resume();
    // 60 seconds of a 1440-second day is one hour. (1000 would be 16.7 hours and
    // would wrap past midnight, which is a different assertion.)
    cycle.update(60);
    expect(cycle.hour).toBeCloseTo(13, 6);
  });
});

describe('the cycle wired into the light rig', () => {
  it('relights the sun, the ambient and the hemisphere from the sample', () => {
    const lighting = new LightingSystem();
    const cycle = new DayNightCycle({ hour: 12 }).attachLighting(lighting);
    const noon = cycle.sample;

    expect(lighting.sun.color.getHex()).toBe(noon.sunColor);
    expect(lighting.sun.intensity).toBeCloseTo(noon.sunIntensity, 6);
    expect(lighting.ambient.color.getHex()).toBe(noon.ambientColor);
    expect(lighting.ambient.intensity).toBeCloseTo(noon.ambientIntensity, 6);
    expect(lighting.hemi.color.getHex()).toBe(noon.hemiSkyColor);
    expect(lighting.hemi.groundColor.getHex()).toBe(noon.hemiGroundColor);
    expect(lighting.hemi.intensity).toBeCloseTo(noon.hemiIntensity, 6);
    lighting.dispose();
  });

  it('re-points the sun along the sampled direction', () => {
    const lighting = new LightingSystem();
    const cycle = new DayNightCycle({ hour: 12 }).attachLighting(lighting);

    // The light must sit OUT along the sampled direction, not merely share its
    // direction: `followShadowFocus` re-derives the position from `sunOffset`,
    // and an offset that is not along the sun direction makes the shadows fall
    // the wrong way the moment the camera moves.
    const position = lighting.sun.position;
    const expected = cycle.sample.sunDirection.clone().multiplyScalar(position.length());
    expect(position.x).toBeCloseTo(expected.x, 4);
    expect(position.y).toBeCloseTo(expected.y, 4);
    expect(position.z).toBeCloseTo(expected.z, 4);
    expect(position.length()).toBeGreaterThan(0);
    lighting.dispose();
  });

  it('keeps the shadow box over the player after the sun is re-pointed', () => {
    // This is the bookkeeping half of the bug the comment on `setSunPosition`
    // warns about: re-point the sun, move the focus, and the shadows must still
    // fall in the sun's direction.
    const lighting = new LightingSystem();
    const cycle = new DayNightCycle({ hour: 12 }).attachLighting(lighting);

    lighting.followShadowFocus(40, -60, 3);
    const directionAtStart = lighting.sun.position
      .clone()
      .sub(lighting.sun.target.position)
      .normalize();

    cycle.hour = 17;
    lighting.followShadowFocus(40, -60, 3);

    const directionAfter = lighting.sun.position
      .clone()
      .sub(lighting.sun.target.position)
      .normalize();

    expect(directionAfter.x).toBeCloseTo(cycle.sample.sunDirection.x, 4);
    expect(directionAfter.y).toBeCloseTo(cycle.sample.sunDirection.y, 4);
    expect(directionAfter.z).toBeCloseTo(cycle.sample.sunDirection.z, 4);
    // And it moved: the evening sun is not the noon sun.
    expect(directionAfter.distanceTo(directionAtStart)).toBeGreaterThan(0.1);
    lighting.dispose();
  });

  it("puts the light and its target inside the shadow camera's depth range", () => {
    // The shadow camera sits AT the light and looks at the target, so the target
    // has to land between `near` and `far` or the box the shadows are rendered
    // into is empty. Too close is as fatal as too far: a light on top of its own
    // target casts nothing, which is a flatly-lit world with no error anywhere.
    const lighting = new LightingSystem();
    const cycle = new DayNightCycle({ hour: 9.5 }).attachLighting(lighting);
    const camera = lighting.sun.shadow.camera;
    const distance = lighting.sun.position.distanceTo(lighting.sun.target.position);
    expect(distance).toBeGreaterThan(camera.near);
    expect(distance).toBeLessThan(camera.far);
    // And there is margin on both sides, so a small change of hour cannot push
    // the target out of the box.
    expect(distance).toBeGreaterThan(camera.near * 4);
    expect(distance).toBeLessThan(camera.far * 0.75);
    expect(cycle.sample.sunIntensity).toBeGreaterThan(0);
    lighting.dispose();
  });

  it('never produces a non-finite light state at any hour', () => {
    const lighting = new LightingSystem();
    const cycle = new DayNightCycle({ hour: 0 });
    for (let h = 0; h < HOURS_PER_DAY; h += 1.5) {
      cycle.hour = h;
      const p = lighting.sun.position;
      expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
      expect(Number.isFinite(lighting.sun.intensity)).toBe(true);
      expect(Number.isFinite(lighting.ambient.intensity)).toBe(true);
      expect(Number.isFinite(lighting.hemi.intensity)).toBe(true);
      expect(lighting.sun.intensity).toBeGreaterThanOrEqual(0);
      expect(lighting.ambient.intensity).toBeGreaterThanOrEqual(0);
      expect(lighting.hemi.intensity).toBeGreaterThanOrEqual(0);
    }
    lighting.dispose();
  });

  it('leaves the point-light flicker service alone', () => {
    // `applySkyState` writes the sun, ambient and hemisphere every frame. It must
    // not touch the flickering glow lights, or the flicker would be overwritten
    // by a constant and the corruption's sickly pulse would go flat.
    const lighting = new LightingSystem();
    const cycle = new DayNightCycle({ hour: 12 }).attachLighting(lighting);
    // A non-zero baseline: the flicker service takes the light's intensity at
    // registration as its baseline, so a light created at 0 flickers around 0
    // forever and the test would pass no matter what the cycle did to it.
    const glow = new PointLight(0x9fc46a, 0.8);
    lighting.flicker(glow, { rate: 5, depth: 0.5 });
    lighting.update(0.2);
    const flickered = glow.intensity;
    expect(flickered).toBeGreaterThan(0);

    cycle.hour = 20;
    lighting.update(0.2);
    // Still flickering after the cycle relit the rig.
    expect(glow.intensity).not.toBe(flickered);
    lighting.dispose();
  });
});

describe('the cycle wired into the sky', () => {
  it('pushes the colours, the directions and the opacities', () => {
    const sky = new SkySystem();
    const cycle = new DayNightCycle({ hour: 12 }).attachSky(sky);
    const s = cycle.sample;
    const u = sky.mesh.material.uniforms;

    expect((u.uHorizonColor.value as Color).getHex()).toBe(s.horizonColor);
    expect((u.uZenithColor.value as Color).getHex()).toBe(s.zenithColor);
    expect((u.uSunColor.value as Color).getHex()).toBe(s.sunColor);
    expect(u.uSunDirection.value).toEqual(s.sunDirection);
    expect(u.uMoonDirection.value).toEqual(s.moonDirection);
    expect(u.uStarOpacity.value).toBe(s.starOpacity);
    expect(u.uMoonOpacity.value).toBe(s.moonOpacity);
    expect(u.uCloudOpacity.value).toBe(s.cloudOpacity);
    expect(u.uSunDisc.value).toBe(s.sunDiscOpacity);
    sky.dispose();
  });

  it('fades the sun disc in at night so it clips rather than disappearing', () => {
    const sky = new SkySystem();
    const cycle = new DayNightCycle({ hour: 12 }).attachSky(sky);
    expect(sky.mesh.material.uniforms.uSunDisc.value).toBeGreaterThan(0.9);

    cycle.hour = 22;
    expect(sky.mesh.material.uniforms.uSunDisc.value).toBeLessThan(0.05);
    sky.dispose();
  });

  it('scrolls the cloud deck on its own clock', () => {
    const sky = new SkySystem();
    const before = (sky.mesh.material.uniforms.uCloudOffset.value as { x: number }).x;
    sky.update(2);
    const after = (sky.mesh.material.uniforms.uCloudOffset.value as { x: number }).x;
    expect(after).toBeGreaterThan(before);
    sky.dispose();
  });

  it('never puts a NaN in a uniform', () => {
    const sky = new SkySystem();
    const cycle = new DayNightCycle({ hour: 0 });
    for (let h = 0; h < HOURS_PER_DAY; h += 3) {
      cycle.hour = h;
      for (const [, uniform] of Object.entries(sky.mesh.material.uniforms)) {
        const value = uniform.value;
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
        if (value instanceof Color) {
          expect(Number.isFinite(value.r + value.g + value.b)).toBe(true);
        }
      }
    }
    sky.dispose();
  });
});

describe('SkySystem cloud layer', () => {
  it('clamps coverage into 0..1', () => {
    const sky = new SkySystem({ cloudCoverage: 4 });
    expect(sky.mesh.material.uniforms.uCloudCoverage.value).toBe(1);
    sky.setCloudCoverage(-2);
    expect(sky.mesh.material.uniforms.uCloudCoverage.value).toBe(0);
    sky.setCloudCoverage(0.4);
    expect(sky.mesh.material.uniforms.uCloudCoverage.value).toBeCloseTo(0.4, 6);
    sky.dispose();
  });

  it('fades the deck out at the horizon rather than letting it diverge', () => {
    // `dir.xz / dir.y` runs to infinity as dir.y approaches 0, so the shader
    // needs the fade. Without it the horizon fills with noise.
    const sky = new SkySystem();
    expect(sky.mesh.material.fragmentShader).toContain('horizonFade');
    expect(sky.mesh.material.fragmentShader).toContain('max(dir.y, 0.05)');
    sky.dispose();
  });

  it('guards the normalize against a zero-length direction', () => {
    // NaN in a colour channel is a black frame with nothing in the log to say so.
    const sky = new SkySystem();
    expect(sky.mesh.material.fragmentShader).toContain('length(vViewDirection) > 1e-6');
    sky.dispose();
  });

  it('draws the sun, moon and stars back to front', () => {
    const sky = new SkySystem();
    const shader = sky.mesh.material.fragmentShader;
    const stars = shader.indexOf('starLayer(dir) * uStarOpacity');
    const moon = shader.indexOf('moon * uMoonOpacity');
    const sun = shader.indexOf('disc * uSunDisc');
    expect(stars).toBeGreaterThan(-1);
    expect(moon).toBeGreaterThan(stars);
    expect(sun).toBeGreaterThan(moon);
    sky.dispose();
  });
});

describe('the sample type', () => {
  it('carries everything the frame needs and nothing it does not', () => {
    const s: SkySample = sampleSkyAt(9.5);
    expect(Object.keys(s).sort()).toEqual(
      [
        'ambientColor',
        'ambientIntensity',
        'cloudOpacity',
        'hazeColor',
        'hemiGroundColor',
        'hemiIntensity',
        'hemiSkyColor',
        'horizonColor',
        'hour',
        'moonDirection',
        'moonOpacity',
        'starOpacity',
        'sunAzimuth',
        'sunColor',
        'sunDirection',
        'sunDiscOpacity',
        'sunElevation',
        'sunIntensity',
        'zenithColor',
      ].sort(),
    );
  });

  it('uses a default day length of 24 minutes, long enough to look still', () => {
    // A full day in 24 minutes means the sun moves 0.4 degrees a second - slow
    // enough that a player standing still never notices it, fast enough that
    // someone who waits sees the light change.
    expect(DEFAULT_DAY_LENGTH).toBe(1440);
    const cycle = new DayNightCycle({ hour: 12, paused: false });
    cycle.update(60);
    expect(cycle.hour - 12).toBeCloseTo(1, 1);
  });

  it('exposes the tutorial hour the world is built at', () => {
    expect(DEFAULT_TUTORIAL_HOUR).toBeGreaterThan(9);
    expect(DEFAULT_TUTORIAL_HOUR).toBeLessThan(10);
  });
});
