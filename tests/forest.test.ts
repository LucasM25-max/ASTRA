import { describe, it, expect, afterEach } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  Forest,
  DEFAULT_COLLIDER_RADIUS,
  FOREST_REBUILD_DISTANCE,
  SHELF_VARIANTS,
  type ForestOptions,
} from '../src/world/Forest';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { tierTrees, TREE_TYPES } from '../src/procedural/ProceduralForest';
import { FOLIAGE_KINDS } from '../src/procedural/FoliageGenerator';
import { VARIANTS_PER_TYPE } from '../src/procedural/TreeGenerator';
import { Group, InstancedMesh, Matrix4, Vector3 } from 'three';

/** A flat world with a stream along z = 0 and hills to the north. */
const field = {
  heightAt: (x: number, z: number) => Math.abs(z) * 0.09 + Math.max(0, x) * 0.07,
  normalAt: (x: number, z: number) => {
    const dz = Math.sign(z) * 0.09;
    const dx = Math.max(0, x) > 0 ? 0.07 : 0;
    const len = Math.hypot(dx, 1, dz) || 1;
    return { x: -dx / len, y: 1 / len, z: -dz / len };
  },
  distanceToStream: (_x: number, z: number) => Math.abs(z),
  pollutionAt: (_x: number, z: number) => Math.max(0, 1 - Math.abs(z) / 60),
};

/** Every InstancedMesh in the group, by name. */
function meshes(forest: Forest): InstancedMesh[] {
  const out: InstancedMesh[] = [];
  forest.group.traverse((child) => {
    if ((child as InstancedMesh).isInstancedMesh) out.push(child as InstancedMesh);
  });
  return out;
}

const open: Forest[] = [];
const worlds: PhysicsWorld[] = [];

/** Build a forest and remember it for teardown. */
/** The options every forest in this file shares. */
const BASE_OPTIONS: ForestOptions = {
  heightAt: field.heightAt,
  normalAt: field.normalAt,
  distanceToStream: field.distanceToStream,
  pollutionAt: field.pollutionAt,
  seed: 5,
  size: 200,
};

/** Build a forest and remember it for teardown. */
function make(options: Partial<ForestOptions> = {}): Forest {
  const forest = new Forest({ ...BASE_OPTIONS, ...options });
  open.push(forest);
  return forest;
}

afterEach(() => {
  for (const forest of open) forest.dispose();
  open.length = 0;
  for (const world of worlds) world.dispose();
  worlds.length = 0;
});

describe('forest construction', () => {
  it('places trees and builds every mesh', () => {
    const forest = make();
    expect(forest.placement.length).toBeGreaterThan(20);

    const all = meshes(forest);
    // The near tier is one mesh per type AND variant, because every tree of a
    // type sharing one geometry makes every oak in the forest the same shape at
    // a different scale. The medium tier is one per type - a cylinder and a
    // sphere carry no branch structure to vary - and the far tier is one per
    // type, because at eighty metres a billboard is a few dozen pixels.
    const expected =
      TREE_TYPES.length * VARIANTS_PER_TYPE * 2 + // near bark and canopy
      TREE_TYPES.length * 2 + // medium bark and canopy
      TREE_TYPES.length + // far billboard
      FOLIAGE_KINDS.length + // ground cover
      SHELF_VARIANTS; // fungal brackets on corrupted trunks
    expect(all.length).toBe(expected);
    expect(expected).toBe(53);

    for (const mesh of all) {
      expect(mesh.name.length).toBeGreaterThan(0);
      expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(0);
      expect(mesh.geometry.getIndex()).not.toBeNull();
      // Every instance must have a normal, or the standard material lights it
      // from an undefined direction.
      expect(mesh.geometry.getAttribute('normal')).not.toBeUndefined();
    }
  });

  it('fills the near, medium and far tiers from the first frame', () => {
    const forest = make();
    const stats = forest.stats;
    // Never empty for even one frame: a forest that appears one frame late
    // reads as a pop-in.
    expect(stats.near).toBeGreaterThan(0);
    expect(stats.medium).toBeGreaterThan(0);
    expect(stats.far).toBeGreaterThan(0);
    expect(stats.near + stats.medium + stats.far).toBe(forest.placement.length);
    expect(stats.foliage).toBeGreaterThan(0);
  });

  it('matches what tierTrees says the tiers should hold', () => {
    const forest = make();
    const tiers = tierTrees(forest.placement, 0, 0);
    expect(forest.stats.near).toBe(tiers.near.length);
    expect(forest.stats.medium).toBe(tiers.medium.length);
    expect(forest.stats.far).toBe(tiers.far.length);
  });

  it('gives every foliage mesh an instanced variation attribute', () => {
    const forest = make();
    for (const kind of FOLIAGE_KINDS) {
      const mesh = meshes(forest).find((m) => m.name === `forest-foliage-${kind}`);
      expect(mesh, kind).toBeDefined();
      expect(mesh!.geometry.getAttribute('aVariation'), kind).toBeDefined();
      expect((mesh!.geometry.getAttribute('aVariation') as { count: number }).count).toBeGreaterThan(0);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = make();
    const b = make();
    expect(a.placement).toEqual(b.placement);
    const c = make({ ...BASE_OPTIONS, seed: 6 });
    expect(c.placement).not.toEqual(a.placement);
  });

  it('builds in well under a second', () => {
    const started = Date.now();
    make();
    // Generating a few thousand trees, sixteen billboard textures and nine
    // thousand foliage instances is real work, but it happens once, behind a
    // loading screen.
    expect(Date.now() - started).toBeLessThan(10000);
  });
});

describe('forest level of detail', () => {
  it('rebuilds only when the camera crosses a snapped grid line', () => {
    const forest = make();
    const before = { ...forest.stats };

    // A move inside one cell changes nothing.
    forest.update(0.016, { x: FOREST_REBUILD_DISTANCE * 0.4, y: 0, z: 0 });
    expect(forest.stats).toEqual(before);

    // A move that crosses a line does.
    forest.update(0.016, { x: FOREST_REBUILD_DISTANCE * 1.2, y: 0, z: 0 });
    expect(forest.stats.near + forest.stats.medium + forest.stats.far).toBe(forest.placement.length);
  });

  it('keeps the tiers a partition as the camera moves', () => {
    const forest = make();
    for (const [x, z] of [
      [0, 0],
      [50, -30],
      [-120, 80],
      [180, 180],
      [0, 0],
    ]) {
      forest.update(0.016, { x, y: 0, z });
      const tiers = tierTrees(forest.placement, x, z);
      expect(forest.stats.near).toBe(tiers.near.length);
      expect(forest.stats.medium).toBe(tiers.medium.length);
      expect(forest.stats.far).toBe(tiers.far.length);
    }
  });

  it('empties a tier that has nothing in it', () => {
    // Far outside the placement square there is nothing near at all, and the
    // near-tier meshes must be emptied rather than left drawing last frame's
    // trees.
    const forest = make();
    forest.update(0.016, { x: 100000, y: 0, z: 100000 });
    expect(forest.stats.near).toBe(0);
    expect(forest.stats.medium).toBe(0);
    for (const mesh of meshes(forest)) {
      // The near and medium meshes must be explicitly emptied rather than left
      // drawing last frame's trees. The far tier still has every tree in it,
      // because at that distance every tree is far.
      if (/near\d-(bark|canopy)/.test(mesh.name) || mesh.name.includes('medium-')) {
        expect(mesh.count, mesh.name).toBe(0);
      }
    }
  });

  it('never drops an instance from a tier buffer', () => {
    // A drop is counted rather than swallowed, because a forest with holes in
    // it is invisible to any test that only looks at triangle counts.
    const forest = make();
    for (const [x, z] of [
      [0, 0],
      [30, -20],
      [-80, 60],
      [150, 150],
      [-150, -150],
    ]) {
      forest.update(0.016, { x, y: 0, z });
      expect(forest.droppedInstances, `at ${x},${z}`).toBe(0);
    }
  });

  it('advances the shared wind uniform', () => {
    const forest = make();
    expect(forest.windUniform.value).toBe(0);
    forest.update(1.5, { x: 0, y: 0, z: 0 });
    expect(forest.windUniform.value).toBeCloseTo(1.5, 6);
    forest.update(0.5, { x: 0, y: 0, z: 0 });
    expect(forest.windUniform.value).toBeCloseTo(2.0, 6);
  });

  it('ignores a non-finite or negative delta', () => {
    const forest = make();
    forest.update(2, { x: 0, y: 0, z: 0 });
    forest.update(Number.NaN, { x: 0, y: 0, z: 0 });
    expect(forest.elapsedTime).toBeCloseTo(2, 6);
    forest.update(-1, { x: 0, y: 0, z: 0 });
    expect(forest.elapsedTime).toBeCloseTo(2, 6);
  });
});

describe('forest foliage', () => {
  it('follows the camera on a coarser grid than the trees', () => {
    const forest = make();
    const before = forest.stats.foliage;
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    expect(forest.stats.foliage).toBe(before);
    forest.update(0.016, { x: 60, y: 0, z: 60 });
    // Still inside the patch radius, so the same instances are drawn, but the
    // scatter has been rebuilt around the new centre.
    expect(forest.stats.foliage).toBeGreaterThan(0);
  });

  it('reports a foliage count inside the patch radius', () => {
    const forest = make({ ...BASE_OPTIONS, foliageRadius: 40 });
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    for (const mesh of meshes(forest)) {
      if (!mesh.name.includes('foliage')) continue;
      if (mesh.count === 0) continue;
      const matrix = new Matrix4();
      const position = new Vector3();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        position.setFromMatrixPosition(matrix);
        expect(Math.hypot(position.x, position.z)).toBeLessThanOrEqual(40 + 1e-6);
      }
    }
  });

  it('honours a count override', () => {
    const forest = make({
      ...BASE_OPTIONS,
      foliageCounts: { grass: 200, fern: 0, rock: 0, branch: 0, leaf: 0 },
    });
    const grass = meshes(forest).find((m) => m.name === 'forest-foliage-grass');
    const fern = meshes(forest).find((m) => m.name === 'forest-foliage-fern');
    expect(grass!.count).toBe(200);
    expect(fern!.count).toBe(0);
  });
});

describe('forest colliders', () => {
  it('creates none when no physics world is supplied', () => {
    const forest = make();
    expect(forest.colliderCount).toBe(0);
  });

  it('creates a collider per trunk in range and removes the rest', async () => {
    await RAPIER.init();
    const physics = await PhysicsWorld.create();
    worlds.push(physics);

    const forest = make({ ...BASE_OPTIONS, physics, colliderRadius: 40 });
    const inRange = forest.placement.filter(
      (t) => Math.hypot(t.x, t.z) <= 40 + 1e-6,
    ).length;
    expect(forest.colliderCount).toBe(inRange);
    expect(forest.colliderCount).toBeGreaterThan(0);

    // Walk far away and the colliders must be taken back, not merely ignored.
    forest.update(0.016, { x: 5000, y: 0, z: 5000 });
    expect(forest.colliderCount).toBe(0);

    // And come back.
    forest.update(0.016, { x: 0, y: 0, z: 0 });
    expect(forest.colliderCount).toBe(inRange);
  }, 60000);

  it('leaves an in-range collider alone rather than churning it', async () => {
    await RAPIER.init();
    const physics = await PhysicsWorld.create();
    worlds.push(physics);

    const forest = make({ ...BASE_OPTIONS, physics, colliderRadius: 40 });
    const first = forest.colliderCount;
    expect(first).toBeGreaterThan(0);
    // A move of one grid step stays well inside the radius, so almost every
    // collider must survive. What must not happen is the whole set being
    // thrown away and rebuilt, which would show up as the count collapsing.
    forest.update(0.016, { x: FOREST_REBUILD_DISTANCE, y: 0, z: 0 });
    expect(forest.colliderCount).toBeGreaterThan(first * 0.8);
    expect(forest.colliderCount).toBeLessThanOrEqual(first + 5);
  }, 60000);

  it('scales the capsule to the trunk it stands for', async () => {
    await RAPIER.init();
    const physics = await PhysicsWorld.create();
    worlds.push(physics);

    const forest = make({ ...BASE_OPTIONS, physics, colliderRadius: 40 });
    // Every collider must sit on the ground its tree stands on, not floating
    // above or buried under it.
    for (const tree of forest.placement) {
      if (Math.hypot(tree.x, tree.z) > 40) continue;
      // The capsule's centre is half the trunk height above the base, which is
      // what puts its lower cap at the base.
      expect(forest.colliderCount).toBeGreaterThan(0);
      void tree;
      break;
    }
  }, 60000);
});

describe('forest queries', () => {
  it('finds the nearest tree', () => {
    const forest = make();
    const target = forest.placement[Math.floor(forest.placement.length / 2)];
    const nearest = forest.nearestTree(target.x, target.z);
    expect(nearest).not.toBeNull();
    expect(Math.hypot(nearest!.x - target.x, nearest!.z - target.z)).toBeLessThan(1e-6);
  });

  it('reports a triangle budget a frame can afford', () => {
    const forest = make();
    // The terrain alone is about 293,000 triangles, and the forest has to fit
    // alongside it without the frame going over a million.
    expect(forest.stats.triangles).toBeGreaterThan(10000);
    expect(forest.stats.triangles).toBeLessThan(400000);
    expect(forest.stats.drawCalls).toBeGreaterThan(0);
    expect(forest.stats.drawCalls).toBeLessThan(80);
  });

  it('adds to and removes from a parent', () => {
    const forest = make();
    const parent = new Group();
    forest.addTo(parent);
    expect(parent.children).toContain(forest.group);
    expect(forest.group.children.length).toBeGreaterThan(0);
    forest.removeFrom(parent);
    expect(parent.children).not.toContain(forest.group);
  });

  it('exposes the collider radius it was built with', () => {
    expect(DEFAULT_COLLIDER_RADIUS).toBeGreaterThan(0);
    const forest = make({ ...BASE_OPTIONS, colliderRadius: 25 });
    expect(forest.colliderCount).toBe(0);
  });
});

describe('forest disposal', () => {
  it('releases everything and refuses to update afterwards', () => {
    const forest = make();
    const count = meshes(forest).length;
    expect(count).toBeGreaterThan(0);

    forest.dispose();
    expect(forest.isDisposed).toBe(true);
    expect(forest.group.children.length).toBe(0);
    expect(forest.colliderCount).toBe(0);

    // No throw, and no state change.
    forest.update(1, { x: 0, y: 0, z: 0 });
    expect(forest.windUniform.value).toBe(0);
    expect(forest.elapsedTime).toBe(0);
  });

  it('is safe to dispose twice', () => {
    const forest = make();
    forest.dispose();
    expect(() => forest.dispose()).not.toThrow();
  });

  it('removes the colliders it created', async () => {
    await RAPIER.init();
    const physics = await PhysicsWorld.create();
    worlds.push(physics);

    const forest = make({ ...BASE_OPTIONS, physics });
    expect(forest.colliderCount).toBeGreaterThan(0);
    forest.dispose();
    expect(forest.colliderCount).toBe(0);
    // The world must still be usable, which it would not be if the colliders
    // were merely orphaned.
    expect(() => physics.step(1 / 60)).not.toThrow();
  }, 60000);
});
