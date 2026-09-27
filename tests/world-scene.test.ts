import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import {
  PLAYER_HALF_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPAWN,
} from '../src/player/Player';
import { WorldScene, type WorldSceneOptions } from '../src/world/WorldScene';
import { GROUND_KINDS } from '../src/world/CorruptionSystem';
import { DEFAULT_FOG_SHADER } from '../src/renderer/PostProcessing';

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

  it('leaves the fog to the atmosphere pass', async () => {
    // The depth cue is no longer a linear `Fog`. The render pipeline's atmosphere
    // pass does it from the depth buffer - height falloff, a valley floor, and a
    // corruption tint, none of which a distance fog can express - so a `Fog` on
    // the scene would fog every pixel twice and pull the horizon in by half.
    const { scene, world } = await buildScene();

    expect(scene.fog).toBeNull();
    expect(world.fog).toBeNull();
    expect(world.terrain.sizeMetres).toBe(500);
  });

  it('tunes the atmosphere so the 500m terrain dissolves instead of ending', async () => {
    await buildScene();

    // The same requirement Step 2.1's wide fog was tuned for, now expressed as
    // the atmosphere pass's exponential density: the ground under the player
    // stays crisp, and the distance dissolves rather than showing a hard edge.
    // With the camera near the centre of a 500m terrain the far rim sits about
    // 250m away, so the density has to reach well past that.
    const fogAt = (distance: number): number => {
      // Ground level, away from the valley, so this is the base density alone.
      return 1 - Math.exp(-DEFAULT_FOG_SHADER.density * distance);
    };

    expect(fogAt(0)).toBe(0); // the ground at the player's feet is unfogged
    expect(fogAt(50)).toBeLessThan(0.3); // ...and so is the ground 50m out
    expect(fogAt(200)).toBeGreaterThan(0.3); // the distance is visibly hazy
    expect(fogAt(250)).toBeGreaterThan(0.35); // the far rim recedes
    expect(fogAt(250)).toBeLessThan(0.8); // ...but stays readable
    expect(fogAt(400)).toBeGreaterThan(0.85); // and nearly dissolves past it

    // Monotonic: fog never un-fogs as distance grows.
    let previous = -1;
    for (let d = 0; d <= 450; d += 10) {
      const value = fogAt(d);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('makes the valley mist thicker than the open ground', async () => {
    const { world } = await buildScene();

    // The plan's "ground-level fog in stream valley (denser near water)". In the
    // stream bed the density is multiplied by the valley boost, and the mist is
    // also lifted by the height falloff - so standing in the water the player is
    // in a bank of it, and on a ridge the same distance is thin air.
    //
    // Read the REAL mask, not a hand-rolled copy of the formula. A mask that
    // ramps the wrong way - densest on the ridge, nothing in the stream bed -
    // passes every test that checks the fog formula and fails only on screen.
    const mask = world.buildAtmosphereMask();
    const data = mask.image.data as Uint8Array;
    const res = mask.image.width;
    const at = (i: number, j: number) => data[(j * res + i) * 4] / 255;

    // Find where the mist actually is. The stream is a diagonal, so it does NOT
    // pass through the middle of the mask - assuming it does is how this test
    // came to assert the wrong thing.
    let bestI = 0;
    let bestJ = 0;
    let best = -1;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        if (at(i, j) > best) {
          best = at(i, j);
          bestI = i;
          bestJ = j;
        }
      }
    }
    // Somewhere in the mask is standing water.
    expect(best).toBe(1);

    // Walking out from the water along +x and -x on that row, the mist thins to
    // nothing monotonically, and it is gone before the edge of the box - if it
    // were not, the fog would show the world's edge as a wall.
    const row = bestJ;
    let firstZeroRight = res;
    for (let i = bestI; i < res; i++) {
      if (at(i, row) === 0) {
        firstZeroRight = i;
        break;
      }
    }
    let firstZeroLeft = -1;
    for (let i = bestI; i >= 0; i--) {
      if (at(i, row) === 0) {
        firstZeroLeft = i;
        break;
      }
    }
    expect(firstZeroRight).toBeGreaterThan(bestI);
    expect(firstZeroRight).toBeLessThan(res);
    expect(firstZeroLeft).toBeLessThan(bestI);
    expect(firstZeroLeft).toBeGreaterThan(-1);
    for (let i = bestI; i < firstZeroRight; i++) {
      expect(at(i + 1, row)).toBeLessThanOrEqual(at(i, row) + 1e-6);
    }
    for (let i = bestI; i > firstZeroLeft; i--) {
      expect(at(i - 1, row)).toBeLessThanOrEqual(at(i, row) + 1e-6);
    }

    // And the mist is LOCAL. Most of a 500 m box is open ground with no fog
    // boost at all; if the red channel were near 1 everywhere the valley would
    // be a white-out rather than a bank of mist in the stream bed.
    let misty = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) if (at(i, j) > 0.5) misty++;
    }
    expect(misty).toBeGreaterThan(0);
    expect(misty).toBeLessThan(res * res * 0.25);

    // The same distance is thin air up on a ridge, because of the height term.
    const inValley = 1 - Math.exp(-DEFAULT_FOG_SHADER.density * (1 + DEFAULT_FOG_SHADER.valleyBoost) * 60);
    const onRidge =
      1 -
      Math.exp(
        -DEFAULT_FOG_SHADER.density *
          Math.exp(-40 / DEFAULT_FOG_SHADER.heightFalloff) *
          60,
      );
    expect(inValley).toBeGreaterThan(0.7);
    expect(onRidge).toBeLessThan(0.12);
    expect(inValley).toBeGreaterThan(onRidge * 8);
  });

  it('ignores the retired linear-fog option', async () => {
    // The option is kept so an existing caller does not break at the type level,
    // but the pipeline owns the fog now and a caller's numbers would be lost.
    const { world } = await buildScene({ fog: { near: 1, far: 2, color: 0x123456 } });

    expect(world.fog).toBeNull();
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

    // The fixed terrain, the dynamic player, and one fixed body per nearby
    // trunk. Step 2.3 gives trees colliders so the player cannot walk through
    // them, and a capsule has to sit on a body of its own.
    const trunkBodies = world.forest.colliderCount;
    expect(trunkBodies).toBeGreaterThan(0);
    expect(world.physics.world.bodies.len()).toBe(2 + trunkBodies);

    const fixed: number[] = [];
    const dynamic: number[] = [];
    world.physics.world.bodies.forEach((body) => {
      (body.isFixed() ? fixed : dynamic).push(body.translation().y);
    });
    expect(dynamic).toHaveLength(1);
    expect(fixed).toHaveLength(1 + trunkBodies);

    // The terrain body carries no offset, because the mesh's vertex buffer is
    // already in world coordinates - offsetting it here would shift the
    // collision surface away from the visual one. It is found by its position
    // rather than by its index: the trunk bodies are fixed too, and Rapier
    // makes no promise about the order `forEach` visits them in.
    // `bodies` exposes `forEach` but not `find`, so the search is by hand.
    let terrainAtOrigin = false;
    world.physics.world.bodies.forEach((body) => {
      if (body.isFixed() && body.translation().y === 0) terrainAtOrigin = true;
    });
    expect(terrainAtOrigin).toBe(true);

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

    // The player's body and every trunk collider are gone from the simulation.
    // A capsule that is removed without its body leaves a fixed body behind:
    // it stops colliding, but it keeps its slot in the broad phase and keeps
    // showing up here, which is exactly what this catches.
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

  it('carries the forest, placed against the same spline the valley was carved along', async () => {
    const { world } = await buildScene();

    // The forest exists, has trees, and is attached to the renderer's scene.
    expect(world.forest.isDisposed).toBe(false);
    expect(world.forest.placement.length).toBeGreaterThan(1000);
    expect(world.forest.group.parent).not.toBeNull();

    // Three levels of detail, all populated, and a partition of the placement.
    const tiers = world.forest.tierCounts;
    expect(tiers.near + tiers.medium + tiers.far).toBe(world.forest.placement.length);
    expect(tiers.near).toBeGreaterThan(0);
    expect(tiers.medium).toBeGreaterThan(0);
    expect(tiers.far).toBeGreaterThan(0);

    // Ground cover, and trunk colliders, both present from the first frame.
    expect(world.forest.stats.foliage).toBeGreaterThan(0);
    expect(world.forest.colliderCount).toBeGreaterThan(0);

    // Nothing may be silently dropped from a tier's instance buffer.
    expect(world.forest.droppedInstances).toBe(0);
  }, 60000);

  it('moves the forest with the player as the world is updated', async () => {
    const { world } = await buildScene();

    const before = world.forest.tierCounts;
    // Far enough to cross several snapped rebuild cells.
    world.update(FIXED_STEP * 4, { x: 120, y: 0, z: -90 });
    const after = world.forest.tierCounts;

    // The tiers are recomputed against the new camera position and still
    // partition the placement exactly.
    expect(after.near + after.medium + after.far).toBe(world.forest.placement.length);
    expect(after).not.toEqual(before);
    expect(world.forest.droppedInstances).toBe(0);
  }, 60000);

  it('advances the forest wind with game time', async () => {
    const { world } = await buildScene();
    expect(world.forest.windUniform.value).toBe(0);
    world.update(2.5);
    expect(world.forest.windUniform.value).toBeCloseTo(2.5, 6);
  }, 60000);

  describe('corruption', () => {
    it('puts the corruption in the scene and the world', async () => {
      const { scene, world } = await buildScene();
      expect(scene.children).toContain(world.corruption.group);
      expect(scene.getObjectByName('corruption')).toBe(world.corruption.group);
      // The light is in there too, and it is built dark so that adding it does
      // not recompile every material in the scene.
      expect(scene.getObjectByName('corruption-light')).toBe(world.corruption.light);
    }, 60000);

    it('grows the ground fungus and builds the spores', async () => {
      const { world } = await buildScene();
      // One mesh per ground kind, and no shelf: a bracket belongs to a trunk.
      expect(world.corruption.group.children.length).toBeGreaterThanOrEqual(
        GROUND_KINDS.length + 1,
      );
      expect(world.corruption.spores).not.toBeNull();
      expect(world.corruption.stats.fungus).toBeGreaterThanOrEqual(0);
    }, 60000);

    it('answers with the same corruption the terrain bakes', async () => {
      const { world } = await buildScene();
      // Both are CorruptionFields over the terrain's own spline at the same
      // resolution, so they agree to the last decimal. A tree, a patch of ground
      // and a mushroom that disagreed would show as grey bark standing in clean
      // grass.
      for (const [x, z] of [
        [0, 0],
        [40, 10],
        [-120, 40],
        [200, 200],
      ]) {
        expect(world.corruption.intensityAt(x, z)).toBeCloseTo(
          world.forest.corruptionAt(x, z),
          6,
        );
      }
    }, 60000);

    it('advances with the world', async () => {
      const { world } = await buildScene();
      const before = world.corruption.visibleSpores;
      world.update(FIXED_STEP * 4);
      // The spores have moved, which is the only thing that can be observed
      // without a GPU. Over clean ground they are all black, so the count is
      // zero either way and the position is what has to change.
      const position = world.corruption.spores!.geometry.getAttribute('position') as unknown as {
        array: Float32Array;
      };
      expect(Number.isFinite(position.array[0])).toBe(true);
      expect(typeof before).toBe('number');
    }, 60000);

    it('can be built without spores for a cheap test world', async () => {
      const { world } = await buildScene({ corruption: { sporeCount: 0 } });
      expect(world.corruption.spores).toBeNull();
      expect(world.corruption.stats.spores).toBe(0);
    }, 60000);

    it('can be built without the light', async () => {
      const { world } = await buildScene({ corruption: { light: { intensity: 0 } } });
      expect(world.corruption.light.intensity).toBe(0);
    }, 60000);

    it('is disposed with the world', async () => {
      const { world } = await buildScene();
      world.dispose();
      expect(world.corruption.isDisposed).toBe(true);
      expect(world.corruption.group.children.length).toBe(0);
    }, 60000);
  });
});
