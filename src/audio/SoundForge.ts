/**
 * SoundForge.ts - ASTRA audio
 * =============================================================================
 * Every sound in the world, synthesised from code.
 *
 * The project's Code-First Asset Strategy builds the world from code with no
 * external assets, and there is no `assets/audio` directory to load from. So
 * the sounds here are *rendered*: noise and sine oscillators are pushed through
 * filters and envelopes into a float buffer, the buffer is wrapped in a WAV
 * container, and the result is handed to Howler as a base64 data URI. Howler
 * decodes a data URI exactly as it decodes a URL, so nothing about the playback
 * path is unusual.
 *
 * Why synthesise rather than ship files
 * -------------------------------------
 * Three reasons, in order of weight:
 *
 *   1. There are no files. The strategy forbids them.
 *   2. Seeded synthesis is deterministic. The same world seed always sounds the
 *      same, which means the audio is testable in a way recorded audio is not -
 *      a test can render a clip and assert on its spectrum and its envelope.
 *   3. Synthesised sounds are free of the artefacts that make stock audio read
 *      as stock audio: no room tone from a microphone in a room that is not
 *      this forest, no 44.1 kHz of hiss above 8 kHz where nothing in the mix
 *      lives, no two footsteps that are byte-identical.
 *
 * Sample rate
 * -----------
 * 22050 Hz, half of CD. Nothing in this mix has content above ~8 kHz: birds
 * are 0.5-5 kHz, footsteps are 0.1-4 kHz, the corruption hum is 40-120 Hz.
 * Halving the rate halves both the render cost and the size of every data URI,
 * and the extra 10 kHz of headroom would be silence.
 *
 * How the sounds are built
 * -------------------------
 * Every renderer here follows the same three-step shape:
 *
 *   a source      white noise, or a sine whose phase is integrated from a
 *                 frequency function, or both.
 *   a filter      a biquad (lowpass, bandpass, highpass) or a one-pole, which
 *                 is what decides whether a burst of noise reads as grass,
 *                 dirt, rock or water.
 *   an envelope   attack and decay. The envelope is most of the identity of a
 *                 percussive sound; a footstep is a noise burst whose shape is
 *                 the sound.
 *
 * Each clip is peak-normalised before it is packed, so the mixing levels in
 * `AmbientSystem` mean the same thing for every layer and adjusting one sound
 * does not quietly change another.
 * =============================================================================
 */

import { createRng } from '../procedural/NoiseLibrary';

/** Sample rate every clip in this module is rendered at, in Hz. */
export const DEFAULT_SAMPLE_RATE = 22050;

/** Peak a normalised clip is scaled to. Leaves headroom for mixing. */
const NORMALISE_PEAK = 0.92;

/* -------------------------------------------------------------------------- */
/* WAV container                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Wrap 16-bit mono PCM in a WAV container and base64 it into a data URI.
 *
 * Kept as a named export because `WaterAudio` has always exposed it; the
 * implementation now lives in `wavDataUriChannels` so the stereo packer below
 * and this share one container writer rather than two that can drift.
 */
export function wavDataUri(pcm: Int16Array, sampleRate: number): string {
  return wavDataUriChannels([pcm], sampleRate);
}

/**
 * Wrap one or more channels of 16-bit interleaved PCM in a WAV data URI.
 *
 * Channels are interleaved on write, which is what the `fmt ` chunk's
 * `blockAlign` describes. All channels must be the same length; a short one is
 * padded with silence rather than throwing, because a clipped tail is inaudible
 * and a thrown error during world construction is not.
 */
export function wavDataUriChannels(channels: Int16Array[], sampleRate: number): string {
  const channelCount = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;

  const bytes = new Uint8Array(44 + frames * channelCount * 2);
  const view = new DataView(bytes.buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * channelCount * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint16(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true); // byte rate
  view.setUint16(32, channelCount * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, frames * channelCount * 2, true);

  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      view.setInt16(o, channels[c][i] ?? 0, true);
      o += 2;
    }
  }

  return `data:audio/wav;base64,${base64FromBytes(bytes)}`;
}

/** Base64 without `btoa`, which chokes on large inputs in some engines. */
function base64FromBytes(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : alphabet[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : alphabet[b2 & 63];
  }
  return out;
}

/**
 * Render a float clip straight to a WAV data URI.
 *
 * The two steps - quantise, then containerise - are always taken together, and
 * a caller that has to remember both is a caller that can forget one and hand
 * Howler a `Float32Array`.
 */
export function clipDataUri(signal: Float32Array, sampleRate: number = DEFAULT_SAMPLE_RATE): string {
  return wavDataUri(toPcm16(signal), sampleRate);
}

/** Quantise a float clip to 16-bit PCM, clamping rather than wrapping. */
export function toPcm16(signal: Float32Array): Int16Array {
  const pcm = new Int16Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const v = signal[i];
    pcm[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
  }
  return pcm;
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass';

/**
 * A direct-form-I transposed biquad, coefficients from the RBJ cookbook.
 *
 * Written by hand rather than pulled from a library because the whole point of
 * this module is that there is no dependency to pull it from, and because the
 * one thing a stock filter would not give is per-sample coefficient updates -
 * which the leaf rustle and the water splash both need.
 */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(
    kind: BiquadKind,
    frequency: number,
    sampleRate: number,
    q = Math.SQRT1_2,
  ) {
    this.set(kind, frequency, sampleRate, q);
  }

  /** Recompute the coefficients. Cheap enough to call per sample. */
  set(kind: BiquadKind, frequency: number, sampleRate: number, q = Math.SQRT1_2): void {
    // A biquad is only defined strictly inside (0, Nyquist). A corner at or past
    // the edge produces `alpha = Infinity` or negative, and a NaN or unstable
    // coefficient silently turns a whole clip into NaN - which is silence, not
    // an error. Both the frequency and the Q are guarded, because `Math.max(1,
    // NaN)` is NaN and a guard that only looks at one of the two inputs is not
    // a guard. A non-finite corner is treated as Nyquist: fully open.
    const nyquist = sampleRate / 2;
    const wanted = Number.isFinite(frequency) ? frequency : nyquist;
    const f0 = Math.min(nyquist * 0.999, Math.max(1, wanted));
    const quality = Number.isFinite(q) ? Math.max(0.0001, q) : Math.SQRT1_2;

    const w0 = (2 * Math.PI * f0) / sampleRate;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * quality);

    let b0: number;
    let b1: number;
    let b2: number;
    if (kind === 'lowpass') {
      b0 = (1 - cosw0) / 2;
      b1 = 1 - cosw0;
      b2 = (1 - cosw0) / 2;
    } else if (kind === 'highpass') {
      b0 = (1 + cosw0) / 2;
      b1 = -(1 + cosw0);
      b2 = (1 + cosw0) / 2;
    } else {
      // Constant-skirt bandpass: peak gain is Q, not 1. That is what is wanted
      // here - the filters in this module are used to shape the *level* of a
      // band, so a band that reads louder as it narrows is the useful
      // behaviour, not a bug.
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }

    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  /** One sample in, one sample out. */
  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** Filter in place. */
  run(signal: Float32Array): Float32Array {
    for (let i = 0; i < signal.length; i++) signal[i] = this.process(signal[i]);
    return signal;
  }

  /** Forget the filter's history. */
  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/**
 * Scale `signal` in place to a peak of `peak`.
 *
 * Returns the signal unchanged when it is silent, so a clip that renders to
 * zero does not become NaN.
 */
export function normalise(signal: Float32Array, peak = NORMALISE_PEAK): Float32Array {
  let max = 0;
  for (let i = 0; i < signal.length; i++) {
    const a = Math.abs(signal[i]);
    if (a > max) max = a;
  }
  if (max <= 1e-9) return signal;
  const gain = peak / max;
  for (let i = 0; i < signal.length; i++) signal[i] *= gain;
  return signal;
}

/**
 * Make a signal loop seamlessly by crossfading its tail into its head.
 *
 * A loop that is cut at an arbitrary point clicks once per repetition, and a
 * click at 0.2 Hz is one of the most conspicuous artefacts in a mix. The fix is
 * to render `length + fade` samples and blend the extra tail back over the head
 * over `fade` samples, so the waveform at the wrap point is continuous both in
 * value and in slope.
 *
 * Only the head is blended, and only against the tail rendered past the end.
 * Blending the whole output - which is the obvious way to write this - reads
 * `signal[length + i]` for every `i` up to `length`, and the array only has
 * `length + fade` entries. Every read past the end returns `undefined`, and
 * `undefined * anything` is NaN, so the entire loop comes back NaN. A NaN loop
 * is silent rather than loud, which is the worst possible way for this to fail:
 * nothing errors, nothing warns, and three of the world's ambient layers simply
 * do not exist.
 */
export function loopCrossfade(
  signal: Float32Array,
  fadeSeconds: number,
  sampleRate: number,
): Float32Array {
  const fade = Math.min(signal.length - 1, Math.max(1, Math.round(fadeSeconds * sampleRate)));
  const length = signal.length - fade;
  if (length <= 0) return signal.slice();

  const out = new Float32Array(length);
  // The body is the rendered signal, untouched.
  out.set(signal.subarray(0, length));
  // Only the head is blended, and only against the tail that was rendered past
  // the end of the loop.
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    out[i] = signal[i] * w + signal[length + i] * (1 - w);
  }
  return out;
}

/** Raise `signal` to `power` in place, preserving the sign. */
export function shape(signal: Float32Array, power: number): Float32Array {
  for (let i = 0; i < signal.length; i++) {
    const v = signal[i];
    signal[i] = Math.sign(v) * Math.pow(Math.abs(v), power);
  }
  return signal;
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

/** Fill `out` with white noise in [-1, 1] from `rng`. */
export function whiteNoise(out: Float32Array, rng: () => number): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
  return out;
}

/**
 * Fill `out` with pink-ish noise: white noise integrated once, then differenced
 * with a leak so it does not wander off. -3 dB/octave, which is the spectral
 * slope of most natural broadband sound and the reason a waterfall and a wind
 * gust are both dominated by their lows.
 */
export function pinkNoise(out: Float32Array, rng: () => number): Float32Array {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const white = rng() * 2 - 1;
    last = last * 0.86 + white * 0.14;
    out[i] = last;
  }
  return out;
}

/**
 * A sine whose frequency may vary per sample, into `out`.
 *
 * The phase is integrated from the frequency rather than computed as
 * `sin(2*pi*f*t)`, because the latter only produces a chirp when `f` is
 * constant - with a varying `f` the instantaneous phase and the phase implied by
 * the argument disagree and the result detunes. Integrating is what a real
 * oscillator does.
 */
export function sineSweep(
  out: Float32Array,
  sampleRate: number,
  frequencyAt: (t: number) => number,
  phaseOffset = 0,
): Float32Array {
  let phase = phaseOffset;
  for (let i = 0; i < out.length; i++) {
    phase += (2 * Math.PI * frequencyAt(i / sampleRate)) / sampleRate;
    out[i] = Math.sin(phase);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Multiply `signal` in place by an attack/decay envelope.
 *
 * The decay is exponential rather than linear because that is what a struck or
 * plucked thing does: the energy leaves fast and then tails off. A linear decay
 * on a noise burst reads as a volume knob, not as an impact.
 */
export function envelope(
  signal: Float32Array,
  sampleRate: number,
  attack: number,
  decay: number,
  sustain = 0,
): Float32Array {
  const attackSamples = Math.max(1, Math.round(attack * sampleRate));
  const tau = Math.max(1e-4, decay) * sampleRate;
  for (let i = 0; i < signal.length; i++) {
    let g: number;
    if (i < attackSamples) {
      g = i / attackSamples;
    } else {
      g = sustain + (1 - sustain) * Math.exp(-(i - attackSamples) / tau);
    }
    signal[i] *= g;
  }
  return signal;
}

/* -------------------------------------------------------------------------- */
/* Sprite packing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A family of clips laid end to end in one buffer, with named regions.
 *
 * Howler's `sprite` map is `[startMs, durationMs]` per name, so packing several
 * variants into one buffer means one `Howl` and one decoded `AudioBuffer` per
 * family instead of one per variant. It also means the variants share a decode
 * and a network-free load, which matters when there are sixteen footstep
 * variants.
 */
export interface SpriteClip {
  /** The packed buffer as a WAV data URI. */
  readonly src: string;
  /** Sprite name to `[start, duration]` in milliseconds, for Howler. */
  readonly sprites: Record<string, [number, number]>;
  /** Number of variants packed. */
  readonly count: number;
}

/** Silence inserted between variants, in seconds. */
const SPRITE_GAP = 0.02;

/**
 * Pack `clips` into one buffer under `names`.
 *
 * The gap matters: Howler starts a sprite at `start` and stops at
 * `start + duration`, and a variant that begins the instant the previous one
 * ends gets its attack clipped by however coarsely the browser schedules the
 * stop. Twenty milliseconds of silence costs nothing and removes the risk.
 */
export function packSprites(
  clips: readonly Float32Array[],
  names: readonly string[],
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): SpriteClip {
  const gap = Math.round(SPRITE_GAP * sampleRate);
  const total = clips.reduce((sum, c) => sum + c.length, 0) + gap * clips.length;
  const packed = new Float32Array(total);

  const sprites: Record<string, [number, number]> = {};
  let offset = 0;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    packed.set(clip, offset);
    const startMs = (offset / sampleRate) * 1000;
    sprites[names[i] ?? `v${i}`] = [Math.round(startMs), Math.round((clip.length / sampleRate) * 1000)];
    offset += clip.length + gap;
  }

  return { src: wavDataUri(toPcm16(packed), sampleRate), sprites, count: clips.length };
}

/* -------------------------------------------------------------------------- */
/* Bird calls                                                                 */
/* -------------------------------------------------------------------------- */

/** The call shapes a bird can make. Chosen from the seed. */
const BIRD_SPECIES = 4;

/**
 * Render one bird call, 0.3 to 1.2 seconds.
 *
 * A bird call is a short frequency-modulated sine with a percussive envelope,
 * repeated a few times. The FM is what makes it read as a bird rather than as a
 * beep: a pure tone swept monotonically is a siren, but the same tone with a
 * 40 Hz warble on top is a cheep.
 *
 * Four species, picked from the seed so one forest does not sound like one bird
 * with a stuck button:
 *
 *   cheep    three falling syllables, 2.6-3.4 kHz, warble
 *   trill    eight very short bursts at 22 Hz, 3.2 kHz
 *   coo      two long soft syllables, 620-540 Hz, slow vibrato
 *   chatter  six fast noisy bursts, 2.4 kHz
 */
export function renderBirdCall(seed: number, sampleRate = DEFAULT_SAMPLE_RATE): Float32Array {
  const rng = createRng(seed * 2654435761);
  const species = Math.floor(rng() * BIRD_SPECIES) % BIRD_SPECIES;
  const seconds = 0.3 + rng() * 0.9;
  const out = new Float32Array(Math.round(seconds * sampleRate));

  if (species === 0) {
    renderCheep(out, sampleRate, rng);
  } else if (species === 1) {
    renderTrill(out, sampleRate, rng);
  } else if (species === 2) {
    renderCoo(out, sampleRate, rng);
  } else {
    renderChatter(out, sampleRate, rng);
  }

  // A bandpass at the call's own centre removes the DC and the aliasing a
  // frequency-modulated sine leaves at the ends of its sweep, and a touch of
  // air noise gives the call a breath in front of it.
  const air = whiteNoise(new Float32Array(out.length), rng);
  const airFilter = new Biquad('bandpass', 3200, sampleRate, 0.8);
  airFilter.run(air);
  envelope(air, sampleRate, 0.004, 0.05);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.94 + air[i] * 0.06;

  return normalise(out, 0.85);
}

/** Three falling syllables with a warble - the generic small-bird cheep. */
function renderCheep(out: Float32Array, sampleRate: number, rng: () => number): void {
  const base = 2400 + rng() * 700;
  const syllables = 2 + Math.floor(rng() * 3);
  const warbleHz = 35 + rng() * 25;
  const index = 0.4 + rng() * 0.5;

  let cursor = 0.02 * sampleRate;
  for (let s = 0; s < syllables; s++) {
    const len = Math.round((0.055 + rng() * 0.05) * sampleRate);
    const start = base * (1 + s * 0.04) * (0.95 + rng() * 0.1);
    const end = start * (0.72 + rng() * 0.16);
    const seg = out.subarray(cursor, Math.min(out.length, cursor + len));
    if (seg.length <= 0) break;
    sineSweep(seg, sampleRate, (t) => start + (end - start) * (t / (seg.length / sampleRate)));
    applyFm(seg, sampleRate, warbleHz, index);
    envelope(seg, sampleRate, 0.003, 0.035);
    cursor += len + Math.round((0.05 + rng() * 0.07) * sampleRate);
  }
}

/** Eight very short bursts - a trill. */
function renderTrill(out: Float32Array, sampleRate: number, rng: () => number): void {
  const carrier = 2900 + rng() * 600;
  const burstHz = 18 + rng() * 8;
  const bursts = 6 + Math.floor(rng() * 4);

  let cursor = 0.02 * sampleRate;
  for (let s = 0; s < bursts; s++) {
    const len = Math.round((0.018 + rng() * 0.012) * sampleRate);
    const seg = out.subarray(cursor, Math.min(out.length, cursor + len));
    if (seg.length <= 0) break;
    sineSweep(seg, sampleRate, () => carrier * (1 + 0.03 * Math.sin(s)));
    applyFm(seg, sampleRate, burstHz, 0.25);
    envelope(seg, sampleRate, 0.002, 0.02);
    cursor += len;
  }
}

/** Two long soft syllables - a dove or an owl. */
function renderCoo(out: Float32Array, sampleRate: number, rng: () => number): void {
  const base = 520 + rng() * 180;
  const vibratoHz = 5 + rng() * 3;

  let cursor = 0.05 * sampleRate;
  for (let s = 0; s < 2; s++) {
    const len = Math.round((0.2 + rng() * 0.12) * sampleRate);
    const seg = out.subarray(cursor, Math.min(out.length, cursor + len));
    if (seg.length <= 0) break;
    const start = base * (1 - s * 0.06);
    const end = start * (0.86 + rng() * 0.08);
    sineSweep(seg, sampleRate, (t) => start + (end - start) * (t / (seg.length / sampleRate)));
    // A slow, shallow vibrato: enough to sound alive, not enough to sound like
    // a police siren.
    applyFm(seg, sampleRate, vibratoHz, 0.08);
    envelope(seg, sampleRate, 0.05, 0.16);
    cursor += len + Math.round(0.1 * sampleRate);
  }
}

/** Six fast noisy bursts - a warning chatter. */
function renderChatter(out: Float32Array, sampleRate: number, rng: () => number): void {
  const carrier = 2100 + rng() * 500;

  let cursor = 0.01 * sampleRate;
  for (let s = 0; s < 6; s++) {
    const len = Math.round((0.022 + rng() * 0.014) * sampleRate);
    const seg = out.subarray(cursor, Math.min(out.length, cursor + len));
    if (seg.length <= 0) break;
    const tone = sineSweep(new Float32Array(seg.length), sampleRate, () => carrier);
    const noise = whiteNoise(new Float32Array(seg.length), rng);
    for (let i = 0; i < seg.length; i++) seg[i] = tone[i] * 0.55 + noise[i] * 0.45;
    envelope(seg, sampleRate, 0.002, 0.03);
    cursor += len + Math.round(0.02 * sampleRate);
  }
}

/** Apply frequency modulation in place: `y *= cos(index * sin(2*pi*fm*t))`. */
function applyFm(signal: Float32Array, sampleRate: number, modHz: number, index: number): void {
  for (let i = 0; i < signal.length; i++) {
    const t = i / sampleRate;
    signal[i] *= Math.cos(index * Math.sin(2 * Math.PI * modHz * t));
  }
}

/* -------------------------------------------------------------------------- */
/* Leaves, wind, wildlife                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Render a loop of leaves rustling, `seconds` long.
 *
 * Band-passed noise is the whole sound - that is what rustling is. Two things
 * stop it reading as radio static: the band has to be narrow enough to sit in
 * the 2-4 kHz range where leaves actually live, and the amplitude has to swell
 * rather than sit flat. The swell here is four slow sines at incommensurate
 * rates, which produces gusts that never repeat at the same point in the loop.
 */
export function renderLeafRustle(seed: number, seconds = 4, sampleRate = DEFAULT_SAMPLE_RATE): Float32Array {
  const rng = createRng(seed * 40503 + 17);
  const total = Math.round(seconds * sampleRate);
  // Render past the end so the crossfade has material to blend in from.
  const padded = Math.round(total + 0.5 * sampleRate);

  const noise = whiteNoise(new Float32Array(padded), rng);

  // A wandering band: two fixed filters at different centres, crossfaded by a
  // slow LFO. Cheaper and steadier than updating the coefficients per sample,
  // and the audible result - a band that breathes - is the same. Each filter
  // gets its own copy of the noise so neither contaminates the other.
  const low = new Biquad('bandpass', 1800, sampleRate, 0.9);
  const high = new Biquad('bandpass', 3600, sampleRate, 0.7);
  const a = low.run(noise.slice());
  const b = high.run(noise.slice());

  for (let i = 0; i < padded; i++) {
    const t = i / sampleRate;
    const mix = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.11 * t + 1.3);
    const swell =
      0.16 +
      0.3 * Math.max(0, Math.sin(2 * Math.PI * 0.23 * t)) +
      0.24 * Math.max(0, Math.sin(2 * Math.PI * 0.41 * t + 2.1)) +
      0.18 * Math.max(0, Math.sin(2 * Math.PI * 0.67 * t + 4.2));
    noise[i] = (a[i] * mix + b[i] * (1 - mix)) * swell;
  }

  return normalise(loopCrossfade(noise, 0.5, sampleRate), 0.8);
}

/**
 * Render a loop of wind, `seconds` long.
 *
 * Pink noise under a lowpass whose corner sits around 400 Hz. Above that a
 * wind gust is hiss, and hiss at this level is a microphone problem rather than
 * weather. The swell is the gust: one slow sine plus a second at a third of the
 * rate, so the loudest gusts arrive in groups rather than metronomically.
 */
export function renderWind(seed: number, seconds = 6, sampleRate = DEFAULT_SAMPLE_RATE): Float32Array {
  const rng = createRng(seed * 91619 + 41);
  const total = Math.round(seconds * sampleRate);
  const padded = Math.round(total + 1.0 * sampleRate);

  const noise = pinkNoise(new Float32Array(padded), rng);
  const filter = new Biquad('lowpass', 420, sampleRate, 0.7);
  filter.run(noise);

  for (let i = 0; i < padded; i++) {
    const t = i / sampleRate;
    const swell =
      0.12 +
      0.45 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.055 * t + 0.4)) +
      0.28 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.031 * t + 2.6));
    noise[i] *= swell;
  }

  // A gentle highpass keeps the loop from rumbling the subwoofer, which at this
  // playback level would be felt rather than heard and would mask the
  // corruption hum that lives in the same band.
  const hp = new Biquad('highpass', 90, sampleRate, 0.7);
  hp.run(noise);

  return normalise(loopCrossfade(noise, 1.0, sampleRate), 0.75);
}

/**
 * Render one distant animal call, 1 to 2.5 seconds.
 *
 * Distant means two things have been taken away: the high end, by a lowpass at
 * 900 Hz, and the detail, by a long attack and release. Air absorbs high
 * frequencies at a rate of a few dB per hundred metres, so anything far away in
 * a forest is a low, soft, blurred version of itself.
 */
export function renderDistantCall(seed: number, sampleRate = DEFAULT_SAMPLE_RATE): Float32Array {
  const rng = createRng(seed * 2246822519 + 7);
  const seconds = 1 + rng() * 1.5;
  const out = new Float32Array(Math.round(seconds * sampleRate));

  const base = 260 + rng() * 320;
  const bend = 0.18 + rng() * 0.3;
  const vibratoHz = 3.5 + rng() * 3;
  sineSweep(out, sampleRate, (t) => base * (1 + bend * Math.sin(2 * Math.PI * 0.35 * t)));
  applyFm(out, sampleRate, vibratoHz, 0.12);

  // A second, detuned partial an octave up gives the call a throat rather than
  // a tuning fork.
  const partial = sineSweep(
    new Float32Array(out.length),
    sampleRate,
    (t) => base * 2 * (1 + bend * Math.sin(2 * Math.PI * 0.35 * t + 0.2)),
  );
  for (let i = 0; i < out.length; i++) out[i] += partial[i] * 0.22;

  const lp = new Biquad('lowpass', 900, sampleRate, 0.8);
  lp.run(out);
  // A long, soft envelope on both ends: the sound arrives over a tenth of a
  // second and leaves the same way.
  const attack = 0.12 + rng() * 0.1;
  const release = 0.25 + rng() * 0.2;
  applySoftEnvelope(out, sampleRate, attack, release);

  // A whisper of air under it, so the call is not the only thing in the band.
  const air = whiteNoise(new Float32Array(out.length), rng);
  const airFilter = new Biquad('bandpass', 500, sampleRate, 0.6);
  airFilter.run(air);
  for (let i = 0; i < out.length; i++) out[i] += air[i] * 0.1;

  return normalise(out, 0.8);
}

/**
 * Render a loop of the corruption's low hum, `seconds` long.
 *
 * Unsettling, and deliberately so. Three things do the work: a fundamental
 * around 55 Hz with a second sine 0.4 Hz away from it, so the two beat at a
 * rate just slow enough to be felt rather than heard; a detuned fifth above,
 * which is the interval that reads as wrong in every musical tradition; and a
 * lowpassed noise rumble underneath. None of it is loud. That is the point.
 */
export function renderCorruptionHum(seed: number, seconds = 5, sampleRate = DEFAULT_SAMPLE_RATE): Float32Array {
  const rng = createRng(seed * 374761393 + 23);
  const total = Math.round(seconds * sampleRate);
  const padded = Math.round(total + 0.6 * sampleRate);

  const fundamental = 52 + rng() * 8;
  const beat = 0.35 + rng() * 0.4;
  const out = new Float32Array(padded);

  const a = sineSweep(new Float32Array(padded), sampleRate, () => fundamental);
  const b = sineSweep(new Float32Array(padded), sampleRate, () => fundamental + beat);
  const fifth = sineSweep(new Float32Array(padded), sampleRate, () => fundamental * 1.4983);
  for (let i = 0; i < padded; i++) {
    const t = i / sampleRate;
    // A slow wobble in the level, so the hum breathes rather than drones.
    const wobble = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.21 * t + 1.1);
    out[i] = (a[i] * 0.5 + b[i] * 0.34 + fifth[i] * 0.16) * wobble;
  }

  const rumble = pinkNoise(new Float32Array(padded), rng);
  const lp = new Biquad('lowpass', 160, sampleRate, 0.9);
  lp.run(rumble);
  for (let i = 0; i < padded; i++) out[i] += rumble[i] * 0.35;

  return normalise(loopCrossfade(out, 0.6, sampleRate), 0.9);
}

/**
 * Render one organic squelch, ~0.4 seconds.
 *
 * Wet, low, and short. Three parts: a downward pitch sweep for the body, a
 * bandpassed noise burst for the wetness at the attack, and a fast upward
 * bubble that lands just after - the detail that makes it read as something
 * with a surface rather than as a filter sweep.
 */
export function renderSquelch(seed: number, sampleRate = DEFAULT_SAMPLE_RATE): Float32Array {
  const rng = createRng(seed * 668265263 + 31);
  const seconds = 0.32 + rng() * 0.16;
  const out = new Float32Array(Math.round(seconds * sampleRate));

  const start = 380 + rng() * 220;
  const end = 90 + rng() * 60;
  sineSweep(out, sampleRate, (t) => {
    const u = Math.min(1, t / (seconds * 0.7));
    // Exponential rather than linear in frequency: a pitch that falls quickly
    // and then flattens reads as a wet impact; a linear sweep reads as a siren.
    return start * Math.pow(end / start, u * u);
  });
  envelope(out, sampleRate, 0.004, 0.1);

  const wet = whiteNoise(new Float32Array(out.length), rng);
  const bp = new Biquad('bandpass', 1100, sampleRate, 1.1);
  bp.run(wet);
  envelope(wet, sampleRate, 0.002, 0.045);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.62 + wet[i] * 0.38;

  // The bubble: a short rising blip a little way in. Added into a scratch
  // buffer rather than written straight into `out`, because the body of the
  // squelch is still sounding there and overwriting it would cut a hole in the
  // middle of the sound.
  const bubbleAt = Math.round((0.06 + rng() * 0.08) * sampleRate);
  const bubbleLen = Math.round(0.05 * sampleRate);
  if (bubbleAt + bubbleLen < out.length) {
    const bubble = new Float32Array(bubbleLen);
    sineSweep(bubble, sampleRate, (t) => 700 + 900 * (t / (bubbleLen / sampleRate)));
    envelope(bubble, sampleRate, 0.002, 0.03);
    for (let i = 0; i < bubbleLen; i++) out[bubbleAt + i] += bubble[i];
  }

  return normalise(out, 0.85);
}

/* -------------------------------------------------------------------------- */
/* Footsteps                                                                  */
/* -------------------------------------------------------------------------- */

/** The surfaces a footstep can land on. Matches the terrain's four biomes plus water. */
export type FootstepSurface = 'grass' | 'dirt' | 'rock' | 'water';

export const FOOTSTEP_SURFACES: readonly FootstepSurface[] = ['grass', 'dirt', 'rock', 'water'];

/**
 * Render one footstep on `surface`, ~0.1 to 0.25 seconds.
 *
 * The four surfaces are separated almost entirely by their filter and their
 * envelope, which is exactly how they are separated in a recording:
 *
 *   grass  a bright, narrow, very short band. Dry leaves crackle.
 *   dirt   a low, dull, slightly longer thud with a soft body resonance.
 *   rock   a click with a ring - a hard, broad attack and a narrow resonance
 *          that decays over a tenth of a second.
 *   water  a splash, which is the only one of the four with a moving filter:
 *          the band sweeps up as the cavity fills and then falls as it empties,
 *          and a few droplet pings land after the main body.
 *
 * The low thump under every one of them is the boot itself. Without it a
 * footstep reads as a texture rather than as a weight landing.
 */
export function renderFootstep(
  surface: FootstepSurface,
  seed: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
): Float32Array {
  const rng = createRng(seed * 97 + surface.length * 7919);
  const seconds = surface === 'water' ? 0.3 : surface === 'rock' ? 0.22 : 0.16;
  const out = new Float32Array(Math.round(seconds * sampleRate));

  if (surface === 'grass') {
    const noise = whiteNoise(new Float32Array(out.length), rng);
    const bp = new Biquad('bandpass', 2400, sampleRate, 1.3);
    bp.run(noise);
    envelope(noise, sampleRate, 0.002, 0.035);
    for (let i = 0; i < out.length; i++) out[i] = noise[i] * 0.85;
    addThump(out, sampleRate, 150, 0.03, 0.3);
  } else if (surface === 'dirt') {
    const noise = whiteNoise(new Float32Array(out.length), rng);
    const lp = new Biquad('lowpass', 850, sampleRate, 0.8);
    lp.run(noise);
    envelope(noise, sampleRate, 0.003, 0.055);
    for (let i = 0; i < out.length; i++) out[i] = noise[i] * 0.8;
    addThump(out, sampleRate, 190, 0.04, 0.4);
  } else if (surface === 'rock') {
    const click = whiteNoise(new Float32Array(out.length), rng);
    const hp = new Biquad('highpass', 3200, sampleRate, 0.7);
    hp.run(click);
    envelope(click, sampleRate, 0.0008, 0.008);
    for (let i = 0; i < out.length; i++) out[i] += click[i] * 0.7;

    // Two slightly detuned partials: the beat between them is what makes a
    // ring sound like stone rather than like a synthesised sine.
    const ringHz = 1900 + rng() * 700;
    const r1 = sineSweep(new Float32Array(out.length), sampleRate, () => ringHz);
    const r2 = sineSweep(new Float32Array(out.length), sampleRate, () => ringHz * 1.0071);
    envelope(r1, sampleRate, 0.001, 0.075);
    envelope(r2, sampleRate, 0.001, 0.09);
    for (let i = 0; i < out.length; i++) out[i] += (r1[i] + r2[i]) * 0.22;

    addThump(out, sampleRate, 300, 0.02, 0.25);
  } else {
    // Water: a band that sweeps up and back down as the splash cavity opens and
    // empties. This is the one place a time-varying filter earns its cost.
    const noise = whiteNoise(new Float32Array(out.length), rng);
    const filter = new Biquad('bandpass', 1200, sampleRate, 1.0);
    for (let i = 0; i < out.length; i++) {
      const u = i / out.length;
      // Rise to a peak at a third of the way in, then fall away.
      const arc = u < 0.33 ? u / 0.33 : 1 - (u - 0.33) / 0.67;
      filter.set('bandpass', 900 + 3200 * arc, sampleRate, 1.0);
      out[i] = filter.process(noise[i]);
    }
    // The body of the splash is loudest at the start and gone by the end.
    for (let i = 0; i < out.length; i++) {
      const u = i / out.length;
      out[i] *= Math.exp(-u * 5.5);
    }

    // Droplets: two or three short pings scattered over the tail.
    const drops = 2 + Math.floor(rng() * 2);
    for (let d = 0; d < drops; d++) {
      const at = Math.round((0.04 + rng() * 0.18) * sampleRate);
      const len = Math.round(0.035 * sampleRate);
      if (at + len >= out.length) continue;
      const drop = out.subarray(at, at + len);
      const from = 2400 + rng() * 900;
      sineSweep(drop, sampleRate, (t) => from * Math.pow(0.45, t / (len / sampleRate)));
      envelope(drop, sampleRate, 0.001, 0.025);
    }

    // A low glug under the splash, for the weight of the water itself.
    const glug = sineSweep(new Float32Array(out.length), sampleRate, (t) => 240 - 90 * Math.min(1, t / 0.2));
    envelope(glug, sampleRate, 0.004, 0.09);
    for (let i = 0; i < out.length; i++) out[i] += glug[i] * 0.22;
  }

  return normalise(out, 0.9);
}

/** Add a short low sine - the boot hitting the ground - into `out`. */
function addThump(
  out: Float32Array,
  sampleRate: number,
  frequency: number,
  decay: number,
  gain: number,
): void {
  const len = Math.round(decay * 6 * sampleRate);
  if (len <= 0 || len > out.length) return;
  const thump = sineSweep(new Float32Array(len), sampleRate, (t) => frequency * (1 - 0.35 * (t / (len / sampleRate))));
  envelope(thump, sampleRate, 0.001, decay);
  for (let i = 0; i < len; i++) out[i] += thump[i] * gain;
}

/**
 * Multiply `signal` in place by an envelope with separate linear attack and
 * release ramps and a flat middle.
 *
 * `envelope` above is exponential throughout, which is right for an impact but
 * wrong for something that has to *arrive* - a distant call that starts at full
 * amplitude reads as a sound that was already playing when you got there.
 */
function applySoftEnvelope(signal: Float32Array, sampleRate: number, attack: number, release: number): void {
  const a = Math.max(1, Math.round(attack * sampleRate));
  const r = Math.max(1, Math.round(release * sampleRate));
  const hold = signal.length - a - r;
  for (let i = 0; i < signal.length; i++) {
    let g = 1;
    if (i < a) g = i / a;
    else if (hold > 0 && i >= a + hold) g = Math.max(0, (signal.length - i) / r);
    else if (hold <= 0) g = Math.min(i / a, Math.max(0, (signal.length - i) / r));
    signal[i] *= g;
  }
}
