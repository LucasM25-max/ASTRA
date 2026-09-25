/**
 * Rapier is installed for Step 1.3 (the player's physics body). This test only
 * proves the dependency is wired up correctly and usable from both the browser
 * bundle and the Node test runner - no game code depends on it yet.
 */
import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';

describe('Rapier physics (dependency check)', () => {
  it('initialises its WASM core', async () => {
    await RAPIER.init();
    expect(RAPIER.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('creates a world with gravity and integrates a falling body', async () => {
    await RAPIER.init();

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0));
    // A body needs a collider to have mass; without one Rapier will not
    // integrate it at all.
    world.createCollider(RAPIER.ColliderDesc.ball(0.25), body);

    expect(body.translation().y).toBeCloseTo(1, 6);
    expect(body.linvel().y).toBe(0);

    world.step();

    // One step of -9.81 m/s^2 at 60Hz: v = -0.1635 m/s, y drops by ~0.0014 m.
    expect(body.linvel().y).toBeCloseTo(-9.81 * world.timestep, 4);
    expect(body.translation().y).toBeLessThan(1);
    expect(body.translation().y).toBeGreaterThan(0.99);

    world.free();
  });

  it('can build the colliders Step 1.3 will need', async () => {
    await RAPIER.init();

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50), ground);

    const capsule = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
    world.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.35), capsule);

    // Fall onto the ground plane rather than through it. The capsule is
    // 2 * (0.5 + 0.35) = 1.7 tall and the ground top sits at y = 0.5, so it
    // comes to rest with its centre at y = 1.35.
    for (let i = 0; i < 240; i += 1) world.step();

    const y = capsule.translation().y;
    expect(y).toBeGreaterThan(1.3);
    expect(y).toBeLessThan(1.4);

    world.free();
  });
});
