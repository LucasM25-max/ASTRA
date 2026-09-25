/**
 * MovementController.ts - ASTRA player
 * =============================================================================
 * Turns input into motion: WASD relative to the camera, walk/run, smooth
 * acceleration, turning to face the direction of travel, and jumping.
 *
 * Fixed timestep only
 * -------------------
 * This controller runs on `Engine.onFixedUpdate` and nowhere else. Two reasons:
 *
 *   1. Determinism. Rapier is stepped at a constant 1/60 s; driving velocity
 *      from a variable frame delta would make the simulation irreproducible.
 *   2. Time dilation comes for free. The engine's accumulator is fed the
 *      *scaled* delta, so when `gameSpeed` drops it fills more slowly, fewer
 *      fixed steps are issued, and the player slows down - without this file
 *      multiplying anything by `gameSpeed`.
 *
 * That last point is worth stating plainly, because the Step 1.4 brief asks for
 * "all movement multiplied by TimeController.gameSpeed". Multiplying here as
 * well would apply the scale twice and make dilated time run at 6.25% instead
 * of 25%. The multiplication the brief is after is the one the engine already
 * performs by counting fixed steps.
 *
 * Slope handling
 * --------------
 * The player's collider has locked rotation (see `PhysicsWorld.createCapsuleBody`),
 * so the body never tilts, and its velocity is written explicitly every fixed
 * step while grounded. Together those two facts mean sliding is a non-event:
 * there is no velocity to accumulate downhill that is not overwritten. Three
 * details make it hold up on a real gradient:
 *
 *   - The walk target keeps its horizontal component and solves for the
 *     vertical one so the velocity lies *in* the surface plane. Pushing a
 *     horizontal velocity straight into a slope loses most of it to the
 *     contact - measured at 3.04 m/s of ground speed on a 45-degree slope
 *     versus 3.42 m/s with the projection.
 *   - Gravity is switched off on the player's body while it is grounded and
 *     switched back on the moment it is not. That is what makes the speed
 *     numbers exact and the resting drift zero rather than merely small: with
 *     gravity left on, the solver has to cancel it every step, and the friction
 *     it needs in order to do so is charged against the walking velocity -
 *     0.16 m/s of the 3.5 m/s target on flat ground, more on a slope, and it is
 *     the very same friction doing the useful work of stopping the player
 *     sliding downhill. With gravity off there is nothing for the solver to
 *     correct, so the achieved speed is the requested speed. See
 *     `setGravityEnabled`.
 *   - Friction of 1.0 on both colliders, which measured 170x less idle drift
 *     than Rapier's default 0.5. It is belt-and-braces now: the controller owns
 *     the velocity while grounded, so friction only matters if something else
 *     shoves the player. See `DEFAULT_FRICTION`.
 * =============================================================================
 */

import { Vector3, type PerspectiveCamera } from 'three';
import type { InputManager } from '../core/InputManager';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { Player } from './Player';

/** Walking speed, in metres per second. */
export const WALK_SPEED = 3.5;

/** Running speed, in metres per second. Hold either Shift. */
export const RUN_SPEED = 6.0;

/** Upward velocity applied on jump, in metres per second. Apex ~1.26 m. */
export const JUMP_SPEED = 5.0;

/** How fast ground velocity approaches its target, in m/s². */
export const GROUND_ACCELERATION = 24;

/** How fast ground velocity decays when there is no input, in m/s². */
export const GROUND_DECELERATION = 32;

/** How fast the character turns to face its direction of travel, in rad/s. */
export const TURN_SPEED = 10;

/**
 * How far below the capsule's foot to probe for ground, in metres.
 *
 * A tolerance, not a measurement: it absorbs the contact solver's small resting
 * gap and gives a little slack on uneven ground.
 *
 * It must stay below `JUMP_SPEED * fixedTimeStep` - the distance one fixed step
 * of jumping covers, 0.083 m at the defaults. If the probe reaches further than
 * that, the player still reads as "grounded" on the step after take-off, and
 * `updateGroundedVelocity` overwrites the jump's upward velocity with the walk
 * target. There is a test pinning that inequality.
 */
export const GROUND_PROBE = 0.05;

/**
 * Smallest ground-normal Y still treated as standable - about a 60-degree
 * slope. Above it the surface is a floor the character can walk on; below it
 * the surface is a wall, and the walk direction must not be tilted into it
 * (that would divide by a near-zero number).
 *
 * This constant also sizes the ground probe, because a vertical capsule resting
 * on a tilted surface is further from it along Y than its own half-height: a
 * ray straight down from the centre meets the surface at `restHeight /
 * normal.y`. See `updateGroundState`.
 */
export const MIN_STANDABLE_NORMAL_Y = 0.5;

/** Wrap an angle into (-pi, pi] so turns always take the short way round. */
export function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a > Math.PI) a -= twoPi;
  if (a <= -Math.PI) a += twoPi;
  return a;
}

/**
 * Yaw that points an object's forward axis (-Z, Three's convention) along
 * `(x, z)`.
 */
export function yawForDirection(x: number, z: number): number {
  return Math.atan2(-x, -z);
}

export interface MovementControllerOptions {
  player: Player;
  input: InputManager;
  /** The camera whose facing defines "forward". Step 1.5 makes this orbit. */
  camera: PerspectiveCamera;
  physics: PhysicsWorld;
  walkSpeed?: number;
  runSpeed?: number;
  jumpSpeed?: number;
  acceleration?: number;
  deceleration?: number;
  turnSpeed?: number;
  groundProbe?: number;
}

/**
 * Scratch objects, reused so a fixed step allocates nothing.
 *
 * Rapier reads the vectors it is handed live, so reusing them is safe - but
 * each is only ever live for a single statement, never across two. Where one
 * object serves as both the input and the output of a calculation, every read
 * happens before the write; that is called out at the one place it matters.
 */
const SCRATCH = {
  /** Camera-relative move direction on the XZ plane. */
  dir: new Vector3(),
  /** The camera's world direction. */
  forward: new Vector3(),
  /** The body's translation, filled by the ground probe. */
  bodyPosition: new Vector3(),
  /** The body's linear velocity, read and then rewritten in place. */
  velocity: new Vector3(),
  /** The velocity the player is accelerating towards this step. */
  target: new Vector3(),
};

export class MovementController {
  readonly player: Player;

  private readonly input: InputManager;
  private readonly camera: PerspectiveCamera;
  private readonly physics: PhysicsWorld;

  private readonly walkSpeed: number;
  private readonly runSpeed: number;
  private readonly jumpSpeed: number;
  private readonly acceleration: number;
  private readonly deceleration: number;
  private readonly turnSpeed: number;
  private readonly groundProbe: number;

  /** Camera-relative input for this step: strafe and forward, each in [-1, 1]. */
  private strafeInput = 0;
  private forwardInput = 0;
  private runHeld = false;
  private jumpPressed = false;

  /** True while the player is standing on something within `groundProbe`. */
  private grounded = false;
  /** True only on the fixed step where the player touched down. */
  private landedThisStep = false;
  private wasGrounded = false;
  private readonly groundNormal = new Vector3(0, 1, 0);

  /**
   * Latches a jump so one key press produces one jump. `wasKeyPressed` stays
   * true for the whole frame, so without this two fixed steps in the same frame
   * would both fire - and a jump only lifts the player 0.083 m per step, which
   * is inside the ground probe.
   */
  private jumpConsumed = true;

  /** Last gravity scale written to the body, so repeats are skipped. */
  private gravityEnabled = true;

  /**
   * True from the step a jump is taken until the probe reports the player off
   * the ground.
   *
   * The engine can issue several fixed steps inside one frame, and between them
   * no physics step runs - so the ground probe still reports "grounded" on the
   * step after a jump, and the walk ramp would quietly eat the jump's upward
   * velocity. Suppressing velocity control until the player is actually
   * observed airborne makes one press produce one jump regardless of how many
   * steps the frame earned.
   */
  private jumping = false;

  constructor(options: MovementControllerOptions) {
    this.player = options.player;
    this.input = options.input;
    this.camera = options.camera;
    this.physics = options.physics;

    this.walkSpeed = options.walkSpeed ?? WALK_SPEED;
    this.runSpeed = options.runSpeed ?? RUN_SPEED;
    this.jumpSpeed = options.jumpSpeed ?? JUMP_SPEED;
    this.acceleration = options.acceleration ?? GROUND_ACCELERATION;
    this.deceleration = options.deceleration ?? GROUND_DECELERATION;
    this.turnSpeed = options.turnSpeed ?? TURN_SPEED;
    this.groundProbe = options.groundProbe ?? GROUND_PROBE;
  }

  /* ---------------------------------------------------------------------- */
  /* State                                                                  */
  /* ---------------------------------------------------------------------- */

  /** True while the player is standing on something within the ground probe. */
  get isGrounded(): boolean {
    return this.grounded;
  }

  /** True only on the single fixed step where the player touched down. */
  get justLanded(): boolean {
    return this.landedThisStep;
  }

  /**
   * Unit surface normal of whatever the player is standing on, or (0, 1, 0)
   * when airborne. A copy, so a caller cannot corrupt the controller's state.
   */
  get surfaceNormal(): Vector3 {
    return this.groundNormal.clone();
  }

  /** Current horizontal speed, in metres per second. */
  get horizontalSpeed(): number {
    const v = this.player.body.linvel();
    return Math.hypot(v.x, v.z);
  }

  /** True while the run key is held. */
  get isRunning(): boolean {
    return this.runHeld;
  }

  /** The speed the player is currently accelerating towards, in m/s. */
  get targetSpeed(): number {
    if (this.forwardInput === 0 && this.strafeInput === 0) return 0;
    return this.runHeld ? this.runSpeed : this.walkSpeed;
  }

  /* ---------------------------------------------------------------------- */
  /* Fixed step                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the player by one fixed step.
   *
   * Wire this to `Engine.onFixedUpdate` and pass its delta straight through. It
   * must run before `WorldScene.fixedUpdate()` so the velocity written here is
   * the one Rapier integrates this step.
   */
  fixedUpdate(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    // Guard against a use-after-free: WorldScene.dispose() removes the body
    // from Rapier, and touching it afterwards would be undefined behaviour.
    if (this.player.isDisposed) return;

    this.readInput();
    this.updateGroundState();

    // Whether the player was on the ground *before* this step's jump, which is
    // the only thing that decides whether a jump may happen. Read it before
    // the flag is cleared below, or the jump would cancel itself.
    const groundedBefore = this.grounded;

    // A jump leaves the ground on the step it is taken, whatever the probe
    // says. This is the belt to the probe-distance braces in GROUND_PROBE: it
    // makes the airborne transition immediate, so the upward velocity is never
    // overwritten by the walk target on the following step.
    if (this.jumpPressed) this.grounded = false;

    // `jumping` is checked alongside `wasGrounded` because a jump forces
    // `grounded` false, and the step after it can report grounded again when no
    // physics step ran in between - which would otherwise read as a landing.
    this.landedThisStep = this.grounded && !this.wasGrounded && !this.jumping;
    this.wasGrounded = this.grounded;

    this.updateFacing(delta);

    // Airborne: leave the velocity to gravity and to whatever momentum the
    // jump gave it. There is deliberately no air control.
    this.setGravityEnabled(this.jumpPressed || this.jumping || !groundedBefore);
    if (groundedBefore && !this.jumping) {
      this.updateGroundedVelocity(delta);
    }
    if (this.jumpPressed) this.jumping = true;
  }

  /**
   * Turn gravity on or off for the player's body.
   *
   * Grounded means "the controller owns the velocity", and a body whose
   * velocity is owned does not need gravity: leaving it on makes the contact
   * solver fight it every step, and the friction that fight costs is charged
   * against the walking speed. See the note in the file header for the numbers.
   *
   * Off is also what makes the resting state exact - the body sits on the
   * surface with zero velocity instead of sinking a fraction of a millimetre
   * and being pushed back out, which on a slope is where sliding comes from.
   */
  private setGravityEnabled(enabled: boolean): void {
    if (enabled === this.gravityEnabled) return;
    this.gravityEnabled = enabled;
    this.player.body.setGravityScale(enabled ? 1 : 0, true);
  }

  /* ---------------------------------------------------------------------- */
  /* Steps                                                                  */
  /* ---------------------------------------------------------------------- */

  private readInput(): void {
    const input = this.input;

    this.forwardInput =
      (input.isAnyKeyDown('KeyW', 'ArrowUp') ? 1 : 0) -
      (input.isAnyKeyDown('KeyS', 'ArrowDown') ? 1 : 0);
    this.strafeInput =
      (input.isAnyKeyDown('KeyD', 'ArrowRight') ? 1 : 0) -
      (input.isAnyKeyDown('KeyA', 'ArrowLeft') ? 1 : 0);
    this.runHeld = input.isAnyKeyDown('ShiftLeft', 'ShiftRight');

    // One press, one jump - see the note on `jumpConsumed`.
    const jumpDown = input.wasKeyPressed('Space');
    if (!jumpDown) this.jumpConsumed = false;
    this.jumpPressed = jumpDown && !this.jumpConsumed;
    if (this.jumpPressed) this.jumpConsumed = true;
  }

  private updateGroundState(): void {
    const body = this.player.body;
    body.translation(SCRATCH.bodyPosition);
    const restHeight = this.player.restHeight;

    // The cast has to reach as far as the shallowest slope we still call
    // standable can put the surface below a resting capsule.
    const reach = restHeight / MIN_STANDABLE_NORMAL_Y + this.groundProbe;
    const hit = this.physics.castDown(SCRATCH.bodyPosition, reach, body);

    if (hit === null) {
      this.grounded = false;
      this.groundNormal.set(0, 1, 0);
      return;
    }

    const nx = hit.normal.x;
    const ny = hit.normal.y;
    const nz = hit.normal.z;

    // A hit is only ground if it is where a resting capsule would actually be
    // touching it. Without this second test the generous cast above would read
    // a steep face a metre below the player as a floor.
    const standable = ny >= MIN_STANDABLE_NORMAL_Y;
    const withinProbe = hit.distance <= restHeight / ny + this.groundProbe;

    if (!standable || !withinProbe) {
      this.grounded = false;
      this.groundNormal.set(0, 1, 0);
      return;
    }

    this.grounded = true;
    this.groundNormal.set(nx, ny, nz);
    if (this.groundNormal.lengthSq() < 1e-12) this.groundNormal.set(0, 1, 0);
    else this.groundNormal.normalize();

    // Settle the capsule onto the surface.
    //
    // The probe's tolerance is a band, not a snap, and with gravity switched off
    // nothing else would close it: the player would come to rest anywhere
    // inside that band, which on flat ground means up to `groundProbe` above
    // the floor. `restHeight / normal.y` is how far below the centre a resting
    // capsule meets *this* surface, which is what makes the correction correct
    // on a slope as well as on the flat.
    const restingDistance = restHeight / this.groundNormal.y;
    const correction = restingDistance - hit.distance;
    const limit = this.groundProbe;
    const clamped = correction < -limit ? -limit : correction > limit ? limit : correction;

    if (clamped !== 0) {
      // `translation()` hands back a fresh object, so it is safe to mutate and
      // hand straight back to `setTranslation`.
      const position = body.translation();
      position.y += clamped;
      body.setTranslation(position, true);
    }

    // A jump is over once the player is observed off the ground, or once the
    // upward velocity has been spent - the second case is a jump into a low
    // ceiling, where the probe can keep reporting ground underneath the player.
    //
    // This runs on the freshly probed state, never on the previous step's: the
    // step that takes a jump has already forced `grounded` false, so testing the
    // old value here would clear the latch the instant it was set.
    if (!this.grounded || this.player.body.linvel(SCRATCH.velocity).y <= 0) {
      this.jumping = false;
    }
  }

  /**
   * Camera-relative movement direction on the XZ plane, or a zero vector when
   * there is no input.
   *
   * The camera's forward is its world -Z axis projected onto the ground plane.
   * If the camera is looking almost straight up or down that projection
   * degenerates, so it falls back to world -Z rather than producing a NaN
   * direction.
   */
  private worldMoveDirection(): Vector3 {
    if (this.forwardInput === 0 && this.strafeInput === 0) {
      return SCRATCH.dir.set(0, 0, 0);
    }

    this.camera.getWorldDirection(SCRATCH.forward);
    const fx = SCRATCH.forward.x;
    const fz = SCRATCH.forward.z;
    const length = Math.hypot(fx, fz);

    let nx: number;
    let nz: number;
    if (length < 1e-6) {
      nx = 0;
      nz = -1;
    } else {
      nx = fx / length;
      nz = fz / length;
    }

    // right = forward x up, projected onto XZ: (-fz, 0, fx).
    const rx = -nz;
    const rz = nx;

    let x = nx * this.forwardInput + rx * this.strafeInput;
    let z = nz * this.forwardInput + rz * this.strafeInput;

    // Diagonal input must not be faster than cardinal input.
    const magnitude = Math.hypot(x, z);
    if (magnitude > 1) {
      x /= magnitude;
      z /= magnitude;
    }

    return SCRATCH.dir.set(x, 0, z);
  }

  private updateFacing(delta: number): void {
    const dir = this.worldMoveDirection();
    if (dir.lengthSq() < 1e-12) return; // no input: hold the current facing

    const target = yawForDirection(dir.x, dir.z);
    const current = this.player.mesh.rotation.y;

    const difference = wrapAngle(target - current);
    const maxStep = this.turnSpeed * delta;
    const step = Math.abs(difference) <= maxStep ? difference : Math.sign(difference) * maxStep;

    this.player.mesh.rotation.y = wrapAngle(current + step);
  }

  private updateGroundedVelocity(delta: number): void {
    const dir = this.worldMoveDirection();
    const hasInput = dir.lengthSq() > 1e-12;
    const speed = hasInput ? (this.runHeld ? this.runSpeed : this.walkSpeed) : 0;

    // The velocity to accelerate towards: the horizontal input direction at the
    // current speed, lying *in* the surface plane when there is one.
    //
    // That last part is what preserves ground speed. A purely horizontal
    // velocity pushed into a hill spends most of itself on the contact and
    // measures ~13% slow at 45 degrees; keeping the horizontal component and
    // solving for the vertical one (v . n = 0) keeps all of it.
    //
    // No gravity compensation here on purpose: gravity is off while grounded,
    // so the velocity written is the velocity the body keeps. See
    // `setGravityEnabled`.
    const target = SCRATCH.target.set(0, 0, 0);
    if (hasInput) {
      target.x = dir.x * speed;
      target.z = dir.z * speed;

      const n = this.groundNormal;
      if (n.y > MIN_STANDABLE_NORMAL_Y) {
        target.y = -(target.x * n.x + target.z * n.z) / n.y;
      }
    }

    // Move the whole velocity towards the target at a bounded rate. This is the
    // "lerped velocity" the brief asks for, expressed as an acceleration rather
    // than a per-frame lerp factor so it stays frame-rate independent.
    //
    // The vertical is ramped too, which is what makes the player follow the
    // slope rather than skate across it, and what makes a landing a clean stop
    // instead of a bounce.
    const current = this.player.body.linvel(SCRATCH.velocity);
    const rate = hasInput ? this.acceleration : this.deceleration;

    const dx = target.x - current.x;
    const dy = target.y - current.y;
    const dz = target.z - current.z;
    const remaining = Math.hypot(dx, dy, dz);
    const maxDelta = rate * delta;

    // `current` and `out` are the same object, so every read above must happen
    // before the write below - it does.
    const out = SCRATCH.velocity;
    if (remaining <= maxDelta || remaining < 1e-9) {
      out.set(target.x, target.y, target.z);
    } else {
      const scale = maxDelta / remaining;
      out.set(current.x + dx * scale, current.y + dy * scale, current.z + dz * scale);
    }

    // A jump is instantaneous: ramping it would feel like a spring. It also
    // overrides the slope tilt for that one step.
    if (this.jumpPressed) out.y = this.jumpSpeed;

    this.player.body.setLinvel(out, true);
  }
}
