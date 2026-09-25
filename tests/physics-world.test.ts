/**
 * PhysicsWorld - the Rapier wrapper Step 1.3 builds the player on.
 *
 * These tests assert the things that are easy to get wrong and hard to see:
 * gravity's exact value, the ground slab lining up with the visual plane, the
 * capsule coming to rest at the height its dimensions promise, and the API
 * traps (NaN spawns, sleeping bodies) that fail silently rather than loudly.
 */
import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  DEFAULT_GROUND_THICKNESS,
  DEFAULT_PHYSICS_TIMESTEP,
  GRAVITY_Y,
  PhysicsWorld,
} from '../src/physics/PhysicsWorld';

const FIXED_STEP = 1 / 60;

/**
 * Rapier keeps its integration parameters as f32, so values round-tripped
 * through the WASM boundary carry only ~7 significant digits. Assertions on
 * them are therefore pinned to 6 decimal places, not 12.
 */
const F32_PRECISION = 6;

describe('PhysicsWorld', () => {
  it('creates a world pulled down by gravity at -9.81 m/s²', async () => {
    const physics = await PhysicsWorld.create();

    expect(physics.gravity).toEqual({ x: 0, y: -9.81, z: 0 });
    expect(physics.gravity.y).toBe(GRAVITY_Y);
    expect(physics.world.gravity.y).toBeCloseTo(-9.81, 10);
    expect(physics.timestep).toBeCloseTo(DEFAULT_PHYSICS_TIMESTEP, F32_PRECISION);

    physics.dispose();
  });

  it('accepts a custom gravity and timestep', async () => {
    const physics = await PhysicsWorld.create({
      gravity: { x: 1, y: -2, z: 3 },
      timestep: 1 / 30,
    });

    expect(physics.gravity).toEqual({ x: 1, y: -2, z: 3 });
    expect(physics.timestep).toBeCloseTo(1 / 30, F32_PRECISION);

    physics.dispose();
  });

  it('refuses non-finite gravity rather than poisoning the simulation', async () => {
    await expect(
      PhysicsWorld.create({ gravity: { x: 0, y: Number.NaN, z: 0 } }),
    ).rejects.toThrow(RangeError);
  });

  it('builds a ground slab whose top face is exactly level with y = 0', async () => {
    const physics = await PhysicsWorld.create();
    const ground = physics.createGround(50);

    // The slab is centred below the origin, so its top face lands on y = 0.
    expect(ground.translation().y).toBeCloseTo(-DEFAULT_GROUND_THICKNESS / 2, 10);
    expect(ground.isFixed()).toBe(true);

    // Drop a ball from above and confirm it lands at y = 0, not inside it.
    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 3, 0),
    );
    physics.world.createCollider(RAPIER.ColliderDesc.ball(0.25), body);

    for (let i = 0; i < 600; i += 1) physics.step(FIXED_STEP);

    expect(body.translation().y).toBeCloseTo(0.25, 2);

    physics.dispose();
  });

  it('spans the full 100m plane and no further, so the player can fall off', async () => {
    const physics = await PhysicsWorld.create();
    physics.createGround(50);

    // Well inside the slab: supported.
    const inside = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0),
    );
    physics.world.createCollider(RAPIER.ColliderDesc.ball(0.25), inside);

    // Well outside it: nothing to land on.
    const outside = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(90, 1, 0),
    );
    physics.world.createCollider(RAPIER.ColliderDesc.ball(0.25), outside);

    for (let i = 0; i < 300; i += 1) physics.step(FIXED_STEP);

    expect(inside.translation().y).toBeCloseTo(0.25, 2);
    expect(outside.translation().y).toBeLessThan(-5);

    physics.dispose();
  });

  it('rejects a non-positive ground extent', async () => {
    const physics = await PhysicsWorld.create();

    expect(() => physics.createGround(0)).toThrow(RangeError);
    expect(() => physics.createGround(-5)).toThrow(RangeError);
    expect(() => physics.createGround(Number.NaN)).toThrow(RangeError);

    physics.dispose();
  });

  it('creates a rotation-locked capsule that stands upright', async () => {
    const physics = await PhysicsWorld.create();
    const { body, collider } = physics.createCapsuleBody({
      radius: 0.35,
      halfHeight: 0.55,
      spawn: { x: 0, y: 1, z: 0 },
    });

    expect(body.isDynamic()).toBe(true);
    expect(collider.shape.type).toBe(RAPIER.ShapeType.Capsule);
    expect(collider.shape).toBeInstanceOf(RAPIER.Capsule);

    const capsule = collider.shape as RAPIER.Capsule;
    expect(capsule.radius).toBeCloseTo(0.35, F32_PRECISION);
    expect(capsule.halfHeight).toBeCloseTo(0.55, F32_PRECISION);

    // Locked rotation is what stops an upright capsule toppling onto its side.
    body.setLinvel({ x: 40, y: 0, z: 0 }, true);
    for (let i = 0; i < 240; i += 1) physics.step(FIXED_STEP);

    const q = body.rotation();
    const tiltDeg = (Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;
    expect(tiltDeg).toBeLessThan(1e-6);

    physics.dispose();
  });

  it('never lets the capsule fall asleep, so it always answers setLinvel', async () => {
    const physics = await PhysicsWorld.create();
    const { body } = physics.createCapsuleBody({
      radius: 0.35,
      halfHeight: 0.55,
      spawn: { x: 0, y: 1, z: 0 },
    });

    for (let i = 0; i < 600; i += 1) physics.step(FIXED_STEP);

    // A body that has come to rest and gone to sleep would ignore this.
    expect(body.isSleeping()).toBe(false);
    body.setLinvel({ x: 0, y: 5, z: 0 }, true);
    physics.step(FIXED_STEP);
    expect(body.linvel().y).toBeGreaterThan(0);

    physics.dispose();
  });

  it('refuses a NaN spawn instead of silently poisoning the body', async () => {
    const physics = await PhysicsWorld.create();

    expect(() =>
      physics.createCapsuleBody({
        radius: 0.35,
        halfHeight: 0.55,
        spawn: { x: 0, y: Number.NaN, z: 0 },
      }),
    ).toThrow(RangeError);

    expect(() =>
      physics.createCapsuleBody({ radius: 0, halfHeight: 0.55, spawn: { x: 0, y: 1, z: 0 } }),
    ).toThrow(RangeError);

    physics.dispose();
  });

  it('settles the capsule at exactly half its total height above the ground', async () => {
    const physics = await PhysicsWorld.create();
    physics.createGround(50);

    const radius = 0.35;
    const halfHeight = 0.55;
    const { body } = physics.createCapsuleBody({
      radius,
      halfHeight,
      spawn: { x: 0, y: 1, z: 0 },
    });

    for (let i = 0; i < 600; i += 1) physics.step(FIXED_STEP);

    // Lowest point of the capsule sits on the ground: centre = halfHeight + radius.
    expect(body.translation().y).toBeCloseTo(halfHeight + radius, 2);
    expect(body.linvel().y).toBeCloseTo(0, 3);

    physics.dispose();
  });

  it('re-asserts the world timestep on every step, so it cannot drift', async () => {
    const physics = await PhysicsWorld.create({ timestep: 1 / 60 });

    physics.step(1 / 30);
    expect(physics.timestep).toBeCloseTo(1 / 30, F32_PRECISION);

    physics.step(1 / 240);
    expect(physics.timestep).toBeCloseTo(1 / 240, F32_PRECISION);

    // A nonsense delta falls back to the initial timestep rather than hanging
    // the solver on a zero or negative step.
    physics.step(0);
    expect(physics.timestep).toBeCloseTo(1 / 60, F32_PRECISION);
    physics.step(Number.NaN);
    expect(physics.timestep).toBeCloseTo(1 / 60, F32_PRECISION);

    physics.dispose();
  });

  it('integrates gravity at the rate its timestep implies', async () => {
    const physics = await PhysicsWorld.create();
    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 100, 0),
    );
    physics.world.createCollider(RAPIER.ColliderDesc.ball(0.1), body);

    physics.step(FIXED_STEP);

    // v = g * dt after one step from rest.
    expect(body.linvel().y).toBeCloseTo(-9.81 * FIXED_STEP, 6);

    physics.dispose();
  });

  it('slows the fall when stepped with a smaller delta, so time dilation works', async () => {
    const full = await PhysicsWorld.create();
    const dilated = await PhysicsWorld.create();

    const a = full.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 20, 0));
    full.world.createCollider(RAPIER.ColliderDesc.ball(0.1), a);

    const b = dilated.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 20, 0),
    );
    dilated.world.createCollider(RAPIER.ColliderDesc.ball(0.1), b);

    for (let i = 0; i < 60; i += 1) full.step(FIXED_STEP);
    for (let i = 0; i < 60; i += 1) dilated.step(FIXED_STEP * 0.25);

    const fellFull = 20 - a.translation().y;
    const fellDilated = 20 - b.translation().y;

    // Distance fallen under constant acceleration scales with dt².
    expect(fellDilated).toBeGreaterThan(0);
    expect(fellDilated / fellFull).toBeCloseTo(0.0625, 3);

    // The same amount of *scaled* time lands in the same place.
    const dilatedAgain = await PhysicsWorld.create();
    const c = dilatedAgain.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 20, 0),
    );
    dilatedAgain.world.createCollider(RAPIER.ColliderDesc.ball(0.1), c);
    for (let i = 0; i < 240; i += 1) dilatedAgain.step(FIXED_STEP * 0.25);
    expect(c.translation().y).toBeCloseTo(a.translation().y, 1);

    full.dispose();
    dilated.dispose();
    dilatedAgain.dispose();
  });

  it('counts its steps and stays inert once freed', async () => {
    const physics = await PhysicsWorld.create();

    expect(physics.stepCount).toBe(0);
    physics.step(FIXED_STEP);
    physics.step(FIXED_STEP);
    expect(physics.stepCount).toBe(2);

    physics.dispose();
    expect(physics.isFreed).toBe(true);

    // Stepping a freed world must not touch the released WASM memory.
    expect(() => physics.step(FIXED_STEP)).not.toThrow();
    expect(physics.stepCount).toBe(2);

    // And disposing twice must not double-free.
    expect(() => physics.dispose()).not.toThrow();
  });
});
