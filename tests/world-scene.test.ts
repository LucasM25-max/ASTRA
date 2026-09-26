import { afterEach, describe, expect, it, vi } from 'vitest';
import { Fog, Scene } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import {
  PLAYER_HALF_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPAWN,
} from '../src/player/Player';
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

  it('tunes the fog so the 500m terrain dissolves instead of ending', async () => {
    const { world } = await buildScene();

    // Wide fog, as decided for Step 2.1: the ground under the player stays
    // crisp, and the distance dissolves rather than showing a hard edge. With
    // the camera near the centre of a 500m terrain the far rim sits about
    // 250m away, so `far` has to reach well past that for the effect to work.
    const fogAt = (distance: number): number => {
      const { near, far } = world.fog as Fog;
      return Math.min(Math.max((distance - near) / (far - near), 0), 1);
    };

    expect(fogAt(0)).toBe(0); // the ground at the player's feet is unfogged
    expect(fogAt(50)).toBe(0); // ...and so is the ground 50m out
    expect(fogAt(80)).toBe(0); // haze starts exactly at the near plane
    expect(fogAt(200)).toBeGreaterThan(0.2); // the distance is visibly hazy
    expect(fogAt(250)).toBeGreaterThan(0.4); // the far rim recedes
    expect(fogAt(250)).toBeLessThan(0.8); // ...but stays readable
    expect(fogAt(400)).toBe(1); // and dissolves completely past it

    // Monotonic: fog never un-fogs as distance grows.
    let previous = -1;
    for (let d = 0; d <= 450; d += 10) {
      const value = fogAt(d);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('accepts fog overrides', async () => {
    const { world } = await buildScene({ fog: { near: 1, far: 2, color: 0x123456 } });

    expect(world.fog?.near).toBe(1);
    expect(world.fog?.far).toBe(2);
    expect(world.fog?.color.getHex()).toBe(0x123456);
  });

  it('spawns the player standing on the terrain at the spec XZ', async () => {
    const { world } = await buildScene();

    // `PLAYER_SPAWN` still supplies the horizontal position, but the height is
    // derived from the surface rather than assumed. On a heightmap a fixed
    // height means spawning inside a hill about half the time, and Rapier's
    // resolution of that is a shove in an arbitrary direction - which reads as
    // a bug rather than as terrain.
    expect(PLAYER_SPAWN).toEqual({ x: 0, y: 1, z: 0 });
    expect(world.player.position.x).toBe(PLAYER_SPAWN.x);
    expect(world.player.position.z).toBe(PLAYER_SPAWN.z);

    // Capsule centre sits half the player height above the ground, plus a
    // small clearance so it starts free rather than in contact.
    const surface = world.terrain.heightAt(PLAYER_SPAWN.x, PLAYER_SPAWN.z);
    expect(world.player.position.y).toBeCloseTo(surface + PLAYER_HEIGHT / 2 + 0.05, 5);
    expect(world.player.position.y).toBeGreaterThan(surface);
    expect(world.player.height).toBe(PLAYER_HEIGHT);
  });

  it('honours player overrides, deriving only the height from the terrain', async () => {
    const { world } = await buildScene({
      playerSpawn: { x: 2, y: 3, z: 4 },
      playerRadius: 0.5,
      playerHeight: 2,
    });

    // The requested y is not used - it is a suggestion, not a constraint.
    expect(world.player.position.x).toBe(2);
    expect(world.player.position.z).toBe(4);

    const surface = world.terrain.heightAt(2, 4);
    expect(world.player.position.y).toBeCloseTo(surface + 1 + 0.05, 5);
    expect(world.player.radius).toBe(0.5);
    expect(world.player.height).toBe(2);
  });

  it('gives the world a static terrain collider built from the mesh', async () => {
    const { world } = await buildScene();

    // Two bodies: the fixed terrain and the dynamic player.
    expect(world.physics.world.bodies.len()).toBe(2);

    const fixed: number[] = [];
    const dynamic: number[] = [];
    world.physics.world.bodies.forEach((body) => {
      (body.isFixed() ? fixed : dynamic).push(body.translation().y);
    });
    expect(fixed).toHaveLength(1);
    expect(dynamic).toHaveLength(1);

    // The terrain body carries no offset, because the mesh's vertex buffer is
    // already in world coordinates - offsetting it here would shift the
    // collision surface away from the visual one.
    expect(fixed[0]).toBe(0);

    // And it spans the whole terrain, matching `terrain.sizeMetres / 2`.
    expect(world.terrain.sizeMetres).toBe(500);
  });

  it('makes the collision surface agree with the visual surface', async () => {
    const { world } = await buildScene();

    // The single most important property of this collider: the raycast must
    // land on the heightmap the mesh is drawn from, not near it. A mismatch
    // here is invisible in review and shows up as the player skating on air
    // or sinking into a hill.
    //
    // Rapier rebuilds its broad phase during `step()`, so a collider added
    // after the world was built is invisible to raycasts until one step has
    // run. Step first, then probe.
    world.fixedUpdate(FIXED_STEP);

    const samples = [
      { x: 0, z: 0 },
      { x: 40, z: -60 },
      { x: -90, z: 70 },
      { x: 120, z: 120 },
    ];
    for (const { x, z } of samples) {
      const expected = world.terrain.heightAt(x, z);
      // Exclude the player's own capsule: it is a body in the same world, and
      // a ray cast through it stops there instead of reaching the terrain.
      const hit = world.physics.castDown(
        { x, y: expected + 200, z },
        400,
        world.player.body,
      );
      expect(hit, `no hit at ${x},${z}`).not.toBeNull();
      // The ray starts 200m above the heightmap's value there, so it must
      // travel 200m to reach it - not 200 plus a scale factor, and not a
      // rounded number that happens to be close.
      // The trimesh is piecewise linear over triangles, while `heightAt` is a
      // bilinear sample of the same grid, so the two differ by the
      // discretisation error of a 1.3m cell - centimetres, not metres. The
      // assertion is therefore pinned to a couple of centimetres: tight enough
      // to catch a scale factor or a swapped axis, loose enough to tolerate
      // the representation change.
      expect(Math.abs(hit!.distance - 200), `wrong hit at ${x},${z}`).toBeLessThan(0.05);
    }
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

    const surface = world.terrain.heightAt(0, 0);

    for (let i = 0; i < 600; i += 1) world.fixedUpdate(FIXED_STEP);

    // Settles on the terrain at the spawn XZ, not on a flat plane at y = 0.
    //
    // On a slope the capsule rests *higher* than on flat ground, but only by
    // the radius term. The cylinder section is parallel to the player's axis
    // and gains nothing from the tilt; the spherical cap does, because it
    // contacts the surface along the normal. So the centre comes to rest at
    //
    //   surface + halfHeight + radius / normal.y
    //
    // and not at `surface + halfHeight / normal.y`, which would overstate the
    // slope effect by the whole cylinder height. This is measured, not
    // derived on the spot - see the table this was calibrated against.
    const normal = world.terrain.normalAt(0, 0);
    expect(world.player.position.y).toBeCloseTo(
      surface + PLAYER_HALF_HEIGHT + PLAYER_RADIUS / normal.y,
      2,
    );

    // The mesh only follows on the render path - `fixedUpdate` deliberately
    // never touches it, so physics stays out of the presentation layer. It is
    // still sitting where it was created, which is the spawn height the
    // terrain gave it, not the settled height.
    const spawnY = world.player.mesh.position.y;
    expect(spawnY).toBeGreaterThan(surface);
    expect(spawnY).toBeGreaterThan(world.player.position.y);

    world.update(0);
    // The mesh is an exact copy of the body, and Rapier's contact solver
    // leaves a few 1e-5 of margin above the ground, so the rest height is
    // asserted to 3dp rather than treated as exact.
    expect(world.player.mesh.position.y).toBe(world.player.position.y);
    expect(world.player.mesh.position.y).toBeCloseTo(
      surface + PLAYER_HALF_HEIGHT + PLAYER_RADIUS / world.terrain.normalAt(0, 0).y,
      3,
    );
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
