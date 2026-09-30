/**
 * Player - the procedural character on a capsule collider.
 *
 * The assertion that earns its keep here is still the mesh/collider dimension
 * match, and it got *more* important when the capsule became a rig. A render
 * mesh that disagrees with its collider is nearly impossible to spot by eye and
 * every later system (camera framing, ground checks, the encounter system)
 * inherits the mistake. With a rig there are two ways to get it wrong rather
 * than one: the proportions can be wrong, and the *origin* can be wrong - the
 * capsule is centred at half height while the rig's origin is its feet. Both are
 * asserted below against the collider and against the ground.
 */
import { describe, expect, it } from 'vitest';
import { Box3, Group, Object3D, type MeshStandardMaterial } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import {
  PLAYER_FOOT_OFFSET,
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

/** True if `node` sits inside `ancestor`'s subtree. */
function isDescendantOf(node: Object3D, ancestor: Object3D): boolean {
  let parent = node.parent;
  while (parent !== null) {
    if (parent === ancestor) return true;
    parent = parent.parent;
  }
  return false;
}

/**
 * The rig's world-space bounding box.
 *
 * `setFromObject` walks the hierarchy, so this is the whole character - torso,
 * limbs, pauldrons, the sheathed greatsword and all - rather than one part. The
 * collider has to agree with *this*, not with a single cylinder.
 */
function rigBox(player: Player): Box3 {
  player.mesh.updateMatrixWorld(true);
  return new Box3().setFromObject(player.mesh);
}

describe('Player', () => {
  it('builds a procedural character and a matching dynamic capsule collider', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    // The render root is the rig's Group, not a capsule any more. It is still
    // called `mesh` so that every caller above this class - addTo, removeFrom,
    // and MovementController's player.mesh.rotation.y - works unchanged.
    expect(player.mesh).toBeInstanceOf(Group);
    expect(player.mesh.name).toBe('player');
    expect(player.body.isDynamic()).toBe(true);

    expect(player.radius).toBe(PLAYER_RADIUS);
    expect(player.height).toBe(PLAYER_HEIGHT);
    expect(PLAYER_HALF_HEIGHT).toBeCloseTo((PLAYER_HEIGHT - 2 * PLAYER_RADIUS) / 2, 10);

    // A rig, not a single mesh: many parts, a real skeleton, and the greatsword.
    expect(player.character.parts.length).toBeGreaterThan(15);
    expect(player.character.bones.length).toBeGreaterThanOrEqual(20);
    expect(player.character.sword).not.toBeNull();

    physics.dispose();
  });

  it('makes the character and the collider the same size', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    // The collider: a capsule of total height 2 * halfHeight + 2 * radius.
    const capsule = player.collider.shape as unknown as {
      radius: number;
      halfHeight: number;
    };
    expect(capsule.radius).toBeCloseTo(PLAYER_RADIUS, 6);
    expect(2 * capsule.halfHeight + 2 * capsule.radius).toBeCloseTo(PLAYER_HEIGHT, 6);

    // The *body* has to fit inside it. A rig taller than its collider is a head
    // poking through ceilings; a body wider than the capsule is a shoulder
    // catching on doorways the player walks straight through.
    //
    // The greatsword is excluded, and that is not a fudge: a 1.45 m blade slung
    // from a 1.48 m shoulder cannot stay inside a 0.7 m capsule, and it angles
    // out to the character's left precisely so it clears the legs. See the note
    // in CharacterGenerator and the dedicated test in
    // tests/character-generator.test.ts. The capsule approximates the body, and
    // the body is what has to be right.
    const bodyReach = player.character.parts
      .filter((part) => !isDescendantOf(part, player.character.sword))
      .map((part) => {
        part.geometry.computeBoundingBox();
        const b = part.geometry.boundingBox!.clone().applyMatrix4(part.matrixWorld);
        return Math.max(Math.abs(b.max.x), Math.abs(b.min.x));
      });
    const widest = Math.max(...bodyReach);
    expect(widest).toBeLessThanOrEqual(PLAYER_RADIUS);
    // And it is close to filling the capsule, so the collider is not wildly
    // oversized for the character standing inside it.
    expect(widest).toBeGreaterThan(PLAYER_RADIUS * 0.9);

    // Vertically, the whole character - sword included - runs soles to crown.
    const box = rigBox(player);
    const rigHeight = box.max.y - box.min.y;
    expect(rigHeight).toBeGreaterThan(PLAYER_HEIGHT * 0.95);
    expect(rigHeight).toBeLessThanOrEqual(PLAYER_HEIGHT);

    // And the character was generated at the collider's height, not at the
    // generator's own default - otherwise a custom height would leave the two
    // disagreeing by whatever the difference happens to be.
    expect(player.character.proportions.height).toBeCloseTo(PLAYER_HEIGHT, 6);

    physics.dispose();
  });

  it("puts the character feet on the ground, not at the capsule centre", async () => {
    // The offset that is easiest to get wrong: the capsule is centred at half
    // height while the rig's origin is its soles. Get it wrong in either
    // direction and the character floats half a body above the terrain or sinks
    // through it - both of which read as a physics bug, not an offset mistake.
    const physics = await makeWorld();
    physics.createGround(50);
    const player = new Player({ physics });

    for (let i = 0; i < 600; i += 1) physics.step(FIXED_STEP);
    player.syncMesh();

    // The body rests with its lowest cap on y = 0.
    expect(player.position.y).toBeCloseTo(player.restHeight, 2);

    // So the root sits at the feet, and the soles land on the ground with it.
    expect(player.mesh.position.y).toBeCloseTo(player.position.y - PLAYER_FOOT_OFFSET, 6);
    const box = rigBox(player);
    expect(box.min.y).toBeGreaterThan(-0.05);
    expect(box.min.y).toBeLessThan(0.05);

    physics.dispose();
  });

  it('spawns at (0, 1, 0) as the Step 1.3 spec requires', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    expect(player.position).toEqual({ x: 0, y: 1, z: 0 });
    expect(PLAYER_SPAWN).toEqual({ x: 0, y: 1, z: 0 });

    // The root starts on the body, so the character is never drawn at the
    // origin for a frame before the first sync - lifted by the foot offset,
    // because the rig's origin is the ground and the body's is the midpoint.
    expect(player.mesh.position.toArray()).toEqual([0, 1 - PLAYER_FOOT_OFFSET, 0]);

    physics.dispose();
  });

  it('honours a custom spawn point', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics, spawn: { x: 3, y: 4, z: -5 } });

    expect(player.position).toEqual({ x: 3, y: 4, z: -5 });
    expect(player.mesh.position.toArray()).toEqual([3, 4 - PLAYER_FOOT_OFFSET, -5]);

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
    expect(player.mesh.position.toArray()).toEqual([1, 2 - PLAYER_FOOT_OFFSET, 3]);

    player.body.setTranslation({ x: -4, y: 0.5, z: 7 }, true);
    player.syncMesh();
    expect(player.mesh.position.toArray()).toEqual([-4, 0.5 - PLAYER_FOOT_OFFSET, 7]);

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

  it('casts and receives a shadow, and wears the character materials', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    expect(player.mesh.castShadow).toBe(true);
    expect(player.mesh.receiveShadow).toBe(true);

    // Every part has to cast too: the root's flag is what the renderer reads
    // for the group, but a part with its own false would be skipped.
    for (const part of player.character.parts) {
      expect(part.castShadow, `${part.name} must cast a shadow`).toBe(true);
    }

    // Four material *kinds*, not one. The capsule had a single colour and a
    // single roughness; the character has skin, chain mail, leather and steel,
    // which is the whole point of the swap. There are more instances than four
    // because each chain mail part carries its own circumference and height, so
    // the kind is identified by the program cache key rather than by identity.
    const keys = new Set(
      player.character.parts.map((p) => (p.material as MeshStandardMaterial).customProgramCacheKey()),
    );
    expect([...keys].sort()).toEqual([
      'astra-chainmail-v1',
      'astra-leather-v1',
      'astra-skin-v1',
      'astra-steel-v1',
    ]);

    // And the sword is steel: high metalness, low roughness. A greatsword that
    // reads as painted metal is the one material mistake that ruins it.
    const steel = player.character.parts.find(
      (p) => (p.material as MeshStandardMaterial).customProgramCacheKey() === 'astra-steel-v1',
    );
    expect(steel).toBeDefined();
    const steelMaterial = steel!.material as MeshStandardMaterial;
    expect(steelMaterial.metalness).toBeGreaterThan(0.8);
    expect(steelMaterial.roughness).toBeLessThan(0.4);

    physics.dispose();
  });

  it('starts with the greatsword sheathed and the animation at idle', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    // The plan asks for the sword sheathed on the back. Nothing in Phase 2
    // draws it, so that is where it begins.
    expect(player.swordDrawn).toBe(false);
    expect(player.animator.state).toBe('idle');

    player.drawSword();
    expect(player.swordDrawn).toBe(true);
    player.sheatheSword();
    expect(player.swordDrawn).toBe(false);

    // Drawing it again must be a no-op rather than a second reparent.
    player.drawSword();
    player.drawSword();
    expect(player.swordDrawn).toBe(true);

    physics.dispose();
  });

  it('drives the animation from the body, not from the input', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    // Standing still, however hard the caller might be pushing.
    player.syncMesh(1 / 60);
    expect(player.animator.state).toBe('idle');

    // Moving, the animation follows what the body is doing. This is the point
    // of reading the velocity rather than the input: a character pinned against
    // a tree keeps asking to move, and one that keeps striding while pinned is
    // worse than one that stands still.
    player.body.setLinvel({ x: 4, y: 0, z: 0 }, true);
    player.syncMesh(1 / 60);
    expect(player.animator.state).toBe('walk');

    player.body.setLinvel({ x: 6, y: 0, z: 0 }, true);
    player.syncMesh(1 / 60);
    expect(player.animator.state).toBe('run');

    // Vertical velocity is not ground speed: falling is not walking.
    player.body.setLinvel({ x: 0, y: -9, z: 0 }, true);
    player.syncMesh(1 / 60);
    expect(player.animator.state).toBe('idle');

    physics.dispose();
  });

  it('advances the animation only when given a delta', async () => {
    const physics = await makeWorld();
    const player = new Player({ physics });

    const before = player.character.bone('head').position.y;
    player.syncMesh();
    expect(player.character.bone('head').position.y).toBeCloseTo(before, 6);

    // A frame of real time moves the breathing.
    for (let i = 0; i < 30; i += 1) player.syncMesh(1 / 60);
    expect(player.character.bone('hips').position.y).not.toBeCloseTo(before, 3);

    physics.dispose();
  });
});
