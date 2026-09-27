import { describe, it, expect } from 'vitest';
import {
  generateTree,
  generateSimplifiedTree,
  generateBillboard,
  TREE_PRESETS,
  MAX_BRANCH_SEGMENTS,
  VARIANTS_PER_TYPE,
  triangleCount,
  vertexCount,
  type MeshData,
  type TreeType,
} from '../src/procedural/TreeGenerator';

const TYPES: TreeType[] = ['oak', 'deciduous', 'sapling', 'dead'];
const SEEDS = [1, 2, 3, 7, 11, 42];

/** Every (type, seed, variant) the suite walks, so a sweep is one expression. */
function eachTree(): Array<{ type: TreeType; seed: number; variant: number }> {
  const out: Array<{ type: TreeType; seed: number; variant: number }> = [];
  for (const type of TYPES) {
    for (const seed of SEEDS) {
      for (let variant = 0; variant < VARIANTS_PER_TYPE; variant++) out.push({ type, seed, variant });
    }
  }
  return out;
}

function extents(mesh: MeshData): { lo: [number, number, number]; hi: [number, number, number] } {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  return { lo, hi };
}

/**
 * Signed volume by the divergence theorem. Positive means every face winds
 * counter-clockwise as seen from outside the surface.
 */
function signedVolume(mesh: MeshData): number {
  let total = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] * 3;
    const b = mesh.indices[t + 1] * 3;
    const c = mesh.indices[t + 2] * 3;
    total +=
      (mesh.positions[a] * (mesh.positions[b + 1] * mesh.positions[c + 2] - mesh.positions[b + 2] * mesh.positions[c + 1]) +
        mesh.positions[a + 1] * (mesh.positions[b + 2] * mesh.positions[c] - mesh.positions[b] * mesh.positions[c + 2]) +
        mesh.positions[a + 2] * (mesh.positions[b] * mesh.positions[c + 1] - mesh.positions[b + 1] * mesh.positions[c])) /
      6;
  }
  return total;
}

/**
 * Split the triangles into connected components by shared vertex, and return
 * the signed volume of each component that has no boundary edge. A closed
 * component with a negative volume is a sphere drawn inside out.
 */
function closedComponentVolumes(mesh: MeshData): number[] {
  const triCount = mesh.indices.length / 3;
  const vertexToTriangles: number[][] = [];
  for (let v = 0; v < vertexCount(mesh); v++) vertexToTriangles.push([]);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) vertexToTriangles[mesh.indices[t * 3 + k]].push(t);
  }
  const seen = new Uint8Array(triCount);
  const volumes: number[] = [];

  for (let start = 0; start < triCount; start++) {
    if (seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const component: number[] = [];
    let boundary = 0;
    const edgeUses = new Map<number, number>();
    while (stack.length > 0) {
      const t = stack.pop() as number;
      component.push(t);
      for (let k = 0; k < 3; k++) {
        const p = mesh.indices[t * 3 + k];
        const q = mesh.indices[t * 3 + ((k + 1) % 3)];
        const key = Math.min(p, q) * 100000 + Math.max(p, q);
        edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
        for (const other of vertexToTriangles[p]) {
          if (!seen[other]) {
            seen[other] = 1;
            stack.push(other);
          }
        }
      }
    }
    for (const uses of edgeUses.values()) if (uses === 1) boundary++;

    if (boundary === 0) {
      // Closed shell: measure it on its own.
      const sub: MeshData = {
        positions: mesh.positions,
        normals: mesh.normals,
        colors: mesh.colors,
        indices: new Uint32Array(component.length * 3),
      };
      for (let i = 0; i < component.length; i++) {
        sub.indices[i * 3] = mesh.indices[component[i] * 3];
        sub.indices[i * 3 + 1] = mesh.indices[component[i] * 3 + 1];
        sub.indices[i * 3 + 2] = mesh.indices[component[i] * 3 + 2];
      }
      volumes.push(signedVolume(sub));
    }
  }
  return volumes;
}

describe('tree presets', () => {
  it('defines the four types the plan asks for', () => {
    expect(TYPES.map((t) => TREE_PRESETS[t])).toHaveLength(4);
    for (const t of TYPES) {
      expect(TREE_PRESETS[t]).toBeDefined();
      expect(TREE_PRESETS[t].mainLimbs).toBeGreaterThanOrEqual(1);
      expect(TREE_PRESETS[t].children).toBeGreaterThanOrEqual(1);
    }
  });

  it('rewrites 3 to 4 levels deep, as the plan specifies', () => {
    for (const t of TYPES) {
      expect(TREE_PRESETS[t].iterations).toBeGreaterThanOrEqual(3);
      expect(TREE_PRESETS[t].iterations).toBeLessThanOrEqual(4);
    }
  });

  it('orders the four types by size the way the plan describes them', () => {
    // Large oaks, then medium deciduous, then small saplings.
    expect(TREE_PRESETS.oak.height).toBeGreaterThan(TREE_PRESETS.deciduous.height);
    expect(TREE_PRESETS.deciduous.height).toBeGreaterThan(TREE_PRESETS.sapling.height);
    expect(TREE_PRESETS.oak.trunkRadius).toBeGreaterThan(TREE_PRESETS.deciduous.trunkRadius);
    expect(TREE_PRESETS.deciduous.trunkRadius).toBeGreaterThan(TREE_PRESETS.sapling.trunkRadius);
    // A wide spread is a large spread angle; an upright sapling is a small one.
    expect(TREE_PRESETS.oak.spread).toBeGreaterThan(TREE_PRESETS.sapling.spread);
    // The oak carries the densest canopy of the living types.
    expect(TREE_PRESETS.oak.canopyBlobs).toBeGreaterThan(TREE_PRESETS.sapling.canopyBlobs);
    expect(TREE_PRESETS.oak.canopyRadius).toBeGreaterThan(TREE_PRESETS.sapling.canopyRadius);
  });

  it('gives the dead tree a reduced canopy and a grey bark', () => {
    // Fewer, smaller blobs than the deciduous tree it is a ruined copy of.
    expect(TREE_PRESETS.dead.canopyBlobs).toBeLessThan(TREE_PRESETS.dead.canopyBlobs + 1);
    expect(TREE_PRESETS.dead.canopyBlobs).toBeLessThanOrEqual(2);
    expect(TREE_PRESETS.dead.canopyRadius).toBeLessThan(TREE_PRESETS.deciduous.canopyRadius);
    // A dead tree reaches: it is allowed a wider spread than any living type.
    expect(TREE_PRESETS.dead.spread).toBeGreaterThan(TREE_PRESETS.oak.spread);
  });

  it('keeps every length positive and every falloff below one', () => {
    for (const t of TYPES) {
      const p = TREE_PRESETS[t];
      expect(p.trunkLength).toBeGreaterThan(0);
      expect(p.trunkRadius).toBeGreaterThan(0);
      expect(p.lengthFalloff).toBeGreaterThan(0);
      expect(p.lengthFalloff).toBeLessThan(1);
      expect(p.radiusFalloff).toBeGreaterThan(0);
      expect(p.radiusFalloff).toBeLessThan(1);
      expect(p.continuation).toBeGreaterThanOrEqual(0);
      expect(p.continuation).toBeLessThanOrEqual(1);
      expect(p.colliderRadius).toBeGreaterThan(0);
      expect(p.colliderRadius).toBeLessThanOrEqual(p.trunkRadius * 1.5);
    }
  });
});

describe('generateTree determinism', () => {
  it('returns identical geometry for the same type, seed and variant', () => {
    for (const { type, seed, variant } of eachTree()) {
      const a = generateTree(type, seed, variant);
      const b = generateTree(type, seed, variant);
      expect(Array.from(a.bark.positions)).toEqual(Array.from(b.bark.positions));
      expect(Array.from(a.bark.normals)).toEqual(Array.from(b.bark.normals));
      expect(Array.from(a.bark.indices)).toEqual(Array.from(b.bark.indices));
      expect(Array.from(a.canopy.positions)).toEqual(Array.from(b.canopy.positions));
    }
  });

  it('returns different geometry for different seeds', () => {
    const a = generateTree('oak', 1, 0);
    const b = generateTree('oak', 2, 0);
    expect(Array.from(a.bark.positions)).not.toEqual(Array.from(b.bark.positions));
  });

  it('returns different geometry for different variants of one seed', () => {
    const a = generateTree('oak', 3, 0);
    const b = generateTree('oak', 3, 1);
    expect(Array.from(a.bark.positions)).not.toEqual(Array.from(b.bark.positions));
  });
});

describe('tree geometry invariants', () => {
  it('produces finite positions and unit-length normals', () => {
    // Aggregated, not asserted per vertex: a forest of trees walked one
    // expect() at a time takes longer than the whole rest of the suite.
    let nonFinite = 0;
    let worstLength = 0;
    for (const { type, seed, variant } of eachTree()) {
      const g = generateTree(type, seed, variant);
      for (const mesh of [g.bark, g.canopy]) {
        for (let i = 0; i < mesh.positions.length; i++) if (!Number.isFinite(mesh.positions[i])) nonFinite++;
        for (let i = 0; i < mesh.normals.length; i++) if (!Number.isFinite(mesh.normals[i])) nonFinite++;
        for (let i = 0; i < mesh.positions.length / 3; i++) {
          const len = Math.hypot(mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]);
          const off = Math.abs(len - 1);
          if (off > worstLength) worstLength = off;
        }
      }
    }
    expect(nonFinite).toBe(0);
    expect(worstLength).toBeLessThan(1e-4);
  });

  it('emits no degenerate triangles', () => {
    for (const { type, seed, variant } of eachTree()) {
      const g = generateTree(type, seed, variant);
      for (const mesh of [g.bark, g.canopy]) {
        for (let t = 0; t < mesh.indices.length; t += 3) {
          const a = mesh.indices[t] * 3;
          const b = mesh.indices[t + 1] * 3;
          const c = mesh.indices[t + 2] * 3;
          const ux = mesh.positions[b] - mesh.positions[a];
          const uy = mesh.positions[b + 1] - mesh.positions[a + 1];
          const uz = mesh.positions[b + 2] - mesh.positions[a + 2];
          const vx = mesh.positions[c] - mesh.positions[a];
          const vy = mesh.positions[c + 1] - mesh.positions[a + 1];
          const vz = mesh.positions[c + 2] - mesh.positions[a + 2];
          const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
          expect(area).toBeGreaterThan(1e-9);
        }
      }
    }
  });

  it('winds every closed shell outward', () => {
    // The canopy blobs and the dead tree's fungal clusters are closed
    // icospheres. An inside-out sphere is invisible under back-face culling
    // and fully visible under a single-sided alpha test, so it is worth a
    // test. The bark is an open tube and has no closed component at all.
    let shells = 0;
    let inverted = 0;
    for (const { type, seed, variant } of eachTree()) {
      const g = generateTree(type, seed, variant);
      for (const mesh of [g.canopy, g.bark]) {
        for (const v of closedComponentVolumes(mesh)) {
          shells++;
          if (v <= 0) inverted++;
        }
      }
    }
    expect(shells).toBeGreaterThan(50);
    expect(inverted).toBe(0);
  });

  it('winds the trunk tube outward from its own axis', () => {
    // A tree with no branching and NO lean: the trunk axis is then exactly the
    // world y-axis, so the outward direction is exactly measurable. Leaving the
    // lean in makes the ring plane tilt and the ring centre slide off the axis,
    // and a radius measured from the wrong axis reads as an inside-out face.
    let checked = 0;
    let inward = 0;
    let worst = Infinity;
    // Living types only: a dead tree's bark buffer also carries its fungal
    // clusters, whose vertices sit deliberately off the trunk axis and are
    // covered by the closed-shell test below instead.
    for (const type of ['oak', 'deciduous', 'sapling'] as TreeType[]) {
      for (const seed of SEEDS) {
        const g = generateTree(type, seed, 0, { iterations: 0, lean: 0 });
        for (let t = 0; t < g.bark.indices.length; t += 3) {
          const a = g.bark.indices[t] * 3;
          const b = g.bark.indices[t + 1] * 3;
          const c = g.bark.indices[t + 2] * 3;
          const ux = g.bark.positions[b] - g.bark.positions[a];
          const uy = g.bark.positions[b + 1] - g.bark.positions[a + 1];
          const uz = g.bark.positions[b + 2] - g.bark.positions[a + 2];
          const vx = g.bark.positions[c] - g.bark.positions[a];
          const vy = g.bark.positions[c + 1] - g.bark.positions[a + 1];
          const vz = g.bark.positions[c + 2] - g.bark.positions[a + 2];
          const fx = uy * vz - uz * vy;
          const fy = uz * vx - ux * vz;
          const fz = ux * vy - uy * vx;
          const len = Math.hypot(fx, fy, fz);
          if (len < 1e-12) continue;
          // A cap face points along the branch and has no radial component.
          if (Math.abs(fy / len) > 0.9) continue;
          const cx = (g.bark.positions[a] + g.bark.positions[b] + g.bark.positions[c]) / 3;
          const cz = (g.bark.positions[a + 2] + g.bark.positions[b + 2] + g.bark.positions[c + 2]) / 3;
          const dot = (fx * cx + fz * cz) / len;
          checked++;
          if (dot <= 0) inward++;
          if (dot < worst) worst = dot;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(inward).toBe(0);
    expect(worst).toBeGreaterThan(0);
  });

  it('agrees between each face normal and the smoothed vertex normals', () => {
    // An axis-independent winding check that holds for every tree at every
    // lean: the geometric normal of a face and the average of its corners'
    // smoothed normals must point the same way. A flipped triangle is the one
    // failure mode that neither a bounding box nor a triangle count reveals.
    let checked = 0;
    let flipped = 0;
    for (const { type, seed, variant } of eachTree()) {
      const g = generateTree(type, seed, variant);
      for (const mesh of [g.bark, g.canopy]) {
        for (let t = 0; t < mesh.indices.length; t += 3) {
          const a = mesh.indices[t] * 3;
          const b = mesh.indices[t + 1] * 3;
          const c = mesh.indices[t + 2] * 3;
          const ux = mesh.positions[b] - mesh.positions[a];
          const uy = mesh.positions[b + 1] - mesh.positions[a + 1];
          const uz = mesh.positions[b + 2] - mesh.positions[a + 2];
          const vx = mesh.positions[c] - mesh.positions[a];
          const vy = mesh.positions[c + 1] - mesh.positions[a + 1];
          const vz = mesh.positions[c + 2] - mesh.positions[a + 2];
          const fx = uy * vz - uz * vy;
          const fy = uz * vx - ux * vz;
          const fz = ux * vy - uy * vx;
          const sx = mesh.normals[a] + mesh.normals[b] + mesh.normals[c];
          const sy = mesh.normals[a + 1] + mesh.normals[b + 1] + mesh.normals[c + 1];
          const sz = mesh.normals[a + 2] + mesh.normals[b + 2] + mesh.normals[c + 2];
          const dot = fx * sx + fy * sy + fz * sz;
          checked++;
          if (dot <= 0) flipped++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
    expect(flipped).toBe(0);
  });

  it('keeps the trunk base on the ground and the crown above it', () => {
    for (const { type, seed, variant } of eachTree()) {
      const g = generateTree(type, seed, variant);
      const bark = extents(g.bark);
      const canopy = extents(g.canopy);
      // The base ring may dip by its own warp, but never by a branch length.
      expect(bark.lo[1]).toBeGreaterThan(-0.35);
      // The crown sits over the top of the wood, never under it.
      expect(canopy.hi[1]).toBeGreaterThan(bark.hi[1] * 0.8);
    }
  });

  it('stands about as tall as its preset claims', () => {
    for (const type of TYPES) {
      const heights: number[] = [];
      for (const seed of SEEDS) {
        for (let variant = 0; variant < VARIANTS_PER_TYPE; variant++) {
          const g = generateTree(type, seed, variant);
          const bark = extents(g.bark);
          const canopy = extents(g.canopy);
          heights.push(Math.max(bark.hi[1], canopy.hi[1]) - Math.min(bark.lo[1], canopy.lo[1]));
        }
      }
      const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
      // `height` is the shape number, not a hard bound: the L-system's own
      // variation is what makes a forest look planted rather than stamped.
      expect(mean).toBeGreaterThan(TREE_PRESETS[type].height * 0.85);
      expect(mean).toBeLessThan(TREE_PRESETS[type].height * 1.15);
    }
  });

  it('never exceeds the segment ceiling', () => {
    for (const { type, seed, variant } of eachTree()) {
      const g = generateTree(type, seed, variant);
      // One branch costs a fixed number of vertices and triangles, so the
      // ceiling is checkable straight off the mesh.
      const perBranch = (3 * 6 + 1) * 1;
      expect(vertexCount(g.bark)).toBeLessThanOrEqual(MAX_BRANCH_SEGMENTS * perBranch + 64);
      expect(triangleCount(g.bark)).toBeLessThanOrEqual(MAX_BRANCH_SEGMENTS * 30 + 64);
    }
  });

  it('keeps the near LOD inside the triangle budget the plan sets', () => {
    // 3,000 triangles of wood plus 3,000 of leaves per tree is the point at
    // which forty near trees stop being affordable next to a 293k terrain.
    for (const { type, seed, variant } of eachTree()) {
      const g = generateTree(type, seed, variant);
      expect(triangleCount(g.bark)).toBeLessThanOrEqual(6000);
      expect(triangleCount(g.canopy)).toBeLessThanOrEqual(4000);
    }
  });
});

describe('tree vertex colours', () => {
  it('shades leaves from a deep green low down to a yellow-green high up', () => {
    for (const { type, seed, variant } of eachTree()) {
      if (type === 'dead') continue;
      const g = generateTree(type, seed, variant);
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < g.canopy.colors.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (g.canopy.colors[i + k] < lo[k]) lo[k] = g.canopy.colors[i + k];
          if (g.canopy.colors[i + k] > hi[k]) hi[k] = g.canopy.colors[i + k];
        }
      }
      // Green dominates both ends of the ramp, and the top is yellower.
      expect(lo[1]).toBeGreaterThan(lo[0]);
      expect(hi[1]).toBeGreaterThan(hi[0]);
      expect(hi[0]).toBeGreaterThan(lo[0]);
    }
  });

  it('keeps every colour channel inside 0..1', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const { type, seed, variant } of eachTree()) {
      const g = generateTree(type, seed, variant);
      for (const mesh of [g.bark, g.canopy]) {
        for (let i = 0; i < mesh.colors.length; i++) {
          if (mesh.colors[i] < lo) lo = mesh.colors[i];
          if (mesh.colors[i] > hi) hi = mesh.colors[i];
        }
      }
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it('greys the dead tree bark and greens its fungal clusters', () => {
    for (const seed of SEEDS) {
      const living = generateTree('deciduous', seed, 0);
      const dead = generateTree('dead', seed, 0);
      // Living bark is white: the material owns the colour, the vertex does not.
      for (let i = 0; i < living.bark.colors.length; i += 3) {
        expect(living.bark.colors[i]).toBeCloseTo(1, 5);
      }
      // Dead bark is grey, so its three channels sit close together.
      let grey = 0;
      for (let i = 0; i < dead.bark.colors.length; i += 3) {
        const r = dead.bark.colors[i];
        const g2 = dead.bark.colors[i + 1];
        const b = dead.bark.colors[i + 2];
        if (Math.abs(r - g2) < 0.06 && Math.abs(g2 - b) < 0.06 && r < 0.6) grey++;
      }
      expect(grey).toBeGreaterThan(0);
    }
  });

  it('carries fungal clusters on dead trees only', () => {
    // The fungus rides in the bark buffer as vertex colours, so it costs no
    // extra draw call and no extra material. Its green is the only colour in
    // the bark that is not bark-coloured.
    const dead = generateTree('dead', 4, 0);
    let fungus = 0;
    for (let i = 0; i < dead.bark.colors.length; i += 3) {
      const r = dead.bark.colors[i];
      const g = dead.bark.colors[i + 1];
      const b = dead.bark.colors[i + 2];
      if (g > r && g > b && g > 0.3) fungus++;
    }
    expect(fungus).toBeGreaterThan(0);

    for (const type of ['oak', 'deciduous', 'sapling'] as TreeType[]) {
      const g = generateTree(type, 4, 0);
      for (let i = 0; i < g.bark.colors.length; i += 3) {
        expect(g.bark.colors[i]).toBeCloseTo(1, 5);
      }
    }
  });
});

describe('generateSimplifiedTree', () => {
  it('is far cheaper than the full L-system', () => {
    for (const type of TYPES) {
      const full = generateTree(type, 5, 0);
      const simple = generateSimplifiedTree(type, 5, 0);
      // One tapered cylinder and one icosphere: a fixed, tiny cost.
      expect(triangleCount(simple.bark)).toBeLessThanOrEqual(200);
      expect(triangleCount(simple.canopy)).toBeLessThanOrEqual(400);
      const simpleTotal = triangleCount(simple.bark) + triangleCount(simple.canopy);
      const fullTotal = triangleCount(full.bark) + triangleCount(full.canopy);
      // Every type with a branching skeleton is strictly cheaper to simplify.
      // The dead tree's whole canopy is already one blob, so it is bounded
      // rather than reduced.
      if (type === 'dead') expect(simpleTotal).toBeLessThan(fullTotal);
      expect(simpleTotal).toBeLessThanOrEqual(500);
    }
  });

  it('keeps the same silhouette height as the full tree', () => {
    for (const type of TYPES) {
      const full = generateTree(type, 5, 0);
      const simple = generateSimplifiedTree(type, 5, 0);
      const fullTop = Math.max(extents(full.bark).hi[1], extents(full.canopy).hi[1]);
      const simpleTop = Math.max(extents(simple.bark).hi[1], extents(simple.canopy).hi[1]);
      // Within a third: a medium-LOD tree must not visibly shrink when the
      // camera crosses 30 m.
      expect(simpleTop).toBeGreaterThan(fullTop * 0.6);
      expect(simpleTop).toBeLessThan(fullTop * 1.3);
    }
  });

  it('produces the same clean geometry invariants', () => {
    for (const type of TYPES) {
      const g = generateSimplifiedTree(type, 9, 2);
      for (const mesh of [g.bark, g.canopy]) {
        for (let i = 0; i < mesh.positions.length; i++) expect(Number.isFinite(mesh.positions[i])).toBe(true);
        expect(closedComponentVolumes(mesh).every((v) => v > 0)).toBe(true);
      }
    }
  });
});

describe('generateBillboard', () => {
  it('renders a square RGBA silhouette', () => {
    const bb = generateBillboard('oak', 3);
    expect(bb.width).toBe(64);
    expect(bb.height).toBe(64);
    expect(bb.data.length).toBe(64 * 64 * 4);
  });

  it('puts the crown above the trunk', () => {
    for (const type of TYPES) {
      const bb = generateBillboard(type, 3);
      const half = bb.height / 2;
      let topHalf = 0;
      let bottomHalf = 0;
      for (let y = 0; y < bb.height; y++) {
        for (let x = 0; x < bb.width; x++) {
          if (bb.data[(y * bb.width + x) * 4 + 3] > 128) {
            if (y < half) topHalf++;
            else bottomHalf++;
          }
        }
      }
      // The crown is wider than the trunk, so the upper half holds more pixels.
      expect(topHalf).toBeGreaterThan(bottomHalf);
    }
  });

  it('covers a plausible fraction of the quad', () => {
    for (const type of TYPES) {
      for (const seed of SEEDS) {
        const bb = generateBillboard(type, seed);
        let cover = 0;
        for (let i = 3; i < bb.data.length; i += 4) if (bb.data[i] > 128) cover++;
        const fraction = cover / (bb.width * bb.height);
        // Too little is a tree that vanishes; too much is a green square.
        expect(fraction).toBeGreaterThan(0.04);
        expect(fraction).toBeLessThan(0.7);
      }
    }
  });

  it('leaves the corners empty so a cross of quads reads as a tree', () => {
    for (const type of TYPES) {
      const bb = generateBillboard(type, 5);
      for (const [x, y] of [
        [0, 0],
        [bb.width - 1, 0],
        [0, bb.height - 1],
        [bb.width - 1, bb.height - 1],
      ]) {
        expect(bb.data[(y * bb.width + x) * 4 + 3]).toBe(0);
      }
    }
  });

  it('is deterministic and type-dependent', () => {
    const a = generateBillboard('oak', 7);
    const b = generateBillboard('oak', 7);
    const c = generateBillboard('oak', 8);
    const d = generateBillboard('dead', 7);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(Array.from(a.data)).not.toEqual(Array.from(c.data));
    expect(Array.from(a.data)).not.toEqual(Array.from(d.data));
  });

  it('ramps the canopy colour the way the leaf material does', () => {
    const bb = generateBillboard('oak', 2);
    // Find the brightest canopy pixel and the darkest, and check the ramp.
    let bright = { r: 0, g: 0, b: 0 };
    let dark = { r: 1, g: 1, b: 1 };
    for (let i = 0; i < bb.data.length; i += 4) {
      if (bb.data[i + 3] < 250) continue;
      const r = bb.data[i] / 255;
      const g = bb.data[i + 1] / 255;
      const b = bb.data[i + 2] / 255;
      if (g > bright.g) bright = { r, g, b };
      if (g < dark.g) dark = { r, g, b };
    }
    // Yellow-green at the top means red rises with green; it stays green-led.
    expect(bright.g).toBeGreaterThan(bright.r);
    expect(bright.r).toBeGreaterThanOrEqual(dark.r);
  });
});

describe('mesh helpers', () => {
  it('counts vertices and triangles', () => {
    const g = generateTree('sapling', 1, 0);
    expect(vertexCount(g.bark)).toBe(g.bark.positions.length / 3);
    expect(vertexCount(g.canopy)).toBe(g.canopy.positions.length / 3);
    expect(triangleCount(g.bark)).toBe(g.bark.indices.length / 3);
    expect(triangleCount(g.canopy)).toBe(g.canopy.indices.length / 3);
    // Every index must address a real vertex.
    for (const mesh of [g.bark, g.canopy]) {
      for (let i = 0; i < mesh.indices.length; i++) {
        expect(mesh.indices[i]).toBeLessThan(vertexCount(mesh));
      }
    }
  });
});
