/**
 * Stream.ts - ASTRA world
 * =============================================================================
 * The stream the player can see, hear and wade through: the water surface, the
 * drifting motes on it, and the sound that follows the player along it.
 *
 * This is the seam between the procedural generators and the rest of the game,
 * exactly as `Terrain` is. Everything below it is plain typed arrays and a
 * shader; everything above it asks questions like "is the player in the water"
 * and never reaches into Three.js or Rapier.
 *
 * Four pieces
 * -----------
 *   surface   the ribbon from `StreamGenerator`, with the patched water
 *             material from `WaterShader`. Level cross-section, soft shoreline,
 *             pollution varying along the spline.
 *   motes     point sprites drifting downstream. Purely procedural: a small
 *             buffer of positions advanced in `update` by walking the spline in
 *             arc length, which is the same parameterization the ribbon uses,
 *             so a mote never slides sideways off the water.
 *   audio     a Howler.js spatial source, positioned at the nearest point on the
 *             spline each frame, so the sound follows the water rather than
 *             sitting at one spot in the world.
 *   queries   `isWaterAt`, `submersionAt`, `surfaceYAt` and `pollutionAt`, which
 *             is what `WorldScene` uses for the wading effect.
 *
 * Ownership: `Stream` builds all of it and `dispose()` releases all of it. The
 * audio object is created and destroyed here too - see `WaterAudio`.
 * =============================================================================
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  type Object3D,
} from 'three';
import {
  StreamProfile,
  generateStream,
  type StreamData,
  type StreamGeneratorOptions,
} from '../procedural/StreamGenerator';
import { createWaterMaterial, type WaterMaterialOptions } from '../procedural/WaterShader';
import { StreamSpline, type SplinePoint } from '../procedural/StreamSpline';
import { WaterAudio, type WaterAudioOptions } from '../audio/WaterAudio';

/** How many drifting motes ride on the surface. */
export const DEFAULT_MOTE_COUNT = 220;

/** Metres per second a mote travels downstream. */
export const DEFAULT_MOTE_SPEED = 0.5;

/** How far a mote may stray from the centreline, as a fraction of half-width. */
const MOTE_SPREAD = 0.7;

/** Above the water by this much, so the sprites are not z-fighting with it. */
const MOTE_LIFT = 0.02;

/** How long a mote lives before it is recycled upstream, in seconds. */
const MOTE_LIFETIME = 60;

export interface StreamOptions {
  /** The stream path. Defaults to the standard sweep. */
  spline?: StreamSpline;
  /** Ground height sampler. Required: the water has to sit on the terrain. */
  heightAt: (x: number, z: number) => number;
  /** World seed, shared with the terrain so both agree on the same stream. */
  seed?: number;
  /** Generator parameters, passed straight through. */
  stream?: StreamGeneratorOptions;
  /** Water material parameters, passed straight through. */
  water?: WaterMaterialOptions;
  /** Audio parameters, passed straight through. Omit to run silent. */
  audio?: WaterAudioOptions;
  /** Number of drifting motes. Zero disables the effect entirely. */
  moteCount?: number;
}

/** What the stream exposes about a point in the world. */
export interface StreamSample {
  readonly distance: number;
  readonly arcLength: number;
  readonly halfWidth: number;
  readonly surfaceY: number;
  readonly pollution: number;
}

export class Stream {
  /** The generated ribbon: typed arrays plus the query helpers. */
  readonly data: StreamData;

  /** The water surface mesh. */
  readonly mesh: Mesh<BufferGeometry, MeshStandardMaterial>;

  /** The drifting motes, or `null` when `moteCount` is zero. */
  readonly motes: Points<BufferGeometry, PointsMaterial> | null;

  /** The stream path this ribbon follows. */
  get spline(): StreamSpline {
    return this.data.spline;
  }

  /** The width, depth and pollution profile along the spline. */
  get profile(): StreamProfile {
    return this.data.profile;
  }

  /** Total arc length of the stream, in metres. */
  get length(): number {
    return this.data.length;
  }

  private readonly heightAt: (x: number, z: number) => number;
  private readonly audio: WaterAudio | null;

  private readonly moteCount: number;
  private readonly moteSpeed: number;
  /** Arc position of each mote, in metres. */
  private readonly moteArc: Float32Array;
  /** Offset across the flow for each mote, as a fraction of half-width. */
  private readonly moteAcross: Float32Array;
  /** Age of each mote in seconds, for the fade in and out. */
  private readonly moteAge: Float32Array;
  private readonly motePhase: Float32Array;
  private readonly moteColor = new Float32Array(0);
  private readonly moteBase: Float32Array;
  private readonly moteGeometry: BufferGeometry | null = null;

  private elapsed = 0;
  private disposed = false;

  constructor(options: StreamOptions) {
    this.heightAt = options.heightAt;

    this.data = generateStream({
      spline: options.spline,
      heightAt: options.heightAt,
      seed: options.seed,
      ...options.stream,
    });

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.data.vertices, 3));
    geometry.setAttribute('astraFlow', new Float32BufferAttribute(this.data.flow, 2));
    geometry.setAttribute('astraDepth', new Float32BufferAttribute(this.data.depths, 1));
    geometry.setAttribute('astraPollution', new Float32BufferAttribute(this.data.pollution, 1));
    geometry.setIndex(Array.from(this.data.indices));
    // The ribbon is a thin sheet; without its own bounds Three would have to
    // measure it every frame for frustum culling, and a stream that spans the
    // map would be measured against a camera that is usually nowhere near it.
    geometry.computeBoundingSphere();

    this.mesh = new Mesh(geometry, createWaterMaterial({ seed: options.seed, ...options.water }));
    this.mesh.name = 'stream-water';
    this.mesh.frustumCulled = true;

    /* ---------------------------------------------------------------- motes */

    this.moteCount = Math.max(0, Math.floor(options.moteCount ?? DEFAULT_MOTE_COUNT));
    this.moteSpeed = DEFAULT_MOTE_SPEED;
    this.moteArc = new Float32Array(this.moteCount);
    this.moteAcross = new Float32Array(this.moteCount);
    this.moteAge = new Float32Array(this.moteCount);
    this.motePhase = new Float32Array(this.moteCount);
    this.moteBase = new Float32Array(this.moteCount * 3);

    if (this.moteCount > 0) {
      this.moteColor = new Float32Array(this.moteCount * 3);
      this.moteGeometry = new BufferGeometry();
      // `BufferAttribute`, not `Float32BufferAttribute`. The convenience class
      // copies its array (`new Float32Array( array )`), so the geometry would
      // hold a snapshot and every write below would go nowhere - the motes would
      // sit frozen at the origin and nothing would look wrong until someone
      // watched the water. `BufferAttribute` stores the array by reference.
      this.moteGeometry.setAttribute('position', new BufferAttribute(this.moteBase, 3));
      this.moteGeometry.setAttribute('color', new BufferAttribute(this.moteColor, 3));
      this.moteGeometry.computeBoundingSphere();
      this.motes = new Points(this.moteGeometry, moteMaterial());
      this.motes.name = 'stream-motes';
      this.motes.frustumCulled = false;

      // Scatter the first frame across the whole stream rather than dropping
      // every mote at the start, where they would all travel down together and
      // read as one clump instead of as a flow.
      const random = mulberry32((options.seed ?? 0) * 2654435761 + 1);
      for (let i = 0; i < this.moteCount; i++) {
        this.moteArc[i] = random() * this.length;
        this.moteAcross[i] = random() * 2 - 1;
        this.moteAge[i] = random() * MOTE_LIFETIME;
        this.motePhase[i] = random() * Math.PI * 2;
      }
      this.writeMotes();
    } else {
      this.motes = null;
    }

    /* ---------------------------------------------------------------- audio */

    this.audio = options.audio ? new WaterAudio(options.audio) : null;
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  /** Everything known about the stream near a world position. */
  query(x: number, z: number): StreamSample {
    return this.data.query(x, z, this.heightAt);
  }

  /** True when the point is over open water, not over the bank. */
  isWaterAt(x: number, z: number): boolean {
    return this.data.isWaterAt(x, z, this.heightAt);
  }

  /** Height of the water surface at a world position. */
  surfaceYAt(x: number, z: number): number {
    return this.data.query(x, z, this.heightAt).surfaceY;
  }

  /** Pollution at a world position, 0 clean to 1 fully polluted. */
  pollutionAt(x: number, z: number): number {
    return this.data.query(x, z, this.heightAt).pollution;
  }

  /** How far the water surface is below `feetY`, or 0 when out of the water. */
  submersionAt(x: number, z: number, feetY: number): number {
    return this.data.submersionAt(x, z, feetY, this.heightAt);
  }

  /** The flowing-water sound, or `null` when this stream was built silent. */
  get sound(): WaterAudio | null {
    return this.audio;
  }

  /* ---------------------------------------------------------------------- */
  /* Presentation                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the presentation by `delta` seconds of game time.
   *
   * Pass `TimeController.getDelta()`, never a raw engine delta, so pause and
   * time dilation stop the water with everything else.
   */
  update(delta: number, listener: SplinePoint): void {
    if (this.disposed) return;
    if (!Number.isFinite(delta) || delta < 0) return;

    this.elapsed += delta;
    // `createWaterMaterial` stashes the shader's uniform objects on
    // `material.userData` from inside `onBeforeCompile`, which is the only place
    // they exist. Advancing `uTime` there is what makes the surface flow.
    const uniforms = this.mesh.material.userData.uniforms as
      | Record<string, { value: number }>
      | undefined;
    if (uniforms?.uTime) uniforms.uTime.value = this.elapsed;

    this.advanceMotes(delta);
    if (this.audio) this.audio.update(delta, listener, this);
  }

  /** Move the motes downstream and rewrite their positions. */
  private advanceMotes(delta: number): void {
    if (this.motes === null || this.moteCount === 0) return;

    for (let i = 0; i < this.moteCount; i++) {
      this.moteAge[i] += delta;
      let a = this.moteArc[i] + this.moteSpeed * delta;

      // Recycle at the downstream end. Resetting the age as well keeps the fade
      // in from being skipped on the frame a mote is reused.
      if (a >= this.length) {
        a -= this.length;
        this.moteAge[i] = 0;
        this.moteAcross[i] = pseudoNoise1(i * 12.9898 + a) * 2 - 1;
      }
      this.moteArc[i] = a;

      const p = this.data.spline.pointAtDistance(a);
      const n = this.data.profile.normalAtDistance(a);
      const across = this.moteAcross[i] * MOTE_SPREAD * this.data.profile.halfWidthAtDistance(a);
      // A slow sideways wander, so the motes do not travel in rigid lanes.
      const wobble = Math.sin(this.elapsed * 0.7 + this.motePhase[i]) * 0.12;

      // The surface height comes from the arc position, not from a world
      // position. `surfaceYAt(x, z)` would work and would cost a full scan of
      // the spline's samples per mote per frame - 220 motes x 1024 samples,
      // which is a quarter of a million distance tests every frame for a number
      // the arc position already knows.
      const surfaceY = this.data.profile.surfaceHeightAtDistance(a, this.heightAt);

      this.moteBase[i * 3] = p.x + n.x * (across + wobble);
      this.moteBase[i * 3 + 1] = surfaceY + MOTE_LIFT;
      this.moteBase[i * 3 + 2] = p.z + n.z * (across + wobble);

      // Fade in and out over the first and last tenth of a life, so motes do
      // not pop into existence at the upstream end.
      const life = this.moteAge[i] / MOTE_LIFETIME;
      const fade = Math.min(1, Math.min(life * 10, (1 - life) * 10));
      const pollution = this.data.profile.pollutionAtDistance(a);
      // Clean water carries pale flecks; polluted water carries darker spores.
      const shade = 0.55 + 0.45 * pollution;
      this.moteColor[i * 3] = shade * fade;
      this.moteColor[i * 3 + 1] = (0.75 + 0.2 * pollution) * fade;
      this.moteColor[i * 3 + 2] = (0.7 - 0.25 * pollution) * fade;
    }

    const position = this.moteGeometry?.getAttribute('position');
    const color = this.moteGeometry?.getAttribute('color');
    if (position) position.needsUpdate = true;
    if (color) color.needsUpdate = true;
  }

  /** Push the motes' current state into their buffers, for the first frame. */
  private writeMotes(): void {
    this.advanceMotes(0);
  }

  addTo(parent: Object3D): void {
    parent.add(this.mesh);
    if (this.motes) parent.add(this.motes);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.mesh);
    if (this.motes) parent.remove(this.motes);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.audio?.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.moteGeometry?.dispose();
    // The mote material is shared between streams, so it is deliberately not
    // disposed here; it lives for the lifetime of the module.
  }
}

/**
 * Point-sprite material for the drifting motes.
 *
 * One instance is shared by every `Stream`, because the material holds no
 * per-stream state - the positions live on the geometry, which is per-stream.
 * The round sprite is drawn into a 32x32 canvas at module load, so there is
 * still no image file anywhere in the project.
 */
let sharedMoteMaterial: PointsMaterial | null = null;

function moteMaterial(): PointsMaterial {
  if (sharedMoteMaterial === null) sharedMoteMaterial = buildMoteMaterial();
  return sharedMoteMaterial;
}

function buildMoteMaterial(): PointsMaterial {
  return new PointsMaterial({
    size: 0.08,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    // Additive, and never writing depth: the motes sit *on* the water, and a
    // depth write here would cut holes in the surface behind them.
    depthWrite: false,
    blending: AdditiveBlending,
    map: createDotTexture(),
  });
}

/**
 * A 32x32 radial dot for the motes, as a `DataTexture`.
 *
 * Built from a typed array rather than drawn into a canvas, because a canvas
 * needs a DOM and the stream has to be constructible in Node - the world scene
 * tests build a whole world without a browser. There is still no image file
 * anywhere in the project; the sprite is 32 rows of numbers.
 */
function createDotTexture(): DataTexture {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const d = Math.hypot(dx, dy) / radius;
      // Two stops: solid at the middle, gone at the rim, with a soft shoulder
      // between. A hard disc reads as a square the moment it is a pixel or two
      // across, which at this size it always is.
      const falloff = d < 0.4 ? 1 : Math.max(0, 1 - (d - 0.4) / 0.6);
      const alpha = Math.round(falloff * falloff * 255);
      const k = (y * size + x) * 4;
      pixels[k] = 255;
      pixels[k + 1] = 255;
      pixels[k + 2] = 255;
      pixels[k + 3] = alpha;
    }
  }

  const texture = new DataTexture(pixels, size, size);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Deterministic 0..1 noise, so a mote's lane does not change between runs. */
function pseudoNoise1(x: number): number {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
}

/** Small deterministic PRNG, so the same seed always scatters the same way. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
