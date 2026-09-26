/**
 * WaterAudio.ts - ASTRA audio
 * =============================================================================
 * The sound of the stream: a looping flow, positioned in the world, played
 * through Howler.js.
 *
 * Where the sound comes from
 * --------------------------
 * There is no audio file. The project's Code-First Asset Strategy says the
 * world is built from code with no external assets, and the audio library is a
 * later step (2.8), so at this point there is nothing on disk to load. The
 * sound is therefore *synthesised*: a few seconds of band-limited noise with a
 * slow swell, rendered into a 16-bit PCM WAV and handed to Howler as a base64
 * data URI. Howler accepts a data URI anywhere it accepts a URL, so nothing
 * about the playback path is unusual - it is an ordinary looping `Howl` - and
 * when Step 2.8 replaces the synthesised buffer with a recorded one, only
 * `createSource()` changes.
 *
 * Why a data URI rather than a Blob URL
 * -------------------------------------
 * A Blob URL would be marginally cheaper to build, but it is revocable and
 * tied to the document that made it, so it cannot be produced once and shared.
 * A data URI is a plain string: it can be memoised, compared in a test, and
 * logged. The base64 expansion is about a third again over the raw PCM, which
 * at this length is a few tens of kilobytes.
 *
 * How it is positioned
 * --------------------
 * Howler's core build exposes `Howler.pos()`, which drives the Web Audio
 * listener's own position, and `Howl.stereo()`, which drives the source's pan.
 * Full 3D positional audio lives in Howler's separate spatial plugin, which is
 * a minified IIFE that reaches for a bare `HowlerGlobal` global - a global the
 * UMD core build does not set when it is loaded as a module, which is how Vite
 * loads it. Depending on that would mean either a fragile global shim or a
 * bundler-specific import order.
 *
 * So the geometry is computed here and the result is handed to Howler:
 *
 *   listener position   `Howler.pos(camera)` each frame, so anything else that
 *                       ever uses Howler inherits a correct listener for free.
 *   pan                 the source projected onto the listener's right vector,
 *                       through `Howl.stereo()`.
 *   volume              inverse-distance falloff between a near and a far
 *                       distance, so the stream fades up as the player
 *                       approaches and is silent across the map.
 *
 * That is real spatial positioning through Howler, and it does not depend on a
 * plugin the bundler cannot load.
 *
 * Node and jsdom
 * --------------
 * There is no `AudioContext` in a test environment, so `WaterAudio` constructs
 * nothing and stays silent. Every method is a no-op in that case, which is what
 * lets the world be built and stepped in tests without a browser.
 * =============================================================================
 */

import { Howl, Howler } from 'howler';
import type { Stream } from '../world/Stream';
import type { SplinePoint } from '../procedural/StreamSpline';

/** Sample rate of the synthesised loop, in Hz. Water is broadband and low. */
const LOOP_SAMPLE_RATE = 16000;

/** Length of the synthesised loop, in seconds. Long enough not to audible-loop. */
const LOOP_SECONDS = 2.5;

/** Distance at which the stream is at full volume, in metres. */
export const DEFAULT_AUDIO_NEAR = 1.5;

/** Distance at which the stream has faded to nothing, in metres. */
export const DEFAULT_AUDIO_FAR = 45;

/** Playback volume of the stream at its loudest, 0 to 1. */
export const DEFAULT_AUDIO_VOLUME = 0.5;

export interface WaterAudioOptions {
  /** Distance at which the stream is at full volume, in metres. */
  near?: number;
  /** Distance at which the stream has faded to nothing, in metres. */
  far?: number;
  /** Playback volume of the stream at its loudest, 0 to 1. */
  volume?: number;
  /** World seed, so the same world always sounds the same. */
  seed?: number;
  /** Start muted. Useful for tests and for a settings menu later. */
  muted?: boolean;
}

/** A synthesised flow, as a WAV data URI. Memoised: it is deterministic. */
let cachedSource: string | null = null;

/**
 * Build the water sound, or return the one already built.
 *
 * Deterministic in `seed`, so two streams built from the same world sound
 * identical and a test can assert on the result.
 */
export function waterSource(seed = 0): string {
  if (cachedSource === null) cachedSource = synthesizeWaterWav(seed);
  return cachedSource;
}

/** Drop the memoised buffer. Only needed by tests that change the seed. */
export function resetWaterSource(): void {
  cachedSource = null;
}

/**
 * Render a few seconds of flowing water into a WAV data URI.
 *
 * The sound is three things stacked:
 *
 *   a noise floor    white noise, which is what running water actually is.
 *   a low-pass       a one-pole filter rolling off above ~1.2 kHz, which turns
 *                    hiss into the body of a flow. Without it the result reads
 *                    as radio static rather than as water.
 *   a slow swell     two sines at 0.19 Hz and 0.07 Hz, which gives the loop a
 *                    breathing rhythm so it does not sound like a machine.
 *
 * Deterministic, and no `Math.random` anywhere: a seeded LCG stands in for it,
 * so the same seed always renders byte-identical audio.
 */
export function synthesizeWaterWav(seed = 0, seconds = LOOP_SECONDS): string {
  const sampleRate = LOOP_SAMPLE_RATE;
  const count = Math.floor(sampleRate * seconds);
  const pcm = new Int16Array(count);

  let state = (seed | 0) ^ 0x9e3779b9;
  const random = (): number => {
    // Numerical Recipes LCG. Small, fast, and good enough for noise.
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return ((state >>> 8) & 0xffffff) / 0x1000000;
  };

  // One-pole low-pass coefficient for a ~1.2 kHz corner at this sample rate.
  const cutoff = 1200;
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);

  let filtered = 0;
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    const swell = 0.55 + 0.25 * Math.sin(2 * Math.PI * 0.19 * t) + 0.2 * Math.sin(2 * Math.PI * 0.07 * t + 1.1);
    filtered += alpha * (random() * 2 - 1 - filtered);
    // A touch of the unfiltered noise keeps the top end from going dead, which
    // is what makes it read as moving water rather than as wind.
    const sample = (filtered * 0.85 + (random() * 2 - 1) * 0.15) * swell;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 22000)));
  }

  return wavDataUri(pcm, sampleRate);
}

/** Wrap 16-bit mono PCM in a WAV container and base64 it into a data URI. */
export function wavDataUri(pcm: Int16Array, sampleRate: number): string {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);

  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);

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

/** True when the environment can actually play audio. */
function audioAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window.AudioContext ?? (window as { webkitAudioContext?: unknown }).webkitAudioContext) !==
      'undefined'
  );
}

/**
 * The stream's flowing-water sound.
 *
 * One looping source, repositioned every frame to the nearest point on the
 * spline. Constructing it in a headless environment is a no-op, so a world can
 * be built and stepped in tests without a browser.
 */
export class WaterAudio {
  private readonly howl: Howl | null = null;
  private readonly near: number;
  private readonly far: number;
  private readonly peakVolume: number;

  private soundId: number | null = null;
  private muted: boolean;
  private lastPan = Number.NaN;
  private lastVolume = Number.NaN;

  constructor(options: WaterAudioOptions = {}) {
    this.near = Math.max(0, options.near ?? DEFAULT_AUDIO_NEAR);
    this.far = Math.max(this.near + 0.001, options.far ?? DEFAULT_AUDIO_FAR);
    this.peakVolume = Math.min(1, Math.max(0, options.volume ?? DEFAULT_AUDIO_VOLUME));
    this.muted = options.muted ?? false;

    if (!audioAvailable()) return;

    this.howl = new Howl({
      src: [waterSource(options.seed ?? 0)],
      loop: true,
      volume: 0,
      html5: false,
      preload: true,
    });

    if (this.muted) {
      Howler.mute(true);
    } else {
      // Autoplay policy: a browser will refuse to start a context before a
      // gesture. Howler's own auto-unlock handles that, and `play()` before
      // then is queued rather than lost.
      this.soundId = this.howl.play();
    }
  }

  /** True when this instance has a real sound behind it. */
  get isLive(): boolean {
    return this.howl !== null;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.howl) Howler.mute(muted);
  }

  /**
   * Reposition the sound for this frame.
   *
   * `listener` is the camera position and `forward` the direction it looks, both
   * in world space; `stream` supplies the nearest point on the water. Called
   * from `Stream.update` with game time, so pause and dilation apply.
   */
  update(
    delta: number,
    listener: SplinePoint,
    stream: Stream,
    forward: SplinePoint = { x: 0, y: 0, z: 1 },
  ): void {
    if (this.howl === null) return;
    if (!Number.isFinite(delta) || delta < 0) return;

    // The nearest point on the spline is where the water is loudest. Using the
    // nearest point rather than the player's own position matters: standing on
    // the bank two metres from the water should be nearly as loud as standing
    // in it, and the nearest point on the spline captures that while the
    // player's position does not.
    const nearest = stream.query(listener.x, listener.z);
    const source = stream.spline.pointAtDistance(nearest.arcLength);

    // Listener, so anything else using Howler inherits a correct one.
    Howler.pos(listener.x, listener.y, listener.z);

    const dx = source.x - listener.x;
    const dy = source.y - listener.y;
    const dz = source.z - listener.z;
    const distance = Math.hypot(dx, dy, dz);

    // Right vector from the forward direction: forward cross up, normalised.
    // Guarded because a forward vector pointing straight up makes the cross
    // product zero, and a zero-length normal is NaN in the arithmetic below.
    let rx = forward.z;
    let rz = -forward.x;
    const rLen = Math.hypot(rx, rz);
    if (rLen < 1e-6) {
      rx = 1;
      rz = 0;
    } else {
      rx /= rLen;
      rz /= rLen;
    }

    const along = dx * rx + dz * rz;
    const pan = distance > 1e-4 ? Math.max(-1, Math.min(1, along / distance)) : 0;

    // Inverse falloff between the near and far distances, smoothed at both ends
    // so the volume does not step as the player crosses either one.
    const closeness = 1 - smoothstep(this.near, this.far, distance);
    const volume = this.peakVolume * closeness;

    if (pan !== this.lastPan) {
      this.howl.stereo(pan);
      this.lastPan = pan;
    }
    if (volume !== this.lastVolume) {
      this.howl.volume(volume);
      this.lastVolume = volume;
    }

    // A source that has fallen silent is stopped rather than left running at
    // zero volume, so the browser is not keeping a graph node alive for
    // nothing.
    if (this.soundId !== null && !this.howl.playing(this.soundId) && closeness > 0.001) {
      this.soundId = this.howl.play();
    }
  }

  /** Stop and release the sound. */
  dispose(): void {
    if (this.howl === null) return;
    this.howl.stop();
    this.howl.unload();
  }
}

/** Smoothstep on an arbitrary range, clamped at both ends. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
