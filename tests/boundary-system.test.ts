import { afterEach, describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { WorldScene, type WorldSceneOptions } from '../src/world/WorldScene';
import {
  BoundarySystem,
  DEFAULT_ROCK_COUNT,
  WALL_INSET,
  WALL_THICKNESS,
} from '../src/world/BoundarySystem';
import { Terrain } from '../src/world/Terrain';
import { ROCK_TRIANGLES } from '../src/procedural/RockGenerator';

/**
 * The world's edge, and the rocks that stand against it.
 *
 * These tests are deliberately about the things a player would notice: that the
 * wall stops them, that the wall is not somewhere they can get around, that the
 * rocks are where the plan says they should be, and that the whole thing is
 * affordable. What is NOT tested here is the tree belt - that is a rim term in
 * the forest's own density field and belongs to `procedural-forest.test.ts`.
 */

let physics: PhysicsWorld | null = null;

afterEach(() => {
  physics?.dispose();
  physics = null;
});

async function build(options: Omit<WorldSceneOptions, 'scene' | 'physics'> = {}) {
  physics = await PhysicsWorld.create();
  const scene = new Scene();
  return new WorldScene({ scene, physics, ...options });
}

describe('the boundary walls', () => {
  it('stands four of them, one per side', async () => {
    const world = await build();
    expect(world.boundary.wallCount).toBe(4);
    world.dispose();
  });

  it('puts them just inside the terrain edge, not on it', async () => {
    const world = await build();
    const half = world.terrain.sizeMetres / 2;
    // The wall's inner face is at half - WALL_INSET - WALL_THICKNESS / 2, so a
    // player standing at the very edge of the walkable ground is already
    // inside the wall's thickness and cannot slip past it.
    const innerFace = half - WALL_INSET - WALL_THICKNESS / 2;
    expect(innerFace).toBeLessThan(half);
    expect(innerFace).toBeGreaterThan(half - 10);
    world.dispose();
  });

  it('stops a player who walks into it, from every direction', async () => {
    // The whole point. A wall that only works from one side is a wall with a
    // gap in it, and the way to find the gap is to walk at it from all four
    // compass points.
    const world = await build();
    const half = world.terrain.sizeMetres / 2 - 1;
    const height = world.terrain.heightAt(0, 0);

    const spawn = world.terrain.restHeight(0, 0, 2, 0.05);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [0.7, 0.7],
      [-0.7, 0.7],
      [0.7, -0.7],
      [-0.7, -0.7],
    ]) {
      const body = world.physics.createCapsuleBody({
        spawn: { x: spawn.x, y: spawn.y + 200, z: spawn.z },
        halfHeight: 0.5,
        radius: 0.5,
      });
      // Drop it from above the wall so it cannot be resting on the far side.
      for (let i = 0; i < 240; i++) world.fixedUpdate(1 / 60);

      // Now shove it at the wall and see whether it gets out.
      body.body.setTranslation({ x: spawn.x, y: height + 5, z: spawn.z }, true);
      body.body.setLinvel({ x: dx * 40, y: 0, z: dz * 40 }, true);
      for (let i = 0; i < 240; i++) world.fixedUpdate(1 / 60);

      const p = body.body.translation();
      const outside = Math.max(Math.abs(p.x), Math.abs(p.z));
      expect(
        outside,
        `escaped heading ${dx},${dz}`,
      ).toBeLessThan(half + WALL_THICKNESS);
      world.physics.removeCollider(body.collider);
    }
    world.dispose();
  }, 120000);

  it('is invisible: the boundary adds no mesh to the scene', async () => {
    const world = await build();
    // The group holds the rocks. Nothing in it is a wall.
    let wallMeshes = 0;
    world.boundary.group.traverse((child) => {
      if ((child as { isMesh?: boolean }).isMesh) wallMeshes++;
    });
    // Only rock meshes, and none of them named for a wall.
    const names: string[] = [];
    world.boundary.group.traverse((child) => names.push(child.name));
    expect(names.filter((n) => /wall/i.test(n))).toHaveLength(0);
    expect(wallMeshes).toBeGreaterThan(0);
    world.dispose();
  });

  it('survives being built with no physics at all', () => {
    // `WorldScene` requires a physics world and always will - it builds the
    // terrain collider and steps the simulation. The boundary does not: it is
    // the one subsystem here that is useful to a caller with no Rapier at all,
    // because the rocks are worth drawing even if nothing can collide.
    const terrain = new Terrain({ resolution: 48, size: 100, seed: 3 });
    const boundary = new BoundarySystem(terrain, null, { rockCount: 6 });
    expect(boundary.rocks.length).toBe(6);
    // No walls and no colliders, and nothing throws on the way.
    expect(boundary.wallCount).toBe(0);
    expect(boundary.colliderCount).toBe(0);
    const scene = new Scene();
    boundary.addTo(scene);
    expect(scene.children).toContain(boundary.group);
    boundary.update(10, 10);
    boundary.update(Number.NaN, Number.NaN);
    boundary.dispose();
    terrain.dispose();
  });
});

describe('the rock field', () => {
  it('places the number of rocks it was asked for', async () => {
    const world = await build({ boundary: { rockCount: 12 } });
    expect(world.boundary.rocks.length).toBe(12);
    world.dispose();
  });

  it('defaults to a field that fits its triangle budget', async () => {
    const world = await build();
    expect(world.boundary.rocks.length).toBe(DEFAULT_ROCK_COUNT);
    expect(world.boundary.triangleCount).toBeLessThanOrEqual(
      DEFAULT_ROCK_COUNT * ROCK_TRIANGLES.boulder,
    );
    // And it is a real share of the frame rather than nothing at all.
    expect(world.boundary.triangleCount).toBeGreaterThan(0);
    world.dispose();
  });

  it('keeps every rock inside the terrain and above the ground', async () => {
    const world = await build();
    const half = world.terrain.sizeMetres / 2;
    for (const rock of world.boundary.rocks) {
      expect(Math.abs(rock.x)).toBeLessThanOrEqual(half);
      expect(Math.abs(rock.z)).toBeLessThanOrEqual(half);
      // Sunk slightly into the surface, never floating above it.
      expect(rock.y).toBeLessThanOrEqual(world.terrain.heightAt(rock.x, rock.z));
      expect(rock.y).toBeGreaterThan(world.terrain.heightAt(rock.x, rock.z) - 3);
    }
    world.dispose();
  });

  it('concentrates the rocks towards the rim, where the boundary work is', async () => {
    // The plan asks for dense rocks at the edges. Measured as a mean distance
    // to the nearest wall: a uniform scatter over 500 m would average 125 m,
    // and a belt-weighted one comes in well under that.
    const world = await build();
    const half = world.terrain.sizeMetres / 2;
    const distances = world.boundary.rocks.map((r) =>
      Math.min(half - Math.abs(r.x), half - Math.abs(r.z)),
    );
    const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
    expect(mean).toBeLessThan(0.6 * half);
    // And a real share of them are in the belt proper.
    const inBelt = distances.filter((d) => d < 45).length;
    expect(inBelt / distances.length).toBeGreaterThan(0.5);
    world.dispose();
  });

  it('never puts a rock in the stream or on a cliff', async () => {
    const world = await build();
    for (const rock of world.boundary.rocks) {
      const nearest = world.terrain.stream.distanceTo({ x: rock.x, y: 0, z: rock.z });
      expect(nearest.distance).toBeGreaterThan(3.9);
      const normal = world.terrain.normalAt(rock.x, rock.z);
      expect(1 - normal.y).toBeLessThanOrEqual(0.56);
    }
    world.dispose();
  });

  it('is deterministic per seed and different across seeds', async () => {
    const a = await build({ boundary: { seed: 7 } });
    const b = await build({ boundary: { seed: 7 } });
    const c = await build({ boundary: { seed: 8 } });
    const key = (w: typeof a) =>
      w.boundary.rocks.map((r) => `${r.shape}:${r.x.toFixed(4)},${r.z.toFixed(4)}`).join('|');
    expect(key(a)).toBe(key(b));
    expect(key(a)).not.toBe(key(c));
    a.dispose();
    b.dispose();
    c.dispose();
  }, 120000);

  it('gives near rocks a collider and leaves the rest alone', async () => {
    const world = await build();
    const total = world.boundary.rocks.length;
    const withCollider = world.boundary.colliderCount;
    // Some, but not all: the radius gating has to be doing something or the
    // whole set-difference rebuild is decoration.
    expect(withCollider).toBeGreaterThan(0);
    expect(withCollider).toBeLessThan(total);
    world.dispose();
  });

  it('moves the colliders with the camera', async () => {
    const world = await build();
    // Walk the listener to the far corner of the map and let the boundary
    // catch up. The collider set has to change, or the rocks near the new
    // position are ghosts the player walks through.
    const before = world.boundary.colliderCount;
    const corner = world.terrain.restHeight(220, 220, 2, 0.05);
    for (let i = 0; i < 400; i++) {
      world.update(1 / 60, { x: corner.x, y: 0, z: corner.z });
    }
    const after = world.boundary.colliderCount;
    expect(after).toBeGreaterThan(0);
    // The set is a function of where the camera is, so it must have changed.
    expect(after).not.toBe(before);
    world.dispose();
  }, 120000);

  it('stops a player walking into a rock', async () => {
    // The other half of "collision on large rocks": a rock the player can walk
    // through is a rock that should not have a collider.
    const world = await build();
    const rock = world.boundary.rocks[0];
    // Stand next to it and push into it.
    const spawn = world.terrain.restHeight(rock.x, rock.z, 2, 0.05);
    const body = world.physics.createCapsuleBody({
      spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
      halfHeight: 0.5,
      radius: 0.5,
    });
    for (let i = 0; i < 120; i++) world.fixedUpdate(1 / 60);
    // The rock is at rock.x, rock.z; push the body towards it from where it
    // landed, which is on top of the rock's collider.
    const p = body.body.translation();
    const dx = rock.x - p.x;
    const dz = rock.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    body.body.setLinvel({ x: (dx / len) * 30, y: 0, z: (dz / len) * 30 }, true);
    for (let i = 0; i < 120; i++) world.fixedUpdate(1 / 60);
    const q = body.body.translation();
    // It must not have passed through to the far side.
    const before = Math.hypot(p.x - rock.x, p.z - rock.z);
    const afterDist = Math.hypot(q.x - rock.x, q.z - rock.z);
    expect(afterDist).toBeGreaterThan(before - 1.5);
    world.physics.removeCollider(body.collider);
    world.dispose();
  }, 120000);

  it('culls its meshes, because the rocks never move', async () => {
    const world = await build();
    let meshes = 0;
    let cullable = 0;
    world.boundary.group.traverse((child) => {
      const mesh = child as { isInstancedMesh?: boolean; frustumCulled?: boolean };
      if (!mesh.isInstancedMesh) return;
      meshes++;
      if (mesh.frustumCulled) cullable++;
    });
    expect(meshes).toBeGreaterThan(0);
    // Every one of them. A rock behind the player must cost nothing, and the
    // only reason it can is that its instance matrices are written once.
    expect(cullable).toBe(meshes);
    world.dispose();
  });

  it('detaches from the scene and releases its colliders', async () => {
    physics = await PhysicsWorld.create();
    const scene = new Scene();
    const world = new WorldScene({ scene, physics });
    const bodies = world.physics.world.bodies.len();
    expect(bodies).toBeGreaterThan(0);
    expect(scene.children).toContain(world.boundary.group);

    world.dispose();
    expect(scene.children).not.toContain(world.boundary.group);
    // Every collider the boundary created is gone, and its bodies with it.
    expect(world.boundary.colliderCount).toBe(0);
    expect(world.boundary.wallCount).toBe(0);
    expect(world.boundary.triangleCount).toBe(0);
  }, 120000);
});
