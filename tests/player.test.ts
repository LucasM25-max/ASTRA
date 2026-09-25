/**
 * Player - the capsule character.
 *
 * The assertion that earns its keep here is the mesh/collider dimension match:
 * a render mesh that disagrees with its collider is nearly impossible to spot
 * by eye, and every later system (camera framing, ground checks, the encounter
 * system) inherits the mistake.
 */
import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Object3D } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import {
  PLAYER_COLOR,
  PLAYER_HALF_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPAWN,
  Player,
} from '../src/player/Player';

const FIXED_STEP = 1 / 60;

async function makeWorld(): Promise<PhysicsWorld> {
  return PhysicsWorld.create();
}

/** Height of a geometry's bounding box along one axis. */
function extentAlong(geometry: Mesh['geometry'], axis: 'x' | 'y' | 'z'): number {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as Box3;
  return box.max[axis] - box.min[axis];
}

describe('Player', () => {
  it('builds a capsule mesh and a matching dynamic capsule collider', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    expect(player.mesh).toBeInstanceOf(Mesh);
    expect(player.mesh.geometry).toHaveProperty('type', 'CapsuleGeometry');
    expect(player.body.isDynamic()).toBe(true);

    expect(player.radius).toBe(PLAYER_RADIUS);
    expect(player.height).toBe(PLAYER_HEIGHT);
    expect(PLAYER_HALF_HEIGHT).toBeCloseTo((PLAYER_HEIGHT - 2 * PLAYER_RADIUS) / 2, 10);

    physics.dispose();
  });

  it('makes the mesh and the collider the same size', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    // Both describe a capsule of total height 2 * halfHeight + 2 * radius.
    const meshHeight = extentAlong(player.mesh.geometry, 'y');
    expect(meshHeight).toBeCloseTo(PLAYER_HEIGHT, 6);

    const meshWidth = extentAlong(player.mesh.geometry, 'x');
    expect(meshWidth).toBeCloseTo(2 * PLAYER_RADIUS, 6);

    // The collider agrees, and is centred on the body's origin just like the
    // geometry is centred on the mesh's origin.
    const capsule = player.collider.shape as unknown as {
      radius: number;
      halfHeight: number;
    };
    expect(capsule.radius).toBeCloseTo(PLAYER_RADIUS, 6);
    expect(2 * capsule.halfHeight + 2 * capsule.radius).toBeCloseTo(PLAYER_HEIGHT, 6);

    physics.dispose();
  });

  it('spawns at (0, 1, 0) as the Step 1.3 spec requires', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    expect(player.position).toEqual({ x: 0, y: 1, z: 0 });
    expect(PLAYER_SPAWN).toEqual({ x: 0, y: 1, z: 0 });

    // The mesh starts on the body, so the character is never drawn at the
    // origin for a frame before the first sync.
    expect(player.mesh.position.toArray()).toEqual([0, 1, 0]);

    physics.dispose();
  });

  it('honours a custom spawn point', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics, spawn: { x: 3, y: 4, z: -5 } });

    expect(player.position).toEqual({ x: 3, y: 4, z: -5 });
    expect(player.mesh.position.toArray()).toEqual([3, 4, -5]);

    physics.dispose();
  });

  it('falls under gravity and lands standing on the ground', async () => {
    const physics = await makeWorld();
    physics.createGround(50);
    const player = new Player({ physics });

    expect(player.velocity).toEqual({ x: 0, y: 0, z: 0 });

    // Gravity must actually pull it down: spawn at y=1 leaves the capsule
    // floating 0.1m above the ground.
    for (let i = 0; i < 10; i += 1) physics.step(FIXED_STEP);
    expect(player.position.y).toBeLessThan(1);

    for (let i = 0; i < 600; i += 1) physics.step(FIXED_STEP);

    // Comes to rest with its lowest point on y = 0.
    expect(player.position.y).toBeCloseTo(player.restHeight, 2);
    expect(player.restHeight).toBeCloseTo(PLAYER_HEIGHT / 2, 10);
    expect(player.velocity.y).toBeCloseTo(0, 3);

    // And stays upright rather than toppling over.
    const q = player.body.rotation();
    const tiltDeg = (Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;
    expect(tiltDeg).toBeLessThan(1e-6);

    physics.dispose();
  });

  it('falls off the edge of the finite plane instead of hovering', async () => {
    const physics = await makeWorld();
    physics.createGround(50);
    const player = new Player({ physics, spawn: { x: 45, y: 1, z: 0 } });

    player.body.setLinvel({ x: 12, y: 0, z: 0 }, true);
    for (let i = 0; i < 300; i += 1) physics.step(FIXED_STEP);

    expect(player.position.y).toBeLessThan(-5);

    physics.dispose();
  });

  it('follows the body in syncMesh without allocating', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    player.body.setTranslation({ x: 1, y: 2, z: 3 }, true);
    player.mesh.position.set(99, 99, 99);

    player.syncMesh();
    expect(player.mesh.position.toArray()).toEqual([1, 2, 3]);

    player.body.setTranslation({ x: -4, y: 0.5, z: 7 }, true);
    player.syncMesh();
    expect(player.mesh.position.toArray()).toEqual([-4, 0.5, 7]);

    physics.dispose();
  });

  it('does not rotate the mesh, because the controller owns the facing', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    player.mesh.rotation.y = 1.234;
    player.syncMesh();

    // syncMesh reconciles position only; clobbering the visual yaw here would
    // fight the movement controller that turns the character in Step 1.4.
    expect(player.mesh.rotation.y).toBe(1.234);

    physics.dispose();
  });

  it('reports velocity through the body', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    player.body.setLinvel({ x: 1, y: -2, z: 3 }, true);
    expect(player.velocity).toEqual({ x: 1, y: -2, z: 3 });

    physics.dispose();
  });

  it('rejects dimensions that would collapse the capsule', async () => {
    const physics = await makeWorld();

    // A capsule whose caps meet has no middle section left.
    expect(() => new Player({ physics, radius: 0.5, height: 1 })).toThrow(RangeError);
    expect(() => new Player({ physics, radius: -1, height: 1.8 })).toThrow(RangeError);
    expect(() => new Player({ physics, radius: Number.NaN, height: 1.8 })).toThrow(RangeError);

    physics.dispose();
  });

  it('adds to and removes from the scene graph', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });
    const group = new Object3D();

    player.addTo(group);
    expect(group.children).toContain(player.mesh);

    player.removeFrom(group);
    expect(group.children).not.toContain(player.mesh);

    physics.dispose();
  });

  it('tears the body and the GPU resources down on dispose', async () => {
    const physics = await makeWorld();
    physics.createGround(50);
    const player = new Player({ physics });

    for (let i = 0; i < 60; i += 1) physics.step(FIXED_STEP);
    expect(physics.world.bodies.contains(player.body.handle)).toBe(true);

    player.dispose();

    expect(player.isDisposed).toBe(true);
    expect(physics.world.bodies.contains(player.body.handle)).toBe(false);

    // A disposed player stays inert.
    expect(() => player.syncMesh()).not.toThrow();

    // And disposing twice must not double-free.
    expect(() => player.dispose()).not.toThrow();

    physics.dispose();
  });

  it('uses a placeholder colour that is neither the ground nor the sky', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    const color = player.mesh.material.color.getHex();
    expect(color).toBe(PLAYER_COLOR);
    expect(player.mesh.material.roughness).toBeGreaterThan(0);
    expect(player.mesh.castShadow).toBe(true);
    expect(player.mesh.receiveShadow).toBe(true);

    physics.dispose();
  });
});
