/**
 * Phase P1, Task 1.3: footprints in wet mud.
 *
 * Where the soil moisture field reads above 0.7, the walker's feet leave
 * compressed-mud prints that the terrain shader darkens and smooths. The
 * prints live on a small canvas tile (26 m across at ~5 cm/px) that follows
 * the player, recentring with its ink shifted along, and they fade over about
 * a minute -- diegetic, with no UI and no geometry.
 *
 * The world-to-tile math is pure (footprintUV) so the checker can audit it;
 * only the Footprints class touches the DOM.
 */

import * as THREE from "three";
import { P1 } from "./splat.js";

export const FOOTPRINT = {
  size: 512,
  extent: 26,
  /** Recentre once the walker leaves the middle 60% of the tile. */
  recenterMargin: 0.20,
  /** Ink lost per second: prints read for about a minute. */
  fadePerSecond: 0.016,
  fadeInterval: 0.25,
  /** Stride that lays one print, scaled by gait below. */
  strideWalk: 0.55,
  strideRun: 0.95,
  /** Lateral offset of each foot from the body line, in metres. */
  stepWidth: 0.11,
};

/** Tile UV (0..1) for a world position, given the tile centre and extent. */
export function footprintUV(x, z, cx, cz, extent = FOOTPRINT.extent) {
  return [(x - cx) / extent + 0.5, (z - cz) / extent + 0.5];
}

export class Footprints {
  constructor({ size = FOOTPRINT.size, extent = FOOTPRINT.extent } = {}) {
    this.size = size;
    this.extent = extent;
    this.canvas = document.createElement("canvas");
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx = this.canvas.getContext("2d");
    this.ctx.clearRect(0, 0, size, size);
    // A scratch tile for shifting the ink when the tile recentres.
    this.scratch = document.createElement("canvas");
    this.scratch.width = size;
    this.scratch.height = size;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.center = { x: 0, z: 0, set: false };
    this.centerV2 = new THREE.Vector2(0, 0);
    this.lastStamp = null;
    this.side = 1;
    this.fadeAcc = 0;
    this.dirty = false;
  }

  get ppm() {
    return this.size / this.extent;
  }

  /** Canvas pixels for a world position (flipY-aware: canvas y runs down). */
  toPixels(x, z) {
    const [u, v] = footprintUV(x, z, this.center.x, this.center.z, this.extent);
    return [u * this.size, (1 - v) * this.size];
  }

  recenter(x, z) {
    if (!this.center.set) {
      this.center.x = x;
      this.center.z = z;
      this.center.set = true;
      this.centerV2.set(x, z);
      return;
    }
    const dx = ((x - this.center.x) / this.extent) * this.size;
    const dy = ((z - this.center.z) / this.extent) * this.size;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    // Shift the ink along: copy through scratch (self-drawImage is unreliable).
    const sctx = this.scratch.getContext("2d");
    sctx.clearRect(0, 0, this.size, this.size);
    sctx.drawImage(this.canvas, 0, 0);
    this.ctx.clearRect(0, 0, this.size, this.size);
    this.ctx.drawImage(this.scratch, -dx, dy);
    this.center.x = x;
    this.center.z = z;
    this.centerV2.set(x, z);
    this.dirty = true;
  }

  /** Lay one print: a heel and a toe along the walker's heading. */
  stamp(x, z, heading, strength = 1) {
    const [px, py] = this.toPixels(x, z);
    const ppm = this.ppm;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(px, py);
    // Canvas +x is world +x, canvas +y is world -z. Local +y is the toe.
    const dx = -Math.sin(heading), dy = Math.cos(heading);
    ctx.rotate(Math.atan2(-dx, dy));
    ctx.fillStyle = `rgba(255,255,255,${0.62 * strength})`;
    ctx.beginPath();
    ctx.ellipse(0, -0.07 * ppm, 0.055 * ppm, 0.075 * ppm, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, 0.085 * ppm, 0.062 * ppm, 0.095 * ppm, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this.dirty = true;
  }

  /**
   * Follow the player, stamping prints on wet-enough ground.
   * `sample(x, z)` answers { moisture, above } from the relief fields.
   */
  update(dt, player, sample) {
    const p = player.position;
    if (!this.center.set) this.recenter(p.x, p.z);

    // Stay centred on the walker, with hysteresis so the ink rarely shifts.
    const [u, v] = footprintUV(p.x, p.z, this.center.x, this.center.z, this.extent);
    const m = FOOTPRINT.recenterMargin;
    if (u < m || u > 1 - m || v < m || v > 1 - m) this.recenter(p.x, p.z);

    // Fade slowly, in coarse steps to avoid re-uploading every frame.
    this.fadeAcc += dt;
    if (this.fadeAcc >= FOOTPRINT.fadeInterval) {
      const a = Math.min(1, FOOTPRINT.fadePerSecond * this.fadeAcc);
      this.ctx.save();
      this.ctx.globalCompositeOperation = "destination-out";
      this.ctx.fillStyle = `rgba(0,0,0,${a.toFixed(4)})`;
      this.ctx.fillRect(0, 0, this.size, this.size);
      this.ctx.restore();
      this.fadeAcc = 0;
      this.dirty = true;
    }

    // Stamp while walking on wet ground that is not itself underwater.
    const moving = player.grounded && !player.jumping && player.speed > 0.3;
    if (moving) {
      const stride = player.speed > 1.45 ? FOOTPRINT.strideRun : FOOTPRINT.strideWalk;
      const travelled = this.lastStamp
        ? Math.hypot(p.x - this.lastStamp.x, p.z - this.lastStamp.z)
        : Infinity;
      if (travelled >= stride) {
        const { moisture, above } = sample(p.x, p.z);
        if (moisture > P1.footprintMoisture && above > 0.03) {
          // Alternate feet across the body line.
          this.side = -this.side;
          const rx = Math.cos(player.heading), rz = -Math.sin(player.heading);
          const fx = p.x + rx * this.side * FOOTPRINT.stepWidth;
          const fz = p.z + rz * this.side * FOOTPRINT.stepWidth;
          this.stamp(fx, fz, player.heading, 0.55 + 0.45 * moisture);
        }
        this.lastStamp = { x: p.x, z: p.z };
      }
    }

    if (this.dirty) {
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }
}
