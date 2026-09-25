/**
 * MovementController - the Step 1.4 behaviour.
 *
 * These tests are written against real physics wherever the behaviour depends
 * on it (walking speed, slopes, jumping, landing), because that is where the
 * interesting bugs live. A fake body would let a broken controller pass.
 */
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { InputManager } from '../src/core/InputManager';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { Player } from '../src/player/Player';
import {
  GROUND_ACCELERATION,
  GROUND_DECELERATION,
  GROUND_PROBE,
  JUMP_SPEED,
  MIN_STANDABLE_NORMAL_Y,
  MovementController,
  RUN_SPEED,
  TURN_SPEED,
  WALK_SPEED,
  wrapAngle,
  yawForDirection,
} from '../src/player/MovementController';

const FIXED = 1 / 60;

/** Keys the controller binds, as `event.code` values. */
const KEY = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  runLeft: 'ShiftLeft',
  runRight: 'ShiftRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  leftArrow: 'ArrowLeft',
  rightArrow: 'ArrowRight',
} as const;

/**
 * A real InputManager attached to a throwaway target, driven by dispatching
 * real KeyboardEvents. Using the real thing means these tests exercise the
 * actual edge detection the game relies on.
 */
function makeInput(): { input: InputManager; press: (code: string) => void; release: (code: string) => void; step: () => void } {
  const target = new EventTarget();
  const input = new InputManager({ target, canvas: null, eventBus: undefined });
  input.attach();

  const press = (code: string): void => {
    target.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
  };
  const release = (code: string): void => {
    target.dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
  };
  // One "frame" of input: the controller's fixed updates read the state that
  // update() publishes.
  const step = (): void => input.update();

  return { input, press, release, step };
}

interface Rig {
  physics: PhysicsWorld;
  player: Player;
  input: ReturnType<typeof makeInput>;
  movement: MovementController;
  /** One engine frame: poll input, then run the fixed steps it earns. */
  frame: (keys?: string[]) => void;
  run: (frames: number, keys?: string[]) => void;
  dispose: () => void;
}

async function makeRig(options: { spawn?: { x: number; y: number; z: number } } = {}): Promise<Rig> {
  const physics = await PhysicsWorld.create({ timestep: FIXED });
  physics.createGround(50);

  const player = new Player({ physics, spawn: options.spawn });
  const scene = new Scene();
  player.addTo(scene);

  const input = makeInput();
  const camera = new PerspectiveCamera(60, 1.6, 0.1, 2000);
  // The same framing RenderPipeline uses by default: behind and above the
  // player, looking slightly down. Its horizontal forward is world -Z.
  camera.position.set(0, 2.2, 8);
  camera.lookAt(0, 0.8, 0);
  camera.updateMatrixWorld(true);

  const movement = new MovementController({ player, input: input.input, camera, physics });

  // Settle onto the ground first so tests start from a resting state.
  for (let i = 0; i < 120; i += 1) {
    movement.fixedUpdate(FIXED);
    physics.step(FIXED);
  }

  const frame = (keys: string[] = []): void => {
    for (const key of keys) input.press(key);
    input.step();
    movement.fixedUpdate(FIXED);
    physics.step(FIXED);
    for (const key of keys) input.release(key);
  };

  return {
    physics,
    player,
    input,
    movement,
    frame,
    run: (frames, keys = []) => {
      for (let i = 0; i < frames; i += 1) frame(keys);
    },
    dispose: () => {
      input.input.dispose();
      physics.dispose();
    },
  };
}

/** Wait long enough for the controller to reach its target speed. */
const SETTLE_FRAMES = 120;

describe('wrapAngle / yawForDirection', () => {
  it('wraps angles into (-pi, pi]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0, 10);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2, 10);
    // Always the short way round.
    expect(Math.abs(wrapAngle(Math.PI * 1.9))).toBeLessThan(Math.PI / 2);
    expect(Math.abs(wrapAngle(-Math.PI * 1.9))).toBeLessThan(Math.PI / 2);
  });

  it('maps directions onto yaw using Three\'s -Z forward convention', () => {
    // rotation.y = 0 already faces -Z.
    expect(yawForDirection(0, -1)).toBeCloseTo(0, 10);
    // Facing +X is a quarter turn anticlockwise... which is -90 degrees.
    expect(yawForDirection(1, 0)).toBeCloseTo(-Math.PI / 2, 10);
    expect(Math.abs(yawForDirection(0, 1))).toBeCloseTo(Math.PI, 10);
    expect(yawForDirection(-1, 0)).toBeCloseTo(Math.PI / 2, 10);
  });
});

describe('MovementController: ground state', () => {
  it('reports grounded once the player has settled on the plane', async () => {
    const rig = await makeRig();
    expect(rig.movement.isGrounded).toBe(true);
    expect(rig.movement.surfaceNormal.y).toBeCloseTo(1, 6);
    expect(rig.player.position.y).toBeCloseTo(rig.player.restHeight, 2);
    rig.dispose();
  });

  it('reports airborne after a jump and grounded again on landing', async () => {
    const rig = await makeRig();
    expect(rig.movement.isGrounded).toBe(true);

    rig.run(1, [KEY.jump]);
    expect(rig.movement.isGrounded).toBe(false);

    // Long enough for the full arc: ~1 s at JUMP_SPEED 5.
    let landed = -1;
    for (let i = 0; i < 180; i += 1) {
      rig.frame();
      if (landed < 0 && rig.movement.justLanded) landed = i;
    }
    expect(landed).toBeGreaterThan(0);
    expect(rig.movement.isGrounded).toBe(true);
    expect(rig.player.position.y).toBeCloseTo(rig.player.restHeight, 2);

    rig.dispose();
  });

  it('reports airborne when the player walks off the edge of the plane', async () => {
    // Spawn near the slab's edge so a couple of seconds of walking clears it.
    const rig = await makeRig({ spawn: { x: 45, y: 1, z: 0 } });
    for (let i = 0; i < 120; i += 1) rig.frame([KEY.right]);

    expect(rig.movement.isGrounded).toBe(false);
    expect(rig.player.position.x).toBeGreaterThan(50);
    expect(rig.player.position.y).toBeLessThan(0);

    rig.dispose();
  });
});

describe('MovementController: walking', () => {
  it('moves at walk speed in the camera-forward direction', async () => {
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.forward]);

    // The default camera looks down -Z, so W carries the player to -Z.
    expect(rig.player.position.z).toBeLessThan(-1);
    expect(Math.abs(rig.player.position.x)).toBeLessThan(0.5);
    expect(rig.movement.horizontalSpeed).toBeCloseTo(WALK_SPEED, 2);

    rig.dispose();
  });

  it('moves backwards, left and right relative to the camera', async () => {
    const back = await makeRig();
    back.run(SETTLE_FRAMES, [KEY.back]);
    expect(back.player.position.z).toBeGreaterThan(1);
    back.dispose();

    const left = await makeRig();
    left.run(SETTLE_FRAMES, [KEY.left]);
    expect(left.player.position.x).toBeLessThan(-1);
    left.dispose();

    const right = await makeRig();
    right.run(SETTLE_FRAMES, [KEY.right]);
    expect(right.player.position.x).toBeGreaterThan(1);
    right.dispose();
  });

  it('accepts the arrow keys as aliases', async () => {
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.up]);
    expect(rig.player.position.z).toBeLessThan(-1);
    rig.dispose();
  });

  it('does not let diagonal input move faster than cardinal input', async () => {
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.forward, KEY.right]);

    // The direction is diagonal...
    expect(rig.player.position.x).toBeGreaterThan(0.5);
    expect(rig.player.position.z).toBeLessThan(-0.5);
    // ...but the speed is still the walk speed, not sqrt(2) times it.
    expect(rig.movement.horizontalSpeed).toBeCloseTo(WALK_SPEED, 2);

    rig.dispose();
  });

  it('runs at 6 m/s while Shift is held and returns to walk speed after', async () => {
    const rig = await makeRig();

    rig.run(SETTLE_FRAMES, [KEY.forward, KEY.runLeft]);
    expect(rig.movement.isRunning).toBe(true);
    expect(rig.movement.horizontalSpeed).toBeCloseTo(RUN_SPEED, 2);

    rig.run(SETTLE_FRAMES, [KEY.forward]);
    expect(rig.movement.isRunning).toBe(false);
    expect(rig.movement.horizontalSpeed).toBeCloseTo(WALK_SPEED, 2);

    rig.dispose();
  });

  it('accelerates smoothly rather than snapping to full speed', async () => {
    const rig = await makeRig();

    rig.frame([KEY.forward]);
    const afterOne = rig.movement.horizontalSpeed;
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(WALK_SPEED);

    // Roughly one step of acceleration, not an instant jump to top speed.
    expect(afterOne).toBeCloseTo(GROUND_ACCELERATION * FIXED, 1);

    // And it keeps climbing monotonically. The slack is float32: Rapier stores
    // velocity in f32, so 3.5 comes back as 3.4999618.
    let previous = afterOne;
    for (let i = 0; i < 20; i += 1) {
      rig.frame([KEY.forward]);
      const speed = rig.movement.horizontalSpeed;
      expect(speed).toBeGreaterThanOrEqual(previous - 1e-3);
      previous = speed;
    }

    rig.dispose();
  });

  it('decelerates smoothly to a full stop when input is released', async () => {
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.forward]);

    rig.frame();
    const afterOne = rig.movement.horizontalSpeed;
    expect(afterOne).toBeLessThan(WALK_SPEED);
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeCloseTo(WALK_SPEED - GROUND_DECELERATION * FIXED, 1);

    rig.run(60);
    expect(rig.movement.horizontalSpeed).toBeCloseTo(0, 3);

    rig.dispose();
  });

  it('comes to a complete stop, not a crawl', async () => {
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.forward, KEY.right]);
    rig.run(120);
    expect(rig.movement.horizontalSpeed).toBeCloseTo(0, 4);
    rig.dispose();
  });
});

describe('MovementController: facing', () => {
  it('turns the mesh to face the direction of travel', async () => {
    const rig = await makeRig();
    expect(rig.player.mesh.rotation.y).toBeCloseTo(0, 6);

    // Camera forward is -Z, so the character should end up facing -Z too,
    // which is rotation.y = 0.
    rig.run(SETTLE_FRAMES, [KEY.forward]);
    expect(Math.abs(wrapAngle(rig.player.mesh.rotation.y))).toBeLessThan
      (0.05);

    // Now strafe right: +X is a quarter turn to the character's right.
    rig.run(SETTLE_FRAMES, [KEY.right]);
    expect(rig.player.mesh.rotation.y).toBeCloseTo(-Math.PI / 2, 1);

    rig.dispose();
  });

  it('turns smoothly rather than snapping', async () => {
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.forward]);

    rig.frame([KEY.back]);
    const afterOne = rig.player.mesh.rotation.y;
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(Math.PI);
    // One step of turn rate, not an instant about-face.
    expect(afterOne).toBeCloseTo(TURN_SPEED * FIXED, 2);

    rig.dispose();
  });

  it('takes the short way round when the direction reverses', async () => {
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.forward]);

    // Turn to face +Z by walking backwards, then reverse again. The rotation
    // must stay near 0/pi rather than winding up to 2pi.
    rig.run(SETTLE_FRAMES, [KEY.back]);
    const first = wrapAngle(rig.player.mesh.rotation.y);
    expect(Math.abs(first)).toBeGreaterThan(2.5); // facing +Z

    rig.run(SETTLE_FRAMES, [KEY.forward]);
    const second = wrapAngle(rig.player.mesh.rotation.y);
    expect(Math.abs(second)).toBeLessThan(0.2); // back to -Z, not 2pi

    rig.dispose();
  });

  it('holds its facing when there is no input', async () => {
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.right]);
    const facing = rig.player.mesh.rotation.y;

    rig.run(60);
    expect(rig.player.mesh.rotation.y).toBe(facing);

    rig.dispose();
  });

  it('never touches the physics body\'s rotation, which is locked', async () => {
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.forward, KEY.right]);

    const q = rig.player.body.rotation();
    expect(Math.abs(q.w)).toBeCloseTo(1, 6);
    expect(Math.abs(q.x)).toBeLessThan(1e-6);
    expect(Math.abs(q.z)).toBeLessThan(1e-6);

    rig.dispose();
  });
});

describe('MovementController: jumping', () => {
  it('leaves the ground at the configured jump speed', async () => {
    const rig = await makeRig();
    const rest = rig.player.position.y;

    rig.frame([KEY.jump]);
    // Gravity is on for the take-off step, so the velocity the body holds once
    // the step has run is the jump speed less one step of gravity.
    const expected = JUMP_SPEED + rig.physics.gravity.y * FIXED;
    expect(rig.player.body.linvel().y).toBeCloseTo(expected, 3);
    expect(rig.player.position.y).toBeGreaterThan(rest);

    rig.dispose();
  });

  it('reaches an apex of roughly v^2 / 2g', async () => {
    const rig = await makeRig();
    const rest = rig.player.position.y;

    rig.frame([KEY.jump]);
    let apex = rest;
    for (let i = 0; i < 120; i += 1) {
      rig.frame();
      apex = Math.max(apex, rig.player.position.y);
    }

    const expected = (JUMP_SPEED * JUMP_SPEED) / (2 * 9.81);
    expect(apex - rest).toBeGreaterThan(expected * 0.9);
    expect(apex - rest).toBeLessThan(expected * 1.1);

    rig.dispose();
  });

  it('cannot jump again while airborne', async () => {
    const rig = await makeRig();
    rig.frame([KEY.jump]);
    const afterFirst = rig.player.body.linvel().y;

    // Hold the key down: no new press is detected, so no second jump.
    rig.input.press(KEY.jump);
    for (let i = 0; i < 30; i += 1) {
      rig.input.step();
      rig.movement.fixedUpdate(FIXED);
      rig.physics.step(FIXED);
    }
    rig.input.release(KEY.jump);

    // Still rising from the first jump, but nowhere near a double jump.
    expect(rig.player.body.linvel().y).toBeLessThan(afterFirst);
    rig.dispose();
  });

  it('fires exactly one jump per press, even with several fixed steps per frame', async () => {
    const rig = await makeRig();

    // One frame in which the engine issues three fixed steps. No physics step
    // runs between them, so the ground probe still reports "grounded" on the
    // second and third - the worst case for a controller that polls an
    // edge-detected key press and then ramps velocity.
    rig.input.press(KEY.jump);
    rig.input.step();
    for (let i = 0; i < 3; i += 1) rig.movement.fixedUpdate(FIXED);
    rig.physics.step(FIXED);
    rig.input.release(KEY.jump);

    const expected = JUMP_SPEED + rig.physics.gravity.y * FIXED;
    expect(rig.player.body.linvel().y).toBeCloseTo(expected, 3);
    rig.dispose();
  });

  it('cannot jump in mid-air after walking off a ledge', async () => {
    const rig = await makeRig({ spawn: { x: 40, y: 1, z: 0 } });
    rig.run(200, [KEY.right]);
    expect(rig.movement.isGrounded).toBe(false);

    const before = rig.player.body.linvel().y;
    rig.run(1, [KEY.jump]);
    // Gravity is still in charge; no second impulse was added.
    expect(rig.player.body.linvel().y).toBeLessThanOrEqual(before + 1e-6);

    rig.dispose();
  });

  it('keeps horizontal momentum through a jump', async () => {
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.forward]);
    const horizontal = rig.movement.horizontalSpeed;

    rig.run(1, [KEY.forward, KEY.jump]);
    expect(rig.movement.horizontalSpeed).toBeCloseTo(horizontal, 1);

    rig.dispose();
  });
});

describe('MovementController: slopes', () => {
  it('does not slide down a slope when standing still', async () => {
    const { default: RAPIER } = await import('@dimforge/rapier3d-compat');
    await RAPIER.init();

    const physics = await PhysicsWorld.create({ timestep: FIXED });
    const angle = 45;
    const a = (angle * Math.PI) / 180;
    const groundBody = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0).setRotation(
        new RAPIER.Quaternion(0, 0, Math.sin(a / 2), Math.cos(a / 2)),
      ),
    );
    const groundCollider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(50, 0.5, 50),
      groundBody,
    );
    groundCollider.setFriction(1);

    const player = new Player({ physics, spawn: { x: 0, y: 6, z: 0 } });
    const input = makeInput();
    const camera = new PerspectiveCamera(60, 1.6, 0.1, 2000);
    camera.position.set(0, 2.2, 8);
    camera.lookAt(0, 0.8, 0);
    camera.updateMatrixWorld(true);

    const movement = new MovementController({ player, input: input.input, camera, physics });

    // 15 seconds of standing still on a 45-degree slope.
    for (let i = 0; i < 900; i += 1) {
      movement.fixedUpdate(FIXED);
      physics.step(FIXED);
    }

    const drift = Math.abs(player.position.x);
    const speed = movement.horizontalSpeed;
    expect(movement.isGrounded).toBe(true);
    expect(movement.surfaceNormal.y).toBeCloseTo(Math.cos(a), 2);
    // Rapier's default 0.5 friction drifts 0.61 m here; 1.0 drifts 0.004 m.
    expect(drift).toBeLessThan(0.05);
    expect(speed).toBeLessThan(0.05);

    input.input.dispose();
    physics.dispose();
  });

  it('keeps full ground speed walking up a slope', async () => {
    const { default: RAPIER } = await import('@dimforge/rapier3d-compat');
    await RAPIER.init();

    const physics = await PhysicsWorld.create({ timestep: FIXED });
    const angle = 30;
    const a = (angle * Math.PI) / 180;
    const groundBody = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0).setRotation(
        new RAPIER.Quaternion(0, 0, Math.sin(a / 2), Math.cos(a / 2)),
      ),
    );
    const groundCollider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(50, 0.5, 50),
      groundBody,
    );
    groundCollider.setFriction(1);

    const player = new Player({ physics, spawn: { x: 0, y: 8, z: 0 } });
    const input = makeInput();
    const camera = new PerspectiveCamera(60, 1.6, 0.1, 2000);
    // Facing +X, which is the uphill direction for this slope.
    camera.position.set(-8, 2.2, 0);
    camera.lookAt(0, 0.8, 0);
    camera.updateMatrixWorld(true);
    const movement = new MovementController({ player, input: input.input, camera, physics });

    const frame = (keys: string[]): void => {
      for (const k of keys) input.press(k);
      input.step();
      movement.fixedUpdate(FIXED);
      physics.step(FIXED);
      for (const k of keys) input.release(k);
    };

    for (let i = 0; i < 120; i += 1) frame([]);
    const start = player.position;

    for (let i = 0; i < 600; i += 1) frame([KEY.forward]);

    const dx = player.position.x - start.x;
    const dy = player.position.y - start.y;
    const seconds = 600 * FIXED;

    // Ground speed is preserved: pushing a horizontal velocity straight into
    // the hill measures ~3.0 m/s here, the slope-projected target ~3.4 m/s.
    expect(dx / seconds).toBeGreaterThan(WALK_SPEED * 0.9);
    // And the player actually climbs rather than grinding along the bottom.
    expect(dy / dx).toBeCloseTo(Math.tan(a), 1);

    input.input.dispose();
    physics.dispose();
  });

  it('treats a near-vertical normal as unstandable rather than dividing by zero', async () => {
    const rig = await makeRig();
    // Force a wall-like normal and confirm the controller neither throws nor
    // produces a NaN velocity.
    (rig.movement as unknown as { groundNormal: Vector3 }).groundNormal.set(0.99, 0.01, 0);

    rig.run(30, [KEY.forward]);
    const v = rig.player.body.linvel();
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Number.isFinite(v.y)).toBe(true);
    expect(Number.isFinite(v.z)).toBe(true);

    // The walk direction falls back to horizontal instead of tilting.
    expect(Math.abs(v.y)).toBeLessThan(1);
    expect(MIN_STANDABLE_NORMAL_Y).toBeGreaterThan(0.01);

    rig.dispose();
  });
});

describe('MovementController: time dilation', () => {
  it('slows the player because fewer fixed steps are issued, not by scaling', async () => {
    // The engine feeds its accumulator the *scaled* delta, so a dilated frame
    // earns a quarter of the fixed steps. The controller multiplies nothing by
    // gameSpeed itself - doing so would apply the scale twice.
    const full = await makeRig();
    full.run(SETTLE_FRAMES, [KEY.forward]);
    const fullDistance = Math.abs(full.player.position.z);
    full.dispose();

    // Simulate dilation the way the engine does: a quarter of the game time per
    // frame, so only every fourth frame earns a fixed step.
    const dilated = await makeRig();
    dilated.input.press(KEY.forward);
    for (let i = 0; i < SETTLE_FRAMES; i += 1) {
      dilated.input.step();
      // One fixed step only every fourth frame, as the accumulator would.
      if (i % 4 === 0) {
        dilated.movement.fixedUpdate(FIXED);
        dilated.physics.step(FIXED);
      }
    }
    dilated.input.release(KEY.forward);
    const dilatedDistance = Math.abs(dilated.player.position.z);

    expect(dilatedDistance).toBeGreaterThan(0);
    expect(dilatedDistance / fullDistance).toBeLessThan(0.35);
    expect(dilatedDistance / fullDistance).toBeGreaterThan(0.15);

    dilated.dispose();
  });

  it('freezes the player completely when game time is paused', async () => {
    // Paused means zero fixed steps, so the controller never runs at all.
    const rig = await makeRig();
    rig.run(SETTLE_FRAMES, [KEY.forward]);
    const position = { ...rig.player.position };
    const stepCount = rig.physics.stepCount;

    // No fixed updates issued at all - this is what a paused engine does.
    for (let i = 0; i < 60; i += 1) rig.input.step();

    expect(rig.physics.stepCount).toBe(stepCount);
    expect(rig.player.position.x).toBe(position.x);
    expect(rig.player.position.y).toBe(position.y);
    expect(rig.player.position.z).toBe(position.z);

    rig.dispose();
  });
});

describe('MovementController: robustness', () => {
  it('ignores non-finite and non-positive deltas', async () => {
    const rig = await makeRig();

    rig.movement.fixedUpdate(Number.NaN);
    rig.movement.fixedUpdate(0);
    rig.movement.fixedUpdate(-1);

    expect(Number.isFinite(rig.player.position.y)).toBe(true);
    expect(rig.player.position.y).toBeCloseTo(rig.player.restHeight, 2);

    rig.dispose();
  });

  it('stays inert once the player has been disposed', async () => {
    const rig = await makeRig();
    rig.player.dispose();

    // Would be a use-after-free if the controller still touched the body.
    expect(() => rig.movement.fixedUpdate(FIXED)).not.toThrow();
    expect(rig.physics.stepCount).toBeGreaterThan(0);

    rig.dispose();
  });

  it('exposes the probe distance it uses for the ground check', async () => {
    const rig = await makeRig();
    // Small enough that a single jump step (0.083 m) clears it.
    expect(GROUND_PROBE).toBeLessThan(JUMP_SPEED * FIXED);
    expect(GROUND_PROBE).toBeGreaterThan(0);
    rig.dispose();
  });

  it('falls back to world -Z when the camera looks straight down', async () => {
    const rig = await makeRig();
    const camera = new PerspectiveCamera(60, 1.6, 0.1, 2000);
    camera.position.set(0, 10, 0);
    camera.lookAt(0, -10, 0); // straight down: the horizontal forward degenerates
    camera.updateMatrixWorld(true);

    (rig.movement as unknown as { camera: PerspectiveCamera }).camera = camera;

    rig.run(SETTLE_FRAMES, [KEY.forward]);

    const v = rig.player.body.linvel();
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Number.isFinite(v.z)).toBe(true);
    // World -Z fallback, so the player travels in -Z.
    expect(rig.player.position.z).toBeLessThan(-1);

    rig.dispose();
  });
});
