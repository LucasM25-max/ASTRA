/**
 * Third person follow camera.
 *
 * It swings in behind the character only while they are heading away from it;
 * that is what stops strafing from turning into a spiral (with a camera that
 * always chases the body, "move right" keeps re-aiming itself and the
 * character ends up spinning on the spot). Drag to orbit -- there is no
 * on-screen control of any kind.
 */

import * as THREE from "three";
import { CAMERA } from "./config.js";

/** how far off the view the character may travel before the camera follows */
const ALIGNMENT = 0.35;

export class FollowCamera {
  constructor(camera, character, domElement) {
    this.camera = camera;
    this.character = character;
    this.yaw = character.object3D.rotation.y;
    this.pitch = CAMERA.startPitch;
    this.focus = new THREE.Vector3();
    this.dragging = false;
    this.lastX = 0;
    this.lastY = 0;
    this._view = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._want = new THREE.Vector3();

    if (domElement) {
      const canvas = domElement;
      this._onDown = (e) => {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        canvas.setPointerCapture?.(e.pointerId);
      };
      this._onMove = (e) => {
        if (!this.dragging) return;
        this.yaw -= (e.clientX - this.lastX) * CAMERA.dragSpeed;
        this.pitch = clamp(this.pitch + (e.clientY - this.lastY) * CAMERA.dragSpeed,
                           CAMERA.minPitch, CAMERA.maxPitch);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      };
      this._onUp = () => { this.dragging = false; };
      for (const [type, fn] of [["pointerdown", this._onDown], ["pointermove", this._onMove],
                                ["pointerup", this._onUp], ["pointercancel", this._onUp],
                                ["pointerleave", this._onUp]]) {
        canvas.addEventListener(type, fn);
      }
    }

    const position = character.object3D.position;
    this.focus.set(position.x, position.y + CAMERA.targetHeight, position.z);
    this.place();
  }

  /** Horizontal direction the camera is looking along. */
  viewDirection(out = this._view) {
    this.camera.getWorldDirection(out);
    out.y = 0;
    return out.lengthSq() < 1e-6 ? out.set(0, 0, -1) : out.normalize();
  }

  /** `moveDirection` is where the character is actually travelling, or null. */
  update(dt, moveDirection) {
    const body = this.character.object3D;

    if (moveDirection) {
      const alignment = this.viewDirection().dot(moveDirection);
      if (alignment > ALIGNMENT) {
        const want = Math.atan2(-moveDirection.x, -moveDirection.z);
        this.yaw = dampAngle(this.yaw, want, CAMERA.yawFollow, dt);
      }
    }

    const focus = this._want.set(
      body.position.x,
      body.position.y + CAMERA.targetHeight,
      body.position.z,
    );
    this.focus.lerp(focus, 1 - Math.exp(-CAMERA.positionFollow * dt));
    this.place();
  }

  place() {
    const cos = Math.cos(this.pitch);
    const offset = this._offset.set(
      Math.sin(this.yaw) * cos,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cos,
    ).multiplyScalar(CAMERA.distance);
    this.camera.position.copy(this.focus).add(offset);
    this.camera.position.y = Math.max(this.camera.position.y, 0.6);
    this.camera.lookAt(this.focus);
    this.camera.updateMatrixWorld();
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Exponential damping that takes the short way around the circle. */
function dampAngle(current, target, rate, dt) {
  const delta = ((target - current + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return current + delta * (1 - Math.exp(-rate * dt));
}
