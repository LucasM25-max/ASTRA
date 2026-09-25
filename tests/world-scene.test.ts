import { afterEach, describe, expect, it, vi } from 'vitest';
import { Fog, Scene } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { PLAYER_HEIGHT, PLAYER_SPAWN } from '../src/player/Player';
import {
  DEFAULT_FOG_COLOR,
  DEFAULT_FOG_FAR,
  DEFAULT_FOG_NEAR,
  WorldScene,
  type WorldSceneOptions,
} from '../src/world/WorldScene';

const FIXED_STEP = 1 / 60;

/** Every test gets its own physics world, torn down afterwards. */
let physics: PhysicsWorld;

async function buildScene(
  options: Omit<WorldSceneOptions, 'scene' | 'physics'> = {},
): Promise<{ scene: Scene; world: WorldScene }> {
  physics = await PhysicsWorld.create();
  const scene = new Scene();
  const world = new WorldScene({ scene, physics, ...options });
  return { scene, world };
}

afterEach(() => {
  physics?.dispose();
});

describe('WorldScene', () => {
  it('populates the scene with terrain, sky, lights and the player', async () => {
    const { scene, world } = await buildScene();

    expect(scene.children).toContain(world.terrain.mesh);
    expect(scene.children).toContain(world.sky.mesh);
    expect(scene.children).toContain(world.lighting.group);
    expect(scene.children).toContain(world.player.mesh);

    expect(scene.getObjectByName('terrain')).toBe(world.terrain.mesh);
    expect(scene.getObjectByName('sky')).toBe(world.sky.mesh);
    expect(scene.getObjectByName('sun')).toBe(world.lighting.sun);
    expect(scene.getObjectByName('ambient')).toBe(world.lighting.ambient);
    expect(scene.getObjectByName('player')).toBe(world.player.mesh);
  });

  it('adds linear fog for depth', async () => {
    const { world } = await buildScene();

    expect(world.fog).toBeInstanceOf(Fog);
    expect(world.fog?.near).toBe(DEFAULT_FOG_NEAR);
    expect(world.fog?.far).toBe(DEFAULT_FOG_FAR);
    expect(world.fog?.color.getHex()).toBe(DEFAULT_FOG_COLOR);
  });

  it('tunes the fog so the 100m plane dissolves instead of ending', async () => {
    const { world } = await buildScene();

    // The camera sits at z = 8, so the plane's far edge is 58m away and its
    // nearest edge 42m. The far edge must be almost fully fogged.
    const fogAt = (distance: number): number => {
      const { near, far } = world.fog as Fog;
      return Math.min(Math.max((distance - near) / (far - near), 0), 1);
    };

    expect(fogAt(42)).toBeGreaterThan(0.3); // some haze on the near ground
    expect(fogAt(42)).toBeLessThan(0.7); // ...but still clearly visible
    expect(fogAt(58)).toBeGreaterThan(0.85); // the far edge is nearly gone
    expect(fogAt(200)).toBe(1); // anything past the plane is fully fogged
  });

  it('accepts fog overrides', async () => {
    const { world } = await buildScene({ fog: { near: 1, far: 2, color: 0x123456 } });

    expect(world.fog?.near).toBe(1);
    expect(world.fog?.far).toBe(2);
    expect(world.fog?.color.getHex()).toBe(0x123456);
  });

  it('spawns the player at (0, 1, 0) with the spec dimensions', async () => {
    const { world } = await buildScene();

    expect(world.player.position).toEqual({ x: 0, y: 1, z: 0 });
    expect(PLAYER_SPAWN).toEqual({ x: 0, y: 1, z: 0 });
    expect(world.player.height).toBe(PLAYER_HEIGHT);
  });

  it('honours player overrides', async () => {
    const { world } = await buildScene({
      playerSpawn: { x: 2, y: 3, z: 4 },
      playerRadius: 0.5,
      playerHeight: 2,
    });

    expect(world.player.position).toEqual({ x: 2, y: 3, z: 4 });
    expect(world.player.radius).toBe(0.5);
    expect(world.player.height).toBe(2);
  });

  it('gives the world a static ground collider level with the visual plane', async () => {
    const { world } = await buildScene();

    // Two bodies: the fixed ground and the dynamic player.
    expect(world.physics.world.bodies.len()).toBe(2);

    const fixed: number[] = [];
    const dynamic: number[] = [];
    world.physics.world.bodies.forEach((body) => {
      (body.isFixed() ? fixed : dynamic).push(body.translation().y);
    });
    expect(fixed).toHaveLength(1);
    expect(dynamic).toHaveLength(1);

    // The slab is centred below the origin so its top face lands on y = 0,
    // level with the visual plane.
    expect(fixed[0]).toBeCloseTo(-0.5, 6);

    // The slab spans the whole 100m plane: half-extent 50 either side of the
    // origin, matching `terrain.sizeMetres / 2`.
    expect(world.terrain.sizeMetres).toBe(100);
  });

  it('advances the sky with the game delta it is given', async () => {
    const { world } = await buildScene();

    expect(world.elapsedTime).toBe(0);

    world.update(0.016);
    expect(world.elapsedTime).toBeCloseTo(0.016, 6);
    expect(world.sky.elapsedTime).toBeCloseTo(0.016, 6);
  });

  it('does nothing when handed a zero delta, so a paused world is frozen', async () => {
    const { world } = await buildScene();

    world.update(0.016);
    const elapsed = world.elapsedTime;

    world.update(0);
    expect(world.elapsedTime).toBe(elapsed);
    expect(world.sky.elapsedTime).toBe(elapsed);
  });

  it('ignores negative and non-finite deltas', async () => {
    const { world } = await buildScene();

    world.update(-1);
    world.update(Number.NaN);

    expect(world.elapsedTime).toBe(0);
  });

  it('steps physics on the fixed path and never on the render path', async () => {
    const { world } = await buildScene();

    // The render path must not move physics: a variable frame delta would make
    // the simulation non-deterministic.
    const before = world.physics.stepCount;
    for (let i = 0; i < 10; i += 1) world.update(1 / 30);
    expect(world.physics.stepCount).toBe(before);

    // The fixed path is the only thing that advances the simulation.
    for (let i = 0; i < 10; i += 1) world.fixedUpdate(FIXED_STEP);
    expect(world.physics.stepCount).toBe(before + 10);
  });

  it('reconciles the player mesh with the body on the render path', async () => {
    const { world } = await buildScene();

    // Move the body without going through physics, then render once.
    world.player.body.setTranslation({ x: 1, y: 2, z: 3 }, true);
    world.player.mesh.position.set(0, 0, 0);

    world.update(1 / 60);

    expect(world.player.mesh.position.toArray()).toEqual([1, 2, 3]);
  });

  it('drops the player onto the ground through the fixed path', async () => {
    const { world } = await buildScene();

    for (let i = 0; i < 600; i += 1) world.fixedUpdate(FIXED_STEP);

    expect(world.player.position.y).toBeCloseTo(PLAYER_HEIGHT / 2, 2);

    // The mesh only follows on the render path - `fixedUpdate` deliberately
    // never touches it, so physics stays out of the presentation layer.
    expect(world.player.mesh.position.y).toBe(1);

    world.update(0);
    // The mesh is an exact copy of the body, and Rapier's contact solver
    // leaves a few 1e-5 of margin above the ground, so the rest height is
    // asserted to 3dp rather than treated as exact.
    expect(world.player.mesh.position.y).toBe(world.player.position.y);
    expect(world.player.mesh.position.y).toBeCloseTo(PLAYER_HEIGHT / 2, 3);
  });

  it('tears everything down on dispose', async () => {
    const { scene, world } = await buildScene();

    const disposeTerrain = vi.spyOn(world.terrain.mesh.geometry, 'dispose');
    const disposeSky = vi.spyOn(world.sky.mesh.geometry, 'dispose');
    const disposeLights = vi.spyOn(world.lighting.sun, 'dispose');
    const disposePlayerGeometry = vi.spyOn(world.player.mesh.geometry, 'dispose');

    world.dispose();

    expect(scene.children).toHaveLength(0);
    expect(scene.fog).toBeNull();
    expect(world.isDisposed).toBe(true);
    expect(disposeTerrain).toHaveBeenCalledTimes(1);
    expect(disposeSky).toHaveBeenCalledTimes(1);
    expect(disposeLights).toHaveBeenCalledTimes(1);
    expect(disposePlayerGeometry).toHaveBeenCalledTimes(1);

    // The player's body is gone from the simulation...
    expect(world.physics.world.bodies.len()).toBe(1); // just the ground
    // ...but the physics world itself survives: it was passed in, not created.
    expect(world.physics.isFreed).toBe(false);

    // A disposed world must stay inert.
    world.update(1);
    world.fixedUpdate(1);
    expect(world.elapsedTime).toBe(0);

    // And disposing twice must not double-free.
    expect(() => world.dispose()).not.toThrow();
    expect(disposeTerrain).toHaveBeenCalledTimes(1);
  });
});
