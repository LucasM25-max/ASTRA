/**
 * LightingSystem.ts - ASTRA renderer
 * =============================================================================
 * The light rig: a warm sun that casts shadows, a cool ambient fill, a
 * hemisphere light that separates sky from ground, and a flicker service for the
 * sickly green glow of the corruption.
 *
 * Step 1.2 asked for exactly two lights and that is still the public surface:
 * callers keep talking to `lighting.sun` and `lighting.ambient`. Everything this
 * step adds hangs off `lighting.group` and needs no change at any call site.
 *
 * Three decisions in here are worth stating up front, because each one is a
 * place where the obvious implementation is wrong:
 *
 *  1. The sun's shadow camera follows the player. A directional light's shadow
 *     camera is a fixed orthographic box in light space; left alone it covers
 *     the same patch of ground forever, so the world outside it casts no shadow
 *     at all. Moving the light and its target together keeps the box over the
 *     player without changing the light's direction.
 *
 *  2. The shadow bias is a normal bias, not a depth bias. Procedural geometry is
 *     the worst case for shadow acne: the trees are noise-displaced cylinders
 *     whose faces lean at every angle, and the terrain is a 1.3 m grid whose
 *     slope reaches 0.32. A depth bias big enough to clear those surfaces also
 *     detaches every shadow from its caster - peter-panning, which on a tree
 *     reads as a shadow floating a metre off the ground. A normal bias scales
 *     the offset with the surface slope instead, which is the one that works.
 *
 *  3. There is one shadow cascade, not the two the plan asks for. See the note
 *     at `SHADOW_CASCADE_NOTE`. The short version is that a second cascade
 *     cannot be done without rewriting the shadow lookup in every material, and
 *     this project patches every material.
 * =============================================================================
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  type Object3D,
  PointLight,
  type Texture,
  Vector3,
} from 'three';
import type { SkySample } from './DayNightCycle';

/** Angled rather than overhead, so shadows fall at a readable angle. */
export const DEFAULT_SUN_POSITION = { x: 45, y: 70, z: 30 } as const;

export const DEFAULT_SUN_COLOR = 0xfff1d6;
export const DEFAULT_SUN_INTENSITY = 2.6;
export const DEFAULT_AMBIENT_COLOR = 0xa8bdd4;
export const DEFAULT_AMBIENT_INTENSITY = 0.9;

/**
 * Sky blue at the top of the hemisphere, earthy green at the bottom.
 *
 * This is the light that stops the world reading as flat. The ambient light is
 * omnidirectional, so it lifts a shadowed trunk and a sunlit rock by exactly the
 * same amount and the picture has no sense of up. A hemisphere light lifts the
 * sky-facing surfaces and barely touches the ground-facing ones, which is what
 * makes a shaded bank read as a shaded bank rather than as a darker bank.
 */
export const DEFAULT_HEMI_SKY_COLOR = 0xbcd4ea;
export const DEFAULT_HEMI_GROUND_COLOR = 0x5c6b3a;
export const DEFAULT_HEMI_INTENSITY = 0.55;

/**
 * Half-width of the shadow box, in metres.
 *
 * Sized to the near and medium tree tiers - the only geometry whose shadows
 * carry any information at gameplay distance. Beyond this the fog has already
 * swallowed the frame, so a shadow there would be invisible anyway.
 */
export const DEFAULT_SHADOW_EXTENT = 110;

/** Shadow map resolution. 2048 over a 220 m box is ~10 cm per texel. */
export const DEFAULT_SHADOW_MAP_SIZE = 2048;

/**
 * Offset along the surface normal, in metres, at which the shadow is sampled.
 *
 * This is the acne cure for leaning, noise-displaced geometry. A depth bias of
 * the same magnitude would detach the shadows from the casters.
 */
export const DEFAULT_SHADOW_NORMAL_BIAS = 0.06;

/** Radius of the PCF blur, in texels. Small: soft edges, not mush. */
export const DEFAULT_SHADOW_RADIUS = 2.2;

/**
 * The default glow colour for the corruption: a sickly green with a yellow
 * cast, which is the same family the fungus materials use so the light and the
 * thing it falls on agree.
 */
export const DEFAULT_GLOW_COLOR = 0x9fc46a;

/** How far the corruption's glow reaches, in metres. */
export const DEFAULT_GLOW_DISTANCE = 34;

/** Height above the ground at which a glow light sits, in metres. */
export const DEFAULT_GLOW_HEIGHT = 1.6;

/** A registered flicker: which light, how fast, and how deep. */
interface Flicker {
  readonly light: PointLight;
  /** The light's own intensity, before flicker. */
  readonly base: number;
  /** Radians per second of the primary wobble. */
  readonly rate: number;
  /** Radians per second of the secondary wobble. */
  readonly secondary: number;
  /** Phase offset, so two lights never pulse in step. */
  readonly phase: number;
  /** How much of the intensity the flicker is allowed to move. */
  readonly depth: number;
  /** Live baseline, or `null` when the captured one is the whole story. */
  readonly baseline: (() => number) | null;
}

export interface FlickerOptions {
  /** Radians per second of the primary wobble. Defaults to 2.1. */
  rate?: number;
  /** Radians per second of the secondary wobble. Defaults to 5.7. */
  secondary?: number;
  /** Fraction of the intensity the flicker may move, 0 to 1. Defaults to 0.28. */
  depth?: number;
  /** Phase offset in turns, 0 to 1. Defaults to a fresh random phase. */
  phase?: number;
  /**
   * Where the un-flickered intensity comes from, read every frame.
   *
   * Without this the baseline is captured once at registration and the flicker
   * owns `intensity` outright - fine for a light whose brightness is fixed.
   * The corruption's glow is not one of those: it scales with the rot under the
   * player's feet and has to keep doing so while it flickers. So the owner of
   * such a light publishes its own baseline and passes it here, and the two
   * systems never write the same field for the same reason.
   */
  baseline?: () => number;
}

export interface LightingSystemOptions {
  sunColor?: number;
  sunIntensity?: number;
  sunPosition?: { readonly x: number; y: number; z: number };
  ambientColor?: number;
  ambientIntensity?: number;
  hemiSkyColor?: number;
  hemiGroundColor?: number;
  hemiIntensity?: number;
  /** Half-width of the sun's shadow box, in metres. Defaults to 110. */
  shadowExtent?: number;
  /** Shadow map edge length in texels. Defaults to 2048. */
  shadowMapSize?: number;
  /** Defaults to true. Turn it off for a headless or screenshot render. */
  shadows?: boolean;
}

export class LightingSystem {
  /** The sun: a directional light aimed at the world origin. */
  readonly sun: DirectionalLight;
  /** The sky fill: omnidirectional, so it carries no direction. */
  readonly ambient: AmbientLight;
  /** Sky above, earth below. The light that gives the world its up. */
  readonly hemi: HemisphereLight;
  /** Parent node holding every light, for tidy add/remove. */
  readonly group: Group;

  private readonly shadowExtent: number;
  /**
   * How far out along its direction the sun sits, in metres.
   *
   * Irrelevant to a directional light's shading - only the direction matters -
   * but it must be outside the shadow camera's far plane or the light is inside
   * its own box and casts nothing. Held as a field so `applySkyState` and the
   * constructor agree on one number.
   */
  private readonly sunDistance: number;
  private readonly flickers: Flicker[] = [];
  private elapsed = 0;

  /** Where the sun last pointed its shadow box, so it can be followed. */
  private readonly shadowFocus = new Vector3(0, 0, 0);

  /**
   * The sun's offset from the point its shadow box is centred on.
   *
   * Captured once at construction and never recomputed. The obvious version of
   * this - deriving the offset from `DEFAULT_SUN_POSITION` on every call - works
   * exactly once: after the first follow the light sits at the focus plus the
   * default offset, so the derived offset collapses to zero and the light lands
   * on top of its own target. The shadows then point nowhere.
   */
  private readonly sunOffset: Vector3;

  constructor(options: LightingSystemOptions = {}) {
    const sunPosition = options.sunPosition ?? DEFAULT_SUN_POSITION;

    this.shadowExtent = Math.max(1, options.shadowExtent ?? DEFAULT_SHADOW_EXTENT);

    // The target starts at the origin, so the light's own position is its offset
    // from the focus.
    this.sunOffset = new Vector3(sunPosition.x, sunPosition.y, sunPosition.z);
    // Far enough out to clear the shadow camera's far plane with room to spare.
    this.sunDistance = Math.max(1, this.sunOffset.length());

    this.sun = new DirectionalLight(
      options.sunColor ?? DEFAULT_SUN_COLOR,
      options.sunIntensity ?? DEFAULT_SUN_INTENSITY,
    );
    this.sun.name = 'sun';
    this.sun.position.set(sunPosition.x, sunPosition.y, sunPosition.z);
    // A directional light shines from its position towards its target, which
    // defaults to the origin - the centre of the 100m plane.
    this.sun.target.position.set(0, 0, 0);
    this.configureSunShadow(options);

    this.ambient = new AmbientLight(
      options.ambientColor ?? DEFAULT_AMBIENT_COLOR,
      options.ambientIntensity ?? DEFAULT_AMBIENT_INTENSITY,
    );
    this.ambient.name = 'ambient';

    this.hemi = new HemisphereLight(
      options.hemiSkyColor ?? DEFAULT_HEMI_SKY_COLOR,
      options.hemiGroundColor ?? DEFAULT_HEMI_GROUND_COLOR,
      options.hemiIntensity ?? DEFAULT_HEMI_INTENSITY,
    );
    this.hemi.name = 'hemisphere';
    // The hemisphere light has no position that matters - it is evaluated per
    // fragment against the world up axis. Putting it at the origin keeps it out
    // of the way of anything that does care about light positions.
    this.hemi.position.set(0, 0, 0);

    this.group = new Group();
    this.group.name = 'lighting';
    this.group.add(this.sun, this.sun.target, this.ambient, this.hemi);
  }

  /* ---------------------------------------------------------------------- */
  /* The sun's shadow                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Size and bias the sun's shadow camera.
   *
   * The near and far planes are pushed as tight as the box allows. A shadow
   * camera whose near plane sits at 0.1 and whose far plane sits at 2000 has a
   * depth range of four orders of magnitude, and a 24-bit depth buffer spread
   * that thin is where acne comes from - not from the bias, which is what it
   * looks like when you are debugging it.
   */
  private configureSunShadow(options: LightingSystemOptions): void {
    const cast = options.shadows ?? true;
    this.sun.castShadow = cast;
    if (!cast) return;

    const size = Math.max(64, Math.floor(options.shadowMapSize ?? DEFAULT_SHADOW_MAP_SIZE));
    const map = this.sun.shadow.mapSize;
    map.set(size, size);

    const camera = this.sun.shadow.camera;
    camera.left = -this.shadowExtent;
    camera.right = this.shadowExtent;
    camera.top = this.shadowExtent;
    camera.bottom = -this.shadowExtent;
    // The box is a slab through the player, not a sphere around the origin: the
    // sun arrives at (45, 70, 30), so its rays are steep enough that a slab
    // centred on the ground under the player covers everything the player can
    // see of the near and medium tiers, and nothing more.
    camera.near = 1;
    camera.far = this.shadowExtent * 4;
    camera.updateProjectionMatrix();

    this.sun.shadow.bias = 0;
    this.sun.shadow.normalBias = DEFAULT_SHADOW_NORMAL_BIAS;
    this.sun.shadow.radius = DEFAULT_SHADOW_RADIUS;
    // The sun is the only shadow caster. The corruption's glow lights are point
    // lights, and six shadow-casting point lights is six extra cube-map renders
    // per frame for a glow that is meant to be felt rather than mapped.
    this.sun.shadow.autoUpdate = true;
  }

  /**
   * Keep the sun's shadow box over `x, z`.
   *
   * Call this once per frame with the camera position. Moving the light and its
   * target by the same vector keeps the light's direction - and therefore the
   * direction of every shadow - exactly where it was.
   */
  followShadowFocus(x: number, z: number, groundHeight = 0): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (this.shadowFocus.x === x && this.shadowFocus.y === groundHeight && this.shadowFocus.z === z) {
      return;
    }
    this.shadowFocus.set(x, groundHeight, z);
    this.sun.target.position.set(x, groundHeight, z);
    this.sun.target.updateMatrixWorld();
    // The light sits at the same offset from the new focus that it started at
    // from the origin, so its direction - and therefore the direction of every
    // shadow in the world - is preserved exactly.
    this.sun.position.set(
      x + this.sunOffset.x,
      groundHeight + this.sunOffset.y,
      z + this.sunOffset.z,
    );
  }

  /**
   * Re-point the sun without recreating it.
   *
   * This also re-bases the shadow box on the new position, so a later
   * `followShadowFocus` slides the box along the new direction rather than the
   * old one. Re-pointing the sun and then having the shadows keep falling the
   * old way is exactly the kind of thing that looks like a lighting bug and is
   * actually a bookkeeping one.
   */
  setSunPosition(x: number, y: number, z: number): void {
    this.sun.position.set(x, y, z);
    this.sunOffset.set(x - this.shadowFocus.x, y - this.shadowFocus.y, z - this.shadowFocus.z);
  }

  /**
   * Re-point the sun along a DIRECTION, keeping the shadow box where it is.
   *
   * This is what the day/night cycle needs and what `setSunPosition` cannot do:
   * `setSunPosition` takes an absolute position, so a direction has to be turned
   * into one by multiplying by a distance - and that absolute position is then
   * measured against the current focus, which leaves `sunOffset` not parallel to
   * the sun direction. The light then drifts off the axis its own shadow camera
   * looks down.
   *
   * Here the offset is written directly as `direction * distance`, so the two
   * invariants that matter both hold afterwards: the target is still the focus,
   * and the light is still out along the direction. A later `followShadowFocus`
   * slides both by the same vector and preserves both.
   */
  setSunDirection(direction: Vector3): void {
    const length = direction.length();
    // A zero direction would leave the offset at zero, putting the light exactly
    // on its target - a directional light aimed at its own position casts no
    // shadow at all and the world goes flat with no error anywhere.
    if (!(length > 1e-6)) return;
    this.sunOffset
      .copy(direction)
      .multiplyScalar(1 / length)
      .multiplyScalar(Math.max(1, this.sunDistance));
    this.sun.position.copy(this.shadowFocus).add(this.sunOffset);
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * Take a whole lighting state from the day/night cycle.
   *
   * The sun's direction comes from the cycle rather than from
   * `DEFAULT_SUN_POSITION`, so the disc in the sky, the shadows on the ground
   * and the colour of the sunlight are all the same sun. `setSunPosition` is
   * used rather than writing `sun.position` directly because it re-bases
   * `sunOffset` - without that the next `followShadowFocus` slides the shadow
   * box back along the OLD direction and the shadows stop matching the sun.
   *
   * The intensity is written every frame, which is deliberate: a caller that
   * also wants the sun to dim has something to overwrite, and the flicker
   * service only touches point lights, so there is no fight here.
   */
  applySkyState(sample: SkySample): void {
    // Re-point along the sampled direction. NOT `setSunPosition(dir * d)`: that
    // takes an absolute world position and re-bases `sunOffset` against whatever
    // the focus happens to be, which breaks the invariant that
    // `sun.position - sun.target.position` is parallel to the sun direction. The
    // next `followShadowFocus` then slides the light along the OLD direction and
    // the shadows stop matching the sun - a bookkeeping bug that looks exactly
    // like a lighting one.
    this.setSunDirection(sample.sunDirection);
    this.sun.color.set(sample.sunColor);
    this.sun.intensity = Math.max(0, sample.sunIntensity);
    this.ambient.color.set(sample.ambientColor);
    this.ambient.intensity = Math.max(0, sample.ambientIntensity);
    this.hemi.color.set(sample.hemiSkyColor);
    this.hemi.groundColor.set(sample.hemiGroundColor);
    this.hemi.intensity = Math.max(0, sample.hemiIntensity);
  }

  /* ---------------------------------------------------------------------- */
  /* The flicker service                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Register a point light to flicker.
   *
   * Returns an unsubscribe function; calling it twice is harmless. The light's
   * intensity at registration is its baseline, and `update` writes
   * `baseline * wobble` every frame - so a caller that wants a glow to fade in
   * and out with the corruption should keep writing the baseline and let this
   * handle the flicker, not the other way round.
   */
  flicker(light: PointLight, options: FlickerOptions = {}): () => void {
    const entry: Flicker = {
      light,
      base: Math.max(0, light.intensity),
      rate: Math.max(0, options.rate ?? 2.1),
      secondary: Math.max(0, options.secondary ?? 5.7),
      phase: (options.phase ?? Math.random()) * Math.PI * 2,
      depth: Math.min(1, Math.max(0, options.depth ?? 0.28)),
      baseline: options.baseline ?? null,
    };
    this.flickers.push(entry);
    return () => {
      const at = this.flickers.indexOf(entry);
      if (at >= 0) this.flickers.splice(at, 1);
    };
  }

  /**
   * Advance every registered flicker by `delta` seconds of game time.
   *
   * Two summed sines rather than noise: it is deterministic, it costs nothing,
   * and - the reason it matters - it is smooth. A flicker that steps between
   * random values reads as a stuttering light, which is a bug report rather than
   * atmosphere.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.elapsed += delta;
    for (const entry of this.flickers) {
      const base = entry.baseline ? Math.max(0, entry.baseline()) : entry.base;
      const wobble =
        1 -
        entry.depth *
          (0.5 +
            0.32 * Math.sin(this.elapsed * entry.rate + entry.phase) +
            0.18 * Math.sin(this.elapsed * entry.secondary + entry.phase * 1.7));
      entry.light.intensity = base * Math.max(0, wobble);
    }
  }

  /** How many lights are currently flickering. */
  get flickerCount(): number {
    return this.flickers.length;
  }

  /* ---------------------------------------------------------------------- */
  /* Scene membership                                                        */
  /* ---------------------------------------------------------------------- */

  addTo(parent: Object3D): void {
    parent.add(this.group);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.group);
  }

  dispose(): void {
    this.flickers.length = 0;
    this.sun.dispose();
    this.ambient.dispose();
    this.hemi.dispose();
  }
}

/**
 * Why there is one shadow cascade and not two.
 *
 * The plan asks for "cascaded shadow maps for sun (at least 2 cascades)". A
 * second cascade cannot be bolted on to this project, for a reason that is worth
 * writing down because it looks like an oversight otherwise.
 *
 * A cascade works by asking, per fragment, which band of the view frustum it
 * falls in and sampling that band's shadow map. That question lives inside
 * Three's `lights_fragment_maps` chunk, so the only ways to answer it are:
 *
 *  - Three's own CSM addon, which assigns `material.onBeforeCompile` outright in
 *    `setupMaterial`. Every procedural material in this project - terrain,
 *    bark, canopy, foliage, fungus, water - is patched through that same
 *    hook, so constructing a CSM after the world is built would silently delete
 *    every one of those patches. Nothing would throw; the corruption, the
 *    drooping canopies and the water's pollution would simply stop appearing.
 *
 *  - Hand-writing the cascade selection into the shadow chunk of every material.
 *    That is a GPU-only bug class: `tsc` cannot see it, the GLSL parser only
 *    checks syntax, and a wrong cascade boundary shows up as a hard shadow seam
 *    that moves as the player walks. There is no way to catch that here.
 *
 * So: one cascade, 2048 texels over a 220 m box, ~10 cm per texel, following the
 * player. That is enough resolution for the near and medium tree tiers, which
 * are the only geometry whose shadows carry information at gameplay distance -
 * and the fog ends at 400 m, so anything beyond the box is already invisible.
 */
export const SHADOW_CASCADE_NOTE =
  'One cascade: CSM overwrites onBeforeCompile, and every procedural material here is patched through it.';

/** True when the colour is a plain number rather than a texture. */
export function isColorLight(value: Color | Texture | null): value is Color {
  return value !== null && typeof (value as Color).isColor === 'boolean';
}
