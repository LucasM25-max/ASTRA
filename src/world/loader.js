/**
 * Client-side loader for ASTRA geometry (.geo) files.
 *
 * Converts AGEO binary containers into Three.js BufferGeometry meshes.
 */

import * as THREE from "three";

const MAGIC = "AGEO";
const VERSION = 1;

/** Parse an AGEO ArrayBuffer into a dictionary of Three.js BufferGeometries. */
export function parseGeoToGeometries(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dec = new TextDecoder();
  if (dec.decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error("not an ASTRA geometry file");
  const version = bytes[4];
  if (version !== VERSION) throw new Error(`unsupported version ${version}`);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(5, true);
  const header = JSON.parse(dec.decode(bytes.subarray(9, 9 + headerLen)));

  const geometries = {};
  let at = 9 + headerLen;
  const readCount = (type) => (type === "f32" ? 4 : type === "u32" ? 4 : 2);

  for (const [blockName, block] of Object.entries(header.blocks)) {
    const geom = new THREE.BufferGeometry();
    for (const [attrName, spec] of Object.entries(block.attributes)) {
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
      geom.setAttribute(attrName, new THREE.BufferAttribute(out, spec.components));
      at += n * b + (n * b % 4 ? 4 - (n * b % 4) : 0);
    }
    geometries[blockName] = geom;
  }

  return { meta: header.meta, geometries };
}
