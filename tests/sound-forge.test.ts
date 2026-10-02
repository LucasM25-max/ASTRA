import { describe, it, expect } from 'vitest';
import {
  Biquad,
  DEFAULT_SAMPLE_RATE,
  FOOTSTEP_SURFACES,
  clipDataUri,
  envelope,
  loopCrossfade,
  normalise,
  packSprites,
  pinkNoise,
  renderBirdCall,
  renderCorruptionHum,
  renderDistantCall,
  renderFootstep,
  renderLeafRustle,
  renderSquelch,
  renderWind,
  shape,
  sineSweep,
  toPcm16,
  wavDataUri,
  wavDataUriChannels,
  whiteNoise,
  type FootstepSurface,
} from '../src/audio/SoundForge';
import { panForAzimuth } from '../src/audio/AmbientSystem';
import { createRng } from '../src/procedural/NoiseLibrary';

/* -------------------------------------------------------------------------- */
/* Measurement helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * RMS of a clip, optionally after a filter.
 *
 * The filters are the shipped ones, measured through the same code path the
 * sounds are built with. A test that reimplemented the filter would be testing
 * its own arithmetic.
 */
function rms(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / Math.max(1, signal.length));
}

function filtered(signal: Float32Array, kind: 'lowpass' | 'highpass' | 'bandpass', hz: number, q = 0.7): Float32Array {
  const copy = signal.slice();
  return new Biquad(kind, hz, DEFAULT_SAMPLE_RATE, q).run(copy);
}

function peak(signal: Float32Array): number {
  let max = 0;
  for (let i = 0; i < signal.length; i++) max = Math.max(max, Math.abs(signal[i]));
  return max;
}

/** Every per-sample step in a clip, sorted. */
function stepStats(signal: Float32Array): { median: number; p99: number; max: number } {
  const steps: number[] = [];
  for (let i = 1; i < signal.length; i++) steps.push(Math.abs(signal[i] - signal[i - 1]));
  steps.sort((a, b) => a - b);
  return {
    median: steps[steps.length >> 1],
    p99: steps[Math.floor(steps.length * 0.99)],
    max: steps[steps.length - 1],
  };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode a `data:audio/wav;base64,` URI back into bytes.
 *
 * Hand-rolled rather than `atob` or `Buffer.from`, because this project has no
 * `@types/node` and the test environment's globals are not something a test
 * should depend on. It is twelve lines and it is the only place in the suite
 * that needs to read back what the container writer produced.
 */
function decodeBase64(text: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    if (char === '=') break;
    const value = BASE64_ALPHABET.indexOf(char);
    expect(value, `base64 character ${char}`).toBeGreaterThanOrEqual(0);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Decode a `data:audio/wav;base64,` URI back into bytes. */
function decodeDataUri(uri: string): Uint8Array {
  expect(uri.startsWith('data:audio/wav;base64,')).toBe(true);
  return decodeBase64(uri.slice('data:audio/wav;base64,'.length));
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}
function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

/** Every renderer, so the shared invariants are checked once rather than ten times. */
const RENDERERS: ReadonlyArray<{ name: string; make: (seed: number) => Float32Array }> = [
  { name: 'bird', make: (s) => renderBirdCall(s) },
  { name: 'wind', make: (s) => renderWind(s, 6) },
  { name: 'leaves', make: (s) => renderLeafRustle(s, 4) },
  { name: 'hum', make: (s) => renderCorruptionHum(s, 5) },
  { name: 'squelch', make: (s) => renderSquelch(s) },
  { name: 'wildlife', make: (s) => renderDistantCall(s) },
  ...FOOTSTEP_SURFACES.map((surface) => ({
    name: `footstep:${surface}`,
    make: (s: number) => renderFootstep(surface, s),
  })),
];

const LOOPING: ReadonlyArray<{ name: string; make: (seed: number) => Float32Array }> = [
  { name: 'wind', make: (s) => renderWind(s, 6) },
  { name: 'leaves', make: (s) => renderLeafRustle(s, 4) },
  { name: 'hum', make: (s) => renderCorruptionHum(s, 5) },
];

/* -------------------------------------------------------------------------- */
/* WAV container                                                              */
/* -------------------------------------------------------------------------- */

describe('WAV container', () => {
  it('writes a well-formed 44-byte header for mono PCM', () => {
    const pcm = toPcm16(sineSweep(new Float32Array(100), DEFAULT_SAMPLE_RATE, () => 440));
    const bytes = decodeDataUri(wavDataUri(pcm, DEFAULT_SAMPLE_RATE));

    expect(bytes.length).toBe(44 + pcm.length * 2);
    expect(readAscii(bytes, 0, 4)).toBe('RIFF');
    expect(readAscii(bytes, 8, 4)).toBe('WAVE');
    expect(readAscii(bytes, 12, 4)).toBe('fmt ');
    expect(readAscii(bytes, 36, 4)).toBe('data');

    expect(readU32(bytes, 4)).toBe(36 + pcm.length * 2); // RIFF chunk size
    expect(readU16(bytes, 16)).toBe(16); // fmt chunk size
    expect(readU16(bytes, 20)).toBe(1); // PCM
    expect(readU16(bytes, 22)).toBe(1); // channels
    expect(readU32(bytes, 24)).toBe(DEFAULT_SAMPLE_RATE);
    expect(readU32(bytes, 28)).toBe(DEFAULT_SAMPLE_RATE * 2); // byte rate
    expect(readU16(bytes, 32)).toBe(2); // block align
    expect(readU16(bytes, 34)).toBe(16); // bits
    expect(readU32(bytes, 40)).toBe(pcm.length * 2); // data chunk size
  });

  it('interleaves multiple channels and gets block align right', () => {
    const left = toPcm16(sineSweep(new Float32Array(50), DEFAULT_SAMPLE_RATE, () => 300));
    const right = toPcm16(sineSweep(new Float32Array(50), DEFAULT_SAMPLE_RATE, () => 600));
    const bytes = decodeDataUri(wavDataUriChannels([left, right], DEFAULT_SAMPLE_RATE));

    expect(readU16(bytes, 22)).toBe(2);
    expect(readU32(bytes, 28)).toBe(DEFAULT_SAMPLE_RATE * 4);
    expect(readU16(bytes, 32)).toBe(4);
    expect(bytes.length).toBe(44 + 50 * 4);

    // Interleaved, not concatenated: frame 0 is left[0] then right[0].
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getInt16(44, true)).toBe(left[0]);
    expect(view.getInt16(46, true)).toBe(right[0]);
    expect(view.getInt16(48, true)).toBe(left[1]);
  });

  it('pads a short channel with silence rather than throwing', () => {
    const long = toPcm16(sineSweep(new Float32Array(20), DEFAULT_SAMPLE_RATE, () => 300));
    const short = toPcm16(sineSweep(new Float32Array(5), DEFAULT_SAMPLE_RATE, () => 600));
    const bytes = decodeDataUri(wavDataUriChannels([long, short], DEFAULT_SAMPLE_RATE));
    expect(bytes.length).toBe(44 + 20 * 4);
  });
});

describe('toPcm16', () => {
  it('clamps instead of wrapping', () => {
    // Wrapping is the failure that turns a loud clip into a burst of noise: an
    // out-of-range value cast straight to int16 flips sign and comes back as a
    // loud sample of the wrong polarity.
    const pcm = toPcm16(new Float32Array([2, -2, 1.5, -1.5, 0]));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(32767);
    expect(pcm[3]).toBe(-32768);
    expect(pcm[4]).toBe(0);
  });

  it('rounds to nearest rather than truncating toward zero', () => {
    // Not exactly 0.5/32767: in binary floating point that product is
    // 0.49999999999999994, which is a tie-break the test would be asserting
    // rather than the rounding rule.
    const pcm = toPcm16(new Float32Array([0.6 / 32767, -0.6 / 32767, 1.4 / 32767, -1.4 / 32767]));
    expect(pcm[0]).toBe(1);
    expect(pcm[1]).toBe(-1);
    expect(pcm[2]).toBe(1);
    expect(pcm[3]).toBe(-1);
  });
});

/* -------------------------------------------------------------------------- */
/* Filters and shapes                                                         */
/* -------------------------------------------------------------------------- */

describe('Biquad', () => {
  it('passes DC through a lowpass and stops the top of the band', () => {
    const dc = new Float32Array(4000).fill(0.5);
    const passed = new Biquad('lowpass', 1000, DEFAULT_SAMPLE_RATE, 0.7).run(dc.slice());
    // A one-pole-ish lowpass settles at unity gain for a constant input. The
    // second-order form needs a few hundred samples to get there.
    expect(Math.abs(passed[passed.length - 1])).toBeCloseTo(0.5, 2);

    // A tone at a third of the sample rate is far above the corner.
    const fast = sineSweep(new Float32Array(4000), DEFAULT_SAMPLE_RATE, () => DEFAULT_SAMPLE_RATE / 3);
    const rolled = new Biquad('lowpass', 1000, DEFAULT_SAMPLE_RATE, 0.7).run(fast.slice());
    expect(rms(rolled.slice(2000))).toBeLessThan(rms(fast.slice(2000)) * 0.05);
  });

  it('rejects DC through a bandpass', () => {
    const dc = new Float32Array(4000).fill(0.5);
    const out = new Biquad('bandpass', 1000, DEFAULT_SAMPLE_RATE, 1).run(dc.slice());
    // Whatever survives the first few samples must decay away.
    expect(Math.abs(out[out.length - 1])).toBeLessThan(1e-3);
  });

  it('stays finite at and past Nyquist, where a biquad is undefined', () => {
    // The guard in `set` exists because a corner at or above Nyquist gives
    // alpha = Infinity or negative, and a NaN filter silently turns a whole
    // clip into NaN - which is silence, not an error.
    for (const hz of [0, -100, DEFAULT_SAMPLE_RATE / 2, DEFAULT_SAMPLE_RATE, DEFAULT_SAMPLE_RATE * 4, Number.NaN]) {
      const out = new Biquad('lowpass', hz, DEFAULT_SAMPLE_RATE, 0.7).run(
        sineSweep(new Float32Array(500), DEFAULT_SAMPLE_RATE, () => 500),
      );
      expect(out.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it('leaves silence silent', () => {
    const out = new Biquad('bandpass', 2000, DEFAULT_SAMPLE_RATE, 2).run(new Float32Array(1000));
    expect(out.every((v) => v === 0)).toBe(true);
  });
});

describe('normalise', () => {
  it('peaks at the requested level', () => {
    const signal = sineSweep(new Float32Array(2000), DEFAULT_SAMPLE_RATE, () => 300);
    normalise(signal, 0.5);
    expect(peak(signal)).toBeCloseTo(0.5, 5);
  });

  it('leaves a silent clip silent rather than dividing by zero', () => {
    const signal = new Float32Array(100);
    normalise(signal, 0.9);
    expect(signal.every((v) => v === 0)).toBe(true);
    expect(signal.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('shape', () => {
  it('preserves sign and monotonicity', () => {
    const signal = new Float32Array([-0.8, -0.2, 0.2, 0.8]);
    shape(signal, 2);
    expect(signal[0]).toBeCloseTo(-0.64, 6);
    expect(signal[3]).toBeCloseTo(0.64, 6);
    // Squaring a small value makes it smaller; the order is preserved.
    expect(signal[1]).toBeCloseTo(-0.04, 6);
  });
});

describe('envelope', () => {
  it('rises over the attack then decays monotonically', () => {
    const signal = new Float32Array(2000).fill(1);
    envelope(signal, DEFAULT_SAMPLE_RATE, 0.01, 0.05);
    expect(signal[0]).toBeLessThan(0.1);
    // The attack ramp is monotonic up to its end.
    const attackEnd = Math.round(0.01 * DEFAULT_SAMPLE_RATE);
    for (let i = 1; i < attackEnd; i++) expect(signal[i]).toBeGreaterThanOrEqual(signal[i - 1]);
    // And the decay is monotonic down afterwards.
    for (let i = attackEnd + 1; i < signal.length; i++) expect(signal[i]).toBeLessThanOrEqual(signal[i - 1]);
    // The tail has actually decayed rather than merely stopped. With 1780
    // samples past the attack and a 1102-sample time constant the remainder is
    // exp(-1.61) = 0.20, so a bound of 0.3 is a decay of better than 3x and
    // still comfortably clear of the measured value.
    expect(signal[signal.length - 1]).toBeLessThan(0.3);
  });
});

/* -------------------------------------------------------------------------- */
/* Loop crossfade                                                             */
/* -------------------------------------------------------------------------- */

describe('loopCrossfade', () => {
  it('returns a loop shorter by exactly the fade, and keeps the body', () => {
    const signal = sineSweep(new Float32Array(5000), DEFAULT_SAMPLE_RATE, () => 300);
    const fadeSeconds = 0.1;
    const fade = Math.round(fadeSeconds * DEFAULT_SAMPLE_RATE);
    const out = loopCrossfade(signal, fadeSeconds, DEFAULT_SAMPLE_RATE);

    expect(out.length).toBe(signal.length - fade);
    // Past the fade region the body is the rendered signal, untouched.
    for (let i = fade; i < out.length; i++) expect(out[i]).toBe(signal[i]);
  });

  it("replaces the wrap-around jump with the natural continuation", () => {
    // What the crossfade actually does: the naive loop's seam is s[L-1] -> s[0],
    // a jump from the end of the render back to its beginning. The crossfaded
    // loop's seam is s[L-1] -> s[L], which are adjacent samples in the original
    // render and therefore already continuous - and the head is blended over the
    // fade so the approach to it is smooth too.
    //
    // So the synthetic signal has to model a render: smooth throughout, with the
    // extra tail continuing it. A discontinuity between ADJACENT samples is not
    // something a crossfade can fix, and asserting on one proves nothing.
    const length = 2000;
    const fade = 500;
    const total = length + fade;
    const cycles = 3;
    const signal = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      signal[i] = Math.sin((2 * Math.PI * cycles * i) / total);
    }

    const naive = Math.abs(signal[length - 1] - signal[0]);
    const out = loopCrossfade(signal, fade / DEFAULT_SAMPLE_RATE, DEFAULT_SAMPLE_RATE);
    expect(out.length).toBe(length);

    const seam = Math.abs(out[0] - out[length - 1]);
    const steps = stepStats(out);

    // The seam is now an ordinary sample-to-sample step.
    expect(seam).toBeLessThanOrEqual(steps.max + 1e-6);
    // And it is far smaller than the jump the naive loop would have made.
    expect(seam).toBeLessThan(naive * 0.2);
    expect(naive).toBeGreaterThan(0.5);
  });

  it('does not read past the end of the signal', () => {
    // The bug this guards: blending the whole output rather than just the head
    // indexes `signal[length + i]` for every i, and every read past the end
    // yields undefined, which makes the entire loop NaN. NaN is silent, so the
    // failure is three ambient layers that quietly do not exist.
    const signal = new Float32Array(1000).fill(0.5);
    const out = loopCrossfade(signal, 0.5, DEFAULT_SAMPLE_RATE);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('is the identity when the fade covers the whole signal', () => {
    const signal = sineSweep(new Float32Array(100), DEFAULT_SAMPLE_RATE, () => 400);
    const out = loopCrossfade(signal, 10, DEFAULT_SAMPLE_RATE);
    expect(out.length).toBe(1);
    expect(Number.isFinite(out[0])).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

describe('sineSweep', () => {
  it('produces the frequency it was asked for', () => {
    const hz = 500;
    const signal = sineSweep(new Float32Array(22050), DEFAULT_SAMPLE_RATE, () => hz);
    let crossings = 0;
    for (let i = 1; i < signal.length; i++) {
      if (signal[i] >= 0 !== signal[i - 1] >= 0) crossings++;
    }
    // Two zero crossings per cycle.
    expect(crossings / 2).toBeCloseTo(hz, -0.5);
  });

  it('actually sweeps when the frequency varies', () => {
    // A chirp must not have a constant zero-crossing rate, or it is a tone with
    // extra steps.
    const signal = sineSweep(new Float32Array(22050), DEFAULT_SAMPLE_RATE, (t) => 300 + 1500 * t);
    const firstThird = signal.slice(0, 7350);
    const lastThird = signal.slice(22050 - 7350);
    const rate = (a: Float32Array): number => {
      let c = 0;
      for (let i = 1; i < a.length; i++) if (a[i] >= 0 !== a[i - 1] >= 0) c++;
      return c / 2 / (a.length / DEFAULT_SAMPLE_RATE);
    };
    expect(rate(lastThird)).toBeGreaterThan(rate(firstThird) * 2);
  });
});

describe('noise sources', () => {
  it('white noise fills the band and pink noise does not', () => {
    const rng = createRng(7);
    const white = whiteNoise(new Float32Array(22050), rng);
    const pink = pinkNoise(new Float32Array(22050), rng);

    for (const noise of [white, pink]) {
      expect(noise.every((v) => Number.isFinite(v))).toBe(true);
      expect(peak(noise)).toBeGreaterThan(0.5);
      expect(peak(noise)).toBeLessThanOrEqual(1);
    }

    // Pink is -3 dB/octave, so it must carry far less energy above 4 kHz than
    // white does. This is the property that makes wind read as wind and not as
    // static, so it is worth asserting rather than assuming.
    const whiteHi = rms(filtered(white, 'highpass', 4000));
    const pinkHi = rms(filtered(pink, 'highpass', 4000));
    expect(pinkHi).toBeLessThan(whiteHi * 0.5);
  });

  it('is deterministic in the seed', () => {
    const a = whiteNoise(new Float32Array(100), createRng(11));
    const b = whiteNoise(new Float32Array(100), createRng(11));
    const c = whiteNoise(new Float32Array(100), createRng(12));
    expect(a.every((v, i) => v === b[i])).toBe(true);
    expect(a.some((v, i) => v !== c[i])).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Sprite packing                                                             */
/* -------------------------------------------------------------------------- */

describe('packSprites', () => {
  it('lays variants end to end with a gap, and reports them in milliseconds', () => {
    const clips = [
      sineSweep(new Float32Array(2205), DEFAULT_SAMPLE_RATE, () => 400), // 100 ms
      sineSweep(new Float32Array(4410), DEFAULT_SAMPLE_RATE, () => 500), // 200 ms
    ];
    const packed = packSprites(clips, ['a', 'b'], DEFAULT_SAMPLE_RATE);

    expect(packed.count).toBe(2);
    expect(Object.keys(packed.sprites)).toEqual(['a', 'b']);
    expect(packed.sprites.a).toEqual([0, 100]);
    expect(packed.sprites.b).toEqual([120, 200]);

    // The gap is 20 ms of silence, so the second sprite starts after it.
    const gap = packed.sprites.b[0] - (packed.sprites.a[0] + packed.sprites.a[1]);
    expect(gap).toBe(20);
  });

  it('keeps every sprite inside the packed buffer', () => {
    const clips = [0, 1, 2, 3].map((i) => sineSweep(new Float32Array(1000 + i * 137), DEFAULT_SAMPLE_RATE, () => 300 + i * 100));
    const packed = packSprites(clips, ['v0', 'v1', 'v2', 'v3'], DEFAULT_SAMPLE_RATE);
    const totalFrames = (decodeDataUri(packed.src).length - 44) / 2;
    const totalMs = (totalFrames / DEFAULT_SAMPLE_RATE) * 1000;
    for (const [start, duration] of Object.values(packed.sprites)) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start + duration).toBeLessThanOrEqual(totalMs);
    }
  });

  it('names missing variants rather than dropping them', () => {
    const packed = packSprites([new Float32Array(100), new Float32Array(100)], ['only'], DEFAULT_SAMPLE_RATE);
    expect(Object.keys(packed.sprites)).toEqual(['only', 'v1']);
  });
});

/* -------------------------------------------------------------------------- */
/* Every renderer                                                             */
/* -------------------------------------------------------------------------- */

describe('every synthesised clip', () => {
  it('is finite, audible, and inside the normalised range', () => {
    for (const { name, make } of RENDERERS) {
      const signal = make(3);
      expect(signal.length, `${name} has samples`).toBeGreaterThan(100);
      expect(signal.every((v) => Number.isFinite(v)), `${name} is finite`).toBe(true);

      const pk = peak(signal);
      expect(pk, `${name} is not silent`).toBeGreaterThan(0.1);
      expect(pk, `${name} does not clip`).toBeLessThanOrEqual(1);
      // Peak-normalised, so the mixing levels in AmbientSystem mean the same
      // thing for every layer.
      expect(pk, `${name} is normalised`).toBeGreaterThan(0.7);

      const level = rms(signal);
      expect(level, `${name} has body`).toBeGreaterThan(0.02);
    }
  });

  it('is deterministic in the seed and sensitive to it', () => {
    for (const { name, make } of RENDERERS) {
      const a = make(101);
      const b = make(101);
      const c = make(102);
      expect(a.every((v, i) => v === b[i]), `${name} is reproducible`).toBe(true);
      expect(a.some((v, i) => v !== c[i]), `${name} varies with the seed`).toBe(true);
    }
  });

  it('survives a hostile seed without producing NaN', () => {
    // Seed 0, negative and huge. `seed | 0` on a value above 2^31 wraps, and a
    // wrapped seed must not become a degenerate RNG.
    for (const seed of [0, -1, 1, 2 ** 31, -(2 ** 31), 0x7fffffff]) {
      for (const { name, make } of RENDERERS) {
        const signal = make(seed);
        expect(signal.every((v) => Number.isFinite(v)), `${name} at seed ${seed}`).toBe(true);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Spectral character                                                         */
/* -------------------------------------------------------------------------- */

describe('the sounds are distinguishable from each other', () => {
  /**
   * The four footstep surfaces are separated almost entirely by their filter,
   * and that separation is the whole feature - "a different sound per surface"
   * is meaningless if the four are the same noise burst. Measured through the
   * shipped filter, with thresholds taken well inside the measured gaps rather
   * than at them.
   */
  it('separates the four footstep surfaces by brightness', () => {
    const energy = (surface: FootstepSurface): { hi: number; lo: number } => {
      const signal = renderFootstep(surface, 5);
      return {
        hi: rms(filtered(signal, 'highpass', 2000)),
        lo: rms(filtered(signal, 'lowpass', 400)),
      };
    };

    const grass = energy('grass');
    const dirt = energy('dirt');
    const rock = energy('rock');
    const water = energy('water');

    // Grass is dry leaves: the brightest of the ground surfaces.
    // Measured 0.108 against dirt's 0.023 - a factor of 4.6, so 2x is safe.
    expect(grass.hi).toBeGreaterThan(dirt.hi * 2);
    // Dirt is a dull thud with body: an order of magnitude more low-mid.
    // Measured 0.086 against grass's 0.0075.
    expect(dirt.lo).toBeGreaterThan(grass.lo * 3);
    // Rock is hard and rings, so it keeps grass's brightness.
    expect(rock.hi).toBeGreaterThan(dirt.hi * 2);
    // Water is a splash, and a splash is the brightest thing on the ground.
    expect(water.hi).toBeGreaterThan(grass.hi);
  });

  it('puts the wind in the lows and the leaves in the highs', () => {
    // This is the pair that has to be right or the forest sounds like a hiss:
    // wind is air moving, leaves are air being struck.
    const wind = renderWind(9, 6);
    const leaves = renderLeafRustle(9, 4);

    const windLo = rms(filtered(wind, 'lowpass', 400));
    const windHi = rms(filtered(wind, 'highpass', 2000));
    const leafLo = rms(filtered(leaves, 'lowpass', 400));
    const leafHi = rms(filtered(leaves, 'highpass', 2000));

    // Measured: wind 0.136 low vs 0.007 high; leaves 0.014 low vs 0.135 high.
    expect(windLo).toBeGreaterThan(windHi * 5);
    expect(leafHi).toBeGreaterThan(leafLo * 3);
    // And they are opposites, not merely different.
    expect(windLo).toBeGreaterThan(leafLo * 3);
    expect(leafHi).toBeGreaterThan(windHi * 5);
  });

  it('puts the corruption hum below everything else in the mix', () => {
    // A hum that shares a band with the wind is not a hum, it is more wind. It
    // has to live under 120 Hz, where nothing else does.
    const hum = renderCorruptionHum(4, 5);
    const sub = rms(filtered(hum, 'lowpass', 120));
    const above = rms(filtered(hum, 'highpass', 2000));
    // Measured: 0.298 against 0.0014.
    expect(sub).toBeGreaterThan(above * 20);
  });

  it('gives bird calls a pitch in the range a small bird actually uses', () => {
    // 0.5 to 5 kHz. A "bird call" at 200 Hz is a frog, and one at 12 kHz is a
    // mosquito, and neither belongs in a daytime forest.
    for (let seed = 0; seed < 12; seed++) {
      const signal = renderBirdCall(seed * 977);
      let crossings = 0;
      for (let i = 1; i < signal.length; i++) {
        if (signal[i] >= 0 !== signal[i - 1] >= 0) crossings++;
      }
      const zcr = (crossings / 2) * (DEFAULT_SAMPLE_RATE / signal.length);
      expect(zcr, `bird ${seed} pitch`).toBeGreaterThan(400);
      expect(zcr, `bird ${seed} pitch`).toBeLessThan(12000);
    }
  });

  it('gives a distant call less top end than a near one', () => {
    // Air absorbs high frequencies, so anything far away is a low, blurred
    // version of itself. A distant call with the same spectrum as a near one is
    // a near call played quietly.
    const near = renderBirdCall(3);
    const far = renderDistantCall(3);
    const nearHi = rms(filtered(near, 'highpass', 2000)) / rms(near);
    const farHi = rms(filtered(far, 'highpass', 2000)) / rms(far);
    expect(farHi).toBeLessThan(nearHi);
  });
});

/* -------------------------------------------------------------------------- */
/* Loop seams                                                                 */
/* -------------------------------------------------------------------------- */

describe('the looping layers loop', () => {
  it('has no step at the wrap point larger than an ordinary step inside the loop', () => {
    // A loop cut at an arbitrary phase clicks once per repetition, and at these
    // cycle lengths that click is the most conspicuous artefact in the mix. The
    // crossfade makes the wrap continuous, so the step across the seam has to be
    // unremarkable - no larger than the 99th-percentile step in the body.
    for (const { name, make } of LOOPING) {
      const signal = make(17);
      const steps = stepStats(signal);
      const seam = Math.abs(signal[0] - signal[signal.length - 1]);
      expect(seam, `${name} seam step`).toBeLessThanOrEqual(steps.p99);
    }
  });

  it('renders to the length it was asked for', () => {
    // The crossfade trims the padded tail, so a 6-second request has to come
    // back as 6 seconds - not 7, which is what an untrimmed render gives.
    expect(renderWind(1, 6).length / DEFAULT_SAMPLE_RATE).toBeCloseTo(6, 5);
    expect(renderLeafRustle(1, 4).length / DEFAULT_SAMPLE_RATE).toBeCloseTo(4, 5);
    expect(renderCorruptionHum(1, 5).length / DEFAULT_SAMPLE_RATE).toBeCloseTo(5, 5);
  });
});

/* -------------------------------------------------------------------------- */
/* clipDataUri                                                                */
/* -------------------------------------------------------------------------- */

describe('clipDataUri', () => {
  it('round-trips a clip to the right number of frames', () => {
    const signal = sineSweep(new Float32Array(1234), DEFAULT_SAMPLE_RATE, () => 440);
    const bytes = decodeDataUri(clipDataUri(signal, DEFAULT_SAMPLE_RATE));
    expect(bytes.length).toBe(44 + 1234 * 2);
    expect(readU32(bytes, 40)).toBe(1234 * 2);
  });
});

/* -------------------------------------------------------------------------- */
/* panForAzimuth                                                              */
/* -------------------------------------------------------------------------- */

describe('panForAzimuth', () => {
  it('centres a source in front or behind, and hard-pans one at the side', () => {
    expect(panForAzimuth(0)).toBeCloseTo(0, 6);
    expect(panForAzimuth(Math.PI)).toBeCloseTo(0, 6);
    expect(panForAzimuth(Math.PI / 2)).toBeCloseTo(1, 6);
    expect(panForAzimuth(-Math.PI / 2)).toBeCloseTo(-1, 6);
  });

  it('stays inside [-1, 1] for any azimuth', () => {
    for (let a = -20; a <= 20; a += 0.13) {
      const pan = panForAzimuth(a);
      expect(pan).toBeGreaterThanOrEqual(-1);
      expect(pan).toBeLessThanOrEqual(1);
    }
  });
});
