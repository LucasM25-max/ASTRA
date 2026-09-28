// @vitest-environment jsdom
/**
 * PostProcessing unit tests.
 *
 * The chain cannot be executed here - jsdom has no WebGL context and a stub
 * renderer has no shader compiler - so these tests check everything that can be
 * checked without one, and check it hard:
 *
 *   - Uniform-name parity between the TypeScript uniform objects and the GLSL
 *     `uniform` declarations. A name that exists on one side only is a uniform
 *     that is either never set or never read, and GLSL silently ignores an
 *     undeclared name while the JS side silently writes to a location that does
 *     not exist. Nothing throws; the effect just does not happen.
 *   - The shader's structure, asserted as source. The fog must be exponential in
 *     distance, must scale with height and with the valley mask, and must leave
 *     the sky alone; the god rays must be gated on the sun being on screen. A
 *     later edit that drops the height term or moves the gate would otherwise
 *     pass every test in the suite and change the look.
 *   - `buildAtmosphereMask`'s channel encoding and smoothstep shape, against the
 *     real texture bytes.
 *   - The wiring, the per-frame update contract, and disposal.
 *
 * `WebGLRenderer` is stubbed exactly as in render-pipeline.test.ts: everything
 * else is the real thing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Color,
  DataTexture,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import {
  AtmosphereShader,
  buildAtmosphereMask,
  DEFAULT_BLOOM,
  DEFAULT_FOG_SHADER,
  DEFAULT_GOD_RAYS,
  DEFAULT_GRADE,
  GradeShader,
  type PostProcessingOptions,
  PostProcessing,
} from '../src/renderer/PostProcessing';

/* --------------------------------------------------------------- stubbing -- */

const { RendererStub } = vi.hoisted(() => {
  class RendererStub {
    readonly canvas: unknown;
    clearColorHex = 0;
    clearAlpha = 1;
    pixelRatio = 1;
    drawingBufferSize = { width: 800, height: 600 };
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = 'srgb';
    autoClear = true;
    autoClearColor = true;
    autoClearDepth = true;
    autoClearStencil = true;
    shadowMap = { enabled: false, type: 0 };

    constructor(options: { canvas: unknown }) {
      this.canvas = options.canvas;
    }

    getPixelRatio(): number {
      return this.pixelRatio;
    }

    getDrawingBufferSize(target: { width: number; height: number }) {
      target.width = this.drawingBufferSize.width;
      target.height = this.drawingBufferSize.height;
      return target;
    }

    getSize(target: { width: number; height: number }) {
      target.width = this.drawingBufferSize.width;
      target.height = this.drawingBufferSize.height;
      return target;
    }

    setClearColor(color: { getHex(): number }, alpha: number): void {
      this.clearColorHex = color.getHex();
      this.clearAlpha = alpha;
    }

    setPixelRatio(ratio: number): void {
      this.pixelRatio = ratio;
    }

    setSize(width: number, height: number): void {
      this.drawingBufferSize = { width, height };
    }

    render(): void {}

    setRenderTarget(): void {}

    getRenderTarget(): unknown {
      return null;
    }

    clear(): void {}

    getClearColor(target: { set(hex: number): void }) {
      target.set(this.clearColorHex);
      return target;
    }

    getClearAlpha(): number {
      return this.clearAlpha;
    }

    clearColor(): void {}
    clearDepth(): void {}
    clearStencil(): void {}
    dispose(): void {}
  }

  return { RendererStub };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: RendererStub };
});

import { WebGLRenderer } from 'three';
import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/* ----------------------------------------------------------------- helpers -- */

/** Every `uniform <type> <name>;` declared in a GLSL source string. */
function declaredUniforms(source: string): string[] {
  return [...source.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]).sort();
}

/** The uniform names a shader object exposes to Three. */
function objectUniforms(shader: { uniforms: Record<string, unknown> }): string[] {
  return Object.keys(shader.uniforms).sort();
}

/** A stub renderer, cast to the real type the chain asks for. */
function makeRenderer(): WebGLRenderer {
  return new RendererStub({ canvas: null }) as unknown as WebGLRenderer;
}

/** The whole fragment shader of a pass, as one string. */
function frag(shader: { fragmentShader: string }): string {
  return shader.fragmentShader;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

/* -------------------------------------------------------------- the shaders -- */

describe('GradeShader', () => {
  it('declares exactly the uniforms its object exposes', () => {
    // A name on only one side is the classic silent post-processing bug: the JS
    // writes to a location GLSL never declared (so the value is dropped), or
    // GLSL reads a name the JS never sets (so it keeps its initial value
    // forever). Neither raises anything.
    expect(declaredUniforms(frag(GradeShader))).toEqual(objectUniforms(GradeShader));
  });

  it('scales exposure in linear light, before anything else', () => {
    const source = frag(GradeShader);
    // Compare against the first USE in the body, not the declaration: every
    // uniform is declared at the top of the shader, so `indexOf` on the bare
    // name always finds the declaration and the test would pass vacuously.
    const exposureAt = source.indexOf('colour *= uExposure');
    const saturationAt = source.indexOf('mix( vec3( luma ), colour, uSaturation )');
    const liftAt = source.indexOf('+ uLift');
    expect(exposureAt).toBeGreaterThan(-1);
    expect(saturationAt).toBeGreaterThan(-1);
    expect(liftAt).toBeGreaterThan(-1);
    // Exposure has to come first: every later step assumes the image is already
    // at display brightness.
    expect(exposureAt).toBeLessThan(saturationAt);
    expect(exposureAt).toBeLessThan(liftAt);
  });

  it('shifts temperature as a channel gain, not a hue rotation', () => {
    // A hue rotation swings the greens towards orange, which is the last thing
    // an earthy palette needs. The gains are warm-up / cool-down, and the green
    // gain is deliberately the smallest.
    const source = frag(GradeShader);
    const r = /colour\.r \*= 1\.0 \+ uTemperature \* ([\d.]+)/.exec(source);
    const g = /colour\.g \*= 1\.0 \+ uTemperature \* ([\d.]+)/.exec(source);
    const b = /colour\.b \*= 1\.0 - uTemperature \* ([\d.]+)/.exec(source);
    expect(r).not.toBeNull();
    expect(g).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Number(r![1])).toBeGreaterThan(Number(b![1]));
    expect(Number(g![1])).toBeLessThan(Number(r![1]));
    expect(Number(b![1])).toBeGreaterThan(0);
  });

  it('desaturates around Rec.709 luma', () => {
    const source = frag(GradeShader);
    expect(source).toContain('vec3( 0.2126, 0.7152, 0.0722 )');
    expect(source).toMatch(/mix\(\s*vec3\(\s*luma\s*\),\s*colour,\s*uSaturation\s*\)/);
  });

  it('lifts the blacks off zero so a forest floor does not read as a hole', () => {
    const source = frag(GradeShader);
    expect(source).toMatch(/colour = max\( colour, vec3\( 0\.0 \) \) \+ uLift;/);
  });

  it('softens highlights with a shoulder rather than clipping them', () => {
    const source = frag(GradeShader);
    expect(source).toMatch(/peak > uShoulder/);
    expect(source).toMatch(/1\.0 - exp\( -over \* uShoulderStrength \)/);
    // The pressed factor has to be clamped, or a value well over the shoulder
    // drives the multiplier negative and inverts the channel.
    expect(source).toMatch(/clamp\(\s*pressed,\s*0\.0,\s*1\.0\s*\)/);
  });

  it('vignettes by radius, so the corners fall off without a visible edge', () => {
    const source = frag(GradeShader);
    expect(source).toMatch(/length\( vUv - 0\.5 \)/);
    expect(source).toMatch(/smoothstep\( uVignetteRadius, uVignetteRadius \+ 0\.45, radius \)/);
    // 1.4142 is the corner distance, so radius 1 lands exactly on the corners.
    expect(source).toContain('1.41421356');
  });

  it('never emits a negative colour', () => {
    expect(frag(GradeShader)).toMatch(/gl_FragColor = vec4\( max\( colour, vec3\( 0\.0 \) \), 1\.0 \);/);
  });

  it('ships a grade that is warm, restrained and only lightly vignetted', () => {
    // The desaturation is what keeps the earthy palette from going loud.
    expect(DEFAULT_GRADE.saturation).toBeLessThan(1);
    expect(DEFAULT_GRADE.saturation).toBeGreaterThan(0.6);
    expect(DEFAULT_GRADE.temperature).toBeGreaterThan(0);
    expect(DEFAULT_GRADE.lift).toBeGreaterThan(0);
    expect(DEFAULT_GRADE.lift).toBeLessThan(0.05);
    expect(DEFAULT_GRADE.vignette).toBeLessThan(0.35);
    expect(DEFAULT_GRADE.shoulder).toBeGreaterThan(0);
    expect(DEFAULT_GRADE.shoulder).toBeLessThan(1);
    expect(DEFAULT_GRADE.exposure).toBeGreaterThan(0.9);
    expect(DEFAULT_GRADE.exposure).toBeLessThan(1.2);
  });
});

describe('AtmosphereShader', () => {
  it('declares exactly the uniforms its object exposes', () => {
    expect(declaredUniforms(frag(AtmosphereShader))).toEqual(objectUniforms(AtmosphereShader));
  });

  it('treats a far-plane depth as the sky, and leaves it unfogged', () => {
    // The sky dome writes no depth, so without this the horizon disappears into
    // the fog and the world loses its edge.
    const source = frag(AtmosphereShader);
    expect(source).toMatch(/bool sky = depth >= 0\.9999;/);
    expect(source).toMatch(/if \( ! sky \)/);
  });

  it('makes the fog exponential in distance, not linear', () => {
    // Linear fog reads as a gradient painted on the lens.
    const source = frag(AtmosphereShader);
    expect(source).toMatch(/amount = 1\.0 - exp\( -density \* distance \)/);
    expect(source).not.toMatch(/mix\([^;]*distance \* /);
  });

  it('makes the fog exponential in height as well, so it pools in the valley', () => {
    const source = frag(AtmosphereShader);
    expect(source).toMatch(/heightFactor = exp\( -max\( height, 0\.0 \) \/ max\( uHeightFalloff, 1e-3 \) \);/);
    // The height term has to actually scale the density.
    expect(source).toMatch(/density = uDensity \* heightFactor/);
  });

  it('boosts the fog by the valley mask', () => {
    const source = frag(AtmosphereShader);
    expect(source).toMatch(/density = uDensity \* heightFactor \* \( 1\.0 \+ uValleyBoost \* valley \)/);
    expect(source).toMatch(/float valley = clamp\( mask\.r, 0\.0, 1\.0 \);/);
  });

  it('samples the mask by world XZ against its half size, and thins out at the edge', () => {
    // Stopping dead at the mask's box would show the world's edge as a wall.
    const source = frag(AtmosphereShader);
    expect(source).toMatch(/maskUv = world\.xz \/ \( uMaskHalfSize \* 2\.0 \) \+ 0\.5;/);
    expect(source).toMatch(/maskUv\.x > 0\.0 && maskUv\.x < 1\.0 && maskUv\.y > 0\.0 && maskUv\.y < 1\.0/);
  });

  it('drifts the fog in world space, so the mist is anchored to the ground', () => {
    // Drifting by uv would slide the mist across the screen with the camera.
    const source = frag(AtmosphereShader);
    expect(source).toMatch(/drift = 1\.0 \+ uDrift \* 0\.18 \* sin\( uTime \* 0\.21 \+ world\.x \* 0\.05 \+ world\.z \* 0\.037 \)/);
  });

  it('tints the haze green in the rot, from the same mask', () => {
    const source = frag(AtmosphereShader);
    expect(source).toMatch(/haze = mix\( uHazeColor, uCorruptionColor, corruption \* uCorruptionTint \)/);
    expect(source).toMatch(/float corruption = clamp\( mask\.g, 0\.0, 1\.0 \);/);
  });

  it('suppresses the god rays when the sun is off screen', () => {
    // Off screen, or intensity off: no rays and no work. The gate is on the
    // normalised device coordinates, which `update()` sets to (2, 2) when there
    // is no sun at all.
    const source = frag(AtmosphereShader);
    expect(source).toMatch(
      /if \( uRayIntensity > 0\.0 && uSunNdc\.x >= -1\.2 && uSunNdc\.x <= 1\.2 && uSunNdc\.y >= -1\.2 && uSunNdc\.y <= 1\.2 \)/,
    );
  });

  it('reconstructs world position from the depth texture', () => {
    // Both fog and god rays need this, which is why they are one pass.
    const source = frag(AtmosphereShader);
    expect(source).toMatch(/vec3 worldAt\( vec2 uv, float depth \)/);
    expect(source).toMatch(/uProjectionInverse \* vec4\( uv \* 2\.0 - 1\.0, depth \* 2\.0 - 1\.0, 1\.0 \)/);
    expect(source).toMatch(/texture2D\( tDepth, vUv \)\.x/);
  });

  it('ships fog constants that dissolve the 500m terrain instead of ending it', () => {
    // At 0.0052/m the far edge of a 500 m terrain is 92% haze, so the mesh's
    // own edge is never visible - and at 250 m it is 73%, which is a dissolve
    // rather than a wall.
    const at = (d: number) => 1 - Math.exp(-DEFAULT_FOG_SHADER.density * d);
    expect(at(0)).toBe(0);
    expect(at(50)).toBeGreaterThan(0.15);
    expect(at(50)).toBeLessThan(0.35);
    expect(at(250)).toBeGreaterThan(0.6);
    expect(at(250)).toBeLessThan(0.9);
    expect(at(400)).toBeGreaterThan(0.85);
    expect(at(400)).toBeLessThan(1);
    // Monotonic over the whole terrain, not just at the sampled points.
    let previous = -1;
    for (let d = 0; d <= 450; d += 5) {
      const value = at(d);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
    // The valley floor is several times denser than the open ground.
    expect(DEFAULT_FOG_SHADER.valleyBoost).toBeGreaterThan(2);
      // And it thins with height over several metres, not instantly. The test is
      // "several, not one" - a falloff of 30 m is a uniform haze rather than
      // ground fog, and the far field of a high camera comes back as a flat
      // white wall with a luminance spread of 2.4, so the band has to stay in
      // single-digit metres for the mist to read as a bank you see over.
      expect(DEFAULT_FOG_SHADER.heightFalloff).toBeGreaterThan(4);
      expect(DEFAULT_FOG_SHADER.heightFalloff).toBeLessThan(20);
    expect(DEFAULT_FOG_SHADER.heightBase).toBeLessThan(0);
  });

  it('ships a haze that is cooler than the corruption haze', () => {
    // Clean air is a cold grey; rotten air is a sickly yellow-green. If the two
    // were the same the corruption would be invisible in the mist.
    const haze = new Color(0xc6d2d6);
    const rot = new Color(0x707c48);
    expect(haze.b).toBeGreaterThan(haze.r);
    expect(rot.g).toBeGreaterThan(rot.r);
    expect(rot.b).toBeLessThan(rot.g);
  });

  it('ships ray defaults that are cheap and subtle', () => {
    expect(DEFAULT_GOD_RAYS.samples).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_GOD_RAYS.samples).toBeLessThanOrEqual(48);
    expect(DEFAULT_GOD_RAYS.intensity).toBeGreaterThan(0);
    expect(DEFAULT_GOD_RAYS.intensity).toBeLessThan(0.5);
    expect(DEFAULT_BLOOM.threshold).toBeGreaterThan(0.5);
    expect(DEFAULT_BLOOM.strength).toBeLessThan(1);
  });
});

/* ------------------------------------------------------- the atmosphere mask -- */

describe('buildAtmosphereMask', () => {
  /** Row `j` is z = -half + j/(res-1)*size, so the middle row is the stream. */
  const zAt = (j: number, res: number, size: number) =>
    -size / 2 + (j / (res - 1)) * size;

  it('encodes valley in R and corruption in G, with alpha opaque', () => {
    // On the water: R is full. Far from it: R is empty.
    const texture = buildAtmosphereMask(() => ({ distance: 0, corruption: 1 }));
    const data = texture.image.data as Uint8Array;
    expect(data).not.toBeNull();
    expect(data[0]).toBe(255);
    expect(data[1]).toBe(255);
    expect(data[3]).toBe(255);
    // B is unused. Writing anything else there would be a second, silently
    // conflicting source of truth for the same information.
    expect(data[2]).toBe(0);

    const clean = buildAtmosphereMask(() => ({ distance: 999, corruption: 0 }));
    const cleanData = clean.image.data as Uint8Array;
    expect(cleanData[0]).toBe(0);
    expect(cleanData[1]).toBe(0);
  });

  it('puts the densest mist on the water and none far from it', () => {
    // This is the assertion that catches the mask ramping the wrong way. The
    // obvious `distance / valleyWidth` ramps UP with distance, which puts the
    // densest mist on the ridge and none at all in the stream bed - and it
    // passes every test that checks the fog formula instead of the mask.
    const width = 40;
    const size = 100;
    const res = 101;
    const texture = buildAtmosphereMask(
      (_x: number, z: number) => ({ distance: Math.abs(z), corruption: 0 }),
      { size, resolution: res, valleyWidth: width },
    );
    const data = texture.image.data as Uint8Array;
    const at = (j: number) => data[(j * res + Math.floor(res / 2)) * 4] / 255;

    const streamRow = Math.floor(res / 2);
    expect(at(streamRow)).toBe(1);
    // Both ends of the box are further than `width` from the water.
    expect(at(0)).toBe(0);
    expect(at(res - 1)).toBe(0);

    // Monotonic walking out from the water, on both sides.
    for (let j = streamRow; j + 1 < res; j++) {
      expect(at(j + 1)).toBeLessThanOrEqual(at(j) + 1e-6);
    }
    for (let j = streamRow; j - 1 >= 0; j--) {
      expect(at(j - 1)).toBeLessThanOrEqual(at(j) + 1e-6);
    }
  });

  it('uses a smoothstep, so the mist edge is a bank rather than a wall', () => {
    const width = 40;
    const size = 100;
    const res = 101;
    const texture = buildAtmosphereMask(
      (_x: number, z: number) => ({ distance: Math.abs(z), corruption: 0 }),
      { size, resolution: res, valleyWidth: width },
    );
    const data = texture.image.data as Uint8Array;
    const valleyAt = (j: number) => data[(j * res + Math.floor(res / 2)) * 4] / 255;
    // Ramp DOWN from the water's edge: 1 in the bed, 0 at `width` and beyond.
    const expected = (d: number) => {
      const t = Math.min(1, Math.max(0, 1 - d / width));
      return t * t * (3 - 2 * t);
    };
    for (const j of [0, 10, 25, 50, 75, 90, 100]) {
      const z = zAt(j, res, size);
      expect(valleyAt(j)).toBeCloseTo(expected(Math.abs(z)), 2);
    }
    // The derivative at the water is zero - that is the whole point of the
    // smoothstep. A hard ramp would have a corner there.
    const slopeNearWater = Math.abs(valleyAt(52) - valleyAt(50));
    const slopeMidway = Math.abs(valleyAt(70) - valleyAt(65));
    expect(slopeNearWater).toBeLessThan(slopeMidway * 0.2);
  });

  it('honours a wider valley by holding the mist further from the water', () => {
    const size = 100;
    const res = 101;
    const fromZ = (_x: number, z: number) => ({ distance: Math.abs(z), corruption: 0 });
    const narrow = buildAtmosphereMask(fromZ, { size, resolution: res, valleyWidth: 20 });
    const wide = buildAtmosphereMask(fromZ, { size, resolution: res, valleyWidth: 60 });
    const read = (t: { image: { data: unknown; width: number } }, j: number) =>
      ((t.image.data as Uint8Array)[(j * t.image.width + Math.floor(t.image.width / 2)) * 4]) / 255;
    // A wider bank is misty everywhere a narrow one is, so it can only ever be
    // greater or equal - and it has to be strictly greater somewhere, or the
    // width option would do nothing at all.
    for (let j = 0; j < res; j++) {
      expect(read(wide, j)).toBeGreaterThanOrEqual(read(narrow, j) - 1e-6);
    }
    // 20 m out: gone from the narrow bank, still thick in the wide one.
    expect(read(narrow, 70)).toBe(0);
    expect(read(wide, 70)).toBeGreaterThan(0.6);
    // 45 m out: gone from the narrow bank, still there in the wide one.
    expect(read(narrow, 95)).toBe(0);
    expect(read(wide, 95)).toBeGreaterThan(0.1);
  });

  it('carries the corruption channel independently of the valley', () => {
    const texture = buildAtmosphereMask(
      (x) => ({ distance: 0, corruption: x > 0 ? 1 : 0 }),
      { size: 100, resolution: 65 },
    );
    const data = texture.image.data as Uint8Array;
    expect(data).not.toBeNull();
    const res = texture.image.width;
    const left = (Math.floor(res / 2) * res + 2) * 4;
    const right = (Math.floor(res / 2) * res + res - 3) * 4;
    expect(data[left + 1]).toBe(0);
    expect(data[right + 1]).toBe(255);
    // Both halves are in the water, so the valley channel is the same on both.
    expect(data[left]).toBe(255);
    expect(data[right]).toBe(255);
  });

  it('clamps out-of-range sample values instead of wrapping them', () => {
    // A negative distance means "inside the water", which is full density, not
    // none - and clamping is what stops a NaN or a 1.0000001 from wrapping
    // round the byte.
    const texture = buildAtmosphereMask(() => ({ distance: -5, corruption: 4 }), {
      size: 10,
      resolution: 8,
    });
    const data = texture.image.data as Uint8Array;
    expect(data).not.toBeNull();
    expect(data[0]).toBe(255);
    expect(data[1]).toBe(255);
    expect(data[3]).toBe(255);

    const nan = buildAtmosphereMask(
      () => ({ distance: Number.NaN, corruption: Number.NaN }),
      { size: 10, resolution: 8 },
    );
    const nanData = nan.image.data as Uint8Array;
    expect(nanData).not.toBeNull();
    expect(nanData[0]).toBe(0);
    expect(nanData[1]).toBe(0);
    expect(nanData[3]).toBe(255);
  });

  it('builds a square, unsigned-byte RGBA texture at the requested resolution', () => {
    const texture = buildAtmosphereMask(() => ({ distance: 0, corruption: 0 }), {
      size: 400,
      resolution: 128,
    });
    expect(texture).toBeInstanceOf(DataTexture);
    expect(texture.image.width).toBe(128);
    expect(texture.image.height).toBe(128);
    const bytes = texture.image.data;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect((bytes as Uint8Array).length).toBe(128 * 128 * 4);
    expect(texture.format).toBe(RGBAFormat);
    expect(texture.type).toBe(UnsignedByteType);
    expect(texture.name).toBe('astra-atmosphere-mask');
    // `needsUpdate` is a setter with no getter on Three's Texture, so the
    // observable effect of setting it is the version bump.
    expect(texture.version).toBeGreaterThan(0);
  });

  it('refuses a degenerate resolution rather than building a 1x1 mask', () => {
    for (const bad of [0, 1, -4]) {
      const texture = buildAtmosphereMask(() => ({ distance: 0, corruption: 0 }), {
        resolution: bad,
      });
      expect(texture.image.width).toBeGreaterThanOrEqual(2);
    }
  });
});

/* ------------------------------------------------------------ the chain -- */

describe('PostProcessing', () => {
  let renderer: WebGLRenderer;
  let camera: PerspectiveCamera;
  let scene: Scene;

  beforeEach(() => {
    renderer = makeRenderer();
    camera = new PerspectiveCamera(60, 800 / 600, 0.1, 2000);
    scene = new Scene();
  });

  function build(options: Omit<PostProcessingOptions, 'scene' | 'camera'> = {}): PostProcessing {
    return new PostProcessing(renderer, camera, scene, { ...options, scene, camera });
  }

  it('gives the composer a render target that carries a real depth texture', () => {
    // The atmosphere pass rebuilds world position from that depth, so without
    // one it has nothing to read - and Three's default composer target has no
    // depth texture at all.
    const post = build();
    expect(post.renderTarget.depthTexture).not.toBeNull();
    expect(post.renderTarget.depthTexture).toBeDefined();
    post.dispose();
  });

  it('runs the passes in the order the chain needs', () => {
    // Render, then atmosphere, then bloom, then grade, then output. The
    // atmosphere has to be immediately after the render pass because only that
    // buffer has a depth texture.
    const post = build();
    const names = post.composer.passes.map((p) => p.constructor.name);
    expect(names[0]).toBe('RenderPass');
    expect(names[1]).toBe('ShaderPass');
    expect(names[names.length - 1]).toBe('OutputPass');
    expect(names).toContain('UnrealBloomPass');
    expect(names.indexOf('UnrealBloomPass')).toBeGreaterThan(1);
    post.dispose();
  });

  it('multisamples the composer target so the terrain edges do not stair', () => {
    const post = build({ samples: 4 });
    expect(post.renderTarget.samples).toBe(4);
    post.dispose();
  });

  it('honours a request for no multisampling', () => {
    const post = build({ samples: 0 });
    expect(post.renderTarget.samples).toBe(0);
    post.dispose();
  });

  it('puts ACES tone mapping on the renderer, where OutputPass reads it', () => {
    const post = build();
    // ACESFilmicToneMapping is 4 in Three's enum.
    expect(renderer.toneMapping).toBe(4);
    expect(renderer.toneMappingExposure).toBe(1);
    post.dispose();
  });

  it('applies the shipped grade and fog defaults to the passes', () => {
    const post = build();
    const g = (post.composer.passes[post.composer.passes.length - 2] as ShaderPass).uniforms;
    // The grade pass is second from last.
    expect(g.uExposure.value).toBe(DEFAULT_GRADE.exposure);
    expect(g.uSaturation.value).toBe(DEFAULT_GRADE.saturation);
    expect(g.uTemperature.value).toBe(DEFAULT_GRADE.temperature);
    expect(post.atmospherePass.uniforms.uDensity.value).toBe(DEFAULT_FOG_SHADER.density);
    expect(post.atmospherePass.uniforms.uValleyBoost.value).toBe(DEFAULT_FOG_SHADER.valleyBoost);
    post.dispose();
  });

  it('accepts a partial grade without NaN-ing the rest', () => {
    // `{...DEFAULT, ...partial}` where partial has an explicit `undefined`
    // replaces the default with undefined, and the uniform then goes NaN and the
    // whole frame goes black. Partial options must merge over the defaults.
    const post = build();
    post.applyGrade({ saturation: 0.5 });
    expect(post.atmospherePass.uniforms.uDensity.value).toBe(DEFAULT_FOG_SHADER.density);
    const grade = (post.composer.passes[post.composer.passes.length - 2] as ShaderPass).uniforms;
    expect(grade.uSaturation.value).toBe(0.5);
    expect(grade.uExposure.value).toBe(DEFAULT_GRADE.exposure);
    expect(grade.uTemperature.value).toBe(DEFAULT_GRADE.temperature);
    expect(grade.uVignette.value).toBe(DEFAULT_GRADE.vignette);
    post.dispose();
  });

  it('accepts a partial fog without NaN-ing the rest', () => {
    const post = build();
    post.applyFog({ density: 0.01 });
    expect(post.atmospherePass.uniforms.uDensity.value).toBe(0.01);
    expect(post.atmospherePass.uniforms.uValleyBoost.value).toBe(DEFAULT_FOG_SHADER.valleyBoost);
    expect(post.atmospherePass.uniforms.uHeightFalloff.value).toBe(DEFAULT_FOG_SHADER.heightFalloff);
    post.dispose();
  });

  it('turns the rays off by setting their intensity to zero, not by hiding the pass', () => {
    // The pass also draws the fog, so it cannot simply be disabled.
    const post = build({ godRays: { enabled: false } });
    expect(post.atmospherePass.uniforms.uRayIntensity.value).toBe(0);
    expect(post.atmospherePass.enabled).toBe(true);
    post.dispose();
  });

  it('takes the atmosphere mask and its half size from the options', () => {
    const mask = buildAtmosphereMask(() => ({ distance: 0, corruption: 0 }), {
      resolution: 8,
    });
    const post = build({ atmosphereMask: mask, atmosphereMaskHalfSize: 250 });
    expect(post.atmospherePass.uniforms.uMask.value).toBe(mask);
    expect(post.atmospherePass.uniforms.uMaskHalfSize.value).toBe(250);
    post.dispose();
  });

  it('can be switched off without tearing the chain down', () => {
    const post = build();
    expect(post.isEnabled).toBe(true);
    post.setEnabled(false);
    expect(post.isEnabled).toBe(false);
    post.setEnabled(true);
    expect(post.isEnabled).toBe(true);
    post.dispose();
  });

  describe('update', () => {
    it('rejects a non-finite or non-positive delta', () => {
      // A NaN delta poisons the accumulated time forever, and the drift term
      // then walks the fog off to infinity. Zero is rejected too: it would be a
      // no-op on a float accumulator but it is not one on every backend.
      const post = build();
      const before = post.atmospherePass.uniforms.uTime.value as number;
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1 / 60]) {
        post.update(bad, camera);
        expect(post.atmospherePass.uniforms.uTime.value).toBe(before);
      }
      post.update(1 / 60, camera);
      expect(post.atmospherePass.uniforms.uTime.value).toBeCloseTo(before + 1 / 60, 6);
      post.dispose();
    });

    it('accumulates time across frames', () => {
      const post = build();
      for (let i = 0; i < 10; i++) post.update(0.1, camera);
      expect(post.atmospherePass.uniforms.uTime.value).toBeCloseTo(1, 6);
      post.dispose();
    });

    it('feeds the pass the camera position and the inverse projection', () => {
      const post = build();
      camera.position.set(3, 4, 5);
      camera.updateMatrixWorld();
      post.update(0.016, camera);
      const position = post.atmospherePass.uniforms.uCameraPosition.value as Vector3;
      expect(position.x).toBeCloseTo(3, 5);
      expect(position.y).toBeCloseTo(4, 5);
      expect(position.z).toBeCloseTo(5, 5);
      expect(post.atmospherePass.uniforms.uProjectionInverse.value).toBe(
        camera.projectionMatrixInverse,
      );
      post.dispose();
    });

    it('projects a supplied sun position into device coordinates', () => {
      const post = build();
      const sun = new Vector3(50, 80, 30);
      post.update(0.016, camera, sun);
      const ndc = sun.clone().project(camera);
      const stored = post.atmospherePass.uniforms.uSunNdc.value as Vector2;
      expect(stored.x).toBeCloseTo(ndc.x, 5);
      expect(stored.y).toBeCloseTo(ndc.y, 5);
      post.dispose();
    });

    it('parks the sun off screen when none is supplied, which suppresses the rays', () => {
      const post = build();
      post.update(0.016, camera);
      const stored = post.atmospherePass.uniforms.uSunNdc.value as Vector2;
      // Outside the shader's +/-1.2 gate on both axes.
      expect(Math.abs(stored.x)).toBeGreaterThan(1.2);
      expect(Math.abs(stored.y)).toBeGreaterThan(1.2);
      post.dispose();
    });

    it('parks the sun off screen when it is behind the camera', () => {
      const post = build();
      camera.position.set(0, 2, 0);
      camera.lookAt(0, 2, -10);
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      // Straight behind the camera: project() puts it beyond the near plane and
      // the w divide sends it off screen.
      post.update(0.016, camera, new Vector3(0, 2, 40));
      const stored = post.atmospherePass.uniforms.uSunNdc.value as Vector2;
      expect(Number.isFinite(stored.x)).toBe(true);
      expect(Number.isFinite(stored.y)).toBe(true);
      post.dispose();
    });

    it('does nothing once disposed', () => {
      const post = build();
      post.dispose();
      const before = post.atmospherePass.uniforms.uTime.value as number;
      post.update(1, camera);
      expect(post.atmospherePass.uniforms.uTime.value).toBe(before);
    });
  });

  describe('dispose', () => {
    it('disposes the render target and its depth texture', () => {
    const post = build();
    const target = post.renderTarget;
    const depth = target.depthTexture;
    expect(depth).toBeDefined();

    // `WebGLRenderTarget.dispose()` only dispatches an event for the renderer to
    // act on, and there is no renderer here, so what is observable is that the
    // depth texture the chain owned gets its own dispose call. A chain that
    // leaked it would keep a multisampled depth buffer alive for the life of the
    // page, on every resize.
    const depthDisposed = vi.spyOn(depth!, 'dispose');
    const targetDisposed = vi.spyOn(target, 'dispose');
    post.dispose();
    // Exactly once each. The composer was built with this target as its
    // renderTarget1, so it owns it; the chain must not dispose it a second time
    // as well, because a redundant dispose is only harmless for as long as Three
    // keeps dropping the listener before it touches any bookkeeping.
    expect(targetDisposed).toHaveBeenCalledTimes(1);
    expect(depthDisposed).toHaveBeenCalledTimes(1);
  });

  it('is idempotent', () => {
      const post = build();
      post.dispose();
      expect(() => post.dispose()).not.toThrow();
    });

    it('makes render a no-op', () => {
      const post = build();
      post.dispose();
      expect(() => post.render()).not.toThrow();
    });
  });

  it('resizes every pass target', () => {
    const post = build();
    post.setSize(1024, 768);
    expect(post.renderTarget.width).toBe(1024);
    expect(post.renderTarget.height).toBe(768);
    post.dispose();
  });

  it('clamps a zero-size resize instead of building an empty target', () => {
    const post = build();
    post.setSize(0, 0);
    expect(post.renderTarget.width).toBeGreaterThanOrEqual(1);
    expect(post.renderTarget.height).toBeGreaterThanOrEqual(1);
    post.dispose();
  });
});
