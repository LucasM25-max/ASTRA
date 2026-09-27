/**
 * CorruptionSystem.ts - ASTRA world
 * =============================================================================
 * The rot itself: the ground fungus, the floating spores and the light that
 * comes off them, all of it a function of one number - how rotten the place the
 * player is standing in happens to be.
 *
 * Purely visual and atmospheric, exactly as Step 2.4 asks. Nothing in here is
 * read by the simulation, nothing here collides with anything, and deleting the
 * whole module would change how the world looks and nothing else.
 *
 * Three pieces
 * ------------
 *   ground    mushroom clusters, spore pods, rot and carrion, scattered by
 *             `FungusGenerator.scatterFungus` over a disc that follows the
 *             camera. The shelves that grow on tree trunks are NOT here: they
 *             belong to a specific tree instance, so `Forest` owns them.
 *   spores    point sprites drifting on a wind field, additively blended, with
 *             their colour carrying both the local corruption and their age.
 *   light     one point light with a sickly tint, whose intensity is the local
 *             corruption. The plan's "unnatural lighting" for the inner zone.
 *
 * Why one patch and not the whole world
 * -------------------------------------
 * The corruption field's reach tops out at thirty-four metres, so the rot is a
 * ribbon along the stream rather than a property of the world. Scattering it
 * over all 500 m would mean a few thousand instances almost all of them standing
 * in clean ground, which is the "ring of blight around the whole stream" the
 * scatter's own `minCorruption` exists to avoid.
 *
 * So the patch follows the camera and is rebuilt only when the camera crosses a
 * snapped grid line - the same throttling the forest's foliage uses, for the same
 * reason: scattering a thousand instances is far more expensive than writing
 * their matrices.
 *
 * Everything is seeded off the patch's own cell, so the same patch of ground
 * always grows the same mushrooms. A patch that reshuffled itself as the player
 * paced would read as the forest crawling.
 * =============================================================================
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Object3D,
} from 'three';
import {
  generateFungusGeometry,
  scatterFungus,
  FUNGUS_KINDS,
  FUNGUS_TRIANGLES,
  instancesForBudget,
  type FungusGeometrySet,
  type FungusInstance,
  type FungusKind,
} from '../procedural/FungusGenerator';
import { createFungusMaterial } from '../procedural/FungusMaterial';
import {
  CorruptionField,
  corruptionStage,
  type CorruptionStage,
} from '../procedural/CorruptionField';
import { createRng } from '../procedural/NoiseLibrary';
import type { StreamSpline } from '../procedural/StreamSpline';

/** How far the camera moves before the fungus patch is rescattered, in metres. */
export const CORRUPTION_REBUILD_DISTANCE = 12;

/** Radius of the camera-following fungus patch, in metres. */
export const DEFAULT_FUNGUS_PATCH_RADIUS = 60;

/** How far the camera moves before the spores are re-homed, in metres. */
export const SPORE_REBUILD_DISTANCE = 20;

/**
 * Spores in the air at once.
 *
 * Four hundred and twenty, against the stream's own two hundred and twenty
 * motes. The spores are the bigger effect because they fill a volume rather than
 * riding a surface, and because they are the one thing in the corruption that
 * moves on its own.
 */
export const DEFAULT_SPORE_COUNT = 420;

/** Radius of the disc the spores drift in, in metres. */
export const DEFAULT_SPORE_RADIUS = 26;

/** How high above the ground a spore can drift, in metres. */
export const DEFAULT_SPORE_HEIGHT = 4.2;

/** How far above the ground a spore is held, in metres. */
export const SPORE_GROUND_CLEARANCE = 0.05;

/** Metres per second a spore rises. Buoyant, because spores go up. */
export const DEFAULT_SPORE_RISE = 0.22;

/** Metres per second a spore travels on the wind. */
export const DEFAULT_SPORE_DRIFT = 0.55;

/** How long a spore lives before it is recycled, in seconds. */
export const SPORE_LIFETIME = 14;

/**
 * Triangles the ground fungus may cost per patch.
 *
 * The generators' own counts add up to about a thousand instances per kind at
 * full strength, which at seven hundred triangles a cluster is over half a
 * million triangles for a patch the player can walk out of in ten seconds. The
 * budget is what keeps that honest: the counts below are derived from it rather
 * than written down, so adding a ring to a stalk cannot quietly triple the cost.
 */
export const DEFAULT_FUNGUS_TRIANGLE_BUDGET = 190_000;

/**
 * The kinds that grow on the ground.
 *
 * `shelf` is deliberately absent. A shelf is a bracket: it has a root that sits
 * against a trunk, and `Forest` places those against real tree instances. A
 * shelf scattered flat on the ground is a bracket growing out of nothing.
 */
export const GROUND_KINDS: readonly FungusKind[] = ['mushroom', 'pod', 'rot', 'carrion'];

/**
 * What fraction of the spores are VISIBLE at each corruption stage.
 *
 * A fraction of `DEFAULT_SPORE_COUNT` rather than a count of its own, because
 * the stage is what the player reads and stage 1 has to be a haze rather than a
 * swarm. Stage 0 gets none at all - a spore over clean ground is a spore in the
 * wrong world.
 *
 * This is a density, not a brightness. Scaling the colour instead would give a
 * patch where every spore is present and dim, which reads as haze rather than as
 * thinning air: the plan asks for the density to rise with the stage, and the
 * only way to get that out of one `Points` object is to leave some of them
 * black.
 */
export const SPORE_STAGE_SHARE: Record<CorruptionStage, number> = {
  0: 0,
  1: 0.22,
  2: 0.55,
  3: 1,
};

/**
 * How bright a visible spore is at each stage.
 *
 * Separate from the share, because the two do different work. A stage-1 spore is
 * both sparser and dimmer, which is what makes the outer zone read as a hint of
 * something wrong with the air rather than as a thinner version of the inner
 * zone.
 */
export const SPORE_STAGE_BRIGHTNESS: Record<CorruptionStage, number> = {
  0: 0,
  1: 0.5,
  2: 0.78,
  3: 1,
};

/** The sickly green the rot's light is. */
export const CORRUPTION_LIGHT_COLOR = 0x9fc46a;

/**
 * How bright the light gets at full corruption, in candela.
 *
 * Three's lights are physical since r155, so a point light's illuminance falls
 * off as `intensity / distance^2`. Eight candela is about a third of the ambient
 * term five metres out - enough to read as a pool of sickly green on the ground,
 * and about four hundredths of it at fifteen metres, where it is a hint rather
 * than a lamp.
 */
export const CORRUPTION_LIGHT_INTENSITY = 8;

/** How far the light reaches, in metres. */
export const CORRUPTION_LIGHT_DISTANCE = 34;

/** How far above the ground the rot's light sits, in metres. */
export const CORRUPTION_LIGHT_HEIGHT = 1.6;

/** What the system needs to know about the world it is growing in. */
export interface CorruptionWorldSource {
  /** Ground height sampler. Required: every instance stands on the terrain. */
  heightAt: (x: number, z: number) => number;
  /** Surface normal sampler. Optional: without it there is no slope rejection. */
  normalAt?: (x: number, z: number) => { x: number; y: number; z: number };
}

export interface CorruptionSystemOptions extends CorruptionWorldSource {
  /** World seed, shared with the terrain and the forest. */
  seed?: number;
  /**
   * The stream path, used to build the corruption field when `corruptionAt` is
   * not supplied.
   */
  spline?: StreamSpline;
  /**
   * 0..1 corruption intensity.
   *
   * Optional. Without it the system builds its own `CorruptionField` from the
   * spline, which is the same field the terrain bakes its overlay from and the
   * forest reads its bark colour from - so all three agree by construction
   * rather than by coincidence.
   */
  corruptionAt?: (x: number, z: number) => number;
  /** Radius of the camera-following fungus patch, in metres. */
  patchRadius?: number;
  /** Triangles the ground fungus may cost per patch. */
  triangleBudget?: number;
  /** Per-kind instance counts, overriding the budget-derived defaults. */
  counts?: Partial<Record<FungusKind, number>>;
  /** Number of drifting spores. Zero disables them entirely. */
  sporeCount?: number;
  /** Radius of the disc the spores drift in, in metres. */
  sporeRadius?: number;
  /** The light that comes off the rot. Pass `intensity: 0` to disable it. */
  light?: { intensity?: number; color?: number; distance?: number };
  /**
   * Direction the water flows at a point, as a vector in XZ.
   *
   * Optional. Spores drift on a wind field either way; this adds the slow
   * downstream carry that ties the air to the stream. Sampled once per re-homing
   * rather than per spore per frame, because a spline walk per spore would be
   * four hundred polyline scans every frame for a number that barely changes
   * across a patch.
   */
  flowAt?: (x: number, z: number) => { x: number; z: number };
}

/** What one patch grew, for the overlay and the tests. */
export interface CorruptionStats {
  /** Instances of each ground kind currently drawn. Shelves are always zero. */
  readonly byKind: Record<FungusKind, number>;
  /** Ground instances in total. */
  readonly fungus: number;
  /** Spores currently visible. */
  readonly spores: number;
  /** Corruption at the camera, 0..1. */
  readonly corruption: number;
  /** Stage at the camera. */
  readonly stage: CorruptionStage;
  /** Intensity of the rot's light, in candela. */
  readonly lightIntensity: number;
}

/**
 * The corruption.
 *
 * Builds everything in the constructor and releases everything in `dispose()`.
 * `update` is presentation only: it advances the spores and the light every
 * frame, and when the camera has crossed a snapped grid line it rescatters the
 * patch or re-homes the spores.
 */
export class CorruptionSystem {
  /** Everything the corruption draws, as one group. */
  readonly group: Group = new Group();

  /** The corruption sampler this system answers with. */
  readonly corruptionAt: (x: number, z: number) => number;

  /** The light that comes off the rot. */
  readonly light: PointLight;

  /** The drifting spores, or `null` when `sporeCount` is zero. */
  readonly spores: Points<BufferGeometry, PointsMaterial> | null;

  private readonly heightAt: (x: number, z: number) => number;
  private readonly normalAt?: (x: number, z: number) => { x: number; y: number; z: number };
  private readonly patchRadius: number;
  private readonly patchGrid: number;
  private readonly sporeGrid: number;
  private readonly sporeCount: number;
  private readonly sporeRadius: number;
  private readonly lightIntensity: number;
  private readonly flowAt?: (x: number, z: number) => { x: number; z: number };
  private readonly counts: Record<FungusKind, number>;

  private readonly geometry: FungusGeometrySet;
  private readonly meshes = new Map<FungusKind, InstancedMesh>();
  private readonly materials: ReturnType<typeof createFungusMaterial>[] = [];
  private readonly geometries: BufferGeometry[] = [];

  /* ------------------------------------------------------------- spores ---- */

  private readonly sporeBase: Float32Array;
  private readonly sporeColor: Float32Array;
  private readonly sporeAge: Float32Array;
  private readonly sporePhase: Float32Array;
  private readonly sporeLane: Float32Array;
  private readonly sporeRise: Float32Array;
  /**
   * Each spore's permanent place in the density ordering, 0..1.
   *
   * A spore is lit when its rank is below the share at its own position, which
   * is what makes the density a property of the air rather than of the sprite.
   * Drawn once at construction and never changed: a rank that moved would make
   * spores flicker in and out as the player walked.
   */
  private readonly sporeRank: Float32Array;
  /** How many times each spore has been recycled, for the respawn spread. */
  private readonly sporeCycle: Float32Array;
  private sporeGeometry: BufferGeometry | null = null;
  /** The wind the spores are riding, in world XZ. Unit length, or zero. */
  private readonly wind = new Vector3(0, 0, 0);

  /* ------------------------------------------------------------- state ----- */

  private elapsed = 0;
  private disposed = false;
  private lastCorruption = 0;
  private lastStage: CorruptionStage = 0;
  private lastSpores = 0;
  /** Snapped cell the fungus patch was last scattered for. */
  private lastPatchCell = { x: Number.NaN, z: Number.NaN };
  /** Snapped cell the spores were last homed for. */
  private lastSporeCell = { x: Number.NaN, z: Number.NaN };

  constructor(options: CorruptionSystemOptions) {
    this.heightAt = options.heightAt;
    this.normalAt = options.normalAt;
    this.patchRadius = Math.max(8, options.patchRadius ?? DEFAULT_FUNGUS_PATCH_RADIUS);
    this.patchGrid = CORRUPTION_REBUILD_DISTANCE;
    this.sporeGrid = SPORE_REBUILD_DISTANCE;
    this.sporeCount = Math.max(0, Math.floor(options.sporeCount ?? DEFAULT_SPORE_COUNT));
    this.sporeRadius = Math.max(4, options.sporeRadius ?? DEFAULT_SPORE_RADIUS);
    this.flowAt = options.flowAt;
    this.group.name = 'corruption';

    // The field. Built here rather than passed in, because the corruption system
    // is constructed after the terrain and the forest in `WorldScene` and
    // neither exposes the field it built - and a second field over the same
    // spline at the same resolution is bit-identical to the first, so there is
    // nothing to gain from threading one through three constructors.
    const field = options.spline ? new CorruptionField(options.spline) : null;
    this.corruptionAt =
      options.corruptionAt ?? (field ? (x, z) => field.corruptionAt(x, z) : () => 0);

    /* ------------------------------------------------------------- counts --- */

    // The budget is divided between the four ground kinds in proportion to
    // their own triangle cost, so no single kind can eat the lot. Without the
    // division the cheapest kind takes the whole budget and the rest get
    // nothing, and the patch grows mushrooms and no rot at all.
    const budget = Math.max(0, options.triangleBudget ?? DEFAULT_FUNGUS_TRIANGLE_BUDGET);
    const totalTriangles = GROUND_KINDS.reduce((a, k) => a + FUNGUS_TRIANGLES[k], 0);
    const counts = {} as Record<FungusKind, number>;
    for (const kind of FUNGUS_KINDS) counts[kind] = 0;
    for (const kind of GROUND_KINDS) {
      const share = FUNGUS_TRIANGLES[kind] / totalTriangles;
      counts[kind] = instancesForBudget(kind, budget * share);
    }
    // A caller's explicit count wins outright, except for the shelf: a shelf on
    // the ground is a bracket growing out of nothing, so that override is
    // ignored rather than honoured.
    for (const kind of GROUND_KINDS) {
      const override = options.counts?.[kind];
      if (override !== undefined) counts[kind] = Math.max(0, Math.floor(override));
    }
    this.counts = counts;

    /* ------------------------------------------------------------- ground --- */

    this.geometry = generateFungusGeometry(options.seed ?? 1);

    for (const kind of GROUND_KINDS) {
      // One material per kind, shared by every instance of that kind. The tint
      // that distinguishes one mushroom from another is carried per instance by
      // `aVariation`, so there is nothing left for a per-instance material to
      // do.
      //
      // The wind uniform is this system's own. The forest and the foliage each
      // pass their own around, and two systems writing one uniform would fight
      // over it while one system writing another's would freeze it.
      const material = createFungusMaterial(kind, {
        noiseSeed: options.seed ?? 1,
        windUniform: { value: 0 },
      });
      this.materials.push(material);

      const capacity = Math.max(1, counts[kind]);
      const mesh = new InstancedMesh(toGeometry(this.geometry[kind]), material, capacity);
      mesh.name = `corruption-${kind}`;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      const variation = new InstancedBufferAttribute(new Float32Array(capacity), 1);
      variation.setUsage(DynamicDrawUsage);
      mesh.geometry.setAttribute('aVariation', variation);
      this.geometries.push(mesh.geometry);
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }

    /* ------------------------------------------------------------- spores --- */

    this.sporeBase = new Float32Array(this.sporeCount * 3);
    this.sporeColor = new Float32Array(this.sporeCount * 3);
    this.sporeAge = new Float32Array(this.sporeCount);
    this.sporePhase = new Float32Array(this.sporeCount);
    this.sporeLane = new Float32Array(this.sporeCount);
    this.sporeRise = new Float32Array(this.sporeCount);
    this.sporeRank = new Float32Array(this.sporeCount);
    this.sporeCycle = new Float32Array(this.sporeCount);

    let sporePoints: Points<BufferGeometry, PointsMaterial> | null = null;
    if (this.sporeCount > 0) {
      this.sporeGeometry = new BufferGeometry();
      // `BufferAttribute`, not `Float32BufferAttribute`: the convenience class
      // copies its array, so the geometry would hold a snapshot and every write
      // below would go nowhere. The stream's motes learned this the hard way.
      this.sporeGeometry.setAttribute('position', new BufferAttribute(this.sporeBase, 3));
      this.sporeGeometry.setAttribute('color', new BufferAttribute(this.sporeColor, 3));
      this.sporeGeometry.computeBoundingSphere();
      sporePoints = new Points(this.sporeGeometry, sporeMaterial());
      sporePoints.name = 'corruption-spores';
      sporePoints.frustumCulled = false;
      this.group.add(sporePoints);
    }
    this.spores = sporePoints;

    /* -------------------------------------------------------------- light --- */

    this.lightIntensity = options.light?.intensity ?? CORRUPTION_LIGHT_INTENSITY;
    this.light = new PointLight(
      options.light?.color ?? CORRUPTION_LIGHT_COLOR,
      0,
      options.light?.distance ?? CORRUPTION_LIGHT_DISTANCE,
      // Decay 2 is Three's physical default and the right one here: the rot's
      // light is a local pool of sickly green, not a lamp. Decay 1 would push it
      // thirty metres into clean forest and read as a streetlight.
      2,
    );
    this.light.name = 'corruption-light';
    // Built at zero intensity and never destroyed. Adding a light to a scene
    // changes Three's program for every material in it - one recompile of
    // everything - so the light has to exist from the first frame and only ever
    // have its intensity animated.
    this.light.intensity = 0;
    this.group.add(this.light);

    // First build, centred on the origin, so the corruption is never empty for
    // even one frame: a patch that appears one frame late reads as a pop-in.
    this.rescatter(0, 0);
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  /** Corruption at a world position, 0..1. */
  intensityAt(x: number, z: number): number {
    const c = this.corruptionAt(x, z);
    return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0;
  }

  /** Which of the four zones a world position falls in. */
  stageAt(x: number, z: number): CorruptionStage {
    return corruptionStage(this.intensityAt(x, z));
  }

  /** Statistics for the debug overlay and the tests. */
  get stats(): CorruptionStats {
    const byKind = {} as Record<FungusKind, number>;
    let fungus = 0;
    for (const kind of FUNGUS_KINDS) {
      const n = this.meshes.get(kind)?.count ?? 0;
      byKind[kind] = n;
      fungus += n;
    }
    return {
      byKind,
      fungus,
      spores: this.lastSpores,
      corruption: this.lastCorruption,
      stage: this.lastStage,
      lightIntensity: this.light.intensity,
    };
  }

  /** Spores currently visible. */
  get visibleSpores(): number {
    return this.lastSpores;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /* ---------------------------------------------------------------------- */
  /* Presentation                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the presentation by `delta` seconds of game time.
   *
   * Pass `TimeController.getDelta()`, never a raw engine delta, so pause and
   * time dilation stop the rot with everything else.
   *
   * `camera` is where the viewer is, which is the camera rather than the player:
   * the patch follows the eye, because fungus behind the player is fungus nobody
   * is looking at.
   */
  update(delta: number, camera: { x: number; y: number; z: number }): void {
    if (this.disposed) return;
    if (!Number.isFinite(delta) || delta < 0) return;

    this.elapsed += delta;

    const patchCell = {
      x: Math.round(camera.x / this.patchGrid),
      z: Math.round(camera.z / this.patchGrid),
    };
    if (patchCell.x !== this.lastPatchCell.x || patchCell.z !== this.lastPatchCell.z) {
      this.rescatter(camera.x, camera.z);
    }

    const sporeCell = {
      x: Math.round(camera.x / this.sporeGrid),
      z: Math.round(camera.z / this.sporeGrid),
    };
    if (sporeCell.x !== this.lastSporeCell.x || sporeCell.z !== this.lastSporeCell.z) {
      this.homeSpores(camera.x, camera.z);
    }

    // The light follows the camera every frame rather than on the patch grid. A
    // position change costs one `set()` and recompiles nothing, and a light that
    // jumped twelve metres would visibly pulse as the player walked.
    this.lastCorruption = this.intensityAt(camera.x, camera.z);
    this.lastStage = corruptionStage(this.lastCorruption);
    this.light.position.set(
      camera.x,
      this.heightAt(camera.x, camera.z) + CORRUPTION_LIGHT_HEIGHT,
      camera.z,
    );
    this.light.intensity = this.lightIntensity * this.lastCorruption;

    this.advanceSpores(delta, camera);
  }

  /* ---------------------------------------------------------------------- */
  /* Scene membership                                                       */
  /* ---------------------------------------------------------------------- */

  addTo(parent: Object3D): void {
    parent.add(this.group);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.group);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    // The spore material and its texture are shared between systems, so they are
    // deliberately not disposed here; they live for the module's lifetime.
    this.sporeGeometry?.dispose();
    this.sporeGeometry = null;
    // A light holds no GPU resource of its own, so there is nothing to release
    // beyond dropping it out of the scene, which `group.clear()` does.
    this.group.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Rescatter the patch around a point, and re-home the spores with it.
   *
   * Called from the constructor and from `update` when the camera crosses a
   * patch grid line, never from anywhere else.
   */
  private rescatter(cameraX: number, cameraZ: number): void {
    this.lastPatchCell = {
      x: Math.round(cameraX / this.patchGrid),
      z: Math.round(cameraZ / this.patchGrid),
    };
    this.lastSporeCell = {
      x: Math.round(cameraX / this.sporeGrid),
      z: Math.round(cameraZ / this.sporeGrid),
    };
    this.lastCorruption = this.intensityAt(cameraX, cameraZ);
    this.lastStage = corruptionStage(this.lastCorruption);

    /* ----------------------------------------------------------- fungus --- */

    // Seeded off the cell, not off the camera position, so the same patch of
    // ground always grows the same mushrooms however the player approaches it.
    const seed =
      (Math.imul(this.lastPatchCell.x, 73856093) ^ Math.imul(this.lastPatchCell.z, 19349663)) | 0;

    const instances = scatterFungus({
      seed,
      centreX: cameraX,
      centreZ: cameraZ,
      radius: this.patchRadius,
      field: {
        heightAt: this.heightAt,
        normalAt: this.normalAt,
        corruptionAt: (x, z) => this.intensityAt(x, z),
      },
      counts: this.counts,
    });

    const perKind = new Map<FungusKind, FungusInstance[]>();
    for (const instance of instances) {
      const list = perKind.get(instance.kind);
      if (list) list.push(instance);
      else perKind.set(instance.kind, [instance]);
    }

    const matrix = new Matrix4();
    const position = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    const axis = new Vector3(0, 0, 1);
    const tiltQuat = new Quaternion();
    const yawQuat = new Quaternion();

    for (const kind of GROUND_KINDS) {
      const mesh = this.meshes.get(kind)!;
      const list = perKind.get(kind) ?? [];
      // A drop is counted by truncating, not by overflowing: writing past the
      // end of an instance buffer is silent corruption of whatever instance
      // comes next, and the scatter's own cap is derived from this system's
      // counts so it cannot normally happen.
      const capacity = Math.min(mesh.instanceMatrix.count, list.length);
      const variation = mesh.geometry.getAttribute('aVariation') as InstancedBufferAttribute;

      for (let i = 0; i < capacity; i++) {
        const instance = list[i];
        // Tilt about an axis perpendicular to the yaw, then spin. Order matters:
        // tilting after the spin would lean every mushroom the same way
        // regardless of which way it is facing.
        axis.set(
          Math.cos(instance.rotationY + Math.PI / 2),
          0,
          Math.sin(instance.rotationY + Math.PI / 2),
        );
        tiltQuat.setFromAxisAngle(axis, instance.tilt);
        yawQuat.setFromAxisAngle(WORLD_UP, instance.rotationY);
        rotation.copy(yawQuat).multiply(tiltQuat);
        position.set(instance.x, instance.y, instance.z);
        scale.set(instance.scale, instance.scale, instance.scale);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(i, matrix);
        variation.setX(i, instance.variation);
      }

      mesh.count = capacity;
      mesh.instanceMatrix.needsUpdate = true;
      variation.needsUpdate = true;
    }

    /* ------------------------------------------------------------ spores --- */

    if (this.spores) this.homeSpores(cameraX, cameraZ);
  }

  /**
   * Put every spore somewhere inside the disc around a point.
   *
   * Called only when the camera crosses a spore grid line, which is a coarser
   * grid than the fungus patch's: re-homing a spore mid-flight is visible as a
   * pop, so it is worth doing as rarely as the effect allows.
   */
  private homeSpores(cameraX: number, cameraZ: number): void {
    this.lastSporeCell = {
      x: Math.round(cameraX / this.sporeGrid),
      z: Math.round(cameraZ / this.sporeGrid),
    };

    /* ------------------------------------------------------------- wind ---- */

    // The wind at the patch centre, sampled once. A spline walk per spore per
    // frame would be four hundred polyline scans every frame for a number that
    // barely changes across a patch.
    let windX = 0;
    let windZ = 0;
    const flow = this.flowAt?.(cameraX, cameraZ);
    if (flow) {
      const length = Math.hypot(flow.x, flow.z);
      if (Number.isFinite(length) && length > 1e-6) {
        windX = flow.x / length;
        windZ = flow.z / length;
      }
    }
    // A crosswind on top of the flow, so the spores do not travel in rigid lanes
    // down the valley. Deterministic in the cell, so the same place always has
    // the same wind.
    const cross = Math.sin(cameraX * 0.013 + cameraZ * 0.021) * 0.6;
    this.wind.set(windX - windZ * cross, 0, windZ + windX * cross);
    if (this.wind.lengthSq() > 1e-8) this.wind.normalize();

    /* ----------------------------------------------------------- spores ---- */

    const random = createRng(
      (Math.imul(this.lastSporeCell.x, 374761393) ^ Math.imul(this.lastSporeCell.z, 668265263)) | 0,
    );
    for (let i = 0; i < this.sporeCount; i++) {
      // The rank is a golden-ratio sequence rather than a shuffle: it spreads
      // evenly over 0..1, so the visible subset at any share is spread through
      // the whole patch instead of being the first fifth of the buffer.
      this.sporeRank[i] = (i * 0.6180339887498949) % 1;
      // Square-root distributed over the disc, so the spores are spread through
      // it rather than clumped at the centre where the camera is.
      const a = random() * Math.PI * 2;
      const d = Math.sqrt(random()) * this.sporeRadius;
      const x = cameraX + Math.cos(a) * d;
      const z = cameraZ + Math.sin(a) * d;
      this.sporeBase[i * 3] = x;
      this.sporeBase[i * 3 + 1] = this.heightAt(x, z);
      this.sporeBase[i * 3 + 2] = z;
      // Ages staggered, so the patch does not fade in and out as one block.
      this.sporeAge[i] = random() * SPORE_LIFETIME;
      this.sporePhase[i] = random() * Math.PI * 2;
      // A per-spore lane offset, so two spores on the same wind do not travel
      // together for their whole lives.
      this.sporeLane[i] = random() * 2 - 1;
      this.sporeRise[i] = 0.6 + random() * 0.8;
      this.sporeCycle[i] = 0;
      this.sporeColor[i * 3] = 0;
      this.sporeColor[i * 3 + 1] = 0;
      this.sporeColor[i * 3 + 2] = 0;
    }
  }

  /**
   * Move the spores and write their colours.
   *
   * Gentle by construction: the drift is half a metre a second, the rise is a
   * fifth of that, and the wander is two sines out of phase. Anything faster and
   * the spores read as snow, which is a different world.
   */
  private advanceSpores(delta: number, camera: { x: number; y: number; z: number }): void {
    if (this.spores === null || this.sporeCount === 0) return;

    // Twice the radius, squared: a spore is allowed to drift a little way out of
    // the disc before it is recycled, so the edge of the patch is not a hard
    // ring where every spore turns round at once.
    const limit2 = (this.sporeRadius * 2) * (this.sporeRadius * 2);
    let visible = 0;

    for (let i = 0; i < this.sporeCount; i++) {
      let x = this.sporeBase[i * 3];
      let z = this.sporeBase[i * 3 + 2];

      const dx = x - camera.x;
      const dz = z - camera.z;
      const outside = dx * dx + dz * dz > limit2;
      this.sporeAge[i] += delta;

      if (outside || this.sporeAge[i] >= SPORE_LIFETIME) {
        // Recycled to a fresh point in the disc. The angle comes from the
        // spore's own phase and the radius from a low-discrepancy sequence
        // stepped by the cycle count, so a spore does not keep reappearing in
        // the same place - and, more importantly, does not reappear at the
        // camera, where a pop would be unmistakable.
        this.sporeCycle[i] += 1;
        const t = (i * 0.6180339887 + this.sporeCycle[i] * 0.3779660113) % 1;
        const a = this.sporePhase[i];
        const d = Math.sqrt((t + 1) % 1) * this.sporeRadius;
        x = camera.x + Math.cos(a) * d;
        z = camera.z + Math.sin(a) * d;
        this.sporeAge[i] = 0;
      }

      // Drift on the wind, a slow sideways wander along a per-spore lane, and
      // buoyancy. All three are cheap and all three are out of phase with each
      // other, which is what makes the motion read as air rather than as a
      // conveyor belt.
      const wander = Math.sin(this.elapsed * 0.31 + this.sporePhase[i]) * this.sporeLane[i];
      const wanderZ = Math.cos(this.elapsed * 0.27 + this.sporePhase[i] * 1.7) * this.sporeLane[i];
      x += (this.wind.x * DEFAULT_SPORE_DRIFT + wander * 0.4) * delta;
      z += (this.wind.z * DEFAULT_SPORE_DRIFT + wanderZ * 0.4) * delta;
      // And a vertical bob, so a spore does not rise in a straight line.
      let y = this.sporeBase[i * 3 + 1] + DEFAULT_SPORE_RISE * this.sporeRise[i] * delta;
      y += Math.sin(this.elapsed * 0.5 + this.sporePhase[i]) * 0.12 * delta;

      // Everything below is rounded to float32 before it is used, and that is
      // not fussiness.
      //
      // The buffer is a Float32Array, so the frame stores rounded values and the
      // next frame reads them back. Any quantity derived from an unrounded
      // intermediate is therefore a function of a number the buffer will never
      // hold, and it can differ between two consecutive frames even when nothing
      // moved. The ground height is the one that bites: computed from the
      // full-precision `x` on one frame and from the stored float32 on the next,
      // it differs by a fraction of an ULP, which is enough to flip the clamp
      // below and move a spore by sixty nanometres.
      //
      // Sixty nanometres is invisible. What is not invisible is the invariant it
      // breaks: a frame with a zero delta must not write the buffer, because
      // that is what lets a test - and a reader - assert that time did not pass,
      // so nothing moved.
      x = Math.fround(x);
      z = Math.fround(z);
      y = Math.fround(y);

      // Never below the ground: a spore inside a hill is invisible, and a patch
      // that visibly loses spores on rising ground reads as a clipping bug. And
      // never above the canopy's underside - past a few metres a spore is a
      // speck that reads as dust rather than as rot.
      const ground = this.heightAt(x, z);
      const floor = Math.fround(ground + SPORE_GROUND_CLEARANCE);
      if (!(y > floor)) y = floor;
      const ceiling = Math.fround(ground + DEFAULT_SPORE_HEIGHT);
      if (y > ceiling) y = ceiling;

      this.sporeBase[i * 3] = x;
      this.sporeBase[i * 3 + 1] = y;
      this.sporeBase[i * 3 + 2] = z;

      /* ------------------------------------------------------------ colour -- */

      const corruption = this.intensityAt(x, z);
      const stage = corruptionStage(corruption);
      const share = SPORE_STAGE_SHARE[stage];
      // Fade in over the first tenth of a life and out over the last, so a spore
      // does not pop into existence at the edge of the disc.
      const life = this.sporeAge[i] / SPORE_LIFETIME;
      const fade = Math.min(1, Math.min(life * 10, (1 - life) * 10));

      // The density gate. A spore whose rank is above the local share is left
      // black, and additive blending makes black invisible - so the patch thins
      // out where the air is clean without a second draw call or a second
      // geometry.
      if (share <= 0 || fade <= 0 || this.sporeRank[i] >= share) {
        // Additive blending, so black is invisible rather than dark. That is
        // what makes a per-spore density possible without a second draw call: a
        // spore over clean ground adds nothing to the frame.
        this.sporeColor[i * 3] = 0;
        this.sporeColor[i * 3 + 1] = 0;
        this.sporeColor[i * 3 + 2] = 0;
        continue;
      }
      visible++;

      // Sickly green at low corruption, bruised purple at high. The two are the
      // palette the fungus geometry is already built from, so the air and the
      // ground are the same rot.
      const luma = SPORE_STAGE_BRIGHTNESS[stage] * fade * (0.55 + 0.45 * corruption);
      this.sporeColor[i * 3] = (0.34 + 0.42 * corruption) * luma;
      this.sporeColor[i * 3 + 1] = (0.62 - 0.1 * corruption) * luma;
      this.sporeColor[i * 3 + 2] = (0.3 + 0.3 * corruption) * luma;
    }

    this.lastSpores = visible;

    const position = this.sporeGeometry?.getAttribute('position');
    const color = this.sporeGeometry?.getAttribute('color');
    if (position) position.needsUpdate = true;
    if (color) color.needsUpdate = true;
  }
}

/** The world Y axis. Mushrooms and spores spin about it. */
const WORLD_UP = new Vector3(0, 1, 0);

/** Convert a generator's typed arrays into a Three buffer geometry. */
function toGeometry(mesh: {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('color', new BufferAttribute(mesh.colors, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Point-sprite material for the spores.
 *
 * One instance is shared by every `CorruptionSystem`, because the material
 * holds no per-system state - the positions and the colours live on the
 * geometry, which is per-system.
 */
let sharedSporeMaterial: PointsMaterial | null = null;

function sporeMaterial(): PointsMaterial {
  if (sharedSporeMaterial === null) sharedSporeMaterial = buildSporeMaterial();
  return sharedSporeMaterial;
}

function buildSporeMaterial(): PointsMaterial {
  return new PointsMaterial({
    size: 0.075,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    // Additive, and never writing depth. A spore is a mote of light, and a depth
    // write here would cut a hole in every leaf it drifted behind.
    depthWrite: false,
    blending: AdditiveBlending,
    map: sporeTexture(),
  });
}

/**
 * A 32x32 radial dot for the spores, as a `DataTexture`.
 *
 * Built from a typed array rather than drawn into a canvas, because a canvas
 * needs a DOM and the world has to be constructible in Node. There is still no
 * image file anywhere in the project; the sprite is 32 rows of numbers.
 *
 * The falloff is softer than the stream motes' and it never reaches the rim: a
 * spore is a smudge of light rather than a fleck, and a hard-edged dot at three
 * pixels across reads as a full stop.
 */
let sharedSporeTexture: DataTexture | null = null;

function sporeTexture(): DataTexture {
  if (sharedSporeTexture === null) sharedSporeTexture = createSporeTexture();
  return sharedSporeTexture;
}

function createSporeTexture(): DataTexture {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const d = Math.hypot(dx, dy) / radius;
      // Smoothstep from the middle out, with the outer tenth eased to zero so
      // the sprite has no visible edge at all.
      const t = Math.min(1, Math.max(0, (d - 0.15) / 0.85));
      const alpha = Math.round((1 - t * t * (3 - 2 * t)) * 255);
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
