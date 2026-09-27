/**
 * CorruptionField.ts - ASTRA procedural world
 * =============================================================================
 * How rotten a place is, as a number between 0 and 1.
 *
 * This module is pure arithmetic over a spline. It has no Three.js import and
 * no scene graph, because three different consumers need the same answer and
 * none of them should have to reach through a world object to get it:
 *
 *   TerrainGenerator   bakes one corruption value per vertex, so the ground
 *                      itself can carry a fungal overlay in its material.
 *   Forest             bakes one value per tree instance, so the bark greys
 *                      and the crown droops tree by tree rather than all at
 *                      once across the map.
 *   CorruptionSystem   scatters the fungus, the spores and the dead matter
 *                      from the same field, so they agree with the ground.
 *
 * Two inputs, and the order matters
 * ---------------------------------
 *   pollution  how rotten the *water* is at the nearest point along the
 *              stream. The stream already owns this: 0.9 where it leaves the
 *              cave, 0.6 midstream, 0.2 by the village. `StreamProfile`
 *              computes it with a piecewise smoothstep, and the same curve is
 *              reproduced here so the terrain and the trees cannot disagree
 *              with the colour of the water they are standing next to.
 *   distance   how far the point is from the stream centreline, in metres.
 *
 * The shape of the answer
 * -----------------------
 * Corruption is strongest in the water and falls off to nothing over a reach
 * that *widens with pollution*. That second part is the whole story of the
 * fouled stream: the cave end is not only more rotten, it is rotten over a
 * larger area, because there is more of the stuff to spread. A fixed reach
 * would put a hard-edged ring of identical stage-1 blight around the entire
 * stream, which reads as a decal rather than as a contagion.
 *
 * The four stages are the plan's zones, mapped from the intensity so that a
 * threshold is one number rather than a scattering of magic constants:
 *
 *   0  clean       nothing visibly wrong
 *   1  outer       small fungus, dying plants, minor abnormalities
 *   2  middle      larger growths, strange colours, abnormal vegetation
 *   3  inner       enormous structures, twisted trees, glowing spores
 *
 * The thresholds are deliberately not evenly spaced. Stage 1 is meant to be
 * *subtle* - the style guide asks for corruption that progresses subtle,
 * visible, severe - so its band is wide and its start is high enough that the
 * village end of the stream stays clean-looking rather than faintly wrong.
 * =============================================================================
 */

import type { StreamSpline } from './StreamSpline';

/**
 * Arc position of the mid-stream zone, as a fraction of the spline.
 *
 * Must match `StreamProfile`'s own `MIDSTREAM_U`. Both are 0.5, and both are
 * named so that a reader can see they are the same number rather than having
 * to trust that they are.
 */
const MIDSTREAM_U = 0.5;

/** One of the plan's four corruption zones, as a small integer. */
export type CorruptionStage = 0 | 1 | 2 | 3;

/** The stages, in order, for iteration and for tests. */
export const CORRUPTION_STAGES: readonly CorruptionStage[] = [0, 1, 2, 3];

export interface CorruptionFieldOptions {
  /**
   * Metres from the stream centreline at which corruption reaches zero when
   * the water is clean (pollution 0).
   */
  reachMin: number;
  /**
   * The same reach when the water is fully polluted (pollution 1).
   *
   * The cave end of the stream therefore carries its blight roughly three
   * times further into the forest than the village end does.
   */
  reachMax: number;
  /**
   * Exponent applied to pollution before it scales the falloff.
   *
   * Below 1, so that a mildly polluted stream still reads as mildly affected:
   * pollution 0.2 becomes 0.30 rather than 0.2, and pollution 0.9 becomes
   * 0.92 rather than 0.9. The curve is convex, which is what keeps the village
   * end from looking diseased.
   */
  pollutionPower: number;
  /** Intensity at and above which stage 1 begins. */
  stage1Start: number;
  /** Intensity at and above which stage 2 begins. */
  stage2Start: number;
  /** Intensity at and above which stage 3 begins. */
  stage3Start: number;
}

/**
 * Defaults, exported so tests and the debug overlay can read them.
 *
 * A plain typed const rather than `as const`: an `as const` here would leak
 * the literal types `12` and `34` into every spread site, and an override of
 * `reachMin: 20` would then be a type error rather than a value.
 */
export const DEFAULT_CORRUPTION_FIELD_OPTIONS: CorruptionFieldOptions = {
  reachMin: 12,
  reachMax: 34,
  pollutionPower: 0.75,
  stage1Start: 0.08,
  stage2Start: 0.35,
  stage3Start: 0.7,
};

/** Smooth Hermite step from 0 to 1. Degenerate edges collapse to a hard step. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Pollution `t` of the way along the stream, 0 clean to 1 fully polluted.
 *
 * The same piecewise smoothstep `StreamProfile.pollutionAtDistance` uses, in
 * the same order. Kept as a free function so a caller with the arc-length
 * fraction already in hand does not have to construct a profile to ask.
 *
 * Zero derivative at both zone joins, so the gradient changes rate without a
 * visible kink in the middle of the water.
 */
export function pollutionAlongStream(
  t: number,
  upstream: number,
  midstream: number,
  downstream: number,
): number {
  const u = clamp01(t);
  if (u <= MIDSTREAM_U) {
    return upstream + (midstream - upstream) * smoothstep(0, MIDSTREAM_U, u);
  }
  return midstream + (downstream - midstream) * smoothstep(MIDSTREAM_U, 1, u);
}

/** The three zone values `StreamProfile` ships with. */
export const DEFAULT_POLLUTION_ZONES = {
  upstream: 0.9,
  midstream: 0.6,
  downstream: 0.2,
} as const;

/**
 * Corruption intensity at `distance` metres from the stream, where the water
 * carries `pollution`.
 *
 * Returns 0 outside the reach and `pollution` at the centreline. The falloff
 * is a smoothstep in the *scaled* distance, so the bank is fully corrupted and
 * the edge of the reach is clean, with no flat top and no hard ring.
 */
export function corruptionIntensity(
  distance: number,
  pollution: number,
  options: Partial<CorruptionFieldOptions> = {},
): number {
  const o = { ...DEFAULT_CORRUPTION_FIELD_OPTIONS, ...options };
  if (!Number.isFinite(distance) || distance < 0) return 0;
  if (!Number.isFinite(pollution) || pollution <= 0) return 0;

  const p = clamp01(pollution);
  // The reach widens with the pollution. At p = 0 the reach is `reachMin`,
  // which is why a clean stream still shows nothing: `p` is 0 and the whole
  // expression collapses.
  const reach = o.reachMin + (o.reachMax - o.reachMin) * p;
  if (distance >= reach) return 0;

  const falloff = 1 - smoothstep(0, reach, distance);
  return clamp01(Math.pow(p, o.pollutionPower) * falloff);
}

/** Which of the four zones an intensity falls in. */
export function corruptionStage(
  intensity: number,
  options: Partial<CorruptionFieldOptions> = {},
): CorruptionStage {
  const o = { ...DEFAULT_CORRUPTION_FIELD_OPTIONS, ...options };
  const i = Number.isFinite(intensity) ? clamp01(intensity) : 0;
  if (i >= o.stage3Start) return 3;
  if (i >= o.stage2Start) return 2;
  if (i >= o.stage1Start) return 1;
  return 0;
}

/** How the field itself is built, as opposed to the curve it evaluates. */
export interface CorruptionFieldBuildOptions {
  /** Lattice resolution. Higher is finer and slower to build. */
  resolution: number;
  /** Distance beyond which the field stops caring, in metres. */
  maxInfluence: number;
  /** The three stream pollution zones, in order along the spline. */
  upstream: number;
  midstream: number;
  downstream: number;
}

/**
 * Defaults for the field's own construction, separate from the curve's.
 *
 * `maxInfluence` is 60 rather than the spline's own 90: the corruption reach
 * tops out at 34 m, so sampling further out than that is work spent producing
 * zeros.
 */
export const DEFAULT_CORRUPTION_FIELD_BUILD: CorruptionFieldBuildOptions = {
  resolution: 256,
  maxInfluence: 60,
  upstream: DEFAULT_POLLUTION_ZONES.upstream,
  midstream: DEFAULT_POLLUTION_ZONES.midstream,
  downstream: DEFAULT_POLLUTION_ZONES.downstream,
};

/**
 * The corruption field over the whole world, built once.
 *
 * `StreamSpline.nearestField` gives both the distance and the arc length of
 * the nearest point in one pass, and the arc length is what turns a distance
 * into a pollution. Building it here once means every later query is two
 * array reads - which matters, because `Forest` asks this thousands of times
 * during placement and a sampler that walked the spline's polyline per call
 * would turn a 300 ms construction into a twenty second one.
 *
 * The resolution is higher than the forest's own field (256 against 128)
 * because the corruption reach is tens of metres rather than two hundred: a
 * 2 m lattice would blur the bank, and the bank is where the player notices.
 */
export class CorruptionField {
  readonly spline: StreamSpline;
  readonly size: number;
  readonly resolution: number;
  readonly step: number;
  readonly half: number;

  private readonly distance: Float32Array;
  private readonly arcLength: Float32Array;
  private readonly length: number;
  private readonly build: CorruptionFieldBuildOptions;

  constructor(spline: StreamSpline, options: Partial<CorruptionFieldBuildOptions> & { size?: number } = {}) {
    this.spline = spline;
    // 500 m, matching `TERRAIN_SIZE`. A field any smaller than the terrain
    // would leave the far bank of the world answering zero for a question it
    // should be able to answer.
    this.size = options.size ?? 500;
    this.resolution = Math.max(2, Math.floor(options.resolution ?? DEFAULT_CORRUPTION_FIELD_BUILD.resolution));
    this.step = this.size / (this.resolution - 1);
    this.half = this.size / 2;
    this.build = {
      resolution: this.resolution,
      maxInfluence: options.maxInfluence ?? DEFAULT_CORRUPTION_FIELD_BUILD.maxInfluence,
      upstream: options.upstream ?? DEFAULT_CORRUPTION_FIELD_BUILD.upstream,
      midstream: options.midstream ?? DEFAULT_CORRUPTION_FIELD_BUILD.midstream,
      downstream: options.downstream ?? DEFAULT_CORRUPTION_FIELD_BUILD.downstream,
    };

    const nearest = spline.nearestField(this.size, this.resolution, this.build.maxInfluence);
    this.distance = nearest.distance;
    this.arcLength = nearest.arcLength;
    this.length = spline.length;
  }

  /** Row-major index of the lattice cell containing a world position. */
  private index(x: number, z: number): number {
    const res = this.resolution;
    const j = Math.min(res - 1, Math.max(0, Math.round((x + this.half) / this.step)));
    const i = Math.min(res - 1, Math.max(0, Math.round((z + this.half) / this.step)));
    return i * res + j;
  }

  /** Metres from a world position to the stream centreline. */
  distanceAt(x: number, z: number): number {
    return this.distance[this.index(x, z)];
  }

  /** 0..1 pollution of the water at the nearest point along the stream. */
  pollutionAt(x: number, z: number): number {
    const k = this.index(x, z);
    if (this.distance[k] >= this.build.maxInfluence) return 0;
    const t = this.length > 0 ? this.arcLength[k] / this.length : 0;
    return pollutionAlongStream(t, this.build.upstream, this.build.midstream, this.build.downstream);
  }

  /** 0..1 corruption intensity at a world position. */
  corruptionAt(x: number, z: number): number {
    const k = this.index(x, z);
    const distance = this.distance[k];
    if (distance >= this.build.maxInfluence) return 0;
    const t = this.length > 0 ? this.arcLength[k] / this.length : 0;
    const pollution = pollutionAlongStream(
      t,
      this.build.upstream,
      this.build.midstream,
      this.build.downstream,
    );
    return corruptionIntensity(distance, pollution);
  }

  /** Which of the four zones a world position falls in. */
  stageAt(x: number, z: number): CorruptionStage {
    return corruptionStage(this.corruptionAt(x, z));
  }
}
