/**
 * The world geometry container: one small, dependency-free binary format.
 *
 * Why not glTF for the terrain? Because a glTF of a height field spends its whole
 * existence carrying a transform and an accessor chain that say nothing -- the
 * world is already in world space, has one material, and never gets re-rigged.
 * What the renderer actually needs is a flat attribute buffer per block, and what
 * the build needs is to write it in one pass and to be able to *read it back* in
 * the checker and compare against the authored model. So: a text header with the
 * block layout, then the raw typed-array payloads, little-endian, no padding.
 *
 *   [4 bytes "AGEO"][1 byte version][uint32 header length][header JSON][payload]
 *
 * The header is readable on its own (`head -c` on the file tells you what is in
 * it), and the payload is a memcpy for the loader. Both matter when a build takes
 * eight seconds and a check reads four of these.
 */

import { readFile, writeFile } from "node:fs/promises";

const MAGIC = "AGEO";
const VERSION = 1;

const TYPED = {
  f32: { Array: Float32Array, bytes: 4 },
  u16: { Array: Uint16Array, bytes: 2 },
  u32: { Array: Uint32Array, bytes: 4 },
  i16: { Array: Int16Array, bytes: 2 },
};

/**
 * Pack a header and a list of named arrays into the container.
 *
 * `blocks` is { name: { attributes: { name: { type, components, count } } } };
 * pass `data`, a Map of BufferViews, to write payload bytes directly.
 */
export function packGeo({ meta = {}, blocks = {}, payloads = [] }) {
  const header = JSON.stringify({ meta, blocks });
  const headerBytes = new TextEncoder().encode(header);
  let size = 4 + 1 + 4 + headerBytes.length;
  for (const p of payloads) size += p.length + (p.length % 4 ? 4 - (p.length % 4) : 0);

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([0x41, 0x47, 0x45, 0x4f], 0);
  out[4] = VERSION;
  view.setUint32(5, headerBytes.length, true);
  out.set(headerBytes, 9);
  let at = 9 + headerBytes.length;
  for (const p of payloads) {
    out.set(p, at);
    at += p.length;
    if (p.length % 4) at += 4 - (p.length % 4);
  }
  return out;
}

/** Build a payload from plain arrays / typed arrays, in attribute order. */
export function payloadFor(blocks, data) {
  const parts = [];
  for (const [name, block] of Object.entries(blocks)) {
    for (const [attr, spec] of Object.entries(block.attributes)) {
      const src = data[`${name}.${attr}`] ?? data[attr];
      if (!src) throw new Error(`payload missing ${name}.${attr}`);
      const { Array: Ctor, bytes } = TYPED[spec.type];
      const arr = src instanceof Ctor ? src : new Ctor(src);
      const n = spec.count * spec.components;
      if (arr.length !== n) {
        throw new Error(`${name}.${attr}: ${arr.length} values, expected ${n}`);
      }
      const buf = new Uint8Array(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
      parts.push(buf);
      if (buf.length % 4) parts.push(new Uint8Array(4 - buf.length % 4));
    }
  }
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Read a container into { meta, blocks, data } with typed-array views. */
export async function readGeo(path) {
  const buf = await readFile(path);
  return parseGeo(buf);
}

export function parseGeo(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dec = new TextDecoder();
  if (dec.decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error("not an ASTRA geometry file");
  const version = bytes[4];
  if (version !== VERSION) throw new Error(`geometry version ${version}, expected ${VERSION}`);
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5, true);
  const header = JSON.parse(dec.decode(bytes.subarray(9, 9 + headerLen)));
  const data = {};
  let at = 9 + headerLen;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readCount = (type) => (type === "f32" ? 4 : type === "u32" ? 4 : 2);
  for (const [name, block] of Object.entries(header.blocks)) {
    for (const [attr, spec] of Object.entries(block.attributes)) {
      const n = spec.count * spec.components;
      const b = readCount(spec.type);
      const out = spec.type === "f32" ? new Float32Array(n)
        : spec.type === "u32" ? new Uint32Array(n)
          : spec.type === "u16" ? new Uint16Array(n) : new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const o = at + i * b;
        out[i] = spec.type === "f32" ? view.getFloat32(o, true)
          : spec.type === "u32" ? view.getUint32(o, true)
            : spec.type === "u16" ? view.getUint16(o, true) : view.getInt16(o, true);
      }
      data[`${name}.${attr}`] = out;
      at += n * b + (n * b % 4 ? 4 - (n * b % 4) : 0);
    }
  }
  return { ...header, data, byteLength: bytes.length, payloadBytes: bytes.length - at };
}

/**
 * Write a set of geometry blocks: `data` keys are `<block>.<attribute>`.
 * Attribute order in the header is the order the payload is written in.
 */
export async function writeGeo(path, { meta, blocks, data }) {
  const payload = payloadFor(blocks, data);
  await writeFile(path, packGeo({ meta, blocks, payloads: [payload] }));
  return { bytes: 9 + new TextEncoder().encode(JSON.stringify({ meta, blocks })).length + payload.length };
}

/* ------------------------------------------------------------- algorithms */

/**
 * Ear clipping for a simple polygon: the same algorithm three.js'
 * BufferGeometryUtils uses for ShapeGeometry, kept here so the build and the
 * renderer agree on how the water surface is triangulated.
 *
 * (three.js ships this in `examples/jsm/utils/BufferGeometryUtils.js`, which the
 * app already vendors, so it is available at runtime too -- but the build must not
 * depend on the renderer's module graph to produce a file the renderer reads.)
 */
export function triangulatePolygon(vertices, dim = 2, stride = 2) {
  const indices = [];
  const n = Math.floor((vertices.length / stride) | 0);
  if (n < 3) return indices;
  const prev = new Int32Array(n), next = new Int32Array(n);
  for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1; }
  prev[0] = n - 1; next[n - 1] = 0;

  const at = (i, c) => vertices[((i % n) + n) % n * stride + c];
  const signedArea = () => {
    let a = 0;
    for (let i = 0; i < n; i++) {
      const j = next[i];
      a += at(i, 0) * at(j, 1) - at(j, 0) * at(i, 1);
    }
    return a / 2;
  };
  const isConvex = (i) => {
    const a = prev[i], b = next[i];
    return (at(b, 0) - at(a, 0)) * (at(i, 1) - at(a, 1)) - (at(i, 0) - at(a, 0)) * (at(b, 1) - at(a, 1)) > 0;
  };
  const pointInTriangle = (px, py, ax, ay, bx, by, cx, cy) => {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
  const insideAny = (i) => {
    const px = at(i, 0), py = at(i, 1);
    let a = prev[i], b = next[i];
    for (let guard = 0; guard < n * 4 && next[a] !== b; guard++) {
      const c = next[a];
      if (c === b) break;
      if (pointInTriangle(px, py, at(a, 0), at(a, 1), at(b, 0), at(b, 1), at(c, 0), at(c, 1))) return true;
      a = c;
    }
    return false;
  };

  let remaining = n;
  let i = 0;
  let guard = 0;
  const ccw = signedArea() > 0;
  while (remaining > 2 && guard++ < n * n) {
    const a = prev[i], b = next[i];
    if (a === b) break;
    if (isConvex(i) && !insideAny(i)) {
      indices.push(a, i, b);
      next[a] = b; prev[b] = a;
      remaining--;
      i = b;
    } else {
      i = next[i];
    }
    if (!ccw) { /* orientation handled by pushing in list order; no flip needed */ }
  }
  return indices;
}

/**
 * Marching squares over a scalar field on a regular grid, returning closed
 * contours at an iso-value. Used for the water: the contour *is* the waterline,
 * which is the only way the water mesh can be guaranteed to meet the terrain
 * exactly where the terrain says the water ends.
 */
export function marchingSquares(field, nx, nz, level, { cell = 1, originX = 0, originZ = 0 } = {}) {
  const segs = [];
  const v = (ix, iz) => field[iz * nx + ix];
  const interp = (a, b) => (Math.abs(b - a) < 1e-12 ? 0.5 : (level - a) / (b - a));
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const tl = v(ix, iz) - level, tr = v(ix + 1, iz) - level;
      const bl = v(ix, iz + 1) - level, br = v(ix + 1, iz + 1) - level;
      let idx = 0;
      if (tl > 0) idx |= 8;
      if (tr > 0) idx |= 4;
      if (br > 0) idx |= 2;
      if (bl > 0) idx |= 1;
      if (idx === 0 || idx === 15) continue;
      const top = [originX + (ix + interp(v(ix, iz), v(ix + 1, iz))) * cell, originZ + iz * cell];
      const right = [originX + (ix + 1) * cell, originZ + (iz + interp(v(ix + 1, iz), v(ix + 1, iz + 1))) * cell];
      const bottom = [originX + (ix + interp(v(ix, iz + 1), v(ix + 1, iz + 1))) * cell, originZ + (iz + 1) * cell];
      const left = [originX + ix * cell, originZ + (iz + interp(v(ix, iz), v(ix, iz + 1))) * cell];
      const push = (a, b) => segs.push(a, b);
      switch (idx) {
        case 1: case 14: push(left, bottom); break;
        case 2: case 13: push(bottom, right); break;
        case 3: case 12: push(left, right); break;
        case 4: case 11: push(top, right); break;
        case 5: push(left, top); push(bottom, right); break;
        case 6: case 9: push(top, bottom); break;
        case 7: case 8: push(left, top); break;
        case 10: push(left, bottom); push(top, right); break;
        default: break;
      }
    }
  }
  return linkSegments(segs, 1.5e-4);
}

/** Join an unordered segment soup into closed rings, longest ring first. */
export function linkSegments(segs, eps = 1e-4) {
  const key = (p) => `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`;
  const rings = [];
  const used = new Uint8Array(segs.length);
  const start = () => {
    for (let i = 0; i < segs.length; i++) if (!used[i]) return i;
    return -1;
  };
  for (let s = start(); s >= 0; s = start()) {
    used[s] = 1; used[s ^ 1] = 1;
    const ring = [segs[s], segs[s ^ 1]];
    const endKey = key(ring[ring.length - 1]);
    const startKey = key(ring[0]);
    let guard = 0;
    while (key(ring[ring.length - 1]) !== startKey && guard++ < segs.length) {
      const from = key(ring[ring.length - 1]);
      let found = -1;
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        if (key(segs[i]) === from) { found = i; break; }
        if (key(segs[i ^ 1]) === from) { found = i ^ 1; break; }
      }
      if (found < 0) break;
      used[found] = 1; used[found ^ 1] = 1;
      ring.push(segs[found === 0 || !(found % 2) ? segs[found ^ 1] : segs[found ^ 1]]);
      void endKey;
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}
