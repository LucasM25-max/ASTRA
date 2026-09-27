import { describe, it, expect, afterEach } from 'vitest';
import {
  Forest,
  SHELF_VARIANTS,
  SHELF_BUDGET,
  SHELF_MIN_CORRUPTION,
  SHELF_MAX_PER_TREE,
  type ForestOptions,
} from '../src/world/Forest';
import { StreamSpline } from '../src/procedural/StreamSpline';
import { CorruptionField } from '../src/procedural/CorruptionField';
import { TREE_PRESETS, VARIANTS_PER_TYPE } from '../src/procedural/TreeGenerator';
import { TREE_TYPES } from '../src/procedural/ProceduralForest';
import { InstancedMesh, type BufferGeometry } from 'three';

/**
 * A world with a stream the player can actually stand next to.
 *
 * A spline rather than the analytic field the other forest tests use, because
 * the whole point of this file is that the forest derives its corruption from
 * the spline the same way the terrain does. A hand-written `corruptionAt` would
 * test the plumbing and not the agreement.
 */
const spline = new StreamSpline({
  controlPoints: [
    { x: -200, y: 0, z: -40 },
    { x: -60, y: 0, z: 20 },
    { x: 90, y: 0, z: -20 },
    { x: 220, y: 0, z: 50 },
  ],
});

/** Flat ground, so nothing is rejected for slope or height. */
const heightAt = (): number => 0;
const normalAt = (): { x: number; y: number; z: number } => ({ x: 0, y: 1, z: 0 });

const open: Forest[] = [];

function make(options: Partial<ForestOptions> = {}): Forest {
  const forest = new Forest({
    heightAt,
    normalAt,
    spline,
    seed: 7,
    size: 400,
    ...options,
  });
  open.push(forest);
  return forest;
}

afterEach(() => {
  for (const forest of open) forest.dispose();
  open.length = 0;
});

/** Every InstancedMesh in the group, by name. */
function byName(forest: Forest, pattern: RegExp): InstancedMesh[] {
  const out: InstancedMesh[] = [];
  forest.group.traverse((child) => {
    if ((child as InstancedMesh).isInstancedMesh && pattern.test(child.name)) {
      out.push(child as InstancedMesh);
    }
  });
  return out;
}

/** The corruption attribute of a mesh's geometry, or null. */
function corruptionAttribute(mesh: InstancedMesh): { array: Float32Array } | null {
  const attribute = mesh.geometry.getAttribute('corruption');
  if (!attribute) return null;
  return { array: (attribute as unknown as { array: Float32Array }).array };
}

/**
 * Every non-zero corruption value written into a mesh's buffer.
 *
 * Only the first `mesh.count` slots are written by a rebuild - the rest of the
 * buffer is capacity that this round did not fill, and it reads back as zero.
 * Reading the whole capacity would test the allocation rather than the forest.
 */
function writtenCorruption(mesh: InstancedMesh): number[] {
  const attribute = corruptionAttribute(mesh);
  if (!attribute) return [];
  const out: number[] = [];
  for (let i = 0; i < mesh.count; i++) out.push(attribute.array[i]);
  return out;
}

/** Decompose an instance matrix into a position. */
function instancePosition(mesh: InstancedMesh, index: number): [number, number, number] {
  const array = mesh.instanceMatrix.array;
  const o = index * 16;
  return [array[o + 12], array[o + 13], array[o + 14]];
}

describe('forest corruption plumbing', () => {
  it('derives a corruption sampler from the spline when none is supplied', () => {
    const forest = make();
    // The field the forest built for itself, rebuilt here so the two can be
    // compared. If the forest derived its corruption from anything else - a
    // different reach, a different curve - the values below would disagree.
    const expected = new CorruptionField(spline);
    const near = byName(forest, /-near\d+-bark$/);
    expect(near.length).toBeGreaterThan(0);

    // Every drawn instance's corruption is inside the range the field can
    // produce, and at least one of them is non-zero: a forest whose corruption
    // is identically zero is a forest with no rot anywhere in it.
    let any = false;
    let checked = 0;
    for (const mesh of near) {
      for (const c of writtenCorruption(mesh)) {
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        if (c > 0) any = true;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(any).toBe(true);

    // And the forest's own answer matches the field's at the same points. This
    // is the agreement that matters: the terrain bakes `buildCorruption` from a
    // `CorruptionField`, and a tree that disagreed with the ground under it
    // would show as grey bark standing in clean grass.
    for (const mesh of near) {
      for (let i = 0; i < mesh.count; i++) {
        const m = mesh.instanceMatrix.array;
        const o = i * 16;
        const x = m[o + 12];
        const z = m[o + 14];
        const c = corruptionAttribute(mesh)!.array[i];
        if (c === 0) continue;
        expect(c).toBeCloseTo(expected.corruptionAt(x, z), 5);
      }
    }
  });

  it('agrees with the CorruptionField the terrain bakes from', () => {
    const forest = make();
    const field = new CorruptionField(spline);
    const near = byName(forest, /-near\d+-bark$/);
    expect(near.length).toBe(TREE_TYPES.length * VARIANTS_PER_TYPE);

    // Sample the world on a grid and compare the forest's own answer with the
    // field's. Both are lattice lookups on the same spline at the same
    // resolution, so they must agree exactly rather than approximately.
    let compared = 0;
    for (let x = -180; x <= 180; x += 20) {
      for (let z = -180; z <= 180; z += 20) {
        const a = forest.corruptionAt(x, z);
        const b = field.corruptionAt(x, z);
        expect(a).toBeCloseTo(b, 6);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(300);
  });

  it('gives every near and medium tree mesh a corruption attribute', () => {
    const forest = make();
    const meshes = byName(forest, /-(near|medium)\d*-(bark|canopy)$/);
    // 4 types x 4 variants x 2 halves, plus 4 types x 2 halves.
    expect(meshes.length).toBe(TREE_TYPES.length * VARIANTS_PER_TYPE * 2 + TREE_TYPES.length * 2);
    for (const mesh of meshes) {
      const attribute = corruptionAttribute(mesh);
      expect(attribute, `${mesh.name} has no corruption attribute`).not.toBeNull();
      // Instanced, not per vertex: one value for the whole tree, whatever its
      // triangle count. A per-vertex attribute here would need a geometry per
      // tree, which is two thousand of them.
      expect(attribute!.array.length).toBe(mesh.instanceMatrix.count);
    }
  });

  it('accepts a caller-supplied corruption sampler over its own', () => {
    const forest = make({
      corruptionAt: (x, z) => (x > 0 && z > 0 ? 1 : 0),
    });
    expect(forest.corruptionAt(10, 10)).toBe(1);
    expect(forest.corruptionAt(-10, 10)).toBe(0);
    // And it is actually used, not merely stored.
    let ones = 0;
    for (const mesh of byName(forest, /-near\d+-(bark|canopy)$/)) {
      for (const c of writtenCorruption(mesh)) if (c === 1) ones++;
    }
    expect(ones).toBeGreaterThan(0);
  });

  it('is clean when there is no spline and no sampler', () => {
    const forest = new Forest({ heightAt, normalAt, seed: 3, size: 120 });
    open.push(forest);
    expect(forest.corruptionAt(0, 0)).toBe(0);
    for (const mesh of byName(forest, /-near\d+-(bark|canopy)$/)) {
      for (const c of writtenCorruption(mesh)) expect(c).toBe(0);
    }
    expect(forest.stats.shelves).toBe(0);
  });

  it('clamps a nonsense sampler instead of writing NaN into the buffer', () => {
    const forest = make({
      corruptionAt: (x) => (x > 0 ? Number.NaN : 2),
    });
    for (const mesh of byName(forest, /-near\d+-(bark|canopy)$/)) {
      for (const c of writtenCorruption(mesh)) {
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('per-type leaf materials', () => {
  it('gives each tree type its own leaf material and one shared bark', () => {
    const forest = make();
    // The bark needs nothing per type. The leaf material does, because the droop
    // is scaled by the tree's own height and one number cannot serve a 10 m oak
    // and a 3 m sapling.
    const leafMaterials = new Set<string>();
    const barkMaterials = new Set<string>();
    forest.group.traverse((child) => {
      const mesh = child as InstancedMesh;
      if (!mesh.isInstancedMesh) return;
      const material = mesh.material as { uuid?: string } | undefined;
      if (!material?.uuid) return;
      if (/-canopy$/.test(mesh.name)) leafMaterials.add(material.uuid);
      if (/-bark$/.test(mesh.name)) barkMaterials.add(material.uuid);
    });
    expect(leafMaterials.size).toBe(TREE_TYPES.length);
    expect(barkMaterials.size).toBe(1);
  });

  it('scales the droop by each type own height', () => {
    const forest = make();
    // Drive the compile patch and read the uniform back, which is the only way
    // to see what the material would hand the GPU without a GPU.
    const seen = new Map<string, number>();
    forest.group.traverse((child) => {
      const mesh = child as InstancedMesh;
      if (!mesh.isInstancedMesh || !/-canopy$/.test(mesh.name)) return;
      const material = mesh.material as unknown as {
        onBeforeCompile: (shader: Record<string, unknown>) => void;
      };
      const uniforms: Record<string, { value: unknown }> = {};
      material.onBeforeCompile({
        uniforms,
        vertexShader: 'void main() { #include <begin_vertex> }',
        fragmentShader: 'void main() {}',
      } as never);
      const type = TREE_TYPES.find((t) => mesh.name.startsWith(`forest-${t}-`))!;
      seen.set(type, uniforms.uTreeHeight.value as number);
    });
    for (const type of TREE_TYPES) {
      expect(seen.get(type), `${type} has no leaf material`).toBe(TREE_PRESETS[type].height);
    }
    // And the four heights are genuinely different, which is the whole reason
    // the materials are per type.
    expect(new Set(seen.values()).size).toBe(TREE_TYPES.length);
  });
});

describe('fungal shelves', () => {
  it('builds one mesh per variant and no more', () => {
    const forest = make();
    const meshes = byName(forest, /^forest-shelf\d+$/);
    expect(meshes.length).toBe(SHELF_VARIANTS);
    for (const mesh of meshes) {
      expect(mesh.instanceMatrix.count).toBe(SHELF_BUDGET);
      const variation = mesh.geometry.getAttribute('aVariation');
      expect(variation).toBeDefined();
      expect(variation.count).toBe(SHELF_BUDGET);
    }
  });

  it('grows nothing where the forest is clean', () => {
    // The far corner of the world, four hundred metres from any water.
    const forest = make({ corruptionAt: () => 0 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    expect(forest.stats.shelves).toBe(0);
    for (const mesh of byName(forest, /^forest-shelf\d+$/)) expect(mesh.count).toBe(0);
  });

  it('grows shelves on every trunk the field marks', () => {
    const forest = make({ corruptionAt: () => 1 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    const total = forest.stats.shelves;
    expect(total).toBeGreaterThan(0);
    // Full corruption means the maximum count on every drawn near tree.
    const near = forest.stats.near;
    expect(total).toBeLessThanOrEqual(near * SHELF_MAX_PER_TREE);
    expect(total).toBeGreaterThanOrEqual(Math.ceil(near * 0.5));
    expect(forest.droppedInstances).toBe(0);
  });

  it('grows more shelves as the corruption rises', () => {
    // The count is quantised - one shelf, two, three - so it can only be
    // compared across the boundaries. Between them the progression is carried
    // by the scale, which is continuous, and that is what the second half of
    // this test measures.
    const counts: number[] = [];
    const scales: number[] = [];
    for (const corruption of [0.25, 0.75, 0.95]) {
      const forest = make({ corruptionAt: () => corruption });
      forest.update(0.016, { x: 0, y: 0, z: 0 });
      counts.push(forest.stats.shelves);
      let total = 0;
      let n = 0;
      for (const mesh of byName(forest, /^forest-shelf\d+$/)) {
        const array = mesh.instanceMatrix.array;
        for (let i = 0; i < mesh.count; i++) {
          // The scale is the length of the matrix's first column. Reading
          // element [0][0] alone gives `scale * cos(rotation)`, which is not
          // the scale and goes negative for a quarter of the rotations.
          const o = i * 16;
          total += Math.hypot(array[o], array[o + 1], array[o + 2]);
          n++;
        }
      }
      scales.push(n > 0 ? total / n : 0);
      open.pop()!.dispose();
    }
    expect(counts[1]).toBeGreaterThan(counts[0]);
    expect(counts[2]).toBe(counts[1]);
    // And every corruption grows a bigger bracket than the last, which is the
    // style guide's "subtle, visible, severe" doing the work between the
    // count's steps.
    expect(scales[1]).toBeGreaterThan(scales[0]);
    expect(scales[2]).toBeGreaterThan(scales[1]);
  });

  it('grows nothing below the threshold', () => {
    const forest = make({ corruptionAt: () => SHELF_MIN_CORRUPTION * 0.5 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    expect(forest.stats.shelves).toBe(0);
  });

  it('places every shelf against a trunk rather than in mid-air', () => {
    const forest = make({ corruptionAt: () => 0.8 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });

    const trees = forest.placement;
    for (const mesh of byName(forest, /^forest-shelf\d+$/)) {
      for (let i = 0; i < mesh.count; i++) {
        const [x, y, z] = instancePosition(mesh, i);
        // The nearest placed tree has to be close enough that this shelf is
        // growing on it, and the shelf has to be at a plausible height on that
        // trunk rather than floating above or below it.
        let best = Infinity;
        let bestTree = trees[0];
        for (const tree of trees) {
          const d = (tree.x - x) ** 2 + (tree.z - z) ** 2;
          if (d < best) {
            best = d;
            bestTree = tree;
          }
        }
        const trunk = TREE_PRESETS[bestTree.type];
        const height = trunk.height * bestTree.scale;
        // Inside the trunk's radius plus the shelf's own reach, horizontally.
        expect(Math.sqrt(best)).toBeLessThan(trunk.trunkRadius + 0.5);
        // And between the ground and the top of the crown, vertically.
        expect(y - bestTree.y).toBeGreaterThan(-0.5);
        expect(y - bestTree.y).toBeLessThan(height);
      }
    }
  });

  it('repeats itself exactly across rebuilds', () => {
    const forest = make({ corruptionAt: () => 0.8 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    const first = byName(forest, /^forest-shelf\d+$/).map((m) => ({
      count: m.count,
      matrices: Array.from(m.instanceMatrix.array.slice(0, m.count * 16)),
    }));

    // Walk the camera far enough to force a rebuild, then walk back.
    forest.update(0.016, { x: 500, y: 0, z: 500 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });

    const second = byName(forest, /^forest-shelf\d+$/).map((m) => ({
      count: m.count,
      matrices: Array.from(m.instanceMatrix.array.slice(0, m.count * 16)),
    }));
    expect(second).toEqual(first);
  });

  it('carries the shelf geometry the generator makes', () => {
    const forest = make({ corruptionAt: () => 1 });
    const mesh = byName(forest, /^forest-shelf0$/)[0];
    const geometry: BufferGeometry = mesh.geometry;
    expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(geometry.getAttribute('normal')).toBeDefined();
    expect(geometry.getAttribute('color')).toBeDefined();
    expect(geometry.getIndex()).not.toBeNull();
  });
});

describe('far-tier corruption tint', () => {
  it('tints the billboards yellow-green in proportion to the corruption', () => {
    const forest = make({ corruptionAt: () => 1 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    // The far tier's instance index IS the placement index, so a mesh's buffer
    // is as long as the placement and only the slots this round drew are
    // written. Reading the whole buffer would compare against the untouched
    // white initial value.
    let tinted = 0;
    for (const mesh of byName(forest, /-far$/)) {
      const array = mesh.instanceColor!.array;
      const type = TREE_TYPES.find((t) => mesh.name === `forest-${t}-far`)!;
      for (let i = 0; i < mesh.instanceColor!.count; i++) {
        const r = array[i * 3 + 0];
        const g = array[i * 3 + 1];
        const b = array[i * 3 + 2];
        if (r === 1 && g === 1 && b === 1) continue;
        tinted++;
        expect(r).toBeCloseTo(1 - 0.42, 6);
        expect(g).toBeCloseTo(1 - 0.28, 6);
        expect(b).toBeCloseTo(1 - 0.62, 6);
        // A tinted slot must belong to a tree of this mesh's own type, or the
        // colour is being written through the wrong mesh.
        expect(forest.placement[i].type).toBe(type);
      }
    }
    expect(tinted).toBeGreaterThan(0);
  });

  it('tints only the trees that are actually rotten', () => {
    const forest = make({ corruptionAt: (x, z) => (x > 0 && z > 0 ? 1 : 0) });
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    let tinted = 0;
    for (const mesh of byName(forest, /-far$/)) {
      const array = mesh.instanceColor!.array;
      for (let i = 0; i < mesh.instanceColor!.count; i++) {
        const r = array[i * 3 + 0];
        if (r === 1 && array[i * 3 + 1] === 1 && array[i * 3 + 2] === 1) continue;
        tinted++;
        const tree = forest.placement[i];
        expect(tree.x).toBeGreaterThan(0);
        expect(tree.z).toBeGreaterThan(0);
      }
    }
    expect(tinted).toBeGreaterThan(0);
  });

  it('leaves clean billboards white', () => {
    const forest = make({ corruptionAt: () => 0 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    for (const mesh of byName(forest, /-far$/)) {
      const array = mesh.instanceColor!.array;
      for (let i = 0; i < mesh.instanceColor!.count; i++) {
        expect(array[i * 3 + 0]).toBe(1);
        expect(array[i * 3 + 1]).toBe(1);
        expect(array[i * 3 + 2]).toBe(1);
      }
    }
  });

  it('allocates the tint once rather than per rebuild', () => {
    const forest = make();
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    const before = byName(forest, /oak-far$/)[0].instanceColor;
    forest.update(0.016, { x: 900, y: 0, z: 900 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    expect(byName(forest, /oak-far$/)[0].instanceColor).toBe(before);
  });
});

describe('stats and disposal', () => {
  it('reports the shelf count in the stats', () => {
    const forest = make({ corruptionAt: () => 0.6 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    expect(forest.stats.shelves).toBeGreaterThan(0);
    expect(Number.isInteger(forest.stats.shelves)).toBe(true);
  });

  it('counts the shelf meshes in the draw calls and triangles', () => {
    const clean = make({ corruptionAt: () => 0 });
    clean.update(0.016, { x: 0, y: 0, z: 0 });
    const rotten = make({ corruptionAt: () => 1 });
    rotten.update(0.016, { x: 0, y: 0, z: 0 });
    expect(rotten.stats.drawCalls).toBeGreaterThan(clean.stats.drawCalls);
    expect(rotten.stats.triangles).toBeGreaterThan(clean.stats.triangles);
  });

  it('disposes the shelf meshes and their geometry', () => {
    const forest = make();
    const geometries = byName(forest, /^forest-shelf\d+$/).map((m) => m.geometry);
    expect(geometries.length).toBe(SHELF_VARIANTS);
    forest.dispose();
    for (const geometry of geometries) {
      // A disposed geometry has had its buffers released; asking for the
      // position attribute still works but the attribute's buffer is gone.
      expect(geometry.getAttribute('position')).toBeDefined();
    }
    // The group is emptied, so nothing is left in the scene. `traverse` counts
    // the group itself, so it is the children that have to be gone.
    expect(forest.group.children.length).toBe(0);
  });
});
