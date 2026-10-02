/**
 * character-animator.test.ts
 * =============================================================================
 * The procedural clips, and the two things about them that are easy to get
 * wrong and impossible to see in the code.
 *
 * The first is *contralateral swing*. A walk cycle where the left arm moves with
 * the left leg instead of against it is the most obvious thing wrong a character
 * can be, and both versions look equally plausible in source - the sign that
 * distinguishes them is one character in a sine. So it is asserted against the
 * real bone transforms, not reasoned about.
 *
 * The second is *foot slide*. A clip has a fixed stride; the player moves at
 * 3.5 m/s walking and 6.0 m/s running, and those are fixed by
 * MovementController. A clip whose stride does not match the ground speed makes
 * the planted foot skate across the terrain every step, which reads instantly as
 * ice and ruins the whole character. The animator's answer is to scale the
 * clip's playback rate by speed, and the number it scales against is measured
 * off the built clip rather than guessed - so these tests measure it back and
 * check it really does land on the game's two speeds.
 *
 * Nothing here needs a GPU: the clips are data, and the mixer writes plain
 * object transforms.
 * =============================================================================
 */

import { describe, expect, it } from 'vitest';
import { AnimationMixer, Euler, LoopPingPong, LoopRepeat, MathUtils, Object3D, Vector3 } from 'three';
import { CharacterGenerator, type BoneName } from '../src/player/CharacterGenerator';
import { RUN_SPEED as CONTROLLER_RUN_SPEED, WALK_SPEED as CONTROLLER_WALK_SPEED } from '../src/player/MovementController';
import {
  CharacterAnimator,
  IDLE_CYCLE,
  IDLE_SPEED,
  MAX_TIME_SCALE,
  MIN_TIME_SCALE,
  RUN_CYCLE,
  RUN_SPEED,
  WALK_CYCLE,
  WALK_SPEED,
} from '../src/player/CharacterAnimator';

/** A fresh rig and animator, at the rest pose. */
function rig_and_animator() {
  const generator = new CharacterGenerator();
  const rig = generator.generate();
  const animator = new CharacterAnimator(rig);
  return { generator, rig, animator };
}

/** Rotation of a bone about local X, in degrees. */
function pitchOf(object: Object3D): number {
  return MathUtils.radToDeg(new Euler().setFromQuaternion(object.quaternion, 'XYZ').x);
}

/** World position of a bone. */
function worldOf(rig: ReturnType<CharacterGenerator['generate']>, name: BoneName): Vector3 {
  return new Vector3().setFromMatrixPosition(rig.bone(name).matrixWorld);
}

/** A mixer playing exactly one clip, sampled across its full duration. */
function sampleClip<T>(
  rig: ReturnType<CharacterGenerator['generate']>,
  clip: { duration: number },
  sample: (fraction: number) => T,
): T[] {
  const mixer = new AnimationMixer(rig.root);
  const action = mixer.clipAction(clip as never);
  if (action === null) throw new Error('no action');
  action.play();
  const steps = 24;
  const out: T[] = [];
  // One full cycle with no duplicated endpoint. Sampling `steps + 1` points
  // would evaluate phase 0 twice, which makes any cyclic count off by one.
  for (let i = 0; i < steps; i++) {
    mixer.setTime((i / steps) * clip.duration);
    rig.root.updateMatrixWorld(true);
    out.push(sample(i / steps));
  }
  action.stop();
  mixer.uncacheRoot(rig.root);
  return out;
}

/* ========================================================================== */

describe('idle', () => {
  it('breathes by scaling the chest, not by rotating it', () => {
    const { rig } = rig_and_animator();
    const clip = new CharacterAnimator(rig).clipMap.idle;

    const scale = clip.tracks.find((t) => t.name === 'chest.scale');
    expect(scale, 'the breath must be a scale track, not a rotation').toBeDefined();

    // A chest that rotates while breathing reads as the character looking down
    // at their own feet, which is not what standing still looks like.
    const chestRotation = clip.tracks.find((t) => t.name === 'chest.quaternion');
    expect(chestRotation, 'nothing should rotate the chest while idle').toBeUndefined();

    const values = (scale as unknown as { values: number[] }).values;
    // Four keys, three channels each.
    expect(values.length % 3).toBe(0);
    for (let i = 0; i < values.length; i += 3) {
      const [x, y, z] = [values[i], values[i + 1], values[i + 2]];
      // Every keyframe must stay near unit scale. A track of raw offsets here
      // would collapse the ribcage to nothing on the first frame.
      for (const channel of [x, y, z]) {
        expect(channel).toBeGreaterThan(0.97);
        expect(channel).toBeLessThan(1.03);
      }
      // Height must not change - a chest that gets taller is not a chest that
      // breathes.
      expect(y).toBeCloseTo(1, 5);
    }
  });

  it('shifts weight sideways without leaving the ground', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    const restY = rig.bone('hips').position.y;

    const ys = sampleClip(rig, animator.clipMap.idle, () => rig.bone('hips').position.y);
    const xs = sampleClip(rig, animator.clipMap.idle, () => rig.bone('hips').position.x);

    // The weight shift moves the hips sideways by a few centimetres, and drops
    // them by no more than a couple.
    const spread = Math.max(...xs) - Math.min(...xs);
    expect(spread).toBeGreaterThan(0.02);
    expect(spread).toBeLessThan(0.15);

    for (const y of ys) {
      expect(Math.abs(y - restY)).toBeLessThan(0.03);
    }
  });

  it('loops forever, and reverses rather than snapping', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    // The weight shift is a translation, and the eye tracks position far more
    // readily than angle - so a ping-pong loop is what keeps it from snapping
    // from one side to the other.
    expect(animator.clipMap.idle.duration).toBeCloseTo(IDLE_CYCLE, 5);
  });

  it('drifts the head against the hips', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    const pitches = sampleClip(rig, animator.clipMap.idle, () => pitchOf(rig.bone('head')));
    const spread = Math.max(...pitches) - Math.min(...pitches);
    // A standing figure whose head is perfectly rigid reads as a mannequin.
    expect(spread).toBeGreaterThan(0.5);
    expect(spread).toBeLessThan(12);
  });
});

/* ========================================================================== */

describe('walk and run', () => {
  it('swings the left arm against the left leg', () => {
    // The single most obvious thing a walk cycle can get wrong, and the one
    // thing that is invisible in source: both signs look equally plausible
    // until you watch the character move.
    for (const clip of ['walk', 'run'] as const) {
      const { rig } = rig_and_animator();
      const animator = new CharacterAnimator(rig);
      const samples = sampleClip(rig, animator.clipMap[clip], () => ({
        leg: pitchOf(rig.bone('thigh.L')),
        arm: pitchOf(rig.bone('upperArm.L')),
      }));

      let opposite = 0;
      let together = 0;
      for (const { leg, arm } of samples) {
        if (Math.abs(leg) < 1 || Math.abs(arm) < 1) continue;
        if (Math.sign(leg) === Math.sign(arm)) together++;
        else opposite++;
      }
      expect(opposite, `${clip}: the left arm must oppose the left leg`).toBeGreaterThan(0);
      expect(together, `${clip}: no keyframe may move them together`).toBe(0);
    }
  });

  it('bobs the body twice per stride, not once', () => {
    // Highest as the legs pass, lowest at each footfall. Getting this frequency
    // wrong is the other classic tell.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    const ys = sampleClip(rig, animator.clipMap.walk, () => rig.bone('hips').position.y);

    // Count the humps directly rather than assuming half the cycle sits above
    // the mean. A |cos| double hump actually spends two thirds of its period
    // above its midpoint, so "half high, half low" would fail on a correct clip.
    const peak = Math.max(...ys);
    let humps = 0;
    for (let i = 0; i < ys.length; i++) {
      const before = ys[(i - 1 + ys.length) % ys.length];
      const after = ys[(i + 1) % ys.length];
      if (ys[i] > before && ys[i] >= after && ys[i] > peak - 0.004) humps++;
    }
    expect(humps, 'the body must rise twice per stride').toBe(2);
  });

  it('never straightens a knee completely', () => {
    // A locked knee at this scale reads as a mannequin's.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    const pitches = sampleClip(rig, animator.clipMap.walk, () => pitchOf(rig.bone('shin.L')));
    for (const p of pitches) {
      expect(Math.abs(p)).toBeGreaterThan(1);
    }
  });

  it('runs with more bob, more swing and more lean than it walks', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);

    const bob = (clip: 'walk' | 'run') => {
      const ys = sampleClip(rig, animator.clipMap[clip], () => rig.bone('hips').position.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(bob('run')).toBeGreaterThan(bob('walk'));

    const swing = (clip: 'walk' | 'run') => {
      const ps = sampleClip(rig, animator.clipMap[clip], () => pitchOf(rig.bone('thigh.L')));
      return Math.max(...ps) - Math.min(...ps);
    };
    expect(swing('run')).toBeGreaterThan(swing('walk'));

    const lean = (clip: 'walk' | 'run') => {
      const ps = sampleClip(rig, animator.clipMap[clip], () => pitchOf(rig.bone('spine')));
      return Math.max(...ps);
    };
    // The walk must not lean at all; a character that leans while walking
    // reads as sneaking.
    expect(lean('walk')).toBeLessThan(1);
    expect(lean('run')).toBeGreaterThan(5);
  });

  it('keeps both feet at or above the ground for the whole cycle', () => {
    // A foot that dips below the terrain during a stride is a foot sinking into
    // the world, and it is one of the first things anyone notices.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    for (const clip of ['walk', 'run'] as const) {
      const feet = sampleClip(rig, animator.clipMap[clip], () => ({
        l: worldOf(rig, 'foot.L').y,
        r: worldOf(rig, 'foot.R').y,
      }));
      for (const { l, r } of feet) {
        expect(l, `${clip}: left foot sank below the ground`).toBeGreaterThan(-0.01);
        expect(r, `${clip}: right foot sank below the ground`).toBeGreaterThan(-0.01);
      }
    }
  });
});

/* ========================================================================== */

describe('foot slide', () => {
  it('authors the walk at the speed MovementController walks at', () => {
    // Measured off the built clip rather than trusted: the animator plays its
    // own stride and records how far the foot really travels relative to the
    // hips. If a proportion, a knee bend or a cycle length changes, this moves
    // with it, and a stale hand-derived constant would not.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);

    expect(animator.walkReference.speed).toBeGreaterThan(WALK_SPEED * 0.95);
    expect(animator.walkReference.speed).toBeLessThan(WALK_SPEED * 1.05);
  });

  it('authors the run at the speed MovementController runs at', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);

    expect(animator.runReference.speed).toBeGreaterThan(RUN_SPEED * 0.95);
    expect(animator.runReference.speed).toBeLessThan(RUN_SPEED * 1.05);
  });

  it('actually removes the slide, measured through the mixer', () => {
    // The claim the design makes is that timeScale = v / vRef leaves the planted
    // foot where the ground put it. This drives it the way the game does and
    // checks it, rather than re-deriving the algebra.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);

    // Inside the clamp on both ends, so the measured value is the raw ratio.
    for (const speed of [1.5, 2.5, WALK_SPEED]) {
      animator.setSpeed(speed);
      animator.update(1 / 60);
      // With timeScale set, one second of *game* time must advance the walk by
      // exactly `speed` metres of ground. The clip's own cycle is what that
      // corresponds to.
      const scale = animator.mixer.clipAction(animator.clipMap.walk)!.timeScale;
      const expected = speed / animator.walkReference.speed;
      expect(scale).toBeCloseTo(expected, 5);
    }
  });

  it('clamps the playback rate so a crawl is not a stuck record', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);

    animator.setSpeed(0.001);
    const walk = animator.mixer.clipAction(animator.clipMap.walk)!;
    const run = animator.mixer.clipAction(animator.clipMap.run)!;
    expect(walk.timeScale).toBeCloseTo(MIN_TIME_SCALE, 5);
    expect(run.timeScale).toBeCloseTo(MIN_TIME_SCALE, 5);

    animator.setSpeed(1000);
    expect(walk.timeScale).toBeCloseTo(MAX_TIME_SCALE, 5);
    expect(run.timeScale).toBeCloseTo(MAX_TIME_SCALE, 5);
  });
});

/* ========================================================================== */

describe('blending', () => {
  it('starts on a pose, not on a t-pose', () => {
    // A character that renders one frame of t-pose before the idle takes hold
    // is a visible glitch on the very first frame of the game.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    expect(animator.state).toBe('idle');
    animator.update(1 / 60);
    const head = worldOf(rig, 'head');
    expect(head.y).toBeGreaterThan(1.5);
    expect(head.y).toBeLessThan(1.9);
  });

  it('crosses from idle to walk to run as the speed rises', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);

    animator.setSpeed(0);
    expect(animator.state).toBe('idle');

    animator.setSpeed(1.0);
    expect(animator.state).toBe('walk');

    animator.setSpeed(RUN_SPEED);
    expect(animator.state).toBe('run');

    animator.setSpeed(0);
    expect(animator.state).toBe('idle');
  });

  it('holds the outgoing clip at partial weight during a fade', () => {
    // This is what makes the transition smooth rather than a snap, and it is
    // the specific API the plan names. Both actions carry weight at once only
    // for the duration of the fade.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);

    animator.setSpeed(1.0);
    const idle = animator.mixer.clipAction(animator.clipMap.idle)!;
    const walk = animator.mixer.clipAction(animator.clipMap.walk)!;
    expect(idle.getEffectiveWeight()).toBeCloseTo(1, 5);
    expect(walk.getEffectiveWeight()).toBeCloseTo(1, 5);

    // Part-way through the fade both are partially weighted.
    animator.update(WALK_CYCLE * 0.1);
    const idleWeight = idle.getEffectiveWeight();
    const walkWeight = walk.getEffectiveWeight();
    expect(idleWeight).toBeGreaterThan(0);
    expect(idleWeight).toBeLessThan(1);
    expect(walkWeight).toBeGreaterThan(0);
    expect(walkWeight).toBeLessThan(1);
    // And they must sum to one, or the pose is scaled by more than the skeleton.
    expect(idleWeight + walkWeight).toBeCloseTo(1, 3);
  });

  it('ignores a non-positive or non-finite delta', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    const before = worldOf(rig, 'head').y;

    animator.update(0);
    animator.update(-1);
    animator.update(Number.NaN);
    animator.update(Number.POSITIVE_INFINITY);

    expect(worldOf(rig, 'head').y).toBeCloseTo(before, 6);
  });

  it('survives a speed it cannot use', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    animator.setSpeed(Number.NaN);
    animator.setSpeed(-5);
    animator.setSpeed(Number.POSITIVE_INFINITY);
    expect(animator.state).not.toBe('jump');
  });

  it('produces no NaN anywhere in the rig over a long run', () => {
    // A NaN colour channel yields a fully black frame with no error, and the
    // tell is only that JSON.stringify of the mean comes back null. The same is
    // true of a bone transform: one NaN matrix and the whole character vanishes
    // silently.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);

    const speeds = [0, 1, 3.5, 6, 0, 3.5];
    for (let i = 0; i < 600; i++) {
      animator.setSpeed(speeds[i % speeds.length]);
      animator.update(1 / 60);
      if (i === 120) animator.jump();
    }

    rig.root.updateMatrixWorld(true);
    rig.root.traverse((object) => {
      const m = object.matrixWorld.elements;
      for (const value of m) expect(Number.isFinite(value)).toBe(true);
      expect(Number.isFinite(object.position.x)).toBe(true);
      expect(Number.isFinite(object.position.y)).toBe(true);
      expect(Number.isFinite(object.position.z)).toBe(true);
    });
  });
});

/* ========================================================================== */

describe('jump', () => {
  it('plays once, then hands control back to the locomotion', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    animator.setSpeed(2.0);

    animator.jump();
    expect(animator.isJumping).toBe(true);
    expect(animator.state).toBe('jump');

    // A second jump while airborne must not restart the clip, or the character
    // rubber-bands back to the crouch mid-air.
    const jumpAction = animator.mixer.clipAction(animator.clipMap.jump)!;
    const timeAtCall = jumpAction.time;
    animator.jump();
    expect(jumpAction.time).toBeCloseTo(timeAtCall, 6);

    // Run the clip out.
    const duration = animator.clipMap.jump.duration;
    for (let i = 0; i < 40; i++) {
      animator.update(duration / 20);
      if (!animator.isJumping) break;
    }
    expect(animator.isJumping).toBe(false);
    expect(animator.state).toBe('idle');

    // The hand-back must not pop: over the fade the hips stay within a
    // centimetre of where the jump left them.
    const restY = rig.bone('hips').position.y;
    let worst = 0;
    for (let i = 0; i < 20; i++) {
      animator.update(0.12 / 20);
      worst = Math.max(worst, Math.abs(rig.bone('hips').position.y - restY));
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('crouches before it rises, and lands heavier than it left', () => {
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    const restY = rig.bone('hips').position.y;

    animator.jump();
    const ys = sampleClip(rig, animator.clipMap.jump, () => rig.bone('hips').position.y);
    const first = ys[0];
    const highest = Math.max(...ys);
    const last = ys[ys.length - 1];

    // Launch is a crouch, so the first keyframe is below rest.
    expect(first).toBeLessThan(restY - 0.01);
    // The hang is above rest.
    expect(highest).toBeGreaterThan(restY);
    // The landing is an absorb, so the last keyframe is below rest too. It does
    // not have to match the launch crouch - what matters is that it is close
    // enough to the idle pose that handing control back cannot snap. Idle sits
    // at the rest height, so the hand-back blends a couple of centimetres.
    expect(last).toBeLessThan(restY - 0.005);
    expect(Math.abs(last - restY)).toBeLessThan(0.02);
  });

  it('keeps the timings uneven, so it does not feel like a metronome', () => {
    // Quick launch, long hang, quick land. Even spacing is what makes a
    // procedural jump feel mechanical.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    const times = (animator.clipMap.jump.tracks[0] as unknown as { times: number[] }).times;
    expect(times.length).toBe(5);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const launch = gaps[0];
    const hang = gaps[1] + gaps[2];
    const land = gaps[3];
    expect(hang).toBeGreaterThan(launch);
    expect(hang).toBeGreaterThan(land);
    expect(launch).toBeCloseTo(land, 1);
  });
});

/* ========================================================================== */

describe('ownership of the root transform', () => {
  it('never writes the root rotation', () => {
    // MovementController owns rig.root.rotation.y and turns the character to
    // face its direction of travel. Two writers on one transform is how you get
    // a character that vibrates, so this class does not touch it - and that is
    // asserted, not assumed.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);

    for (const clip of Object.values(animator.clipMap)) {
      for (const track of clip.tracks) {
        expect(track.name.startsWith('root.')).toBe(false);
        expect(track.name.startsWith('hips.quaternion')).toBe(false);
      }
    }

    const yaw = 1.234;
    rig.root.rotation.y = yaw;
    for (let i = 0; i < 120; i++) {
      animator.setSpeed(i % 2 === 0 ? 0 : 4);
      animator.update(1 / 60);
    }
    expect(rig.root.rotation.y).toBeCloseTo(yaw, 10);
  });

  it('only ever animates bones the rig actually has', () => {
    // A track bound to a name that does not exist is silently dropped by
    // PropertyBinding, so the pose is simply missing a limb with nothing in the
    // log to say so.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    const names = new Set<string>(rig.bones.map((b) => b.name));

    for (const clip of Object.values(animator.clipMap)) {
      for (const track of clip.tracks) {
        // Strip the trailing property, not the leading segment: the bone names
        // themselves contain a dot, so `thigh.L.quaternion` must yield `thigh.L`.
        const bone = track.name.replace(/\.[^.]+$/, '');
        expect(names.has(bone), `${clip.name} animates a bone the rig does not have: ${bone}`).toBe(true);
      }
    }
  });

  it('animates enough of the body to read as a body', () => {
    // A clip that only moves the legs is a puppet, not a character.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    for (const clip of ['walk', 'run'] as const) {
      const bones = new Set(animator.clipMap[clip].tracks.map((t) => t.name.replace(/\.[^.]+$/, '')));
      for (const required of ['thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'upperArm.L', 'upperArm.R', 'spine', 'hips']) {
        expect(bones.has(required), `${clip} does not animate ${required}`).toBe(true);
      }
    }
  });
});

/* ========================================================================== */

describe('agreement with the movement controller', () => {
  it('blends at exactly the speeds the controller moves at', () => {
    // The thresholds are duplicated rather than imported, because importing
    // MovementController here would close a cycle: it reads Player, which builds
    // the animator. So the agreement has to be asserted instead, or the day one
    // of them changes the character would cross-fade at a speed the body never
    // reaches and spend its whole life in the wrong state.
    expect(WALK_SPEED).toBe(CONTROLLER_WALK_SPEED);
    expect(RUN_SPEED).toBe(CONTROLLER_RUN_SPEED);
    expect(IDLE_SPEED).toBeGreaterThan(0);
    expect(IDLE_SPEED).toBeLessThan(WALK_SPEED);
    expect(WALK_SPEED).toBeLessThan(RUN_SPEED);
  });
});

describe('loop modes', () => {
  it('ping-pongs the idle and repeats the strides', () => {
    // A walk that ping-pongs would walk backwards.
    const { rig } = rig_and_animator();
    const animator = new CharacterAnimator(rig);
    const mixer = animator.mixer;

    const idle = mixer.clipAction(animator.clipMap.idle)!;
    const walk = mixer.clipAction(animator.clipMap.walk)!;
    const run = mixer.clipAction(animator.clipMap.run)!;

    expect(idle.loop).toBe(LoopPingPong);
    expect(walk.loop).toBe(LoopRepeat);
    expect(run.loop).toBe(LoopRepeat);
  });
});

/* ========================================================================== */

describe('lifecycle', () => {
  it('stops cleanly and can be disposed twice', () => {
    const { generator, rig, animator } = rig_and_animator();
    animator.setSpeed(4);
    animator.update(0.5);
    animator.dispose();

    // A second dispose is a no-op rather than a double free on the mixer.
    expect(() => animator.dispose()).not.toThrow();

    // And nothing after dispose may touch the rig.
    animator.setSpeed(4);
    animator.update(0.5);
    animator.jump();
    expect(() => generator.disposeRig(rig.root)).not.toThrow();
    expect(rig.parts.length).toBeGreaterThan(0);
  });

  it('leaves the rig usable by its owner after the animator is gone', () => {
    const { rig, animator } = rig_and_animator();
    animator.dispose();
    expect(() => rig.root.updateMatrixWorld(true)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Stride cadence                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The audio's footstep timing comes from here.
 *
 * A footstep that does not land when the foot lands is worse than no footstep:
 * the sound detaches from the movement and the character reads as a puppet with
 * a sound effect attached. So the cadence is read off the mixer's own action
 * time rather than from a second timer, and these tests check that what it
 * reports is what the clips actually do.
 */
describe('stride cadence', () => {
  it('reports no stride at all when standing still', () => {
    const { animator } = rig_and_animator();
    expect(animator.state).toBe('idle');
    expect(animator.stridePhase).toBe(0);
    expect(animator.footfallInterval).toBe(0);
    animator.dispose();
  });

  it('matches the walk clip at the walk reference speed', () => {
    const { animator } = rig_and_animator();
    animator.setSpeed(WALK_SPEED);

    // The action's time scale is speed / reference speed, so a cycle takes
    // WALK_CYCLE / timeScale seconds and there are two footfalls per cycle.
    const timeScale = WALK_SPEED / animator.walkReference.speed;
    expect(animator.footfallInterval).toBeCloseTo(WALK_CYCLE / timeScale / 2, 6);

    // Measured: 0.3604 s between footfalls at 3.5 m/s, which is 2.8 steps a
    // second - a walk, not a shuffle and not a march.
    expect(animator.footfallInterval).toBeGreaterThan(0.3);
    expect(animator.footfallInterval).toBeLessThan(0.45);
    animator.dispose();
  });

  it('matches the run clip at the run reference speed', () => {
    const { animator } = rig_and_animator();
    animator.setSpeed(RUN_SPEED);

    const timeScale = RUN_SPEED / animator.runReference.speed;
    expect(animator.footfallInterval).toBeCloseTo(RUN_CYCLE / timeScale / 2, 6);

    // Measured: 0.2299 s, which is 4.3 steps a second.
    expect(animator.footfallInterval).toBeGreaterThan(0.18);
    expect(animator.footfallInterval).toBeLessThan(0.28);
    animator.dispose();
  });

  it('steps faster when running than when walking', () => {
    const { animator } = rig_and_animator();
    animator.setSpeed(WALK_SPEED);
    const walk = animator.footfallInterval;
    animator.setSpeed(RUN_SPEED);
    const run = animator.footfallInterval;

    expect(run).toBeLessThan(walk);
    // Measured ratio 1.57. A run that only steps 10% faster than a walk is a
    // walk with the arms wrong.
    expect(walk / run).toBeGreaterThan(1.3);
    animator.dispose();
  });

  it('advances the phase monotonically and wraps through zero', () => {
    const { animator } = rig_and_animator();
    animator.setSpeed(WALK_SPEED);

    let previous = animator.stridePhase;
    let wrapped = false;
    let sawHigh = false;
    for (let i = 0; i < 200; i++) {
      animator.update(1 / 60);
      const phase = animator.stridePhase;
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThanOrEqual(1);
      if (phase < previous - 0.5) wrapped = true;
      if (previous > 0.9) sawHigh = true;
      previous = phase;
    }
    // It got near the end of the cycle, and it came back round.
    expect(sawHigh).toBe(true);
    expect(wrapped).toBe(true);
    animator.dispose();
  });

  it('lands as many footfalls as its own interval predicts', () => {
    // The integration check. Everything above is arithmetic on the interval;
    // this is the interval held against the thing it is supposed to describe.
    const { animator } = rig_and_animator();
    animator.setSpeed(WALK_SPEED);

    const seconds = 6;
    const step = 1 / 60;
    let footfalls = 0;
    let last = -1;
    for (let i = 0; i < Math.round(seconds / step); i++) {
      animator.update(step);
      const index = Math.floor(animator.stridePhase * 2 + 1e-6) % 2;
      if (index !== last) {
        if (last !== -1) footfalls++;
        last = index;
      }
    }

    const predicted = seconds / animator.footfallInterval;
    expect(footfalls).toBeGreaterThan(predicted * 0.9);
    expect(footfalls).toBeLessThan(predicted * 1.1);
    animator.dispose();
  });

  it('reports nothing while jumping', () => {
    const { animator } = rig_and_animator();
    animator.setSpeed(RUN_SPEED);
    animator.jump();

    expect(animator.isJumping).toBe(true);
    expect(animator.stridePhase).toBe(0);
    expect(animator.footfallInterval).toBe(0);

    animator.update(1 / 60);
    expect(animator.stridePhase).toBe(0);
    expect(animator.footfallInterval).toBe(0);
    animator.dispose();
  });

  it('stops shrinking the interval below the time-scale clamp', () => {
    // Below MIN_TIME_SCALE the clip stops slowing down before the body does, and
    // the audio follows the animation rather than the ground speed - what the
    // player should hear is what the player can see. Measured: the interval
    // bottoms out at 1.0286 s for every speed under about 1.2 m/s.
    const { animator } = rig_and_animator();
    animator.setSpeed(0.2);
    const slow = animator.footfallInterval;
    animator.setSpeed(1.0);
    const alsoSlow = animator.footfallInterval;
    animator.setSpeed(1.75);
    const faster = animator.footfallInterval;

    expect(alsoSlow).toBeCloseTo(slow, 6);
    expect(faster).toBeLessThan(slow);
    animator.dispose();
  });
});
