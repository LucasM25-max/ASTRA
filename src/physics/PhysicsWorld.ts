/**
 * PhysicsWorld.ts - ASTRA physics
 * =============================================================================
 * Owns the Rapier simulation: the world, its gravity, its timestep, and the two
 * colliders Step 1.3 needs - a static ground slab and the player's dynamic
 * capsule.
 *
 * Every Rapier call in the project goes through this class. That is not
 * bureaucracy for its own sake: the compat build's WASM has to be initialised
 * before a single `new RAPIER.World()` can exist, so construction has to be
 * async. Funnelling it through `PhysicsWorld.create()` keeps that one `await`
 * in one place instead of leaking through every caller.
 *
 * Timestep discipline
 * -------------------
 * `World.step()` takes no delta - the step length lives on `world.timestep`.
 * `step(delta)` therefore writes the timestep before stepping, so the
 * simulation can never drift out of sync with the delta the caller actually
 * used. Callers pass the engine's fixed timestep, which is what keeps physics
 * deterministic and makes time dilation work for free: when `gameSpeed` drops,
 * the engine's accumulator fills more slowly, fixed steps simply happen less
 * often, and the world slows down without any special case here.
 *
 * API traps verified against rapier3d-compat 0.21.0
 * -------------------------------------------------
 *   - `RigidBodyDesc.setTranslation(x, y, z)` takes three numbers. The
 *     *instance* method `RigidBody.setTranslation(vector, wakeUp)` takes a
 *     Vector. Mixing the two up does not throw - it silently produces a NaN
 *     transform, after which `translation()` reports `null`.
 *   - `setCanSleep(false)` exists on the descriptor only, never on the body.
 *   - An upright capsule is unstable: without locked rotations it topples.
 * =============================================================================
 */

import RAPIER from '@dimforge/rapier3d-compat';

/** Downward acceleration, in m/s². */
export const GRAVITY_Y = -9.81;

/**
 * Default simulation step, in seconds. Must match the engine's fixed timestep
 * (`Engine.fixedTimeStep`); `step()` re-asserts it every call regardless.
 */
export const DEFAULT_PHYSICS_TIMESTEP = 1 / 60;

/**
 * Thickness of the static ground slab, in metres. The slab is centred on
 * `y = -thickness / 2` so its top face lands exactly on `y = 0`, level with the
 * visual ground plane.
 */
export const DEFAULT_GROUND_THICKNESS = 1;

/**
 * Friction for the ground slab and for the player's capsule. Dimensionless,
 * like every friction coefficient.
 *
 * Rapier combines the two colliders' friction into a single effective value, so
 * setting both sides to the same number keeps that effective value predictable.
 * 1.0 is the sweet spot measured against the alternative strategies for
 * "prevent sliding on slopes":
 *
 *   friction 0.5 (Rapier's default) + velocity control: 0.61 m of idle drift
 *     down a 45-degree slope over 15 s, and the player slides clean off.
 *   friction 1.0 + velocity control: 0.0036 m over the same 15 s - a 170x
 *     improvement - while costing only about 1% of walk speed.
 *   friction 2.0+: no further anti-slide benefit, and measurably slower walking.
 *
 * Cancelling gravity's tangential component with a per-step impulse was also
 * tested and is *worse* (0.22 m of drift): it fights the contact solver instead
 * of helping it. Velocity control plus adequate friction is the whole answer.
 */
export const DEFAULT_FRICTION = 1.0;

/** A plain 3-component vector. Structurally compatible with Three's `Vector3`. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PhysicsWorldOptions {
  /** Gravity vector. Defaults to straight down at 9.81 m/s². */
  gravity?: Vec3;
  /** Simulation step in seconds. Defaults to `DEFAULT_PHYSICS_TIMESTEP`. */
  timestep?: number;
}

export interface CapsuleBodyOptions {
  /** Radius of the capsule, in metres. */
  radius: number;
  /** Half-height of the capsule's cylindrical section, in metres. */
  halfHeight: number;
  /** Initial position of the body's centre. */
  spawn: Vec3;
  /** Collider friction. Defaults to Rapier's own 0.5. */
  friction?: number;
  /** Collider restitution. Defaults to Rapier's own 0. */
  restitution?: number;
  /** Linear velocity damping per second. Defaults to none. */
  linearDamping?: number;
  /** Continuous collision detection. Defaults to true. */
  ccd?: boolean;
}

/** A dynamic body together with the collider that gives it mass. */
export interface CapsuleBody {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
}

/** What a downward ground probe found. */
export interface GroundHit {
  /** Unit surface normal at the hit point. */
  readonly normal: Vec3;
  /** Distance from the ray's origin to the hit, in metres. */
  readonly distance: number;
}

/** Reject anything that is not a usable, positive, finite measurement. */
function requirePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `[PhysicsWorld] ${label} must be a positive finite number, received ${String(value)}`,
    );
  }
  return value;
}

/** Reject a vector containing NaN or infinity - it would poison the body. */
function requireFiniteVec3(value: Vec3, label: string): void {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) {
    throw new RangeError(
      `[PhysicsWorld] ${label} must be finite, received ` +
        `(${String(value.x)}, ${String(value.y)}, ${String(value.z)})`,
    );
  }
}

export class PhysicsWorld {
  /** The underlying Rapier world. Exposed so systems can add their own bodies. */
  readonly world: RAPIER.World;

  private readonly initialTimestep: number;
  /** Reused by `castDown`; Rapier reads its origin/dir at cast time. */
  private readonly downRay: RAPIER.Ray;
  private steps = 0;
  private freed = false;

  private constructor(gravity: Vec3, timestep: number) {
    this.initialTimestep = requirePositive(timestep, 'timestep');
    this.world = new RAPIER.World({ x: gravity.x, y: gravity.y, z: gravity.z });
    this.world.timestep = this.initialTimestep;
    this.downRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  /**
   * Initialise Rapier's WASM core and build a world.
   *
   * `RAPIER.init()` is idempotent and cheap once loaded, so callers may invoke
   * this as often as they like.
   */
  static async create(options: PhysicsWorldOptions = {}): Promise<PhysicsWorld> {
    await RAPIER.init();
    const gravity = options.gravity ?? { x: 0, y: GRAVITY_Y, z: 0 };
    requireFiniteVec3(gravity, 'gravity');
    return new PhysicsWorld(gravity, options.timestep ?? DEFAULT_PHYSICS_TIMESTEP);
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Cast a ray straight down from `origin` and report the first surface hit.
   *
   * This is the ground check the player's movement controller uses. The ray is
   * a single reused instance rather than a fresh one per call, because it runs
   * every fixed step and Rapier reads its `origin`/`dir` live at cast time.
   *
   * `exclude` should be the caller's own body: without it the ray starts inside
   * the capsule and reports a hit at distance 0, which would make the player
   * permanently "grounded".
   */
  castDown(origin: Vec3, maxDistance: number, exclude?: RAPIER.RigidBody): GroundHit | null {
    if (this.freed) return null;
    const reach = Number.isFinite(maxDistance) && maxDistance > 0 ? maxDistance : 0;
    if (reach === 0) return null;

    this.downRay.origin.x = origin.x;
    this.downRay.origin.y = origin.y;
    this.downRay.origin.z = origin.z;

    const hit = this.world.castRayAndGetNormal(
      this.downRay,
      reach,
      true,
      undefined,
      undefined,
      undefined,
      exclude,
    );
    if (hit === null) return null;

    return {
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      distance: hit.timeOfImpact,
    };
  }

  get gravity(): Vec3 {
    return { x: this.world.gravity.x, y: this.world.gravity.y, z: this.world.gravity.z };
  }

  /** The timestep the next `step()` will use, in seconds. */
  get timestep(): number {
    return this.world.timestep;
  }

  /** How many times `step()` has advanced this world. */
  get stepCount(): number {
    return this.steps;
  }

  /** True once `dispose()` has released the underlying WASM memory. */
  get isFreed(): boolean {
    return this.freed;
  }

  /* ---------------------------------------------------------------------- */
  /* Construction                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Create the static ground: a fixed cuboid of the given half-extent whose top
   * face sits exactly on `y = 0`, level with the visual ground plane.
   *
   * Finite on purpose. A half-space would be cheaper, but the playable area is
   * a 100m plane and the player must be able to walk off its edge and fall -
   * that is a real behaviour, not a bug to be papered over.
   */
  createGround(
    halfExtent: number,
    thickness: number = DEFAULT_GROUND_THICKNESS,
    friction: number = DEFAULT_FRICTION,
  ): RAPIER.RigidBody {
    const half = requirePositive(halfExtent, 'ground halfExtent');
    const thick = requirePositive(thickness, 'ground thickness');

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -thick / 2, 0),
    );
    const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(half, thick / 2, half), body);
    collider.setFriction(friction);
    return body;
  }

  /**
   * Create a dynamic, rotation-locked capsule body.
   *
   * Rotations are locked on all three axes because an upright capsule is
   * unstable: give it the slightest nudge and it topples onto its side, at
   * which point the player is lying on the ground. Locking rotation is the
   * standard fix and costs nothing for a capsule, which is rotationally
   * symmetric anyway.
   *
   * Sleeping is disabled so the body always responds to `setLinvel` - a
   * sleeping Rapier body ignores velocity changes made without `wakeUp`.
   */
  createCapsuleBody(options: CapsuleBodyOptions): CapsuleBody {
    const radius = requirePositive(options.radius, 'capsule radius');
    const halfHeight = requirePositive(options.halfHeight, 'capsule halfHeight');
    requireFiniteVec3(options.spawn, 'capsule spawn');

    const colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius);
    colliderDesc.setFriction(options.friction ?? DEFAULT_FRICTION);
    if (options.restitution !== undefined) colliderDesc.setRestitution(options.restitution);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(options.spawn.x, options.spawn.y, options.spawn.z)
      .setCanSleep(false)
      .setCcdEnabled(options.ccd ?? true);

    const body = this.world.createRigidBody(bodyDesc);
    body.setEnabledRotations(false, false, false, true);
    if (options.linearDamping !== undefined) body.setLinearDamping(options.linearDamping);

    const collider = this.world.createCollider(colliderDesc, body);
    return { body, collider };
  }

  /* ---------------------------------------------------------------------- */
  /* Simulation                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the simulation by `delta` seconds.
   *
   * Pass the engine's *fixed* timestep (`Engine.onFixedUpdate`), never a raw
   * frame delta: a variable timestep makes Rapier's solver inaccurate and
   * non-deterministic. Time dilation is already accounted for by the engine,
   * which simply issues fewer fixed steps when `gameSpeed` drops.
   */
  step(delta: number = this.initialTimestep): void {
    if (this.freed) return;
    const dt = Number.isFinite(delta) && delta > 0 ? delta : this.initialTimestep;
    this.world.timestep = dt;
    this.world.step();
    this.steps += 1;
  }

  /** Release the WASM memory held by this world and everything in it. */
  dispose(): void {
    if (this.freed) return;
    this.freed = true;
    this.world.free();
  }
}
