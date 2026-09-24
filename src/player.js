/**
 * The player: WASD to walk, Shift to sprint, Space to jump.
 *
 * Movement is camera-relative (W is always away from the camera) and the body
 * turns towards wherever it is heading. Horizontal speed is driven towards the
 * speed the animation was authored for, so the feet stay on the ground.
 */

import * as THREE from "three";
import { GAIT, MOVEMENT } from "./config.js";

const UP = new THREE.Vector3(0, 1, 0);

export class Player {
  constructor(character, camera, domElement) {
    this.character = character;
    this.camera = camera;
    this.dom = domElement;

    this.position = new THREE.Vector3(0, 0, 0);
    this.heading = 0;             // radians, 0 = facing -Z
    this.speed = 0;               // horizontal, m/s
    this.vertical = 0;            // m/s, while airborne
    this.grounded = true;
    this.jumping = false;         // inside a jump clip, waiting to launch
    this.launchAt = 0;            // seconds of jump clip left before take-off

    this.keys = new Set();
    this.moveDirection = new THREE.Vector3();
    this._view = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._forward = new THREE.Vector3();

    this._onKeyDown = (e) => {
      this.keys.add(e.code);
      if (e.code !== "Space") return;
      e.preventDefault?.();
      if (!e.repeat) this.jump();      // holding the key is one jump, not a pogo
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._onBlur);

    character.object3D.position.copy(this.position);
  }

  get object3D() {
    return this.character.object3D;
  }

  /** Unit vector of the direction the body is actually travelling, or null. */
  travelDirection() {
    if (this.speed < 0.05) return null;
    this._travel ??= new THREE.Vector3();
    return this._travel.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  /** WASD in camera space. Returns a unit vector, or null when idle. */
  readInput() {
    const k = this.keys;
    const forward = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0)
      - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    const strafe = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0)
      - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    if (!forward && !strafe) return null;

    const view = this._view;
    this.camera.getWorldDirection(view);
    view.y = 0;
    if (view.lengthSq() < 1e-6) view.set(0, 0, -1);
    view.normalize();
    const right = this._right.crossVectors(view, UP).normalize();

    this.moveDirection.set(0, 0, 0)
      .addScaledVector(view, forward)
      .addScaledVector(right, strafe)
      .normalize();
    return this.moveDirection;
  }

  update(dt) {
    const input = this.readInput();
    const sprinting = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");

    /* ---- steering and speed ------------------------------------------- */
    if (this.jumping) {
      this.launchAt -= dt;
      if (this.launchAt <= 0) {          // the clip's drive phase has passed
        this.jumping = false;
        this.grounded = false;
        this.vertical = MOVEMENT.jumpSpeed;
        this.character.beginFall();
      }
    }

    // Speed is always driven towards a gait speed the animation was authored
    // for; in the air, momentum is kept unless the player steers.
    const absorbing = this.grounded && this.character.state === "land"
      && this.character.timeLeft() > (input ? 0.10 : 0.16);
    let target = 0;
    if (input && !absorbing) target = sprinting ? GAIT.run.speed : GAIT.walk.speed;
    else if (!this.grounded) target = this.speed;
    const rate = (target > this.speed ? MOVEMENT.accelerate : MOVEMENT.brake)
      * (this.grounded ? 1 : MOVEMENT.airControl);
    this.speed = THREE.MathUtils.damp(this.speed, target, rate, dt);

    if (input) {
      const wanted = Math.atan2(-input.x, -input.z);
      this.heading = approachAngle(this.heading, wanted, MOVEMENT.turn * dt);
    }

    /* ---- position ------------------------------------------------------ */
    if (this.speed > 0.001) {
      const forward = this._forward.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
      this.position.addScaledVector(forward, this.speed * dt);
    }
    if (!this.grounded) {
      this.vertical -= MOVEMENT.gravity * dt;
      this.position.y += this.vertical * dt;
      if (this.position.y <= 0 && this.vertical < 0) {
        this.position.y = 0;
        this.vertical = 0;
        this.grounded = true;
        this.character.beginLand();
      }
    }

    /* ---- animation ----------------------------------------------------- */
    this.driveAnimation(input);

    this.object3D.position.copy(this.position);
    this.object3D.rotation.y = this.heading;
  }

  driveAnimation(input) {
    const character = this.character;
    if (this.jumping || !this.grounded) return;   // jump and fall own the clip

    // The absorb at the end of a landing holds the pose -- and the feet -- for
    // a moment; control comes back a touch sooner if the player is already
    // pushing a direction again.
    if (character.state === "land" && character.timeLeft() > (input ? 0.10 : 0.16)) return;
    character.setLocomotion(this.speed);
  }

  jump() {
    if (!this.grounded || this.jumping) return;
    this.jumping = true;
    this.launchAt = MOVEMENT.launchTime;
    this.character.beginJump();
  }

  dispose() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._onBlur);
  }
}

/** Turn `from` towards `to` by at most `maxStep`, taking the short way round. */
function approachAngle(from, to, maxStep) {
  let delta = ((to - from + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  if (Math.abs(delta) <= maxStep) return to;
  return from + Math.sign(delta) * maxStep;
}
