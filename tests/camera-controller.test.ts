// @vitest-environment jsdom
/**
 * Step 1.5 - the third-person camera.
 *
 * These run against real physics wherever the behaviour depends on it (the
 * occlusion pull-in and the ground clamp), because that is where the
 * interesting bugs live. A stubbed world would let a broken camera pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { InputManager } from '../src/core/InputManager';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { Player } from '../src/player/Player';
import {
  CAMERA_HEIGHT_OFFSET,
  CameraController,
  DEFAULT_CAMERA_DISTANCE,
  DEFAULT_CAMERA_PITCH,
  MAX_CAMERA_DISTANCE,
  MAX_CAMERA_PITCH,
  MIN_CAMERA_DISTANCE,
  MIN_CAMERA_PITCH,
  MIN_GROUND_CLEARANCE,
  ORBIT_MOUSE_BUTTON,
} from '../src/renderer/CameraController';

const FIXED = 1 / 60;

/** Right mouse button, as an `event.buttons` bitmask. */
const RIGHT_BUTTONS = 2;

interface Rig {
  physics: PhysicsWorld;
  player: Player;
  input: InputManager;
  camera: PerspectiveCamera;
  controller: CameraController;
  /** One rendered frame: poll input, then advance the camera. */
  frame: (delta?: number) => void;
  /** Move the mouse, then poll, then advance - one frame of dragging. */
  drag: (x: number, y: number, delta?: number) => void;
  scroll: (deltaY: number, delta?: number) => void;
  press: (button?: number) => void;
  release: (button?: number) => void;
  dispose: () => void;
}

async function makeRig(options: { spawn?: { x: number; y: number; z: number } } = {}): Promise<Rig> {
  const physics = await PhysicsWorld.create({ timestep: FIXED });
  physics.createGround(50);

  const player = new Player({ physics, spawn: options.spawn ?? { x: 0, y: 1, z: 0 } });
  player.addTo(new Scene());

  const target = new EventTarget();
  const input = new InputManager({ target, canvas: null });
  input.attach();

  const camera = new PerspectiveCamera(60, 1.6, 0.1, 2000);
  const controller = new CameraController({ camera, input, physics, player });

  // Seed the mouse position so the first real movement is not swallowed as the
  // "first sample" the InputManager discards.
  target.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0 }));
  input.update();

  // Let the player settle onto the ground and the camera snap into place.
  for (let i = 0; i < 120; i += 1) {
    input.update();
    controller.update(FIXED);
    physics.step(FIXED);
  }

  const frame = (delta: number = FIXED): void => {
    input.update();
    controller.update(delta);
  };

  // Mouse coordinates are absolute in the DOM, so a drag is expressed as a
  // *relative* delta here and accumulated - dispatching the same clientX twice
  // would report no movement at all, which silently turns every multi-frame
  // drag into a single-frame one.
  let mouseX = 0;
  let mouseY = 0;
  const drag = (dx: number, dy: number, delta: number = FIXED): void => {
    mouseX += dx;
    mouseY += dy;
    target.dispatchEvent(new MouseEvent('mousemove', { clientX: mouseX, clientY: mouseY }));
    frame(delta);
  };

  const scroll = (deltaY: number, delta: number = FIXED): void => {
    target.dispatchEvent(new WheelEvent('wheel', { deltaY }));
    frame(delta);
  };

  const press = (button: number = ORBIT_MOUSE_BUTTON): void => {
    target.dispatchEvent(new MouseEvent('mousedown', { button, buttons: RIGHT_BUTTONS }));
  };

  const release = (button: number = ORBIT_MOUSE_BUTTON): void => {
    target.dispatchEvent(new MouseEvent('mouseup', { button, buttons: 0 }));
  };

  return {
    physics,
    player,
    input,
    camera,
    controller,
    frame,
    drag,
    scroll,
    press,
    release,
    dispose: () => {
      input.dispose();
      physics.dispose();
    },
  };
}

/** Wait long enough for the follow and zoom easing to settle. */
const SETTLE_FRAMES = 120;

let rig: Rig | undefined;

beforeEach(() => {
  // Nothing global to install: the camera controller takes no browser API
  // beyond what the InputManager already reads.
});

afterEach(() => {
  rig?.dispose();
  rig = undefined;
  vi.unstubAllGlobals();
});

describe('CameraController: defaults', () => {
  it('starts at the specified distance, pitch and behind-the-player yaw', async () => {
    rig = await makeRig();

    expect(rig.controller.distance).toBe(DEFAULT_CAMERA_DISTANCE);
    expect(DEFAULT_CAMERA_DISTANCE).toBe(4);
    expect(rig.controller.pitch).toBeCloseTo(DEFAULT_CAMERA_PITCH, 6);
    expect(rig.controller.yaw).toBeCloseTo(0, 6);

    rig.dispose();
  });

  it('aims at the player centre plus the height offset', async () => {
    rig = await makeRig();

    const focus = rig.controller.focusPoint;
    expect(focus.x).toBeCloseTo(rig.player.position.x, 3);
    expect(focus.y).toBeCloseTo(rig.player.position.y + CAMERA_HEIGHT_OFFSET, 3);
    expect(focus.z).toBeCloseTo(rig.player.position.z, 3);
    expect(CAMERA_HEIGHT_OFFSET).toBe(1.5);

    // The camera is behind the player at +Z and above the focus point, which
    // for yaw 0 and a positive pitch is exactly this offset.
    const expected = new Vector3()
      .copy(focus)
      .add(new Vector3(0, DEFAULT_CAMERA_DISTANCE * Math.sin(DEFAULT_CAMERA_PITCH), DEFAULT_CAMERA_DISTANCE * Math.cos(DEFAULT_CAMERA_PITCH)));
    expect(rig.camera.position.x).toBeCloseTo(expected.x, 3);
    expect(rig.camera.position.y).toBeCloseTo(expected.y, 3);
    expect(rig.camera.position.z).toBeCloseTo(expected.z, 3);

    rig.dispose();
  });

  it('clamps out-of-range construction values into the allowed range', async () => {
    const physics = await PhysicsWorld.create({ timestep: FIXED });
    physics.createGround(50);
    const player = new Player({ physics, spawn: { x: 0, y: 1, z: 0 } });
    player.addTo(new Scene());
    const input = new InputManager({ target: new EventTarget(), canvas: null });
    input.attach();
    const camera = new PerspectiveCamera(60, 1.6, 0.1, 2000);

    const controller = new CameraController({
      camera,
      input,
      physics,
      player,
      distance: 999,
      pitch: 99,
      yaw: 999,
    });

    expect(controller.distance).toBe(MAX_CAMERA_DISTANCE);
    expect(controller.pitch).toBe(MAX_CAMERA_PITCH);
    expect(Math.abs(controller.yaw)).toBeLessThanOrEqual(Math.PI + 1e-9);

    const low = new CameraController({
      camera,
      input,
      physics,
      player,
      distance: -5,
      pitch: -99,
    });
    expect(low.distance).toBe(MIN_CAMERA_DISTANCE);
    expect(low.pitch).toBe(MIN_CAMERA_PITCH);

    input.dispose();
    physics.dispose();
  });

  it('exposes the range it clamps to', async () => {
    rig = await makeRig();
    expect(MIN_CAMERA_DISTANCE).toBe(2);
    expect(MAX_CAMERA_DISTANCE).toBe(10);
    rig.dispose();
  });
});

describe('CameraController: orbiting', () => {
  it('orbits while the right mouse button is held', async () => {
    rig = await makeRig();
    const startYaw = rig.controller.yaw;
    const startPitch = rig.controller.pitch;

    rig.press();
    rig.drag(120, 40);
    rig.drag(120, 40);

    // Dragging right turns the view right, which carries the camera towards
    // -X, so yaw decreases.
    expect(rig.controller.yaw).toBeLessThan(startYaw);
    // Dragging down looks down, which lifts the camera, so pitch increases.
    expect(rig.controller.pitch).toBeGreaterThan(startPitch);

    rig.dispose();
  });

  it('does not orbit while the button is up', async () => {
    rig = await makeRig();
    const startYaw = rig.controller.yaw;
    const startPitch = rig.controller.pitch;

    rig.drag(120, 40);
    rig.drag(120, 40);

    expect(rig.controller.yaw).toBe(startYaw);
    expect(rig.controller.pitch).toBe(startPitch);

    rig.dispose();
  });

  it('stops orbiting when the button is released mid-drag', async () => {
    rig = await makeRig();
    rig.press();
    rig.drag(100, 0);
    const yaw = rig.controller.yaw;

    rig.release();
    rig.drag(100, 0);

    expect(rig.controller.yaw).toBe(yaw);
    rig.dispose();
  });

  it('clamps the pitch so the camera cannot flip over the top', async () => {
    rig = await makeRig();

    rig.press();
    for (let i = 0; i < 40; i += 1) rig.drag(0, 200);

    expect(rig.controller.pitch).toBeCloseTo(MAX_CAMERA_PITCH, 6);
    // Still a real orbit angle, not NaN or a flipped sign.
    expect(Number.isFinite(rig.camera.position.y)).toBe(true);
    expect(rig.camera.position.y).toBeGreaterThan(rig.controller.focusPoint.y);

    rig.dispose();
  });

  it('clamps the pitch so the camera cannot go under the floor', async () => {
    rig = await makeRig();

    rig.press();
    for (let i = 0; i < 40; i += 1) rig.drag(0, -200);

    expect(rig.controller.pitch).toBeCloseTo(MIN_CAMERA_PITCH, 6);
    expect(Number.isFinite(rig.camera.position.y)).toBe(true);

    rig.dispose();
  });

  it('keeps the orbit distance constant while orbiting', async () => {
    rig = await makeRig();

    rig.press();
    for (let i = 0; i < 10; i += 1) rig.drag(60, 20);

    const focus = rig.controller.focusPoint;
    const radius = rig.camera.position.distanceTo(focus);
    expect(radius).toBeCloseTo(DEFAULT_CAMERA_DISTANCE, 2);

    rig.dispose();
  });

  it('wraps yaw instead of letting it grow without bound', async () => {
    rig = await makeRig();
    rig.press();
    for (let i = 0; i < 60; i += 1) rig.drag(500, 0);

    expect(Math.abs(rig.controller.yaw)).toBeLessThanOrEqual(Math.PI + 1e-9);
    // A full turn of dragging must land back where it started, modulo the wrap.
    rig.dispose();
  });

  it('moves the camera to the other side of the player when dragged far enough', async () => {
    rig = await makeRig();
    const startZ = rig.camera.position.z;

    rig.press();
    // Half a turn: 180 degrees is pi radians, at 0.005 rad/px that is 628px.
    for (let i = 0; i < 14; i += 1) rig.drag(45, 0);

    // The camera has swung round to -Z, in front of the player.
    expect(rig.camera.position.z).toBeLessThan(startZ);
    expect(rig.camera.position.z).toBeLessThan(rig.player.position.z);
    rig.dispose();
  });
});

describe('CameraController: zoom', () => {
  it('zooms in on scroll up and out on scroll down', async () => {
    rig = await makeRig();

    rig.scroll(-120);
    rig.frame();
    rig.frame();
    const closer = rig.controller.distance;

    rig.scroll(240);
    rig.frame();
    rig.frame();
    const further = rig.controller.distance;

    expect(closer).toBeLessThan(DEFAULT_CAMERA_DISTANCE);
    expect(further).toBeGreaterThan(closer);

    rig.dispose();
  });

  it('clamps the zoom to the 2m-10m range', async () => {
    rig = await makeRig();

    for (let i = 0; i < 40; i += 1) rig.scroll(-120);
    expect(rig.controller.distance).toBeCloseTo(MIN_CAMERA_DISTANCE, 6);

    for (let i = 0; i < 80; i += 1) rig.scroll(120);
    expect(rig.controller.distance).toBeCloseTo(MAX_CAMERA_DISTANCE, 6);

    rig.dispose();
  });

  it('eases the applied distance towards the target rather than snapping', async () => {
    rig = await makeRig();

    rig.scroll(-120);
    rig.frame();
    const afterOne = rig.controller.appliedDistance;
    expect(afterOne).toBeLessThan(DEFAULT_CAMERA_DISTANCE);
    expect(afterOne).toBeGreaterThan(MIN_CAMERA_DISTANCE);

    for (let i = 0; i < SETTLE_FRAMES; i += 1) rig.frame();
    expect(rig.controller.appliedDistance).toBeCloseTo(rig.controller.distance, 3);

    rig.dispose();
  });

  it('is unaffected by the orbit button', async () => {
    rig = await makeRig();
    rig.scroll(-120);
    const scrolled = rig.controller.distance;

    rig.press();
    rig.drag(0, 0);
    expect(rig.controller.distance).toBe(scrolled);

    rig.dispose();
  });
});

describe('CameraController: follow', () => {
  it('follows the player as they move', async () => {
    rig = await makeRig();

    // Move the player by teleporting the body, the way a fast step would.
    rig.player.body.setTranslation({ x: 6, y: rig.player.position.y, z: -4 }, true);

    for (let i = 0; i < SETTLE_FRAMES; i += 1) rig.frame();

    const focus = rig.controller.focusPoint;
    expect(focus.x).toBeCloseTo(6, 2);
    expect(focus.z).toBeCloseTo(-4, 2);

    rig.dispose();
  });

  it('eases towards the player instead of snapping, when the move is small', async () => {
    rig = await makeRig();

    rig.player.body.setTranslation({ x: 1, y: rig.player.position.y, z: 0 }, true);
    rig.frame();
    const afterOne = rig.controller.focusPoint.x;

    // One frame of easing, not an instant catch-up.
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(1);

    for (let i = 0; i < SETTLE_FRAMES; i += 1) rig.frame();
    expect(rig.controller.focusPoint.x).toBeCloseTo(1, 3);

    rig.dispose();
  });

  it('snaps rather than eases when the player teleports', async () => {
    rig = await makeRig();

    rig.player.body.setTranslation({ x: 40, y: rig.player.position.y, z: 40 }, true);
    rig.frame();

    // No long fly-across-the-level; the camera is already there.
    expect(rig.controller.focusPoint.x).toBeCloseTo(40, 3);
    expect(rig.controller.focusPoint.z).toBeCloseTo(40, 3);

    rig.dispose();
  });

  it('keeps the same follow behaviour at very different frame rates', async () => {
    // The whole point of exponential smoothing: 60 small frames and 6 large
    // ones covering the same elapsed time must land in the same place.
    const slow = await makeRig();
    const fast = await makeRig();
    slow.player.body.setTranslation({ x: 3, y: slow.player.position.y, z: 0 }, true);
    fast.player.body.setTranslation({ x: 3, y: fast.player.position.y, z: 0 }, true);

    for (let i = 0; i < 60; i += 1) slow.frame(1 / 60);
    for (let i = 0; i < 6; i += 1) fast.frame(1 / 6);

    expect(fast.controller.focusPoint.x).toBeCloseTo(slow.controller.focusPoint.x, 2);
    expect(fast.controller.appliedDistance).toBeCloseTo(slow.controller.appliedDistance, 3);

    slow.dispose();
    fast.dispose();
  });

  it('snap() puts the camera exactly where it wants to be', async () => {
    rig = await makeRig();

    rig.player.body.setTranslation({ x: 9, y: rig.player.position.y, z: -2 }, true);
    rig.controller.snap();

    expect(rig.controller.focusPoint.x).toBeCloseTo(9, 6);
    expect(rig.controller.focusPoint.z).toBeCloseTo(-2, 6);
    expect(rig.controller.appliedDistance).toBeCloseTo(rig.controller.distance, 6);

    rig.dispose();
  });
});

describe('CameraController: collision', () => {
  it('pulls the camera in when something is between it and the player', async () => {
    const { default: RAPIER } = await import('@dimforge/rapier3d-compat');
    await RAPIER.init();

    const physics = await PhysicsWorld.create({ timestep: FIXED });
    physics.createGround(50);
    const player = new Player({ physics, spawn: { x: 0, y: 1, z: 0 } });
    player.addTo(new Scene());
    const target = new EventTarget();
    const input = new InputManager({ target, canvas: null });
    input.attach();
    const camera = new PerspectiveCamera(60, 1.6, 0.1, 2000);
    const controller = new CameraController({ camera, input, physics, player });

    const frame = (): void => {
      input.update();
      controller.update(FIXED);
    };

    for (let i = 0; i < 60; i += 1) frame();
    const openDistance = camera.position.distanceTo(controller.focusPoint);
    expect(controller.isOccluded).toBe(false);

    // A wall two metres behind the player, squarely between it and the camera.
    const wall = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, 2, 2),
    );
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(4, 2, 0.5), wall);

    // Rapier refreshes its broad phase during `step()`, so a collider created
    // at runtime is invisible to raycasts until the world has been stepped
    // once. In the game that is a non-event - colliders are built during world
    // construction and physics steps continuously - but a test that adds one
    // has to pay it.
    physics.step(FIXED);

    for (let i = 0; i < 60; i += 1) frame();

    expect(controller.isOccluded).toBe(true);
    const blockedDistance = camera.position.distanceTo(controller.focusPoint);
    // Pulled in, but never inside the player and never past the wall.
    expect(blockedDistance).toBeLessThan(openDistance);
    expect(blockedDistance).toBeGreaterThan(MIN_CAMERA_DISTANCE * 0.5);
    // The wall's near face is at z = 1.5, so the camera stops just short of it.
    expect(camera.position.z).toBeLessThan(1.5);
    expect(camera.position.z).toBeGreaterThan(1.0);

    input.dispose();
    physics.dispose();
  });

  it('does not treat the player itself as an occluder', async () => {
    rig = await makeRig();

    // The ray starts at the player's chest, so without the body exclusion it
    // would hit the player's own capsule at distance zero and pin the camera.
    expect(rig.controller.isOccluded).toBe(false);
    expect(rig.camera.position.distanceTo(rig.controller.focusPoint)).toBeCloseTo(
      DEFAULT_CAMERA_DISTANCE,
      2,
    );

    rig.dispose();
  });

  it('never lets the camera drop below the ground', async () => {
    rig = await makeRig();
    rig.controller.snap();

    // Pitch all the way down and zoom all the way out: the raw orbit position
    // would be several metres under the floor. The frames have to actually run
    // for any of this to be applied.
    rig.press();
    for (let i = 0; i < 40; i += 1) rig.drag(0, -200);
    for (let i = 0; i < 80; i += 1) rig.scroll(120);
    for (let i = 0; i < 120; i += 1) rig.frame();

    expect(rig.controller.pitch).toBeCloseTo(MIN_CAMERA_PITCH, 6);
    expect(rig.controller.distance).toBeCloseTo(MAX_CAMERA_DISTANCE, 6);

    // The orbit alone would put the camera at -2.4m, two metres of solid floor
    // below the surface.
    const wanted =
      rig.controller.focusPoint.y + MAX_CAMERA_DISTANCE * Math.sin(MIN_CAMERA_PITCH);
    expect(wanted).toBeLessThan(0);

    expect(rig.camera.position.y).toBeGreaterThanOrEqual(MIN_GROUND_CLEARANCE);
    expect(rig.camera.position.y).toBeGreaterThan(wanted);

    rig.dispose();
  });

  it('lifts the camera out of the floor however it got there', async () => {
    rig = await makeRig();
    rig.controller.snap();

    // Same destination, reached the other way round: pitch first, then zoom.
    // Both paths have to land on the same clamped answer, because the clamp is
    // a property of where the camera is, not of how it got there.
    rig.press();
    for (let i = 0; i < 40; i += 1) rig.drag(0, -200);
    for (let i = 0; i < 80; i += 1) rig.scroll(120);
    for (let i = 0; i < 120; i += 1) rig.frame();
    const a = rig.camera.position.y;
    rig.dispose();

    rig = await makeRig();
    rig.controller.snap();
    for (let i = 0; i < 80; i += 1) rig.scroll(120);
    rig.press();
    for (let i = 0; i < 40; i += 1) rig.drag(0, -200);
    for (let i = 0; i < 120; i += 1) rig.frame();
    const b = rig.camera.position.y;
    rig.dispose();

    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeGreaterThan(0);
  });

  it('leaves the camera alone when the ground is far below', async () => {
    rig = await makeRig({ spawn: { x: 0, y: 30, z: 0 } });
    rig.controller.snap();

    const focus = rig.controller.focusPoint;
    const expected = new Vector3().copy(focus).add(new Vector3(
      0,
      DEFAULT_CAMERA_DISTANCE * Math.sin(DEFAULT_CAMERA_PITCH),
      DEFAULT_CAMERA_DISTANCE * Math.cos(DEFAULT_CAMERA_PITCH),
    ));
    // Nothing within reach of the ground probe, so no clamping happened.
    expect(rig.camera.position.y).toBeCloseTo(expected.y, 3);

    rig.dispose();
  });
});

describe('CameraController: robustness', () => {
  it('ignores non-finite and non-positive deltas', async () => {
    rig = await makeRig();
    const before = rig.camera.position.clone();

    rig.controller.update(Number.NaN);
    rig.controller.update(0);
    rig.controller.update(-1);

    expect(rig.camera.position.equals(before)).toBe(true);
    rig.dispose();
  });

  it('stays inert once the player has been disposed', async () => {
    rig = await makeRig();
    rig.player.dispose();

    expect(() => rig?.controller.update(FIXED)).not.toThrow();
    expect(() => rig?.controller.snap()).not.toThrow();
    rig.dispose();
  });

  it('never produces a NaN camera position, whatever the mouse does', async () => {
    rig = await makeRig();

    rig.press();
    for (let i = 0; i < 30; i += 1) {
      rig.drag(1000, -1000);
      rig.scroll(500);
      rig.drag(-1000, 1000);
      rig.scroll(-500);
    }

    const p = rig.camera.position;
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(Number.isFinite(p.z)).toBe(true);

    rig.dispose();
  });

  it('resetOrbit returns the framing to its defaults', async () => {
    rig = await makeRig();
    rig.press();
    rig.drag(200, 80);
    rig.scroll(-120);
    for (let i = 0; i < 30; i += 1) rig.frame();

    rig.controller.resetOrbit();
    for (let i = 0; i < SETTLE_FRAMES; i += 1) rig.frame();

    expect(rig.controller.yaw).toBeCloseTo(0, 6);
    expect(rig.controller.pitch).toBeCloseTo(DEFAULT_CAMERA_PITCH, 6);
    expect(rig.controller.distance).toBeCloseTo(DEFAULT_CAMERA_DISTANCE, 6);

    rig.dispose();
  });
});

describe('CameraController: movement reference', () => {
  it('reports a forward direction the movement controller can use', async () => {
    rig = await makeRig();

    // Default framing: behind and above the player, looking forwards.
    const forward = new Vector3();
    rig.camera.getWorldDirection(forward);
    expect(forward.y).toBeLessThan(0); // looking down at the player
    expect(forward.z).toBeLessThan(0); // and towards -Z
    expect(Math.abs(forward.x)).toBeLessThan(1e-6);

    rig.dispose();
  });

  it('changes the reported forward direction when orbited', async () => {
    rig = await makeRig();

    rig.press();
    // A quarter turn. The camera starts at +Z for yaw 0 and swings towards -X,
    // so the view ends up looking towards +X. Dragging *right* does that, at
    // 0.005 rad/px: pi/2 radians is 314px.
    for (let i = 0; i < 7; i += 1) rig.drag(45, 0);

    expect(rig.controller.yaw).toBeCloseTo(-Math.PI / 2, 2);

    const forward = new Vector3();
    rig.camera.getWorldDirection(forward);
    expect(forward.x).toBeGreaterThan(0.9);
    expect(Math.abs(forward.z)).toBeLessThan(0.1);

    rig.dispose();
  });

  it('stays usable while the player is airborne', async () => {
    rig = await makeRig();

    rig.player.body.setTranslation({ x: 0, y: 12, z: 0 }, true);
    for (let i = 0; i < 10; i += 1) rig.frame();

    expect(Number.isFinite(rig.camera.position.y)).toBe(true);
    // Still aiming at the player's chest plus the offset.
    expect(rig.controller.focusPoint.y).toBeGreaterThan(12);

    rig.dispose();
  });
});
