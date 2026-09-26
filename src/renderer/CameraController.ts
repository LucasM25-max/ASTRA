/**
 * CameraController.ts - ASTRA renderer
 * =============================================================================
 * The third-person orbit camera: it follows the player, the mouse orbits it,
 * the wheel zooms it, and it refuses to sit inside geometry.
 *
 * Time independence
 * -----------------
 * This controller is driven by `Engine.onRender` with the frame's *real* delta,
 * never the scaled game delta. That is the whole point of the Step 1.5
 * requirement that camera movement is unaffected by `TimeController`: during an
 * Active Encounter the world runs at 0.25 speed while the player still orbits
 * and zooms at full rate, because the camera's clock is the wall clock.
 *
 * The alternative - driving the camera from `onFixedUpdate` - would be wrong
 * twice over: fixed steps are issued in proportion to game time, so the camera
 * would dilate along with the world, and it would also stutter whenever a frame
 * earned zero or two steps instead of one.
 *
 * Input latency
 * -------------
 * The camera reads the mouse on the render step, which is one frame after the
 * simulation has consumed the direction it set. That is a single frame of
 * latency on the turn, which is imperceptible and buys the more useful property
 * that the camera's *position* reflects the player's position as of this frame
 * rather than the previous one.
 *
 * Collision
 * ---------
 * Two separate concerns, because they fail in different ways:
 *
 *   - Occlusion: a ray from the focus point towards the desired camera
 *     position. If it hits something, the camera is pulled in along the same
 *     line. This is what stops a wall or a tree from filling the screen.
 *   - Ground: a ray straight down from above the camera. If the ground is
 *     closer than the clearance, the camera is lifted. This is what stops the
 *     camera dropping through the floor when the player backs into a slope or
 *     the orbit pitches low.
 *
 * Both exclude the player's own body. Without that the occlusion ray starts
 * inside the player's capsule and reports a hit at distance zero, which would
 * pin the camera to the player's chest.
 * =============================================================================
 */

import { PerspectiveCamera, Vector3 } from 'three';
import type { InputManager } from '../core/InputManager';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { Player } from '../player/Player';

/** Default orbit radius, in metres. */
export const DEFAULT_CAMERA_DISTANCE = 4;

/** Closest the camera may come to the player, in metres. */
export const MIN_CAMERA_DISTANCE = 2;

/** Furthest the camera may sit from the player, in metres. */
export const MAX_CAMERA_DISTANCE = 10;

/**
 * How far above the player's centre the camera aims, in metres.
 *
 * The brief specifies +1.5m. Note this is above the capsule's *centre*, so with
 * the player resting at 0.9m the focus point sits at 2.4m - slightly above the
 * character's head, which is what gives the classic over-the-shoulder read.
 */
export const CAMERA_HEIGHT_OFFSET = 1.5;

/** Lowest orbit angle, in radians. Negative looks up at the player. */
export const MIN_CAMERA_PITCH = -0.5;

/** Highest orbit angle, in radians. Above this the camera is nearly overhead. */
export const MAX_CAMERA_PITCH = 1.25;

/** Orbit angle the camera starts at, in radians. */
export const DEFAULT_CAMERA_PITCH = 0.35;

/** Radians of orbit per pixel of mouse movement. */
export const ORBIT_SENSITIVITY = 0.005;

/**
 * Zoom per unit of wheel delta, applied multiplicatively.
 *
 * Browsers report roughly +/-100 per notch, so one notch changes the distance by
 * about 14% - the same feel at 2m and at 10m, which an additive step does not
 * give. The sign is such that scrolling up, which browsers report as a
 * *negative* deltaY, brings the camera closer.
 */
export const ZOOM_SENSITIVITY = 0.0015;

/** Mouse button that orbits the camera when held. */
export const ORBIT_MOUSE_BUTTON = 2;

/** How fast the camera catches up with the player, in 1/s. */
export const FOLLOW_RATE = 16;

/** How fast the zoom eases towards its target, in 1/s. */
export const ZOOM_SMOOTHING = 12;

/** Gap kept between the camera and whatever it is occluded by, in metres. */
export const OCCLUSION_MARGIN = 0.25;

/** Gap kept between the camera and the ground, in metres. */
export const MIN_GROUND_CLEARANCE = 0.3;

/** How far above the camera the ground probe starts, in metres. */
const GROUND_PROBE_HEIGHT = 0.8;

/**
 * Distance the focus point may move in one frame before the camera snaps
 * instead of easing. Without this, a teleport (respawn, fast travel, a level
 * transition) makes the camera visibly fly across the map.
 */
const TELEPORT_THRESHOLD = 5;

/** Scratch vectors, reused so a frame allocates nothing. */
const SCRATCH = {
  focus: new Vector3(),
  /** Where the camera wants to be this frame, before any collision. */
  ideal: new Vector3(),
  /** Where the camera ends up, after collision. */
  applied: new Vector3(),
  toCamera: new Vector3(),
  groundOrigin: new Vector3(),
};

export interface CameraControllerOptions {
  camera: PerspectiveCamera;
  input: InputManager;
  physics: PhysicsWorld;
  /** What the camera follows. */
  player: Player;
  /** Defaults to `DEFAULT_CAMERA_DISTANCE`, clamped to the allowed range. */
  distance?: number;
  /** Defaults to `DEFAULT_CAMERA_PITCH`, clamped to the allowed range. */
  pitch?: number;
  /** Defaults to 0 - directly behind the player's back. */
  yaw?: number;
  /** Defaults to `CAMERA_HEIGHT_OFFSET`. */
  heightOffset?: number;
  minDistance?: number;
  maxDistance?: number;
  orbitSensitivity?: number;
}

/** Clamp `value` into `[min, max]`, tolerating a min above a max. */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return value < min ? min : value > max ? max : value;
}

/** Wrap an angle into (-pi, pi] so yaw never grows without bound. */
function wrapYaw(angle: number): number {
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a > Math.PI) a -= twoPi;
  if (a <= -Math.PI) a += twoPi;
  return a;
}

export class CameraController {
  readonly camera: PerspectiveCamera;
  readonly player: Player;

  private readonly input: InputManager;
  private readonly physics: PhysicsWorld;

  private readonly minDistance: number;
  private readonly maxDistance: number;
  private readonly heightOffset: number;
  private readonly orbitSensitivity: number;

  /** Orbit angle around the player's vertical axis, in radians. */
  private yawAngle: number;
  /** Orbit angle above the focus point, in radians. */
  private pitchAngle: number;

  /** The distance the user has asked for, already clamped. */
  private targetDistance: number;
  /** The distance in use, eased towards `targetDistance`. */
  private currentDistance: number;

  /** The point the camera aims at, eased towards the player. */
  private readonly smoothedFocus = new Vector3();
  /** False until the first update, which snaps rather than eases. */
  private initialised = false;

  /** Set by the last collision pass: is anything between player and camera? */
  private occluded = false;

  constructor(options: CameraControllerOptions) {
    this.camera = options.camera;
    this.player = options.player;
    this.input = options.input;
    this.physics = options.physics;

    this.minDistance = options.minDistance ?? MIN_CAMERA_DISTANCE;
    this.maxDistance = options.maxDistance ?? MAX_CAMERA_DISTANCE;
    this.heightOffset = options.heightOffset ?? CAMERA_HEIGHT_OFFSET;
    this.orbitSensitivity = options.orbitSensitivity ?? ORBIT_SENSITIVITY;

    this.yawAngle = wrapYaw(options.yaw ?? 0);
    this.pitchAngle = clamp(options.pitch ?? DEFAULT_CAMERA_PITCH, MIN_CAMERA_PITCH, MAX_CAMERA_PITCH);

    const distance = clamp(options.distance ?? DEFAULT_CAMERA_DISTANCE, this.minDistance, this.maxDistance);
    this.targetDistance = distance;
    this.currentDistance = distance;
  }

  /* ---------------------------------------------------------------------- */
  /* State                                                                  */
  /* ---------------------------------------------------------------------- */

  /** The distance the user has asked for, in metres. */
  get distance(): number {
    return this.targetDistance;
  }

  /** The distance actually in use this frame, in metres. */
  get appliedDistance(): number {
    return this.currentDistance;
  }

  /** Orbit angle around the player's vertical axis, in radians. */
  get yaw(): number {
    return this.yawAngle;
  }

  /** Orbit angle above the focus point, in radians. */
  get pitch(): number {
    return this.pitchAngle;
  }

  /** True while something sits between the player and the camera. */
  get isOccluded(): boolean {
    return this.occluded;
  }

  /** The point the camera is aiming at. A copy, so callers cannot corrupt it. */
  get focusPoint(): Vector3 {
    return this.smoothedFocus.clone();
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the camera by one rendered frame.
   *
   * Pass the frame's *real* delta - `EngineFrameInfo.realDelta` - never the
   * scaled game delta. See the note at the top of the file.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    if (this.player.isDisposed) return;

    this.readMouse();

    const focus = SCRATCH.focus.copy(this.player.position);
    focus.y += this.heightOffset;

    if (!this.initialised) {
      this.snapTo(focus);
      return;
    }

    // A jump in the focus point is a teleport, not movement. Easing across it
    // would drag the camera through the whole level.
    if (this.smoothedFocus.distanceToSquared(focus) > TELEPORT_THRESHOLD * TELEPORT_THRESHOLD) {
      this.snapTo(focus);
      return;
    }

    // Exponential smoothing: `1 - exp(-rate * dt)` is frame-rate independent in
    // a way a fixed lerp factor is not, so the camera feels the same at 30fps
    // and at 144fps.
    const follow = 1 - Math.exp(-FOLLOW_RATE * delta);
    this.smoothedFocus.lerp(focus, follow);

    const zoom = 1 - Math.exp(-ZOOM_SMOOTHING * delta);
    this.currentDistance += (this.targetDistance - this.currentDistance) * zoom;

    this.applyToCamera();
  }

  /**
   * Put the camera exactly where it wants to be, with no easing.
   *
   * Called on the first frame and after a teleport. Exposed so a spawn or a
   * cutscene can force it.
   */
  snap(): void {
    if (this.player.isDisposed) return;
    const focus = SCRATCH.focus.copy(this.player.position);
    focus.y += this.heightOffset;
    this.snapTo(focus);
  }

  /** Reset the orbit angles, e.g. when re-entering gameplay. */
  resetOrbit(): void {
    this.yawAngle = 0;
    this.pitchAngle = DEFAULT_CAMERA_PITCH;
    this.targetDistance = DEFAULT_CAMERA_DISTANCE;
  }

  private snapTo(focus: Vector3): void {
    this.smoothedFocus.copy(focus);
    this.currentDistance = this.targetDistance;
    this.initialised = true;
    this.applyToCamera();
  }

  /* ---------------------------------------------------------------------- */
  /* Steps                                                                  */
  /* ---------------------------------------------------------------------- */

  private readMouse(): void {
    const input = this.input;

    if (input.isMouseDown(ORBIT_MOUSE_BUTTON)) {
      const delta = input.mouseDelta;
      // Dragging right turns the view right, which swings the camera left:
      // the camera sits at +Z for yaw 0, so decreasing yaw carries it towards
      // -X, which is the direction the view rotates when it turns right.
      this.yawAngle = wrapYaw(this.yawAngle - delta.x * this.orbitSensitivity);
      // Dragging down looks down, which lifts the camera above the player.
      this.pitchAngle = clamp(
        this.pitchAngle + delta.y * this.orbitSensitivity,
        MIN_CAMERA_PITCH,
        MAX_CAMERA_PITCH,
      );
    }

    const wheel = input.wheelDelta.y;
    if (wheel !== 0) {
      this.targetDistance = clamp(
        this.targetDistance * Math.exp(wheel * ZOOM_SENSITIVITY),
        this.minDistance,
        this.maxDistance,
      );
    }
  }

  /** Work out where the camera should be and put it there. */
  private applyToCamera(): void {
    const focus = this.smoothedFocus;
    const cosPitch = Math.cos(this.pitchAngle);
    const sinPitch = Math.sin(this.pitchAngle);

    // Offset from the focus point to the camera. yaw 0 puts the camera at +Z,
    // which is behind a player whose forward is -Z.
    const offsetX = this.currentDistance * cosPitch * Math.sin(this.yawAngle);
    const offsetY = this.currentDistance * sinPitch;
    const offsetZ = this.currentDistance * cosPitch * Math.cos(this.yawAngle);

    // Two vectors, not one. The ideal position is what the orbit asks for; the
    // applied position is where the camera actually goes once collision has
    // pulled it in. The occlusion ray is cast towards the *ideal*, because
    // casting towards the already-shortened position would stop short of the
    // wall, report no occlusion, ease the camera back out, and repeat - the
    // classic breathing camera.
    const ideal = SCRATCH.ideal.set(
      focus.x + offsetX,
      focus.y + offsetY,
      focus.z + offsetZ,
    );
    const applied = SCRATCH.applied.copy(ideal);

    this.resolveOcclusion(focus, ideal, applied);
    this.resolveGround(applied);

    this.camera.position.copy(applied);
    this.camera.lookAt(focus.x, focus.y, focus.z);
  }

  /**
   * Pull the camera in along its own line if something is in the way.
   *
   * The ray is cast from the focus point towards `ideal`, so the distance
   * measured is the full orbit radius rather than whatever the camera managed
   * last frame - which is what keeps the occlusion state stable instead of
   * oscillating once the camera has been pulled in.
   *
   * The ray is cast from the focus point rather than from the camera because
   * the distance being clamped is the distance from the player.
   */
  private resolveOcclusion(focus: Vector3, ideal: Vector3, applied: Vector3): void {
    const toCamera = SCRATCH.toCamera.subVectors(ideal, focus);
    const wanted = toCamera.length();
    if (wanted < 1e-6) {
      this.occluded = false;
      return;
    }

    const hit = this.physics.castRay(focus, toCamera, wanted, this.player.body);
    if (hit === null) {
      this.occluded = false;
      return;
    }

    this.occluded = true;

    // Never closer than half the minimum distance, or the camera would end up
    // inside the player's head when something is pressed right against them.
    const allowed = Math.max(this.minDistance * 0.5, hit.distance - OCCLUSION_MARGIN);
    const scale = allowed / wanted;
    applied.set(
      focus.x + toCamera.x * scale,
      focus.y + toCamera.y * scale,
      focus.z + toCamera.z * scale,
    );
  }

  /**
   * Lift the camera off the floor.
   *
   * The probe starts above the camera and reaches past it, so it finds ground
   * below rather than above - a ray starting at the camera would miss the floor
   * it is already underneath.
   *
   * This only ever makes a small correction: the camera is already stopped from
   * going deep into geometry by the occlusion pass, because the camera always
   * lies on the ray that pass casts. Anything the camera would be inside, that
   * ray has already hit. So this is about the last 30cm, not about rescue.
   *
   * Deliberately *not* bidirectional. Probing upwards too would let a thin
   * floating platform above the camera drag the camera on top of it, which
   * looks like the camera teleporting for no reason.
   */
  private resolveGround(position: Vector3): void {
    const origin = SCRATCH.groundOrigin.set(
      position.x,
      position.y + GROUND_PROBE_HEIGHT,
      position.z,
    );
    const reach = GROUND_PROBE_HEIGHT + MIN_GROUND_CLEARANCE;

    const hit = this.physics.castDown(origin, reach, this.player.body);
    if (hit === null) return;

    const groundY = origin.y - hit.distance;
    const minimum = groundY + MIN_GROUND_CLEARANCE;
    if (position.y < minimum) position.y = minimum;
  }
}
