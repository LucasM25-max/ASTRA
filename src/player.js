import * as THREE from "three";
import { terrainHeight, WORLD_HALF, WATER_Y } from "./landscape.js";

function groundH(x, z) {
  const r = 0.26;
  return Math.max(
    terrainHeight(x, z),
    terrainHeight(x + r, z),
    terrainHeight(x - r, z),
    terrainHeight(x, z + r),
    terrainHeight(x, z - r)
  );
}

export function makeBeanFallback() {
  const g = new THREE.Group();
  g.name = "Bean";
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 28, 20),
    new THREE.MeshPhysicalMaterial({
      color: 0xc9a36a,
      roughness: 0.36,
      clearcoat: 0.5,
      clearcoatRoughness: 0.28,
      sheen: 0.2,
      sheenColor: 0xe8c48a,
    })
  );
  body.scale.set(0.84, 1.12, 0.68);
  body.castShadow = true;
  body.receiveShadow = true;
  const eyeM = new THREE.MeshStandardMaterial({ color: 0x140f0c, roughness: 0.3 });
  const e1 = new THREE.Mesh(new THREE.SphereGeometry(0.034, 10, 8), eyeM);
  e1.position.set(0.09, 0.12, 0.16);
  const e2 = e1.clone();
  e2.position.x = -0.09;
  g.add(body, e1, e2);
  return g;
}

export class Player {
  constructor(scene, camera, bean) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.position.set(-1.2, 0, 26.8);
    this.yaw = 0.42; // look south-southeast toward the confluence
    this.pitch = 0.34;
    this.vel = new THREE.Vector3();
    this.onGround = false;
    this.keys = Object.create(null);
    this.dist = 7.4;
    this.bean = bean;
    this.bean.position.set(0, 0, 0);
    this.root.add(this.bean);
    this.bean.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.bean);
    this._beanLift = -box.min.y + 0.02;
    this.bean.position.y = this._beanLift;
    scene.add(this.root);
    this._bob = 0;
    this._bind();
  }

  _bind() {
    const onDown = (e) => {
      this.keys[e.code] = true;
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
      }
    };
    const onUp = (e) => {
      this.keys[e.code] = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);

    const canvas = this.camera.elCanvas;
    const el = document.getElementById("c") || document.body;
    el.addEventListener("click", () => {
      el.requestPointerLock?.();
    });
    window.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement) {
        this.yaw -= e.movementX * 0.0022;
        this.pitch += e.movementY * 0.0016;
        this.pitch = Math.max(-0.12, Math.min(1.15, this.pitch));
      }
    });
    // drag-look without lock as fallback
    let dragging = false;
    el.addEventListener("mousedown", () => {
      dragging = true;
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
    window.addEventListener("mousemove", (e) => {
      if (!document.pointerLockElement && dragging) {
        this.yaw -= e.movementX * 0.008;
        this.pitch += e.movementY * 0.006;
        this.pitch = Math.max(-0.12, Math.min(1.15, this.pitch));
      }
    });
  }

  get position() {
    return this.root.position;
  }

  update(dt) {
    const sprint = this.keys["ShiftLeft"] || this.keys["ShiftRight"];
    const speed = sprint ? 6.8 : 3.85;
    const look = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(look.z, 0, -look.x);

    let mx = 0;
    let mz = 0;
    if (this.keys["KeyW"] || this.keys["ArrowUp"]) mz += 1;
    if (this.keys["KeyS"] || this.keys["ArrowDown"]) mz -= 1;
    if (this.keys["KeyA"] || this.keys["ArrowLeft"]) mx -= 1;
    if (this.keys["KeyD"] || this.keys["ArrowRight"]) mx += 1;
    const moving = mx !== 0 || mz !== 0;
    if (moving) {
      const dir = look.clone().multiplyScalar(mz).add(right.multiplyScalar(mx));
      dir.y = 0;
      if (dir.lengthSq() > 0) dir.normalize();
      this.vel.x = dir.x * speed;
      this.vel.z = dir.z * speed;
      const face = Math.atan2(-dir.x, -dir.z);
      this.bean.rotation.y = face;
    } else {
      this.vel.x *= Math.pow(0.001, dt);
      this.vel.z *= Math.pow(0.001, dt);
    }

    const p = this.root.position;
    const gh = groundH(p.x, p.z);
    const depth = WATER_Y - gh;
    const inWater = depth > 0.08;
    if (inWater) {
      const drag = depth > 0.7 ? 0.32 : 0.55;
      this.vel.x *= drag;
      this.vel.z *= drag;
    }

    if (this.onGround && (this.keys["Space"] || this.keys["KeyJ"])) {
      this.vel.y = inWater ? 5.2 : 8.15;
      this.onGround = false;
    }

    this.vel.y -= (inWater ? 10 : 24) * dt;
    p.x += this.vel.x * dt;
    p.z += this.vel.z * dt;
    p.y += this.vel.y * dt;

    const half = WORLD_HALF - 2.2;
    p.x = THREE.MathUtils.clamp(p.x, -half, half);
    p.z = THREE.MathUtils.clamp(p.z, -half, half);

    const g2 = groundH(p.x, p.z);
    const slope =
      Math.abs(g2 - gh) /
      Math.max(0.001, Math.hypot(this.vel.x, this.vel.z) * dt || 0.2);
    if (slope > 2.8 && p.y <= g2 + 0.4) {
      p.x -= this.vel.x * dt;
      p.z -= this.vel.z * dt;
    }

    const feet = groundH(p.x, p.z);
    if (p.y <= feet) {
      p.y = feet;
      if (this.vel.y < 0) this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    this._bob += dt * (moving ? (sprint ? 11 : 7.5) : 2.2);
    const bounce = this.onGround && moving ? Math.abs(Math.sin(this._bob)) * 0.045 : 0;
    this.bean.position.y = this._beanLift + bounce + (this.onGround ? 0 : 0.04);
    const squash = this.onGround ? 1 - bounce * 0.8 : 1.06;
    this.bean.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));

    this._camera(dt, look);
  }

  _camera(dt, look) {
    const p = this.root.position;
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const desired = new THREE.Vector3(
      p.x - look.x * this.dist * cp,
      p.y + 1.25 + this.dist * sp,
      p.z - look.z * this.dist * cp
    );
    const camH = terrainHeight(desired.x, desired.z) + 0.55;
    if (desired.y < camH) desired.y = camH;
    this.camera.position.lerp(desired, 1 - Math.pow(0.0008, dt));
    const target = new THREE.Vector3(p.x, p.y + 0.95, p.z);
    const cur = new THREE.Vector3().copy(this.camera.position);
    const lookM = new THREE.Matrix4().lookAt(cur, target, new THREE.Vector3(0, 1, 0));
    const q = new THREE.Quaternion().setFromRotationMatrix(lookM);
    this.camera.quaternion.slerp(q, 1 - Math.pow(0.0004, dt));
  }
}
