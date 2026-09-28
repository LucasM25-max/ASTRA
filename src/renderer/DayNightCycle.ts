/**
 * DayNightCycle.ts - ASTRA renderer
 * =============================================================================
 * The clock, and the one function that decides what the world looks like at a
 * given hour.
 *
 * Step 2.6 asks for three things that are easy to build as three unrelated
 * things and wrong that way:
 *
 *   - a procedural sky whose gradient follows the time of day,
 *   - a sun position that drives the lighting direction,
 *   - and sky colours that influence the ambient light and the fog.
 *
 * All three are the same question - "where is the sun, and how much air is
 * between it and the ground" - so they are answered in one place. `sampleSkyAt`
 * is a pure function of the hour that returns every colour and every intensity
 * the frame needs, and the cycle is nothing more than a clock that calls it and
 * hands the result to the sky, the light rig and the fog. There is no second
 * place where a colour is chosen, so the sky, the sunlight, the shadows' fill
 * and the haze cannot disagree about what time it is.
 *
 * The tutorial holds a fixed late morning. The cycle is fully implemented and
 * paused, per the plan, so Phase 3 can start it with one flag.
 * =============================================================================
 */

import { Color, Vector3 } from 'three';

/** Hours in a day. The cycle wraps here. */
export const HOURS_PER_DAY = 24;

/**
 * The tutorial's fixed hour: late morning.
 *
 * Chosen so the sun is high enough to light the forest floor but low enough to
 * throw long shadows through the canopy - the style guide's "slightly angled
 * for long shadows". At 9.5 the sun sits at ~47 degrees, which is the whole
 * point: a noon sun at 60 degrees flattens the trunks into the ground.
 */
export const DEFAULT_TUTORIAL_HOUR = 9.5;

/** Peak sun elevation, in degrees. A temperate-zone summer noon. */
export const DEFAULT_MAX_ELEVATION = 60;

/** Hour the sun crosses the horizon in the east. */
const SUNRISE_HOUR = 6;

/** Seconds of game time for a full cycle. Only used when the cycle is running. */
export const DEFAULT_DAY_LENGTH = 1440;

/**
 * A complete lighting and atmosphere state for one instant.
 *
 * Every colour is an sRGB hex, because that is what `new Color(hex)` and every
 * existing ASTRA setter take. The sampler interpolates in Three's linear
 * working space - the same space the renderer composites in - so a halfway
 * hour is a halfway *light*, not a halfway *number*.
 */
export interface SkySample {
  /** The hour this sample was taken at, wrapped to [0, 24). */
  hour: number;
  /** Sun elevation above the horizon, in radians. Negative at night. */
  sunElevation: number;
  /** Sun azimuth, in radians, measured from +x (east) towards +z (south). */
  sunAzimuth: number;
  /** Unit vector from the world towards the sun. */
  sunDirection: Vector3;
  /** Unit vector from the world towards the moon. Never both up at once. */
  moonDirection: Vector3;
  /** Zenith and horizon colours of the sky dome, as sRGB hex. */
  zenithColor: number;
  horizonColor: number;
  /** The sun's own colour and intensity. */
  sunColor: number;
  sunIntensity: number;
  /** The cool fill that keeps shadows readable. */
  ambientColor: number;
  ambientIntensity: number;
  /** Hemisphere light: sky above, earth below. */
  hemiSkyColor: number;
  hemiGroundColor: number;
  hemiIntensity: number;
  /** The fog's haze colour, which follows the horizon. */
  hazeColor: number;
  /** 0 in daylight, 1 at night. */
  starOpacity: number;
  moonOpacity: number;
  /** How much of the sky the cloud layer covers. */
  cloudOpacity: number;
  /** The sun disc's own visibility, so it fades rather than clipping. */
  sunDiscOpacity: number;
}

/**
 * One rung of the sky's ladder.
 *
 * Keyed on the sun's ELEVATION, not on the hour. That is the whole design: an
 * hour-keyed table has to be re-tuned every time the day length or the peak
 * elevation changes, and it silently breaks at the solstice. An elevation-keyed
 * table is the physical thing that actually drives the light.
 */
export interface SkyKeyframe {
  /** Sun elevation in degrees. Interpolation runs downwards through the table. */
  elevation: number;
  zenith: number;
  horizon: number;
  sun: number;
  sunIntensity: number;
  ambient: number;
  ambientIntensity: number;
  hemiSky: number;
  hemiIntensity: number;
  haze: number;
  starOpacity: number;
  moonOpacity: number;
  cloudOpacity: number;
  sunDisc: number;
}

/**
 * The ladder, from noon to deep night.
 *
 * The earthy restraint the style guide asks for is enforced here rather than in
 * the sky shader: nothing in this table is a saturated colour, and the only warm
 * entries are the sun itself and the horizon at golden hour. The zenith stays
 * desaturated blue at every hour so the sky never competes with the fantasy
 * elements that are supposed to pop against it.
 */
/**
 * Exported so the tests can assert the sample never leaves the range the ladder
 * spans. That single invariant is what catches an interpolation that runs past a
 * rung, which is the failure that produces a negative light intensity.
 */
export const SKY_LADDER: readonly SkyKeyframe[] = [
  {
    elevation: 60,
    zenith: 0x3f7cb0,
    horizon: 0xdfeaf2,
    sun: 0xfff4e2,
    sunIntensity: 2.9,
    ambient: 0xa8bdd4,
    ambientIntensity: 1.0,
    hemiSky: 0xbcd4ea,
    hemiIntensity: 0.6,
    haze: 0xbfd0da,
    starOpacity: 0,
    moonOpacity: 0,
    cloudOpacity: 0.78,
    sunDisc: 1,
  },
  {
    // The Step 2.5 rig, which is what the world was tuned and verified against.
    elevation: 22,
    zenith: 0x4a7ea8,
    horizon: 0xe8eef2,
    sun: 0xfff1d6,
    sunIntensity: 2.6,
    ambient: 0xa8bdd4,
    ambientIntensity: 0.9,
    hemiSky: 0xbcd4ea,
    hemiIntensity: 0.55,
    haze: 0xc6d2d6,
    starOpacity: 0,
    moonOpacity: 0,
    cloudOpacity: 0.62,
    sunDisc: 1,
  },
  {
    // Golden hour. The sun warms, the shadows' fill cools, the horizon glows.
    elevation: 6,
    zenith: 0x5a86b0,
    horizon: 0xf0d2a8,
    sun: 0xffc878,
    sunIntensity: 2.3,
    ambient: 0xa8b8cc,
    ambientIntensity: 0.75,
    hemiSky: 0xc4ced8,
    hemiIntensity: 0.5,
    haze: 0xd8ccbc,
    starOpacity: 0,
    moonOpacity: 0,
    cloudOpacity: 0.78,
    sunDisc: 1,
  },
  {
    elevation: 0,
    zenith: 0x3a5a80,
    horizon: 0xe08a58,
    sun: 0xff9a52,
    sunIntensity: 1.3,
    ambient: 0x8a90a8,
    ambientIntensity: 0.5,
    hemiSky: 0xa8a8bc,
    hemiIntensity: 0.42,
    haze: 0xd0a888,
    starOpacity: 0.05,
    moonOpacity: 0.1,
    cloudOpacity: 0.85,
    sunDisc: 1,
  },
  {
    elevation: -5,
    zenith: 0x24365c,
    horizon: 0xa05a4e,
    sun: 0xff7a3a,
    sunIntensity: 0.35,
    ambient: 0x5a6480,
    ambientIntensity: 0.32,
    hemiSky: 0x6a7488,
    hemiIntensity: 0.3,
    haze: 0xa87868,
    starOpacity: 0.35,
    moonOpacity: 0.45,
    cloudOpacity: 0.8,
    sunDisc: 0.7,
  },
  {
    elevation: -12,
    zenith: 0x141e38,
    horizon: 0x4e3a4a,
    sun: 0x8a4a3a,
    sunIntensity: 0.06,
    ambient: 0x303c58,
    ambientIntensity: 0.2,
    hemiSky: 0x3e4a60,
    hemiIntensity: 0.22,
    haze: 0x5a4858,
    starOpacity: 0.7,
    moonOpacity: 0.8,
    cloudOpacity: 0.6,
    sunDisc: 0.15,
  },
  {
    elevation: -25,
    zenith: 0x070b16,
    horizon: 0x121a2a,
    sun: 0x2a3a5a,
    sunIntensity: 0,
    ambient: 0x1a2438,
    ambientIntensity: 0.14,
    hemiSky: 0x243050,
    hemiIntensity: 0.16,
    haze: 0x1e2636,
    starOpacity: 1,
    moonOpacity: 1,
    cloudOpacity: 0.4,
    sunDisc: 0,
  },
];

/**
 * The earth the hemisphere light's lower half bounces off.
 *
 * Not a keyframe: it is derived from the haze, because that is what it is. The
 * light that reaches the ground and comes back up has been through the same air
 * the fog is made of, so the ground bounce warms when the haze warms and goes
 * blue when the haze goes blue. Keyframing it separately is how the two end up
 * disagreeing at golden hour - warm light from above, green bounce from below,
 * and a shadow that reads as two different times of day at once.
 */
/** Exported so the derivation can be asserted exactly rather than eyeballed. */
export const HEMI_GROUND_BASE = 0x5c6b3a;

const DEG2RAD = Math.PI / 180;

/** Wrap an hour into [0, 24). */
export function wrapHour(hour: number): number {
  if (!Number.isFinite(hour)) return DEFAULT_TUTORIAL_HOUR;
  const wrapped = hour % HOURS_PER_DAY;
  return wrapped < 0 ? wrapped + HOURS_PER_DAY : wrapped;
}

/**
 * The sun's elevation and azimuth for an hour.
 *
 * A single great circle: the sun rises due east, crosses the meridian at
 * `maxElevation`, and sets due west. The elevation is a sine over the twelve
 * hours of daylight, so it is 0 at sunrise and sunset and peaks at noon, and it
 * goes NEGATIVE outside the day - which is the point. A `max(0, ...)` clamp here
 * would put the sun on the horizon all night and the moon would have nothing to
 * rise against.
 */
export function sunPlacement(
  hour: number,
  maxElevationDegrees: number = DEFAULT_MAX_ELEVATION,
): { elevation: number; azimuth: number } {
  const dayFraction = (wrapHour(hour) - SUNRISE_HOUR) / 12;
  const elevation = maxElevationDegrees * DEG2RAD * Math.sin(Math.PI * dayFraction);
  // Sweep east (+x) to west (-x) over the day, so the shadows swing with the sun
  // rather than rotating around it.
  const azimuth = Math.PI * dayFraction;
  return { elevation, azimuth };
}

/** Turn an elevation and azimuth into a unit direction. */
export function directionFrom(elevation: number, azimuth: number, out = new Vector3()): Vector3 {
  const horizontal = Math.cos(elevation);
  return out.set(
    horizontal * Math.cos(azimuth),
    Math.sin(elevation),
    horizontal * Math.sin(azimuth),
  );
}

/** Linear interpolation between two sRGB hex colours, in Three's working space. */
function lerpHex(from: number, to: number, t: number): number {
  const a = new Color(from);
  const b = new Color(to);
  return a.lerp(b, t).getHex();
}

/**
 * Every colour and intensity the frame needs, for one hour.
 *
 * Pure, and cheap enough to call every frame: it allocates a handful of Colors
 * and does no I/O. Nothing here reads the clock, the renderer or the scene, so
 * the whole visual behaviour of the day/night cycle is testable without a GPU -
 * which is the only reason the table above could be tuned with any confidence.
 */
export function sampleSkyAt(hour: number, maxElevationDegrees = DEFAULT_MAX_ELEVATION): SkySample {
  const h = wrapHour(hour);
  const { elevation, azimuth } = sunPlacement(h, maxElevationDegrees);
  const elevationDegrees = elevation / DEG2RAD;

  // Find the two rungs this elevation sits between. The ladder runs from high
  // to low, so the first rung at or below the elevation is the lower bound.
  let lower = SKY_LADDER[SKY_LADDER.length - 1];
  let upper = SKY_LADDER[0];
  for (let i = 0; i < SKY_LADDER.length - 1; i++) {
    if (elevationDegrees <= SKY_LADDER[i].elevation && elevationDegrees >= SKY_LADDER[i + 1].elevation) {
      upper = SKY_LADDER[i];
      lower = SKY_LADDER[i + 1];
      break;
    }
  }
  const span = upper.elevation - lower.elevation;
  // CLAMPED. Without the clamp, an elevation below the ladder's last rung - which
  // is every hour of deep night, since the sun reaches -60 degrees at midnight
  // against a -25 degree floor - extrapolates past it. `t` reaches 1.41, and a
  // linear extrapolation of an intensity that is already 0 at the last rung goes
  // NEGATIVE: the sample reported a sun intensity of -1.19 at midnight. A
  // negative light intensity is not clamped anywhere downstream, so it subtracts
  // light from the world and the night comes out darker than black.
  const t = span > 1e-6 ? Math.min(1, Math.max(0, (upper.elevation - elevationDegrees) / span)) : 0;

  const mix = (key: keyof Omit<SkyKeyframe, 'elevation'>): number => {
    const from = upper[key] as number;
    const to = lower[key] as number;
    return key === 'sunIntensity' ||
      key === 'ambientIntensity' ||
      key === 'hemiIntensity' ||
      key === 'starOpacity' ||
      key === 'moonOpacity' ||
      key === 'cloudOpacity' ||
      key === 'sunDisc'
      ? from + (to - from) * t
      : lerpHex(from, to, t);
  };

  // The moon is the sun's mirror image, twelve hours out. That keeps exactly one
  // of them above the horizon at any hour, and it means the night has a light
  // source that moves - which a fixed moon disc does not, and the difference
  // shows the moment the player looks up twice.
  const moon = sunPlacement(h + 12, maxElevationDegrees);

  const hemiGround = new Color(HEMI_GROUND_BASE).lerp(new Color(mix('haze')), 0.35).getHex();

  return {
    hour: h,
    sunElevation: elevation,
    sunAzimuth: azimuth,
    sunDirection: directionFrom(elevation, azimuth),
    moonDirection: directionFrom(moon.elevation, moon.azimuth),
    zenithColor: mix('zenith'),
    horizonColor: mix('horizon'),
    sunColor: mix('sun'),
    sunIntensity: mix('sunIntensity'),
    ambientColor: mix('ambient'),
    ambientIntensity: mix('ambientIntensity'),
    hemiSkyColor: mix('hemiSky'),
    hemiGroundColor: hemiGround,
    hemiIntensity: mix('hemiIntensity'),
    hazeColor: mix('haze'),
    starOpacity: mix('starOpacity'),
    moonOpacity: mix('moonOpacity'),
    cloudOpacity: mix('cloudOpacity'),
    sunDiscOpacity: mix('sunDisc'),
  };
}

/** Anything the cycle can recolour. Implemented by SkySystem. */
export interface SkyStateTarget {
  applySkyState(sample: SkySample): void;
}

/** Anything the cycle can relight. Implemented by LightingSystem. */
export interface LightingStateTarget {
  applySkyState(sample: SkySample): void;
}

export interface DayNightCycleOptions {
  /** Starting hour. Defaults to the tutorial's late morning. */
  hour?: number;
  /** Seconds of game time for a full 24 h cycle. */
  dayLength?: number;
  /** Peak sun elevation in degrees. */
  maxElevation?: number;
  /**
   * Hold the clock still. Defaults to true - the plan asks for the cycle to be
   * implemented but paused for the tutorial, and a world whose sun moves during
   * the first five minutes of play is a world the player cannot learn.
   */
  paused?: boolean;
}

/**
 * The clock, and the wiring that keeps the sky, the lights and the fog in step.
 *
 * The cycle owns nothing that renders. It advances a number, samples the ladder
 * once, and hands the result to whatever has been attached - so the same clock
 * can drive the sky, the sun, the ambient fill and the haze without any of them
 * knowing the others exist.
 */
export class DayNightCycle {
  private hourValue: number;
  private readonly dayLength: number;
  private readonly maxElevation: number;
  private pausedValue: boolean;
  private sampleValue: SkySample;

  private skyTarget: SkyStateTarget | null = null;
  private lightingTarget: LightingStateTarget | null = null;

  /** Called whenever the haze colour changes, with the new sRGB hex. */
  onHazeChange: ((hazeColor: number) => void) | null = null;

  constructor(options: DayNightCycleOptions = {}) {
    this.dayLength = Math.max(1, options.dayLength ?? DEFAULT_DAY_LENGTH);
    this.maxElevation = Math.max(1, options.maxElevation ?? DEFAULT_MAX_ELEVATION);
    this.pausedValue = options.paused ?? true;
    this.hourValue = wrapHour(options.hour ?? DEFAULT_TUTORIAL_HOUR);
    this.sampleValue = this.takeSample();
  }

  /** The current hour, wrapped to [0, 24). */
  get hour(): number {
    return this.hourValue;
  }

  set hour(value: number) {
    this.hourValue = wrapHour(value);
    this.refresh();
  }

  /** True while the clock is held still. */
  get paused(): boolean {
    return this.pausedValue;
  }

  /** Resume the cycle. The tutorial calls this when the day is allowed to pass. */
  resume(): void {
    this.pausedValue = false;
  }

  /** Hold the cycle where it is. */
  pause(): void {
    this.pausedValue = true;
  }

  /** The most recent sample. Never recomputes, so it is safe to call per frame. */
  get sample(): SkySample {
    return this.sampleValue;
  }

  /** The fog's haze colour for the current hour. */
  get hazeColor(): number {
    return this.sampleValue.hazeColor;
  }

  /** Attach a sky. Returns this, for chaining. */
  attachSky(sky: SkyStateTarget | null): this {
    this.skyTarget = sky;
    if (sky) sky.applySkyState(this.sampleValue);
    return this;
  }

  /** Attach a light rig. Returns this, for chaining. */
  attachLighting(lighting: LightingStateTarget | null): this {
    this.lightingTarget = lighting;
    if (lighting) lighting.applySkyState(this.sampleValue);
    return this;
  }

  /**
   * Advance the clock by `delta` seconds of *game* time.
   *
   * Pass `TimeController.getDelta()`, so the sun slows and freezes with the rest
   * of the world during time dilation - a paused sun during an Active Encounter
   * is correct, and one that keeps moving is not.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    if (this.pausedValue) return;
    this.hourValue = wrapHour(this.hourValue + (delta / this.dayLength) * HOURS_PER_DAY);
    this.refresh();
  }

  /** Jump straight to an hour, as `hh:mm` or a decimal. */
  setTime(hour: number, minute = 0): void {
    this.hourValue = wrapHour(hour + minute / 60);
    this.refresh();
  }

  /** Re-sample and push the result everywhere it needs to go. */
  private refresh(): void {
    const previousHaze = this.sampleValue.hazeColor;
    this.sampleValue = this.takeSample();
    this.skyTarget?.applySkyState(this.sampleValue);
    this.lightingTarget?.applySkyState(this.sampleValue);
    if (this.sampleValue.hazeColor !== previousHaze) {
      this.onHazeChange?.(this.sampleValue.hazeColor);
    }
  }

  private takeSample(): SkySample {
    return sampleSkyAt(this.hourValue, this.maxElevation);
  }
}
