/**
 * SkySystem.ts - ASTRA renderer
 * =============================================================================
 * The sky: a gradient dome with a sun disc, a moon, stars and a procedural
 * cloud layer, all in one draw call and no texture files.
 *
 * Step 2.6 asks for a procedural sky, a sun position that drives the lighting
 * direction, gradient colours that follow the time of day, and a scrolling
 * noise-based cloud layer. This is that. The day/night clock that feeds it lives
 * in `DayNightCycle`; this file is only the thing that draws.
 *
 * Five details that matter more than they look:
 *
 *  1. `fog: false`. The dome sits at radius 900, far beyond the scene fog's far
 *     plane. With fog enabled it would be flattened into a single flat colour
 *     and the gradient would vanish entirely.
 *  2. `#include <colorspace_fragment>`. The uniform colours are converted from
 *     sRGB hex into Three's linear working space by `new Color(hex)`, so the
 *     shader has to convert its output back or the sky renders visibly too
 *     dark. Custom ShaderMaterials do not get that conversion for free.
 *  3. The view direction is measured from the CAMERA, not from the world origin.
 *     `normalize(vWorldPosition)` points from the origin, which is wrong the
 *     moment the camera leaves it - and on a 900 m dome enclosing a 500 m world
 *     that is a very large moment. The sun disc would sit tens of degrees away
 *     from the light that is actually casting the shadows. `cameraPosition` is a
 *     built-in uniform Three provides to every ShaderMaterial, so the correct
 *     direction costs one subtraction.
 *  4. The sun disc is drawn where the LIGHT is, from the same unit vector the
 *     light rig uses, so the disc and the shadows cannot disagree. A sun drawn
 *     at a hand-placed angle is the classic version of this bug: the light comes
 *     from one side and the visible sun from the other, and no amount of tuning
 *     the colours hides it.
 *  5. `depthWrite: false`. The dome is background. Writing depth would let it
 *     occlude the world it encloses.
 * =============================================================================
 */

import {
  BackSide,
  Color,
  Mesh,
  type Object3D,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { NOISE_GLSL } from '../procedural/NoiseLibrary';
import type { SkySample } from './DayNightCycle';

/** Large enough to enclose the 500m terrain and the camera, well inside `far`. */
export const DEFAULT_SKY_RADIUS = 900;

export const DEFAULT_ZENITH_COLOR = 0x4a7ea8;
export const DEFAULT_HORIZON_COLOR = 0xe8eef2;

/** Fallback palette for the late-morning tutorial, before the cycle first runs. */
export const DEFAULT_SUN_COLOR = 0xfff1d6;

/**
 * How far the gradient midpoint swings, as a fraction of the sky height.
 * Small on purpose - this is atmosphere, not weather.
 */
export const SKY_DRIFT_AMPLITUDE = 0.06;

/** Radians per second of the drift oscillation (~78s per full cycle). */
export const DEFAULT_DRIFT_SPEED = 0.08;

/**
 * The sun's angular radius, as the cosine of its half-angle.
 *
 * About 1.4 degrees, which is generous - the real sun is 0.27 - but a stylised
 * sun that reads at gameplay distance has to be bigger than the physical one or
 * it aliases into a flickering speck. The soft edge is what stops it reading as
 * a flat decal.
 */
const SUN_COS = Math.cos(1.4 * (Math.PI / 180));

/** The moon's angular radius, same reasoning, slightly larger so it reads. */
const MOON_COS = Math.cos(2.2 * (Math.PI / 180));

/** How tightly the cloud layer hugs the horizon before it fades out. */
const CLOUD_HORIZON_FADE = 0.16;

const vertexShader = /* glsl */ `
  varying vec3 vViewDirection;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    // Direction from the CAMERA to this fragment, not from the world origin.
    // See note 3 in the file header: on a dome this size the difference is the
    // whole sun disc.
    vViewDirection = worldPosition.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uHorizonColor;
  uniform vec3 uZenithColor;
  uniform float uFalloff;
  uniform float uDrift;

  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform float uSunDisc;
  uniform float uSunIntensity;

  uniform vec3 uMoonDirection;
  uniform vec3 uMoonColor;
  uniform float uMoonOpacity;

  uniform float uStarOpacity;

  uniform vec3 uCloudColor;
  uniform float uCloudOpacity;
  uniform float uCloudCoverage;
  uniform vec2 uCloudOffset;
  uniform float uCloudScale;

  varying vec3 vViewDirection;

  ${NOISE_GLSL}

  /**
   * The cloud layer: two octaves of fbm on a plane looking up, scrolling.
   *
   * Projecting onto dir.xz / dir.y rather than sampling the sphere directly is
   * what makes the clouds read as a flat layer overhead instead of a texture
   * wrapped around a ball - the same reason a real cloud deck looks flat from
   * below. Near the horizon the projection runs away to infinity, so the layer
   * fades out there and the horizon colour takes over.
   */
  float cloudLayer(vec3 dir) {
    // Fade the deck out towards the horizon, where the projection diverges.
    float horizonFade = smoothstep(0.0, ${CLOUD_HORIZON_FADE.toFixed(3)}, dir.y);
    if (horizonFade <= 0.001) return 0.0;

    vec2 uv = dir.xz / max(dir.y, 0.05) * uCloudScale + uCloudOffset;
    // Two octaves: one for the bulk of the deck, one to break up its edge. A
    // single octave reads as blotchy paint; four reads as static.
    float coarse = astraFbm2D(uv, 1.7, 2, 2.0, 0.5, false) * 0.5 + 0.5;
    float fine = astraFbm2D(uv * 3.1, 4.3, 2, 2.0, 0.5, false) * 0.5 + 0.5;
    float density = coarse * 0.72 + fine * 0.28;

    // Coverage decides how much of the deck is cloud at all, so the same field
    // can be a clear sky or an overcast one without changing its shape.
    float mask = smoothstep(1.0 - uCloudCoverage, 1.0 - uCloudCoverage + 0.28, density);
    return mask * horizonFade;
  }

  /**
   * Stars: two sparse hash layers, the second dimmer.
   *
   * Quantising the direction into cells and thresholding a hash is the cheapest
   * thing that produces points rather than noise. The cell size is a magic
   * number tuned by eye - too small and the sky is television static, too large
   * and there are four stars in the whole hemisphere.
   */
  float starLayer(vec3 dir) {
    vec3 p = dir * 190.0;
    float a = astraHash1(p.xz + p.y * 17.0, 3.0);
    float b = astraHash1(p.xz * 1.7 + p.y * 31.0, 11.0);
    float near = smoothstep(0.9972, 1.0, a);
    float far = smoothstep(0.9988, 1.0, b) * 0.55;
    // Nothing below the horizon: the ground is in the way.
    return (near + far) * smoothstep(-0.02, 0.06, dir.y);
  }

  void main() {
    // Guard against a zero-length direction, which normalize() leaves undefined.
    // It cannot happen for a camera inside the dome, but "cannot happen" is not
    // a reason to emit NaN into a colour channel - NaN there is a black frame
    // with nothing in the log to say so.
    vec3 dir = length(vViewDirection) > 1e-6
      ? normalize(vViewDirection)
      : vec3(0.0, 1.0, 0.0);

    // 0 at the horizon, 1 at the zenith. Everything below the horizon is clamped
    // to the horizon colour and hidden by the ground anyway.
    float height = clamp(dir.y, 0.0, 1.0);
    float gradient = pow(clamp(height + uDrift, 0.0, 1.0), uFalloff);
    vec3 colour = mix(uHorizonColor, uZenithColor, gradient);

    // Clouds, lit from the sun's own direction so the deck is bright on the
    // sunward side and dark on the far side. A flat-coloured cloud layer is the
    // tell that nobody looked at it twice.
    float cloud = cloudLayer(dir);
    if (cloud > 0.001) {
      float sunward = clamp(dot(normalize(vec3(dir.x, 0.35, dir.z)), uSunDirection) * 0.5 + 0.5, 0.0, 1.0);
      vec3 cloudColour = uCloudColor * (0.45 + 0.85 * sunward);
      colour = mix(colour, cloudColour, cloud * uCloudOpacity);
    }

    // Stars, then the moon, then the sun: back to front, so the moon occludes
    // the stars and the sun occludes everything. Drawing them in the other order
    // puts stars on top of the moon.
    colour += vec3(0.85, 0.88, 1.0) * starLayer(dir) * uStarOpacity;

    float moonDot = dot(dir, uMoonDirection);
    float moon = smoothstep(${MOON_COS.toFixed(6)}, ${(MOON_COS + 0.0004).toFixed(6)}, moonDot);
    if (moon > 0.001) {
      colour = mix(colour, uMoonColor, moon * uMoonOpacity * 0.9);
    }

    float sunDot = dot(dir, uSunDirection);
    // A soft rim, not a hard disc: smoothstep over a hair of angle is what stops
    // the edge aliasing into a staircase at this size.
    float disc = smoothstep(${SUN_COS.toFixed(6)}, ${(SUN_COS + 0.0006).toFixed(6)}, sunDot);
    // Two lobes of glow: a wide one for the air the sun is lighting, a tight one
    // for the disc itself. Without the wide lobe the sun reads as a sticker.
    float glow = pow(max(sunDot, 0.0), 350.0) * 0.55 + pow(max(sunDot, 0.0), 24.0) * 0.14;
    colour = mix(colour, uSunColor, disc * uSunDisc);
    colour += uSunColor * glow * uSunIntensity * uSunDisc * 0.35;

    gl_FragColor = vec4(colour, 1.0);

    #include <colorspace_fragment>
  }
`;

export interface SkySystemOptions {
  radius?: number;
  zenithColor?: number;
  horizonColor?: number;
  /** Controls how tightly the gradient hugs the horizon. Defaults to 0.75. */
  falloff?: number;
  /** Drift rate in radians/second. 0 disables the drift entirely. */
  driftSpeed?: number;
  /** How much of the sky the cloud deck covers, 0..1. Defaults to 0.55. */
  cloudCoverage?: number;
  /** Metres of sky per unit of cloud noise. Defaults to 0.02. */
  cloudScale?: number;
  /** Metres per second the deck scrolls. Defaults to 0.6. */
  cloudSpeed?: number;
}

export class SkySystem {
  readonly mesh: Mesh<SphereGeometry, ShaderMaterial>;

  private readonly driftSpeed: number;
  private readonly cloudSpeed: number;
  private readonly cloudScale: number;
  private time = 0;

  constructor(options: SkySystemOptions = {}) {
    this.driftSpeed = Math.max(0, options.driftSpeed ?? DEFAULT_DRIFT_SPEED);
    this.cloudSpeed = Math.max(0, options.cloudSpeed ?? 0.6);
    this.cloudScale = Math.max(1e-4, options.cloudScale ?? 0.02);

    const geometry = new SphereGeometry(options.radius ?? DEFAULT_SKY_RADIUS, 32, 16);

    const material = new ShaderMaterial({
      name: 'sky-gradient',
      vertexShader,
      fragmentShader,
      uniforms: {
        uHorizonColor: { value: new Color(options.horizonColor ?? DEFAULT_HORIZON_COLOR) },
        uZenithColor: { value: new Color(options.zenithColor ?? DEFAULT_ZENITH_COLOR) },
        uFalloff: { value: options.falloff ?? 0.75 },
        uDrift: { value: 0 },

        uSunDirection: { value: new Vector3(0.5, 0.7, 0.5).normalize() },
        uSunColor: { value: new Color(DEFAULT_SUN_COLOR) },
        uSunDisc: { value: 1 },
        uSunIntensity: { value: 2.6 },

        // The moon is cool by design. A warm moon next to a warm sun is two
        // lights of the same colour and the night reads as an overcast day.
        uMoonDirection: { value: new Vector3(-0.5, 0.6, -0.5).normalize() },
        uMoonColor: { value: new Color(0xdfe6f0) },
        uMoonOpacity: { value: 0 },

        uStarOpacity: { value: 0 },

        // The deck's own colour, before the sunward shading above. Cool and
        // desaturated: the style guide's restrained palette applies to the sky
        // too, and a white cloud deck fights the trees for attention.
        uCloudColor: { value: new Color(0xb8c4cc) },
        uCloudOpacity: { value: 0.6 },
        uCloudCoverage: { value: Math.min(1, Math.max(0, options.cloudCoverage ?? 0.55)) },
        uCloudOffset: { value: new Vector3(0, 0, 0) },
        uCloudScale: { value: this.cloudScale },
      },
      side: BackSide,
      // The dome must never be fogged (see note 1 in the file header) and must
      // never occlude the world it encloses.
      fog: false,
      depthWrite: false,
    });

    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'sky';
    // Always drawn: cheap (one sphere) and immune to any future culling pop.
    this.mesh.frustumCulled = false;
  }

  /** Seconds of game time this sky has been advanced by. */
  get elapsedTime(): number {
    return this.time;
  }

  /** Jump straight to a point in the drift cycle. */
  setTime(seconds: number): void {
    this.time = Math.max(0, seconds);
    this.applyDrift();
  }

  /**
   * Advance the sky by `delta` seconds of *game* time.
   *
   * Callers pass `TimeController.getDelta()`, so the sky slows down and stops
   * with the rest of the world during time dilation.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.time += delta;
    this.applyDrift();
  }

  /**
   * Take a whole sky state from the day/night cycle.
   *
   * One call rather than five setters, so the sky cannot end up half-updated:
   * a new horizon with the old sun direction is exactly the mismatch that looks
   * like a rendering bug and is a bookkeeping one.
   */
  applySkyState(sample: SkySample): void {
    const u = this.mesh.material.uniforms;
    (u.uHorizonColor.value as Color).set(sample.horizonColor);
    (u.uZenithColor.value as Color).set(sample.zenithColor);
    (u.uSunColor.value as Color).set(sample.sunColor);
    (u.uSunDirection.value as Vector3).copy(sample.sunDirection);
    (u.uMoonDirection.value as Vector3).copy(sample.moonDirection);
    u.uSunDisc.value = sample.sunDiscOpacity;
    u.uSunIntensity.value = sample.sunIntensity;
    u.uMoonOpacity.value = sample.moonOpacity;
    u.uStarOpacity.value = sample.starOpacity;
    u.uCloudOpacity.value = sample.cloudOpacity;
  }

  /** Recolour the sky at runtime. */
  setColors(zenithColor: number, horizonColor: number): void {
    (this.mesh.material.uniforms.uZenithColor.value as Color).set(zenithColor);
    (this.mesh.material.uniforms.uHorizonColor.value as Color).set(horizonColor);
  }

  /** How much of the sky the cloud deck covers, 0..1. */
  setCloudCoverage(coverage: number): void {
    this.mesh.material.uniforms.uCloudCoverage.value = Math.min(1, Math.max(0, coverage));
  }

  addTo(parent: Object3D): void {
    parent.add(this.mesh);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.mesh);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  private applyDrift(): void {
    const drift =
      this.driftSpeed > 0 ? Math.sin(this.time * this.driftSpeed) * SKY_DRIFT_AMPLITUDE : 0;
    this.mesh.material.uniforms.uDrift.value = drift;
    // The deck scrolls on its own clock, independent of the gradient's drift -
    // they are unrelated motions and tying them together makes the sky feel
    // mechanical, like one thing wobbling rather than two things happening.
    const offset = this.mesh.material.uniforms.uCloudOffset.value as Vector3;
    offset.set(this.time * this.cloudSpeed, this.time * this.cloudSpeed * 0.35, 0);
  }
}
