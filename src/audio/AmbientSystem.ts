/**
 * AmbientSystem.ts - ASTRA audio
 * =============================================================================
 * The sound of standing in the forest.
 *
 * What this is
 * ------------
 * Six layers, all synthesised, all positioned through Howler:
 *
 *   wind        a low gust loop, driven by the same gust multiplier the trees
 *               sway by. One number, read by both - see `Forest.windGustUniform`.
 *   leaves      a rustle loop, louder in the canopy and lifted by the gust.
 *   birds       one-shot calls at scattered azimuths around the listener, thinned
 *               out and quietened by corruption.
 *   wildlife    sparse distant calls, much rarer than the birds.
 *   hum         the corruption's low drone, silent on clean ground.
 *   squelch     an occasional wet organic noise, only where the rot is.
 *   footsteps   one-shot impacts, surface-detected and cadence-matched to the
 *               character's own stride.
 *
 * The plan asks for spatial positioning "via Web Audio API or Howler.js". It is
 * Howler.js, for the reasons `WaterAudio` already documents: Howler's core build
 * exposes `Howler.pos()` for the listener and `Howl.stereo()` for a source's
 * pan, which is enough to place a sound properly, whereas the full 3D spatial
 * plugin is a minified IIFE that reaches for a bare `HowlerGlobal` global the
 * UMD core build does not set when loaded as a module - which is how Vite loads
 * it. So the geometry is computed here and handed to Howler.
 *
 * What "spatial" means for an ambient bed
 * ---------------------------------------
 * The wind and the leaves are deliberately *not* positioned. They are the air;
 * there is no direction to them, and panning an air sound is the fastest way to
 * make a forest sound like a pair of headphones. What is positioned is
 * everything with a location:
 *
 *   the listener      `Howler.pos(camera)` every frame, so the stream's sound and
 *                     anything added later inherit a correct listener for free.
 *   the one-shots     each bird, animal and squelch is given an azimuth and a
 *                     radius around the listener, and panned by `sin(azimuth)`.
 *                     A source dead ahead or dead behind is centred; a source at
 *                     +/-90 degrees is hard left or right. That is the correct
 *                     pan for a listener facing forward, and it is why the calls
 *                     move around the player rather than sitting in the middle
 *                     of the mix.
 *   the stream        already positioned by `WaterAudio`, which this system
 *                     forwards its mute state to so one switch silences
 *                     everything.
 *
 * How the layers are mixed
 * ------------------------
 * All of it goes through `ambientMix`, a pure function of one frame struct. That
 * is not decoration: there is no `AudioContext` in a test environment, so the
 * only part of this system a test can exercise is the arithmetic, and the
 * arithmetic is where the bugs would be. `AmbientSystem.update` reads the mix and
 * writes volumes; the mix itself is testable, and the tests read the real
 * artifact rather than recomputing it.
 *
 * Node and jsdom
 * --------------
 * There is no `AudioContext` in a test environment, so the constructor builds
 * nothing and every method is a no-op. The mixing and the scheduling still run,
 * which is what lets the world be stepped in tests with the audio present.
 * =============================================================================
 */

import { Howl, Howler } from 'howler';
import type { WaterAudio } from './WaterAudio';
import {
  DEFAULT_SAMPLE_RATE,
  FOOTSTEP_SURFACES,
  clipDataUri,
  packSprites,
  renderBirdCall,
  renderCorruptionHum,
  renderDistantCall,
  renderFootstep,
  renderLeafRustle,
  renderSquelch,
  renderWind,
  type FootstepSurface,
} from './SoundForge';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/** Peak volume of the wind layer at a full gust, 0 to 1. */
export const DEFAULT_WIND_VOLUME = 0.3;

/** Peak volume of the leaf-rustle layer, 0 to 1. */
export const DEFAULT_LEAF_VOLUME = 0.2;

/** Peak volume of a bird call, 0 to 1. */
export const DEFAULT_BIRD_VOLUME = 0.3;

/** Peak volume of a distant animal call, 0 to 1. */
export const DEFAULT_WILDLIFE_VOLUME = 0.18;

/** Peak volume of the corruption hum, 0 to 1. */
export const DEFAULT_HUM_VOLUME = 0.3;

/** Peak volume of an organic squelch, 0 to 1. */
export const DEFAULT_SQUELCH_VOLUME = 0.32;

/** Peak volume of a footstep, 0 to 1. */
export const DEFAULT_FOOTSTEP_VOLUME = 0.35;

/**
 * How much of the wind's loudness survives at zero gust.
 *
 * Not zero, and deliberately: a forest with no wind at all is a dead recording,
 * and the gust is the *variation*, not the sound. 0.35 leaves a floor of moving
 * air under everything.
 */
export const WIND_GUST_FLOOR = 0.35;

/**
 * How much of the leaf rustle survives at zero gust.
 *
 * Lower than the wind's floor, because leaves that rustle with no wind are
 * leaves being moved by something that is not the wind - which in this world is
 * either wrong or ominous.
 */
export const LEAF_GUST_FLOOR = 0.12;

/**
 * How much of the bird chorus survives on fully corrupted ground.
 *
 * Zero would be the honest answer and the wrong one: a forest with no birds at
 * all reads as broken rather than as blighted, and the plan asks for *reduced*
 * calls, not silent ones.
 */
export const CORRUPTION_BIRD_FLOOR = 0.12;

/**
 * Corruption above which the hum is audible at all, and the exponent it ramps on.
 *
 * The exponent is above 1 so clean ground is genuinely silent rather than
 * faintly droning. A linear ramp from zero would put an audible hum under the
 * whole forest, and the rot would stop being a place you walk into.
 */
export const HUM_ONSET = 0.12;
export const HUM_RAMP = 2.2;

/** Corruption at which squelches reach their base rate. */
export const SQUELCH_ONSET = 0.3;
export const SQUELCH_RAMP = 3;

/**
 * Spread of the gaps between one variant's calls, in seconds.
 *
 * These are per-variant *spreads*, not the rate: the total rate is a separate
 * number and the scheduler works out what each variant's interval has to be for
 * the variants together to produce it. Conflating the two - which is what the
 * first version of this did - means the rate a layer actually runs at depends on
 * how many variants it happens to have.
 */
export const BIRD_INTERVAL_NEAR = 5;
export const BIRD_INTERVAL_FAR = 12;

export const WILDLIFE_INTERVAL_NEAR = 15;
export const WILDLIFE_INTERVAL_FAR = 40;

export const SQUELCH_INTERVAL_NEAR = 2.5;
export const SQUELCH_INTERVAL_FAR = 12.5;

/**
 * Calls per second each one-shot layer makes at full strength.
 *
 * A bird call every four and a half seconds, an animal every twenty. These are
 * totals across all of a layer's variants, so adding a seventh bird call makes
 * the chorus busier rather than making each bird lazier.
 */
export const BIRD_BASE_RATE = 0.22;
export const WILDLIFE_BASE_RATE = 0.05;

/** How deep the water must be at the player's feet to count as wading, in metres. */
export const WATER_WADE_DEPTH = 0.12;

/** Radius of the ring the bird calls are scattered over, in metres. */
export const BIRD_RADIUS_NEAR = 7;
export const BIRD_RADIUS_FAR = 34;

/** Radius of the ring the animal calls are scattered over, in metres. */
export const WILDLIFE_RADIUS_NEAR = 18;
export const WILDLIFE_RADIUS_FAR = 60;

/** Radius of the ring the squelches come from, in metres. */
export const SQUELCH_RADIUS_NEAR = 1.5;
export const SQUELCH_RADIUS_FAR = 6;

/** Distance at which a scattered source has faded to about half its gain. */
const SOURCE_FALLOFF = 55;

/** How many distinct bird calls to synthesise. */
export const DEFAULT_BIRD_VARIANTS = 6;

/** How many distinct animal calls to synthesise. */
export const DEFAULT_WILDLIFE_VARIANTS = 3;

/** How many distinct squelches to synthesise. */
export const DEFAULT_SQUELCH_VARIANTS = 3;

/** How many variants of each footstep surface to synthesise. */
export const DEFAULT_FOOTSTEP_VARIANTS = 4;

/* -------------------------------------------------------------------------- */
/* Frame and mix                                                              */
/* -------------------------------------------------------------------------- */

/** Everything the mix needs to know about the world this frame. */
export interface AmbientAudioFrame {
  /** Where the ears are. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit forward direction. Only the XZ part is used. */
  readonly forwardX: number;
  readonly forwardZ: number;
  /** 0 clean to 1 fully rotted, at the listener. */
  readonly corruption: number;
  /** 0 calm to 1 full gust - the same number the trees sway by. */
  readonly gust: number;
  /** 0 bare ground to 1 deep forest, around the listener. */
  readonly canopy: number;
  /** What the player is standing on, or null when airborne. */
  readonly surface: FootstepSurface | null;
  /** 0 to 1 position within the stride cycle. Ignored when `footfallInterval` is 0. */
  readonly stridePhase: number;
  /** Seconds between footfalls. 0 when not striding. */
  readonly footfallInterval: number;
}

/** The resolved layer levels for one frame. */
export interface AmbientMix {
  /** Wind layer volume. */
  readonly wind: number;
  /** Leaf-rustle layer volume. */
  readonly leaves: number;
  /** Bird layer volume, applied to every call. */
  readonly birds: number;
  /** Wildlife layer volume. */
  readonly wildlife: number;
  /** Corruption hum volume. */
  readonly hum: number;
  /** Squeches per second at this corruption. */
  readonly squelchRate: number;
  /**
   * 0 to 1 chorusing strength, before the layer gain.
   *
   * The reciprocal is how much longer the gaps between calls get. It is
   * reported separately from `birds` because "how loud" and "how often" are
   * different questions, and deriving the second from the first ties the call
   * rate to whatever the mix level happens to be - so retuning the volume of the
   * birds silently retunes how many there are.
   */
  readonly birdDensity: number;
  /** The same for the animal calls, which thin with corruption but not canopy. */
  readonly wildlifeDensity: number;
}

/** The layer peaks, so a caller can retune the whole mix from one place. */
export interface AmbientTuning {
  wind: number;
  leaves: number;
  birds: number;
  wildlife: number;
  hum: number;
  squelch: number;
  footstep: number;
}

export const DEFAULT_AMBIENT_TUNING: AmbientTuning = {
  wind: DEFAULT_WIND_VOLUME,
  leaves: DEFAULT_LEAF_VOLUME,
  birds: DEFAULT_BIRD_VOLUME,
  wildlife: DEFAULT_WILDLIFE_VOLUME,
  hum: DEFAULT_HUM_VOLUME,
  squelch: DEFAULT_SQUELCH_VOLUME,
  footstep: DEFAULT_FOOTSTEP_VOLUME,
};

/** A frame with nothing in it, used to seed the mix before the first update. */
const EMPTY_FRAME: AmbientAudioFrame = {
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
};

/** Clamp to [0, 1], mapping anything non-finite to 0. */
function unit(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** Smooth Hermite step from 0 to 1 over [edge0, edge1]. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Resolve one frame into layer volumes.
 *
 * Pure, and the only place the mixing rules live - which is the point. The rules
 * are the part of an audio system that goes wrong quietly, and a pure function
 * over a plain struct is the only version of them a test can actually check.
 *
 * The shape of the mix:
 *
 *   wind     always present, lifted by the gust and slightly damped inside the
 *            canopy, because the trees take the top off it.
 *   leaves   scales with the canopy and lifts hard with the gust.
 *   birds    scale with the canopy and fall away with corruption, to a floor.
 *   wildlife like the birds, but quieter and with no canopy term - an animal
 *            calling across a clearing is as audible as one calling under trees.
 *   hum      zero on clean ground, then a convex ramp. It never displaces the
 *            birds entirely; it arrives alongside them thinning out.
 *   squelch  a rate rather than a level, because it is an event. Zero below the
 *            onset, then a steep ramp.
 */
export function ambientMix(frame: AmbientAudioFrame, tuning: AmbientTuning = DEFAULT_AMBIENT_TUNING): AmbientMix {
  const corruption = unit(frame.corruption);
  const gust = unit(frame.gust);
  const canopy = unit(frame.canopy);

  const windGust = WIND_GUST_FLOOR + (1 - WIND_GUST_FLOOR) * gust;
  const leafGust = LEAF_GUST_FLOOR + (1 - LEAF_GUST_FLOOR) * gust;

  // How much of the chorus is left: corruption takes it down to a floor, and
  // the canopy takes it down further because a bare clearing has fewer birds in
  // it than a wood does.
  const corruptionFactor = CORRUPTION_BIRD_FLOOR + (1 - CORRUPTION_BIRD_FLOOR) * (1 - corruption);
  const birdDensity = corruptionFactor * (0.35 + 0.65 * canopy);
  // An animal calling across a clearing is as audible as one calling under
  // trees, so the animal layer has no canopy term.
  const wildlifeDensity = corruptionFactor;

  const humAmount = smoothstep(HUM_ONSET, 1, corruption);
  const humLevel = Math.pow(humAmount, HUM_RAMP);

  const squelchAmount = smoothstep(SQUELCH_ONSET, 1, corruption);
  const squelchRate = Math.pow(squelchAmount, SQUELCH_RAMP) / SQUELCH_INTERVAL_NEAR;

  return {
    wind: tuning.wind * windGust * (1 - 0.35 * canopy),
    leaves: tuning.leaves * leafGust * (0.25 + 0.75 * canopy),
    birds: tuning.birds * birdDensity,
    wildlife: tuning.wildlife * wildlifeDensity,
    hum: tuning.hum * humLevel,
    squelchRate,
    birdDensity,
    wildlifeDensity,
  };
}

/**
 * Decide what a footstep landed on.
 *
 * Water wins over everything: a boot in the stream is a splash whatever the bank
 * is made of. Otherwise the terrain's own biome weights decide, and mud folds
 * into dirt - wet dirt is still dirt, and the plan's four surfaces do not include
 * a fifth.
 *
 * `waterDepth` is how deep the water is at the player's feet, in metres. It has
 * to clear `WATER_WADE_DEPTH` before it counts, because a film of water on a rock
 * is a wet rock, not a puddle.
 *
 * The comparison is written as a plain `>` with no finiteness test in front of
 * it, which is deliberate. `NaN > x` is false, so a non-finite depth from a
 * broken sampler reads as dry ground rather than as a boot in an ocean; and
 * `Infinity > x` is true, so a genuinely unbounded depth reads as water. Adding
 * `Number.isFinite` in front - which is what this looked like first - gets the
 * second of those backwards.
 */
export function resolveSurface(
  biome: { grass: number; dirt: number; rock: number; mud: number },
  waterDepth: number,
): FootstepSurface {
  if (waterDepth > WATER_WADE_DEPTH) return 'water';

  // Dirt takes mud's share: they are the same sound with more water in it.
  const dirt = biome.dirt + biome.mud;

  // A surface has to *dominate* to be chosen. Anything less - a tie, or a vector
  // of zeros from a degenerate sampler - falls through to grass, which is the
  // terrain's dominant biome by construction and therefore the safe default. The
  // previous form used `>=`, which sent every tie to rock and made a boot on
  // level ground sound like a boot on a cliff face.
  if (biome.rock > dirt && biome.rock > biome.grass) return 'rock';
  if (dirt > biome.grass) return 'dirt';
  return 'grass';
}

/**
 * Pan for a source at `azimuth` radians relative to the listener's forward.
 *
 * `sin(azimuth)`, not `azimuth / (pi/2)`. A source directly in front is centred,
 * a source at +/-90 degrees is hard left or right, and a source directly behind
 * is centred again - which is what a pair of ears does. A linear map would put
 * everything behind the listener hard to one side, which is the classic wrong
 * way to pan a 3D mix onto stereo.
 */
export function panForAzimuth(azimuth: number): number {
  return Math.sin(azimuth);
}

/** Gentle inverse falloff for a scattered source: 1 at zero, ~1/2 at `SOURCE_FALLOFF`. */
function sourceGain(radius: number): number {
  const r = Math.max(0.001, Number.isFinite(radius) ? radius : 0.001);
  return SOURCE_FALLOFF / (SOURCE_FALLOFF + r);
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface AmbientSystemOptions {
  /** World seed, so the same world always sounds the same. */
  seed?: number;
  /** Layer peaks. Defaults to `DEFAULT_AMBIENT_TUNING`. */
  tuning?: Partial<AmbientTuning>;
  /** Start muted. Useful for tests and for a settings menu later. */
  muted?: boolean;
  /**
   * The stream's sound, if there is one.
   *
   * Not created here: `Stream` already owns its own `WaterAudio`, and a second
   * water loop would be two recordings of the same river. This system forwards
   * its mute state to it so one switch silences everything.
   */
  water?: WaterAudio | null;
  /** Number of bird-call variants to synthesise. */
  birdVariants?: number;
  /** Number of animal-call variants to synthesise. */
  wildlifeVariants?: number;
  /** Number of squelch variants to synthesise. */
  squelchVariants?: number;
  /** Number of footstep variants per surface. */
  footstepVariants?: number;
}

/** True when the environment can actually play audio. */
function audioAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window.AudioContext ?? (window as { webkitAudioContext?: unknown }).webkitAudioContext) !==
      'undefined'
  );
}

/** Small deterministic RNG, so scheduling is reproducible from the seed. */
function makeRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The mutable state of one scheduled one-shot family.
 *
 * Deliberately free of Howler. The decision about *when* a call fires and *how
 * loud* it should be is the part of a scheduler that goes wrong, and it is the
 * part a test can only check if it does not need an `AudioContext` to run.
 */
export interface ShotLayerState {
  /** Seconds of world time at which each variant next fires. */
  readonly nextAt: number[];
  /** Azimuth of each variant, radians relative to the listener's forward. */
  readonly azimuth: number[];
  /** Distance of each variant from the listener, in metres. */
  readonly radius: number[];
  /** Per-variant gain, so no two calls are the same loudness. */
  readonly gain: number[];
  /** Shortest and longest gap between calls of this kind, in seconds. */
  readonly intervalNear: number;
  readonly intervalFar: number;
}

/** What the scheduler decided about one variant for this frame. */
export interface ScheduledShot {
  /** Index into the layer's variant list. */
  readonly index: number;
  /** Level to play at. Always positive - a variant that should not fire is not returned. */
  readonly level: number;
  /** Stereo pan, -1 to 1. */
  readonly pan: number;
}

/**
 * The gap scale that makes `count` variants together fire at `rate` per second.
 *
 * Each variant fires at `rate / count`, so its mean interval is `count / rate`,
 * and the scale is that divided by the layer's own base interval. A
 * non-positive or non-finite rate means the layer is silent, and silence is
 * expressed as an infinite scale rather than as a flag, so the scheduler has one
 * input to reason about instead of two that can disagree.
 *
 * Exported because it is arithmetic with an off-by-a-factor-of-count failure
 * mode that is invisible in review and silent in the mix: get it wrong and every
 * layer runs at whatever rate its variant count happens to imply.
 */
export function rateToGapScale(
  count: number,
  intervalNear: number,
  intervalFar: number,
  rate: number,
): number {
  if (!(rate > 0) || !Number.isFinite(rate)) return Number.POSITIVE_INFINITY;
  const mid = (intervalNear + intervalFar) / 2;
  if (!(count > 0) || !(mid > 0)) return Number.POSITIVE_INFINITY;
  return count / (rate * mid);
}

/**
 * Decide which of a layer's one-shots fire this frame, and when each next will.
 *
 * Mutates `state` - the azimuths drift and every timer is rewritten - because
 * this *is* the scheduler, and a scheduler that returned a plan without applying
 * it would be a plan that has to be applied twice.
 *
 * `gapScale` multiplies the layer's own interval range, and is how a layer thins
 * out: fewer calls means longer gaps between the ones that remain, not the same
 * gaps played more quietly. A non-finite or non-positive scale means silent.
 *
 * A silent layer still rewrites its timers, at the *unscaled* interval. Pushing
 * them out instead - by a factor of a million, say - would mean that when the
 * layer became audible again every timer would still be in the future and the
 * layer would stay quiet forever, which is exactly the bug this ordering avoids.
 */
export function scheduleShots(
  state: ShotLayerState,
  elapsed: number,
  volume: number,
  gapScale: number,
  rng: () => number,
): ScheduledShot[] {
  const silent = !(gapScale > 0) || !Number.isFinite(gapScale) || !(volume > 0.0005);
  const out: ScheduledShot[] = [];

  for (let i = 0; i < state.nextAt.length; i++) {
    if (elapsed < state.nextAt[i]) continue;

    if (!silent) {
      // The azimuth drifts slowly, so a bird that calls repeatedly moves across
      // the sky instead of sitting on one speaker.
      state.azimuth[i] += (rng() - 0.5) * 0.6;

      const level = volume * state.gain[i] * sourceGain(state.radius[i]);
      if (level > 0.0005) {
        out.push({ index: i, level: Math.min(1, level), pan: panForAzimuth(state.azimuth[i]) });
      }
    }

    // Reschedule. Unscaled while silent, so a layer that goes quiet and comes
    // back resumes at its natural spacing rather than firing everything at once.
    const near = state.intervalNear * (silent ? 1 : gapScale);
    const far = state.intervalFar * (silent ? 1 : gapScale);
    state.nextAt[i] = elapsed + near + rng() * Math.max(0, far - near);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* The system                                                                 */
/* -------------------------------------------------------------------------- */

export class AmbientSystem {
  private readonly tuning: AmbientTuning;
  private readonly seed: number;
  private readonly rng: () => number;

  private readonly wind: Howl | null = null;
  private readonly leaves: Howl | null = null;
  private readonly hum: Howl | null = null;
  private readonly birds: { howl: Howl; names: readonly string[]; state: ShotLayerState } | null = null;
  private readonly wildlife: { howl: Howl; names: readonly string[]; state: ShotLayerState } | null = null;
  private readonly squelch: { howl: Howl; names: readonly string[]; state: ShotLayerState } | null = null;
  private readonly steps: Partial<Record<FootstepSurface, Howl>> = {};
  /** Sprite names per surface, so a footstep can pick a variant without poking Howler. */
  private readonly stepNames: Partial<Record<FootstepSurface, readonly string[]>> = {};

  private readonly water: WaterAudio | null;

  private muted: boolean;
  private master: number;
  private elapsed = 0;
  private disposed = false;

  /** Last footfall index seen, 0 or 1. -1 when not striding. */
  private lastFootfall = -1;

  /** The mix from the most recent frame, kept so a test can read what was applied. */
  private lastMix: AmbientMix;

  constructor(options: AmbientSystemOptions = {}) {
    this.seed = options.seed ?? 0;
    this.rng = makeRng(this.seed * 2246822519 + 13);
    this.tuning = { ...DEFAULT_AMBIENT_TUNING, ...options.tuning };
    this.water = options.water ?? null;
    this.muted = options.muted ?? false;
    this.master = 1;
    this.lastMix = ambientMix(EMPTY_FRAME, this.tuning);

    if (!audioAvailable()) return;

    const rate = DEFAULT_SAMPLE_RATE;

    /* Loops. Each starts silent and is driven up by the first update, so a world
       built mid-frame never starts at full volume. */
    this.wind = this.loop(clipDataUri(renderWind(this.seed, 6, rate), rate));
    this.leaves = this.loop(clipDataUri(renderLeafRustle(this.seed, 4, rate), rate));
    this.hum = this.loop(clipDataUri(renderCorruptionHum(this.seed, 5, rate), rate));

    this.birds = this.shots(
      options.birdVariants ?? DEFAULT_BIRD_VARIANTS,
      (i) => renderBirdCall(this.seed + i * 977, rate),
      BIRD_RADIUS_NEAR,
      BIRD_RADIUS_FAR,
      BIRD_INTERVAL_NEAR,
      BIRD_INTERVAL_FAR,
    );
    this.wildlife = this.shots(
      options.wildlifeVariants ?? DEFAULT_WILDLIFE_VARIANTS,
      (i) => renderDistantCall(this.seed + i * 613 + 41, rate),
      WILDLIFE_RADIUS_NEAR,
      WILDLIFE_RADIUS_FAR,
      WILDLIFE_INTERVAL_NEAR,
      WILDLIFE_INTERVAL_FAR,
    );
    this.squelch = this.shots(
      options.squelchVariants ?? DEFAULT_SQUELCH_VARIANTS,
      (i) => renderSquelch(this.seed + i * 331 + 7, rate),
      SQUELCH_RADIUS_NEAR,
      SQUELCH_RADIUS_FAR,
      SQUELCH_INTERVAL_NEAR,
      SQUELCH_INTERVAL_NEAR * 5,
    );

    const variants = options.footstepVariants ?? DEFAULT_FOOTSTEP_VARIANTS;
    for (const surface of FOOTSTEP_SURFACES) {
      const clips: Float32Array[] = [];
      const names: string[] = [];
      for (let v = 0; v < variants; v++) {
        clips.push(renderFootstep(surface, this.seed + v * 7919 + surface.length * 131, rate));
        names.push(`${surface}${v}`);
      }
      this.steps[surface] = this.loop(packSprites(clips, names, rate).src);
      this.stepNames[surface] = names;
    }

    if (this.muted) Howler.mute(true);
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  /** True when this instance has real sounds behind it. */
  get isLive(): boolean {
    return this.wind !== null;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** The layer levels from the most recent frame. */
  get mix(): AmbientMix {
    return this.lastMix;
  }

  /** Master gain applied to every layer, 0 to 1. */
  get volume(): number {
    return this.master;
  }

  setVolume(volume: number): void {
    this.master = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
  }

  /**
   * Mute or unmute everything, including the stream.
   *
   * Forwarded to the stream's own `WaterAudio` rather than left to it, because
   * `Howler.mute` is global: if both systems called it independently the last
   * writer would win, and unmuting one would unmute the other.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.isLive) return;
    Howler.mute(muted);
    this.water?.setMuted(muted);
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the audio by `delta` seconds of game time.
   *
   * Everything that could be non-finite is guarded rather than trusted: a NaN
   * listener position reaches `Howler.pos` as NaN and silences the entire mix
   * with no error anywhere, which is the failure mode this defends against.
   */
  update(delta: number, frame: AmbientAudioFrame): void {
    if (this.disposed) return;
    if (!Number.isFinite(delta) || delta < 0) return;

    this.elapsed += delta;

    const safe: AmbientAudioFrame = {
      ...frame,
      x: Number.isFinite(frame.x) ? frame.x : 0,
      y: Number.isFinite(frame.y) ? frame.y : 0,
      z: Number.isFinite(frame.z) ? frame.z : 0,
      forwardX: Number.isFinite(frame.forwardX) ? frame.forwardX : 0,
      forwardZ: Number.isFinite(frame.forwardZ) ? frame.forwardZ : 1,
    };

    const mix = ambientMix(safe, this.tuning);
    this.lastMix = mix;

    if (!this.isLive) return;

    /* Listener, so the stream and anything added later inherit a correct one. */
    Howler.pos(safe.x, safe.y, safe.z);

    const g = this.master;
    this.setLoopVolume(this.wind, mix.wind * g);
    this.setLoopVolume(this.leaves, mix.leaves * g);
    this.setLoopVolume(this.hum, mix.hum * g);

    // The one-shots are scheduled by their own timers. Each layer's volume is
    // applied when it fires rather than here, because it changes between calls
    // as the player walks into or out of the rot.
    //
    // Thinning a chorus means longer gaps, not quieter ones, so each layer is
    // given a *rate* that falls with corruption and the scheduler stretches the
    // gaps to match. At the corruption floor the bird calls come about eight
    // times less often, which reads as a forest with fewer birds in it rather
    // than as a forest with the same birds turned down.
    this.playShots(this.birds, mix.birds * g, BIRD_BASE_RATE * mix.birdDensity);
    this.playShots(this.wildlife, mix.wildlife * g, WILDLIFE_BASE_RATE * mix.wildlifeDensity);
    // The squelch's mix entry is already events per second.
    this.playShots(this.squelch, this.tuning.squelch * g, mix.squelchRate);

    this.updateFootsteps(safe);
  }

  /** Stop and release every sound. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const loops: (Howl | null)[] = [
      this.wind,
      this.leaves,
      this.hum,
      this.birds?.howl ?? null,
      this.wildlife?.howl ?? null,
      this.squelch?.howl ?? null,
    ];
    for (const howl of loops) howl?.unload();
    for (const howl of Object.values(this.steps)) howl?.unload();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /** Build a looping `Howl` from a WAV data URI, starting silent. */
  private loop(src: string): Howl {
    const howl = new Howl({ src: [src], loop: true, volume: 0, html5: false, preload: true });
    // Autoplay policy: a browser refuses to start a context before a gesture.
    // Howler's own auto-unlock handles that, and `play()` before then is queued
    // rather than lost.
    howl.play();
    return howl;
  }

  /** Build a family of one-shots as sprites of a single packed buffer. */
  private shots(
    count: number,
    render: (index: number) => Float32Array,
    radiusNear: number,
    radiusFar: number,
    intervalNear: number,
    intervalFar: number,
  ): { howl: Howl; names: string[]; state: ShotLayerState } {
    const clips: Float32Array[] = [];
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      clips.push(render(i));
      names.push(`v${i}`);
    }
    const packed = packSprites(clips, names, DEFAULT_SAMPLE_RATE);

    const nextAt: number[] = [];
    const azimuth: number[] = [];
    const radius: number[] = [];
    const gain: number[] = [];
    for (let i = 0; i < count; i++) {
      // Staggered first fires, so a world that has just loaded does not produce
      // every one of its calls on the same frame.
      nextAt.push(this.rng() * intervalFar);
      azimuth.push(this.rng() * Math.PI * 2);
      radius.push(radiusNear + this.rng() * Math.max(0, radiusFar - radiusNear));
      // +/-20% of loudness, enough to stop two calls in a row sounding like the
      // same sample played twice.
      gain.push(0.8 + this.rng() * 0.4);
    }

    const howl = new Howl({
      src: [packed.src],
      sprite: packed.sprites,
      loop: false,
      volume: 0,
      html5: false,
      preload: true,
    });

    return { howl, names, state: { nextAt, azimuth, radius, gain, intervalNear, intervalFar } };
  }

  /** Set a loop's volume only when it has actually changed. */
  private setLoopVolume(howl: Howl | null, volume: number): void {
    if (howl === null) return;
    const v = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0));
    if (howl.volume() !== v) howl.volume(v);
  }

  /**
   * Ask the scheduler what fires, and hand each result to Howler.
   *
   * Thin on purpose: the decision lives in `scheduleShots`, which is pure and
   * testable, and this is only the part that touches Howler.
   *
   * `rate` is the total calls per second wanted from the whole layer, across all
   * of its variants. That is the number a designer thinks in - "a bird call
   * every four seconds" - and translating it into a per-variant interval here
   * rather than at the call site is what stops the rate a layer actually runs at
   * from depending on how many variants it happens to have.
   */
  private playShots(
    layer: { howl: Howl; names: readonly string[]; state: ShotLayerState } | null,
    volume: number,
    rate: number,
  ): void {
    if (layer === null) return;

    const { intervalNear, intervalFar, nextAt } = layer.state;
    const gapScale = rateToGapScale(nextAt.length, intervalNear, intervalFar, rate);

    for (const shot of scheduleShots(layer.state, this.elapsed, volume, gapScale, this.rng)) {
      layer.howl.volume(shot.level);
      layer.howl.stereo(shot.pan);
      layer.howl.play(layer.names[shot.index]);
    }
  }

  /**
   * Fire a footstep whenever the stride crosses a footfall.
   *
   * The crossings come from the animator's own stride phase, so the sound is
   * locked to the visible footfall rather than to a second timer. Two footfalls
   * per cycle, at phase 0 and phase 0.5, which is what `floor(phase * 2)` counts.
   */
  private updateFootsteps(frame: AmbientAudioFrame): void {
    if (!(frame.footfallInterval > 0) || frame.surface === null) {
      this.lastFootfall = -1;
      return;
    }

    const phase = Number.isFinite(frame.stridePhase) ? frame.stridePhase : 0;
    const index = Math.floor(unit(phase) * 2 + 1e-6) % 2;
    if (index === this.lastFootfall) return;
    this.lastFootfall = index;

    const howl = this.steps[frame.surface];
    const names = this.stepNames[frame.surface];
    if (howl === undefined || names === undefined || names.length === 0) return;

    const level = Math.min(1, this.tuning.footstep * this.master * (0.85 + this.rng() * 0.3));
    if (level <= 0.0005) return;
    howl.volume(level);
    // A footstep is under the player, so it is centred. Panning it would put the
    // player's own boot off to one side.
    howl.stereo(0);
    howl.play(names[Math.floor(this.rng() * names.length) % names.length]);
  }
}
