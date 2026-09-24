/** Shared terrain / river / pollution math. Must match tools/gen_textures.py */

export const WORLD_HALF = 48;
export const WATER_Y = -0.16;

export function lerp(a, b, t) {
  return a + (b - a) * t;
}
export function clamp(v, a = 0, b = 1) {
  return Math.max(a, Math.min(b, v));
}
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 + 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

export function riverCenterZ(x) {
  return 14.5 + Math.sin(x * 0.038) * 5.0 + Math.sin(x * 0.091 + 0.7) * 1.85;
}
export function riverHalfWidth(x) {
  return 6.6 + Math.sin(x * 0.027 + 0.3) * 1.15;
}
export function streamCenterX(z) {
  return 4.8 + Math.sin(z * 0.11) * 2.35 + Math.sin(z * 0.29 + 1.1) * 0.85;
}
export function streamHalfWidth(z) {
  const t = clamp((z + 38.0) / 52.0, 0, 1);
  return 1.15 + t * 0.7;
}

export function fbm(x, z) {
  let a = 0;
  let amp = 1;
  let f = 1;
  let s = 0;
  for (let i = 0; i < 5; i++) {
    a += amp * Math.sin(x * 0.031 * f + i * 1.7) * Math.cos(z * 0.029 * f - i * 1.3);
    s += amp;
    amp *= 0.5;
    f *= 2.07;
  }
  return a / s;
}

export function terrainHeight(x, z) {
  let h = 1.35 + fbm(x, z) * 1.85 + fbm(x * 2.3 + 20, z * 2.3 - 9) * 0.45;
  const nx = x / WORLD_HALF;
  const nz = z / WORLD_HALF;
  const edge = Math.max(Math.abs(nx), Math.abs(nz));
  if (edge > 0.78) {
    const t = (edge - 0.78) / 0.22;
    h += t * t * 9.5;
  }
  if (z < 8) {
    const woods = clamp((8 - z) / 20, 0, 1);
    h += woods * 0.55 * (0.6 + 0.4 * fbm(x + 40, z + 12));
  }

  const rz = riverCenterZ(x);
  const rd = Math.abs(z - rz);
  const rw = riverHalfWidth(x);
  const bank = 4.2;
  if (rd < rw + bank) {
    let bed = -1.72;
    if (Math.abs(x + 20) < 5) bed = -0.55;
    const t = smoothstep(rw + bank, rw * 0.72, rd);
    h = lerp(h, bed, t);
  }

  if (z < rz - 0.4) {
    const sx = streamCenterX(z);
    const sd = Math.abs(x - sx);
    const sw = streamHalfWidth(z);
    const sbank = 2.4;
    if (sd < sw + sbank) {
      const sbed = -0.72;
      const t = smoothstep(sw + sbank, sw * 0.55, sd);
      h = lerp(h, Math.min(h, sbed), t * 0.95);
    }
  }
  return h;
}

export function slopeAt(x, z, eps = 0.6) {
  const dx = terrainHeight(x + eps, z) - terrainHeight(x - eps, z);
  const dz = terrainHeight(x, z + eps) - terrainHeight(x, z - eps);
  return Math.hypot(dx / (2 * eps), dz / (2 * eps));
}

export function pollutionAt(x, z) {
  const sx = streamCenterX(z);
  const sd = Math.abs(x - sx);
  const sw = streamHalfWidth(z);
  const rz = riverCenterZ(x);
  const pStream = smoothstep(sw + 2.6, sw * 0.4, sd);
  const south = z < rz + 1 ? 1 : 0;
  const source = smoothstep(-18, -34, z);
  let p = pStream * south * (0.45 + 0.55 * source);

  const confX = 5;
  const rd = z - rz;
  const rw = riverHalfWidth(x);
  const inRiver = Math.abs(rd) < rw ? 1 : 0;
  const down = clamp((x - confX) / 38, 0, 1);
  const spread = 0.28 + down * 0.72;
  const side = rd / (rw + 1e-6);
  const plume = smoothstep(spread, 0, Math.abs(side + 0.38 * (1 - down)));
  const pPlume = plume * inRiver * (x > confX - 2 ? 1 : 0) * (1 - down * 0.5);
  p = Math.max(p, pPlume);
  return clamp(p, 0, 1);
}

export function forestMask(x, z) {
  const rz = riverCenterZ(x);
  let dens = 1;
  dens *= smoothstep(-24, -14, x) * smoothstep(32, 20, x);
  dens *= smoothstep(-45, -37, z);
  dens *= smoothstep(rz - 4.5, rz - 12, z);
  dens *= 0.5 + 0.5 * (0.5 + 0.5 * fbm(x * 0.85, z * 0.85));
  return clamp(dens, 0, 1);
}

export function inStream(x, z) {
  const rz = riverCenterZ(x);
  if (z >= rz - 0.2) return false;
  return Math.abs(x - streamCenterX(z)) < streamHalfWidth(z) + 0.4;
}

export function inRiver(x, z) {
  return Math.abs(z - riverCenterZ(x)) < riverHalfWidth(x);
}
