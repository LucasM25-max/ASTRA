/**
 * SkySystem.ts - ASTRA renderer
 * =============================================================================
 * The sky: a simple gradient dome, blue at the zenith to white at the horizon.
 *
 * Step 1.2 asks for a "simple skybox (solid gradient blue to white)" and that is
 * what this is - one inverted sphere with a hand-written gradient shader, no
 * texture files (per the code-first asset pillar). Step 2.6 replaces the fixed
 * palette with the procedural sky, sun position and day/night cycle; the dome,
 * the uniforms and the `setTime`/`update` surface are deliberately the ones
 * that work will need.
 *
 * Two details that matter more than they look:
 *
 *  1. `fog: false`. The dome sits at radius 900, far beyond the scene fog's far
 *     plane. With fog enabled it would be flattened into a single flat colour
 *     and the gradient would vanish entirely.
 *  2. `#include <colorspace_fragment>`. The uniform colours are converted from
 *     sRGB hex into Three's linear working space by `new Color(hex)`, so the
 *     shader has to convert its output back or the sky renders visibly too
 *     dark. Custom ShaderMaterials do not get that conversion for free.
 *
 * The gradient drifts very slowly. This exists so the render loop has something
 * real to feed `TimeController.getDelta()` into (a Step 1.2 requirement) and so
 * time dilation is visible in the world rather than only in a number. Step 2.6
 * replaces the drift with the actual day/night cycle.
 * =============================================================================
 */

import {
  BackSide,
  Color,
  Mesh,
  type Object3D,
  ShaderMaterial,
  SphereGeometry,
} from 'three';

/** Large enough to enclose the 100m plane and the camera, well inside `far`. */
export const DEFAULT_SKY_RADIUS = 900;

export const DEFAULT_ZENITH_COLOR = 0x4a7ea8;
export const DEFAULT_HORIZON_COLOR = 0xe8eef2;

/**
 * How far the gradient midpoint swings, as a fraction of the sky height.
 * Small on purpose - this is atmosphere, not weather.
 */
export const SKY_DRIFT_AMPLITUDE = 0.06;

/** Radians per second of the drift oscillation (~78s per full cycle). */
export const DEFAULT_DRIFT_SPEED = 0.08;

const vertexShader = /* glsl */ `
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uHorizonColor;
  uniform vec3 uZenithColor;
  uniform float uFalloff;
  uniform float uDrift;

  varying vec3 vWorldPosition;

  void main() {
    // Direction from the world origin, so the gradient follows the viewer.
    vec3 direction = normalize(vWorldPosition);

    // 0 at the horizon, 1 at the zenith. Everything below the horizon is
    // clamped to the horizon colour and hidden by the ground anyway.
    float height = clamp(direction.y, 0.0, 1.0);
    float gradient = pow(clamp(height + uDrift, 0.0, 1.0), uFalloff);

    gl_FragColor = vec4(mix(uHorizonColor, uZenithColor, gradient), 1.0);

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
}

export class SkySystem {
  readonly mesh: Mesh<SphereGeometry, ShaderMaterial>;

  private readonly driftSpeed: number;
  private time = 0;

  constructor(options: SkySystemOptions = {}) {
    this.driftSpeed = Math.max(0, options.driftSpeed ?? DEFAULT_DRIFT_SPEED);

    const geometry = new SphereGeometry(
      options.radius ?? DEFAULT_SKY_RADIUS,
      32,
      16,
    );

    const material = new ShaderMaterial({
      name: 'sky-gradient',
      vertexShader,
      fragmentShader,
      uniforms: {
        uHorizonColor: { value: new Color(options.horizonColor ?? DEFAULT_HORIZON_COLOR) },
        uZenithColor: { value: new Color(options.zenithColor ?? DEFAULT_ZENITH_COLOR) },
        uFalloff: { value: options.falloff ?? 0.75 },
        uDrift: { value: 0 },
      },
      side: BackSide,
      // The dome must never be fogged (see the note at the top of the file) and
      // must never occlude the world it encloses.
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

  /** Recolour the sky at runtime (used by the day/night cycle in Step 2.6). */
  setColors(zenithColor: number, horizonColor: number): void {
    (this.mesh.material.uniforms.uZenithColor.value as Color).set(zenithColor);
    (this.mesh.material.uniforms.uHorizonColor.value as Color).set(horizonColor);
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
  }
}
