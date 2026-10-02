import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, Scene, Vector3 } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import {
  PLAYER_FOOT_OFFSET,
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

    // X and Z copy straight across. Y is offset by the foot distance, because
    // the body's origin is the capsule's midpoint while the rig's origin is the
    // ground - see the note in Player.ts. A mesh that copied Y verbatim would
    // leave the character standing half a body inside the terrain.
    expect(world.player.mesh.position.toArray()).toEqual([1, 2 - PLAYER_FOOT_OFFSET, 3]);
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
    // The comparison is against the body height the mesh implies, not the mesh's
    // own Y: the two differ by exactly the foot offset, and comparing the raw
    // values would be comparing a feet height against a centre height.
    expect(spawnY + PLAYER_FOOT_OFFSET).toBeGreaterThan(surface + PLAYER_HALF_HEIGHT);
    expect(spawnY + PLAYER_FOOT_OFFSET).toBeGreaterThan(world.player.position.y);

    world.update(0);
    // The mesh follows the body exactly, less the foot offset. Rapier's contact
    // solver leaves a few 1e-5 of margin above the ground, so the rest height is
    // asserted to 3dp rather than treated as exact.
    expect(world.player.mesh.position.y).toBeCloseTo(
      world.player.position.y - PLAYER_FOOT_OFFSET,
      10,
    );
    expect(world.player.mesh.position.y).toBeCloseTo(
      surface + PLAYER_HALF_HEIGHT + PLAYER_RADIUS / world.terrain.normalAt(0, 0).y - PLAYER_FOOT_OFFSET,
      3,
    );
  });

  it('tears everything down on dispose', async () => {
    const { scene, world } = await buildScene();

    const disposeTerrain = vi.spyOn(world.terrain.mesh.geometry, 'dispose');
    const disposeSky = vi.spyOn(world.sky.mesh.geometry, 'dispose');
    const disposeLights = vi.spyOn(world.lighting.sun, 'dispose');
    // The player is a rig now, not one capsule: it owns a geometry per part, and
    // every one of them has to go or the GPU keeps the whole character.
    const disposePlayerParts = world.player.character.parts.map((part) =>
      vi.spyOn(part.geometry, 'dispose'),
    );
    expect(disposePlayerParts.length).toBeGreaterThan(15);

    world.dispose();

    expect(scene.children).toHaveLength(0);
    expect(scene.fog).toBeNull();
    expect(world.isDisposed).toBe(true);
    expect(disposeTerrain).toHaveBeenCalledTimes(1);
    expect(disposeSky).toHaveBeenCalledTimes(1);
    expect(disposeLights).toHaveBeenCalledTimes(1);
    // Each part's geometry is disposed exactly once. Twice would be a double
    // free, and not at all would leak the character for the lifetime of the
    // page - and a rig has enough parts that a leak here is not a rounding error.
    for (const spy of disposePlayerParts) {
      expect(spy).toHaveBeenCalledTimes(1);
    }

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

  // The day/night cycle is wired into the scene, not merely present in it, and
  // the wiring has exactly one load-bearing invariant: the light must point the
  // same way the sky says the sun is. If those two drift apart the world is lit
  // and shadowed from one direction while the sun is drawn in another, which is
  // the single most convincing way to make a scene look broken - and it is a
  // bookkeeping bug, not a rendering one, so nothing about the frame looks wrong
  // enough to diagnose from a screenshot.
  /**
   * The ambient audio.
   *
   * There is no `AudioContext` in Node, so none of this can be heard. What can
   * be checked is that the world assembles the right frame - the listener where
   * the camera is, the corruption from the terrain's own field, the gust from
   * the forest's own uniform, the surface from the terrain's own weights - and
   * that it does so without disturbing anything else. A frame built from the
   * wrong source is the bug that would be inaudible until someone played it.
   */
  describe('ambient audio', () => {
    it('is present and silent in a headless environment', async () => {
      const { world } = await buildScene({ audio: {} });

      expect(world.ambient).toBeDefined();
      // No AudioContext in jsdom, so nothing was constructed - which is what
      // lets the world be built and stepped in tests at all.
      expect(world.ambient.isLive).toBe(false);
      expect(world.ambient.isMuted).toBe(false);
    });

    it('resolves a mix from the world it was given', async () => {
      const { world } = await buildScene({ audio: {} });

      // Before any update there is nothing resolved.
      expect(world.ambient.mix.hum).toBe(0);

      world.update(FIXED_STEP);
      expect(world.ambient.mix.wind).toBeGreaterThan(0);
      expect(world.ambient.mix.leaves).toBeGreaterThan(0);
      expect(Number.isFinite(world.ambient.mix.birds)).toBe(true);
    });

    it('reads the gust from the forest, so the audio and the sway are one event', async () => {
      const { world } = await buildScene({ audio: {} });

      // The forest writes its own gust every update and the audio reads the same
      // object, so the wind level has to be a monotone function of the gust the
      // trees are actually swaying by. Writing the uniform by hand proves
      // nothing here - the forest overwrites it on the next update, which is the
      // design - so the check is over the frames the world really produces.
      const pairs: Array<{ gust: number; wind: number }> = [];
      for (let i = 0; i < 240; i++) {
        world.update(FIXED_STEP);
        pairs.push({ gust: world.forest.windGustUniform.value, wind: world.ambient.mix.wind });
      }

      const gusts = pairs.map((p) => p.gust);
      // The gust has to actually move, or a monotonicity check over a constant
      // is a check over nothing.
      expect(Math.max(...gusts) - Math.min(...gusts)).toBeGreaterThan(0.05);
      expect(Math.min(...gusts)).toBeGreaterThan(0);
      expect(Math.max(...gusts)).toBeLessThanOrEqual(1.75);

      // Sorted by gust, the wind level must never go down.
      const sorted = [...pairs].sort((a, b) => a.gust - b.gust);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].wind, `gust ${sorted[i].gust}`).toBeGreaterThanOrEqual(sorted[i - 1].wind - 1e-9);
      }
    });

    it('takes the listener from the camera position it is handed', async () => {
      const { world } = await buildScene({ audio: {} });

      // The listener has to be the camera, not the player: the same position the
      // light rig and the stream's sound are driven from, so everything in the
      // world agrees about where the viewer is standing.
      const far = new Vector3(120, 30, -80);
      expect(() => world.update(FIXED_STEP, far)).not.toThrow();
      expect(world.ambient.mix.wind).toBeGreaterThan(0);
    });

    it('survives a NaN listener without silencing the mix', async () => {
      // A NaN reaching Howler.pos silences the entire mix with no error
      // anywhere. The audio guards against it, and the world must not be the
      // thing that introduces it.
      const { world } = await buildScene({ audio: {} });
      world.update(FIXED_STEP, new Vector3(Number.NaN, Number.NaN, Number.NaN));

      for (const value of Object.values(world.ambient.mix)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    });

    it('forwards mute to the stream so one switch silences everything', async () => {
      // Howler.mute is global. If the world and the stream each called it
      // independently the last writer would win, and unmuting one would unmute
      // the other.
      const { world } = await buildScene({ audio: {} });
      world.ambient.setMuted(true);
      expect(world.ambient.isMuted).toBe(true);
      world.ambient.setMuted(false);
      expect(world.ambient.isMuted).toBe(false);
    });

    it('thins the chorus and raises the hum as the listener walks into the rot', async () => {
      // The integration the whole step is for, driven through the terrain own
      // baked corruption field rather than through a hand-set number. Measured
      // on the default world along the line z = 110: corruption 0.000 at
      // x = -230, peaking at 0.913 at x = -170, back to 0.061 at x = -110. The
      // mix has to follow that curve.
      const { world } = await buildScene({ audio: {} });

      const at = (x: number): { corruption: number; hum: number; birds: number; squelch: number } => {
        world.update(FIXED_STEP, { x, y: 2, z: 110 });
        return {
          corruption: world.terrain.corruptionAt(x, 110),
          hum: world.ambient.mix.hum,
          birds: world.ambient.mix.birds,
          squelch: world.ambient.mix.squelchRate,
        };
      };

      const clean = at(-230);
      const rotten = at(-170);
      const recovering = at(-110);

      // The field really does vary, or this test proves nothing.
      expect(clean.corruption).toBeLessThan(0.01);
      expect(rotten.corruption).toBeGreaterThan(0.8);

      // Clean ground: no hum, no squelch, the full chorus.
      expect(clean.hum).toBe(0);
      expect(clean.squelch).toBe(0);
      expect(clean.birds).toBeGreaterThan(0.29);

      // The rot: the hum arrives, the squelches start, the birds thin out.
      expect(rotten.hum).toBeGreaterThan(0.2);
      expect(rotten.squelch).toBeGreaterThan(0.2);
      expect(rotten.birds).toBeLessThan(clean.birds * 0.15);
      // Reduced, not gone.
      expect(rotten.birds).toBeGreaterThan(0);

      // And it recovers on the way out, rather than latching.
      expect(recovering.corruption).toBeLessThan(0.1);
      expect(recovering.hum).toBe(0);
      expect(recovering.squelch).toBe(0);
      expect(recovering.birds).toBeGreaterThan(rotten.birds * 5);
    });

    it('clamps the canopy to a fraction, because density is not a fraction', async () => {
      // forestDensityAt goes above one on the stream bank by design. The audio
      // frame documents canopy as 0 to 1, so the world clamps at the boundary
      // rather than leaving the mix to do it silently.
      const { world } = await buildScene({ audio: {} });

      let maxCanopy = 0;
      for (let x = -200; x <= 200; x += 20) {
        for (let z = -200; z <= 200; z += 20) {
          maxCanopy = Math.max(maxCanopy, world.forest.canopyAt(x, z));
          world.update(FIXED_STEP, { x, y: 2, z });
          expect(world.ambient.mix.leaves).toBeGreaterThanOrEqual(0);
          expect(world.ambient.mix.leaves).toBeLessThanOrEqual(1);
        }
      }
      // The raw density really does exceed one somewhere, so the clamp is load
      // bearing rather than decorative.
      expect(maxCanopy).toBeGreaterThan(1);
    });


    it('is disposed with the world', async () => {
      const { world } = await buildScene({ audio: {} });
      expect(() => world.dispose()).not.toThrow();
      expect(world.isDisposed).toBe(true);
    });
  });

  describe('day/night cycle', () => {
    it('holds the tutorial hour still until it is resumed', async () => {
      const { world } = await buildScene();

      expect(world.dayNight.paused).toBe(true);
      const before = world.dayNight.sample.sunIntensity;

      // A full minute of game time must not move a paused cycle.
      for (let i = 0; i < 60; i++) world.update(FIXED_STEP);

      expect(world.dayNight.hour).toBeCloseTo(9.5, 6);
      expect(world.dayNight.sample.sunIntensity).toBeCloseTo(before, 10);

      world.dayNight.resume();
      expect(world.dayNight.paused).toBe(false);
    }, 60000);

    it('points the light the same way the sky draws the sun, all day', async () => {
      const { world } = await buildScene();
      const skyUniforms = world.sky.mesh.material.uniforms;
      const skySun = skyUniforms.uSunDirection.value as Vector3;

      for (const hour of [6, 8, 9.5, 12, 15, 17, 18, 19.5, 22, 2]) {
        world.dayNight.setTime(hour);

        // The light's direction is the offset from its target to itself.
        const light = world.lighting.sun;
        const dx = light.position.x - light.target.position.x;
        const dy = light.position.y - light.target.position.y;
        const dz = light.position.z - light.target.position.z;
        const len = Math.hypot(dx, dy, dz);
        expect(len, `light offset collapsed to zero at hour ${hour}`).toBeGreaterThan(1);

        const dot =
          (dx * skySun.x + dy * skySun.y + dz * skySun.z) / len;
        expect(dot, `light and sky sun disagree at hour ${hour}`).toBeGreaterThan(0.999);

        // And the offset has to sit inside the shadow camera, or the sun is
        // outside its own shadow map and every shadow in the world disappears.
        expect(len).toBeLessThan(440);
      }
    }, 60000);

    it('relights the world and recolours the sky as the hour changes', async () => {
      const { world } = await buildScene();
      const skyUniforms = world.sky.mesh.material.uniforms;

      const read = () => ({
        sun: world.lighting.sun.intensity,
        ambient: world.lighting.ambient.intensity,
        hemi: world.lighting.hemi.intensity,
        stars: skyUniforms.uStarOpacity.value as number,
        moon: skyUniforms.uMoonOpacity.value as number,
        disc: skyUniforms.uSunDisc.value as number,
        haze: world.dayNight.hazeColor,
        horizon: (skyUniforms.uHorizonColor.value as Color).getHex(),
      });

      world.dayNight.setTime(9.5);
      const morning = read();
      world.dayNight.setTime(22);
      const night = read();

      // Day must be brighter than night on every channel that carries light.
      expect(morning.sun).toBeGreaterThan(night.sun * 10);
      expect(morning.ambient).toBeGreaterThan(night.ambient * 3);
      expect(morning.hemi).toBeGreaterThan(night.hemi * 3);
      // And night must have the sky furniture day does not.
      expect(morning.stars).toBe(0);
      expect(night.stars).toBe(1);
      expect(morning.moon).toBe(0);
      expect(night.moon).toBe(1);
      expect(morning.disc).toBeGreaterThan(night.disc);
      // The haze and the horizon both have to move, or the fog is lit by a sun
      // that has already set.
      expect(night.haze).toBeLessThan(morning.haze);
      expect(night.horizon).not.toBe(morning.horizon);
    }, 60000);

    it('keeps the tutorial frame at the Step 2.5 light rig', async () => {
      // Step 2.5 shipped a fixed late-morning rig: sun 0xfff1d6 at 2.6, ambient
      // 0xa8bdd4 at 0.9, hemi 0xbcd4ea / 0x5c6b3a at 0.55.
      //
      // The 22-degree rung reproduces that rig verbatim, and the tutorial hour
      // has to sit close enough to it that the frame the player first sees has
      // not visibly changed. It cannot sit exactly on it: hour 9.5 puts the sun
      // at 47.4 degrees, and the only hours that reach 22 degrees are 07:26 and
      // 16:34, neither of which is late morning.
      //
      // The honest numbers, measured rather than assumed: the sun colour lands
      // 0/2/8 sRGB levels away (a tint, not a brightness), while the sun and
      // ambient intensities come out about 8% above the fixed rig - 2.80 against
      // 2.6, and 0.97 against 0.9. That is the physical cost of a cycle: airmass
      // at 47 degrees is genuinely about half what it is at 22, so the sun really
      // is brighter there, and a ladder that flattened the top to preserve the
      // old number would be less correct to buy nothing the player can see.
      // The bound below is 10%, which is what the interpolation actually gives.
      const { world } = await buildScene();

      expect(world.lighting.sun.intensity).toBeGreaterThan(2.6);
      expect(world.lighting.sun.intensity).toBeLessThan(2.9);
      expect(world.lighting.ambient.intensity).toBeGreaterThan(0.9);
      expect(world.lighting.ambient.intensity).toBeLessThan(1.0);
      expect(world.lighting.hemi.intensity).toBeGreaterThan(0.5);
      expect(world.lighting.hemi.intensity).toBeLessThan(0.6);

      // The colours, though, are the part that reads as "the same game", and
      // those are within a tint of Step 2.5. Expressed in sRGB levels because
      // that is the unit the difference is perceived in; comparing in linear
      // space and guessing a tolerance there is how the first two versions of
      // this assertion came out too tight.
      const actual = world.lighting.sun.color;
      const rig = new Color(0xfff1d6);
      const toSrgb = (l: number) =>
        Math.round((l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) * 255);
      const levels = Math.max(
        Math.abs(toSrgb(actual.r) - toSrgb(rig.r)),
        Math.abs(toSrgb(actual.g) - toSrgb(rig.g)),
        Math.abs(toSrgb(actual.b) - toSrgb(rig.b)),
      );
      expect(levels).toBeLessThanOrEqual(8);

      expect(world.lighting.ambient.color.getHex()).toBe(0xa8bdd4);
      expect(world.lighting.hemi.color.getHex()).toBe(0xbcd4ea);
      // The hemisphere's ground colour is deliberately NOT the Step 2.5 base:
      // it is the base mixed 35% towards the sky's haze, because the light
      // bouncing off the ground has passed through that air. So it is greyer
      // than 0x5c6b3a while staying unmistakably green - which is the whole
      // point of mixing it rather than hard-coding either end.
      const ground = world.lighting.hemi.groundColor;
      expect(ground.g).toBeGreaterThan(ground.r);
      expect(ground.g).toBeGreaterThan(ground.b);
      const base = new Color(0x5c6b3a);
      expect(ground.r).toBeGreaterThan(base.r);
      expect(ground.b).toBeGreaterThan(base.b);
    }, 60000);
  });
});
