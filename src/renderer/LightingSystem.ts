/**
 * LightingSystem.ts - ASTRA renderer
 * =============================================================================
 * The sun and the ambient fill.
 *
 * Step 1.2 asks for exactly two lights: a directional light (the sun) and an
 * ambient light. That is what this provides. Step 2.5 grows it into the full
 * cinematic rig - hemisphere fill, shadow-casting cascades and flickering
 * point lights for the fungal corruption - without changing its interface, so
 * callers keep talking to `lighting.sun` and `lighting.ambient`.
 *
 * The palette follows Astra style guide rule 6 (warm sun, cool shadows): the
 * sun is a warm off-white and the ambient fill is a cool blue-grey, which is
 * what stops a flat green plane from reading as flat green plastic.
 * =============================================================================
 */

import { AmbientLight, DirectionalLight, Group, type Object3D } from 'three';

/** Angled rather than overhead, so shadows (Step 2.5) fall at a readable angle. */
export const DEFAULT_SUN_POSITION = { x: 45, y: 70, z: 30 } as const;

export const DEFAULT_SUN_COLOR = 0xfff1d6;
export const DEFAULT_SUN_INTENSITY = 2.6;
export const DEFAULT_AMBIENT_COLOR = 0xa8bdd4;
export const DEFAULT_AMBIENT_INTENSITY = 0.9;

export interface LightingSystemOptions {
  sunColor?: number;
  sunIntensity?: number;
  sunPosition?: { readonly x: number; readonly y: number; readonly z: number };
  ambientColor?: number;
  ambientIntensity?: number;
}

export class LightingSystem {
  /** The sun: a directional light aimed at the origin. */
  readonly sun: DirectionalLight;
  /** The sky fill: omnidirectional, so it carries no direction. */
  readonly ambient: AmbientLight;
  /** Parent node holding both lights, for tidy add/remove. */
  readonly group: Group;

  constructor(options: LightingSystemOptions = {}) {
    const sunPosition = options.sunPosition ?? DEFAULT_SUN_POSITION;

    this.sun = new DirectionalLight(
      options.sunColor ?? DEFAULT_SUN_COLOR,
      options.sunIntensity ?? DEFAULT_SUN_INTENSITY,
    );
    this.sun.name = 'sun';
    this.sun.position.set(sunPosition.x, sunPosition.y, sunPosition.z);
    // A directional light shines from its position towards its target, which
    // defaults to the origin - the centre of the 100m plane.
    this.sun.target.position.set(0, 0, 0);

    this.ambient = new AmbientLight(
      options.ambientColor ?? DEFAULT_AMBIENT_COLOR,
      options.ambientIntensity ?? DEFAULT_AMBIENT_INTENSITY,
    );
    this.ambient.name = 'ambient';

    this.group = new Group();
    this.group.name = 'lighting';
    this.group.add(this.sun, this.sun.target, this.ambient);
  }

  /** Re-point the sun without recreating it. */
  setSunPosition(x: number, y: number, z: number): void {
    this.sun.position.set(x, y, z);
  }

  addTo(parent: Object3D): void {
    parent.add(this.group);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.group);
  }

  dispose(): void {
    this.sun.dispose();
    this.ambient.dispose();
  }
}
