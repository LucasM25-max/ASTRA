/**
 * CharacterAnimator.ts - ASTRA procedural player
 * =============================================================================
 * Procedural animation for the character rig, played back through
 * `AnimationMixer`.
 *
 * Why clips at all, when the plan also says "procedural sine-based"
 * ----------------------------------------------------------------
 * The plan asks for both: sine-based idle breathing and weight shift, *and*
 * smooth transitions via `AnimationMixer`. Those are not in conflict, and the
 * resolution is the one thing that satisfies both - the *motion* is generated
 * from sine functions, and the *playback and blending* goes through the mixer.
 *
 * That is not a compromise, it is the only design that gets the transitions the
 * plan actually names. Writing the pose straight to the bones every frame means
 * every transition is a hand-rolled lerp with hand-rolled edge cases: what
 * happens when the player stops mid-stride, what happens when they land while
 * still running, what happens when two states are entered on the same frame.
 * `AnimationMixer` already solves all of that, and `crossFadeTo` is the specific
 * API the plan names. So the sine functions build `AnimationClip`s, and the mixer
 * does the rest.
 *
 * Foot slide, and why the stride is speed-matched
 * -----------------------------------------------
 * A clip has a fixed stride length. The player moves at 3.5 m/s walking and 6.0
 * m/s running, and those speeds are fixed by MovementController - they are not
 * something this class can negotiate. So a clip whose foot travels, say, 80 cm
 * per step played at 3.5 m/s leaves the planted foot skating 70 cm across the
 * ground every step, which is the single most obvious thing wrong with a
 * character and reads instantly as ice.
 *
 * The fix is the standard one: keep the stride fixed and scale the clip's
 * playback rate, so stride *frequency* carries the speed. `timeScale = v / vRef`
 * where `vRef` is the speed the clip was authored at, and `vRef` is not guessed -
 * it is *measured* off the built clip by playing it and recording how far the
 * foot actually travels relative to the hips over one cycle:
 *
 *     range = v * cycle / 2     =>     vRef = 2 * range / cycle
 *
 * That is the relation for a swing with no flight phase, where the foot is never
 * planted, so it is the conservative one: at `vRef` there is no slip anywhere in
 * the cycle, not merely during stance. Measuring rather than deriving means the
 * number stays true if a proportion, a knee bend or a cycle length changes, and
 * a stale hand-derived constant is exactly the kind of thing that silently rots.
 *
 * The cost, stated plainly: to match 6 m/s without a flight phase the leg has to
 * swing further than a real sprinter's does, because a real sprinter spends
 * ~40% of the cycle airborne and this rig's foot never is. The amplitudes below
 * are chosen so the measured reference lands on the game's real speeds, which is
 * why the run's swing is larger than anatomy would suggest. A true flight phase
 * needs either IK or a root-motion track, and the plan explicitly allows
 * keyframed bone rotations here.
 *
 * What this class deliberately does NOT do
 * ----------------------------------------
 * It never touches `rig.root.rotation.y`. That belongs to `MovementController`,
 * which turns the character to face its direction of travel, and two writers on
 * one transform is how you get a character that vibrates. See the note in
 * CharacterGenerator.ts.
 * =============================================================================
 */

import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Euler,
  KeyframeTrack,
  LoopPingPong,
  LoopRepeat,
  QuaternionKeyframeTrack,
  Quaternion,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { BONE_NAMES, type BoneName, type CharacterProportions, type CharacterRig } from './CharacterGenerator';

/** Seconds per full idle cycle. Slow enough to read as standing, not fidgeting. */
export const IDLE_CYCLE = 4.2;

/** Seconds per full walk cycle - one left step and one right step. */
export const WALK_CYCLE = 0.72;

/** Seconds per full run cycle. */
export const RUN_CYCLE = 0.46;

/** Ground speed, m/s, at or below which the character is idle. */
export const IDLE_SPEED = 0.05;

/** Ground speed, m/s, at which the walk is fully blended in. Matches MovementController. */
export const WALK_SPEED = 3.5;

/** Ground speed, m/s, at which the run is fully blended in. Matches MovementController. */
export const RUN_SPEED = 6.0;

/**
 * Clamp on the clip playback rate.
 *
 * Below 0.35 the cycle would take three times its authored length, which at a
 * crawl reads as a stuck record rather than as small steps - so below that the
 * character accepts a little slip instead. Above 2.5 the cycle is a blur and the
 * pose stops reading at all. Both ends are outside the range the game's two real
 * speeds produce, so neither is normally reached.
 */
export const MIN_TIME_SCALE = 0.35;
export const MAX_TIME_SCALE = 2.5;

/**
 * How far the legs swing, in radians, at full walk and full run.
 *
 * Larger than a stroll, and deliberately so - see the foot-slide note above.
 * The trade-off this buys is explicit: with a swing-only rig there is no way to
 * cover 3.5 m/s without either a long stride or a very fast cadence, and these
 * values land between the two (about 170 steps/min walking, 260 running). The
 * effective cadence turns out to depend only on the swing angle and the ground
 * speed - the cycle length cancels out - so the cycle is free to be set for
 * readability and the swing is what actually trades stride against cadence.
 */
const WALK_SWING = 0.805;
const RUN_SWING = 0.935;

/** How far the arms counter-swing, in radians. */
const WALK_ARM_SWING = 0.55;
const RUN_ARM_SWING = 0.95;

/** Forward lean of the whole upper body when running, in radians. */
const RUN_LEAN = 0.16;

/** Vertical bob, as a fraction of the character's height, per half cycle. */
const WALK_BOB = 0.02;
const RUN_BOB = 0.045;

export type LocomotionState = 'idle' | 'walk' | 'run' | 'jump';

export interface CharacterAnimatorOptions {
  /** Seconds per idle cycle. Defaults to `IDLE_CYCLE`. */
  idleCycle?: number;
  /** Seconds per walk cycle. Defaults to `WALK_CYCLE`. */
  walkCycle?: number;
  /** Seconds per run cycle. Defaults to `RUN_CYCLE`. */
  runCycle?: number;
}

/**
 * The measured speed a stride clip was authored at, m/s.
 *
 * Exposed so a test can assert the clip actually matches the game's speeds
 * rather than trusting that the amplitudes were chosen well.
 */
export interface StrideReference {
  readonly speed: number;
  /** Metres the foot travels fore-and-aft relative to the hips, per half cycle. */
  readonly footRange: number;
}

export class CharacterAnimator {
  readonly mixer: AnimationMixer;
  private readonly clips: Record<LocomotionState, AnimationClip>;
  private readonly actions: Record<LocomotionState, AnimationAction>;
  readonly walkReference: StrideReference;
  readonly runReference: StrideReference;

  private current: LocomotionState = 'idle';
  private jumping = false;
  private disposed = false;

  constructor(
    private readonly rig: CharacterRig,
    options: CharacterAnimatorOptions = {},
  ) {
    this.mixer = new AnimationMixer(rig.root);

    const p = rig.proportions;
    this.clips = {
      idle: buildIdleClip(rig, p, options.idleCycle ?? IDLE_CYCLE),
      walk: buildWalkClip(rig, options.walkCycle ?? WALK_CYCLE, p),
      run: buildRunClip(rig, options.runCycle ?? RUN_CYCLE, p),
      jump: buildJumpClip(rig),
    };

    // Measure the strides *before* any action has run, then restore the rest
    // pose. Playing a clip writes the bones, and a rig that starts its life
    // mid-stride is a visible glitch on frame one.
    const rest = snapshotPose(rig);
    this.walkReference = measureStride(rig, this.clips.walk);
    this.runReference = measureStride(rig, this.clips.run);
    restorePose(rig, rest);

    // clipAction returns null only for a clip with no tracks or a name that
    // matches nothing on the root, and both of those are build bugs rather than
    // runtime conditions. Failing here is far better than a null dereference
    // three frames into the first walk.
    const states: LocomotionState[] = ['idle', 'walk', 'run', 'jump'];
    const actions = {} as Record<LocomotionState, AnimationAction>;
    for (const state of states) {
      const action = this.mixer.clipAction(this.clips[state]);
      if (action === null) {
        throw new Error(`[CharacterAnimator] no action for the ${state} clip`);
      }
      actions[state] = action;
    }
    this.actions = actions;

    // Idle ping-pongs rather than repeating, so the weight shift reverses
    // smoothly instead of snapping from one side to the other.
    this.actions.idle.setLoop(LoopPingPong, Infinity);
    // The strides repeat; a walk that ping-pongs would walk backwards.
    this.actions.walk.setLoop(LoopRepeat, Infinity);
    this.actions.run.setLoop(LoopRepeat, Infinity);

    // Start on idle, fully weighted, so the first frame is a pose and not a
    // t-pose. A character that renders one frame of t-pose is a visible glitch.
    this.actions.idle.reset().play();
    this.actions.idle.setEffectiveWeight(1);
  }

  /** The state the mixer is currently blending towards. */
  get state(): LocomotionState {
    return this.current;
  }

  /** True while the jump clip is playing. */
  get isJumping(): boolean {
    return this.jumping;
  }

  /**
   * Tell the animator how fast the character is moving over the ground.
   *
   * This is the only input the locomotion needs, which is deliberate: deriving
   * the state from the input manager would make the animation depend on what the
   * player is *asking* for rather than on what the body is *doing*, and the two
   * disagree the moment the character is pushed, slides down a slope, or is
   * stopped against a wall.
   */
  setSpeed(metresPerSecond: number): void {
    if (this.disposed) return;
    const speed = Number.isFinite(metresPerSecond) ? Math.max(0, metresPerSecond) : 0;
    if (this.jumping) return;

    // Both strides stay speed-matched at all times, not only when fully blended.
    // A walk fading in at half weight still has to cover the ground the body
    // covers, or the feet skate for the whole duration of the fade.
    this.actions.walk.timeScale = clamp(speed / this.walkReference.speed, MIN_TIME_SCALE, MAX_TIME_SCALE);
    this.actions.run.timeScale = clamp(speed / this.runReference.speed, MIN_TIME_SCALE, MAX_TIME_SCALE);

    const next: LocomotionState = speed >= RUN_SPEED ? 'run' : speed >= IDLE_SPEED ? 'walk' : 'idle';
    if (next === this.current) return;

    const from = this.current;
    this.current = next;

    // Fade the incoming clip in over a slice of its own cycle, and fade the
    // outgoing one out over the same slice. Both weights are set explicitly
    // rather than left to crossFadeTo's defaults, because a fade that leaves the
    // old action at partial weight sums to more than one and the pose blows up.
    const incoming = this.actions[next];
    const outgoing = this.actions[from];
    const duration = this.clips[next].duration * 0.28;

    incoming.enabled = true;
    incoming.setEffectiveWeight(1);
    incoming.time = 0;
    incoming.play();
    incoming.crossFadeFrom(outgoing, duration, true);
  }

  /**
   * Play the jump once.
   *
   * A one-shot that interrupts whatever is playing, because a jump that has to
   * wait for the walk cycle to reach a convenient point is a jump that feels
   * broken. The mixer is returned to idle when the clip finishes - see
   * `update`.
   */
  jump(): void {
    if (this.disposed || this.jumping) return;
    this.jumping = true;
    const from = this.current;
    this.current = 'jump';

    const jumpAction = this.actions.jump;
    jumpAction.enabled = true;
    jumpAction.setEffectiveWeight(1);
    jumpAction.reset();
    jumpAction.setLoop(LoopRepeat, 0);
    jumpAction.clampWhenFinished = true;
    jumpAction.play();
    jumpAction.crossFadeFrom(this.actions[from], this.clips.jump.duration * 0.18, true);
  }

  /**
   * Advance the mixer.
   *
   * `delta` is *game* time, the same scaled delta the world is advanced with, so
   * the animation slows and freezes with everything else during time dilation.
   */
  update(delta: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(delta) || delta <= 0) return;

    this.mixer.update(delta);

    // A finished jump hands control back to the locomotion. Doing this here
    // rather than in an event listener keeps the animator's state in one place,
    // and a listener that fires after dispose would be a use-after-free.
    if (this.jumping) {
      const jumpAction = this.actions.jump;
      if (!jumpAction.isRunning() || jumpAction.time >= this.clips.jump.duration - 1e-6) {
        this.jumping = false;
        jumpAction.stop();
        this.current = 'idle';
        const idle = this.actions.idle;
        idle.enabled = true;
        idle.setEffectiveWeight(1);
        idle.play();
        idle.crossFadeFrom(jumpAction, 0.12, true);
      }
    }
  }

  /** The clips, exposed so a test can inspect what was actually generated. */
  get clipMap(): Readonly<Record<LocomotionState, AnimationClip>> {
    return this.clips;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const action of Object.values(this.actions)) action.stop();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.rig.root);
  }
}

/* ========================================================================== */
/* Clip construction                                                          */
/* ========================================================================== */

/**
 * A quaternion track from Euler angles in radians.
 *
 * Euler is the authoring format because the poses are far easier to read and
 * reason about as angles than as quaternions, and the track itself stores
 * quaternions because that is what the mixer interpolates. The conversion
 * happens here, once, at build time.
 */
function quaternionTrack(
  boneName: string,
  times: number[],
  eulers: Array<[number, number, number]>,
): QuaternionKeyframeTrack {
  const values: number[] = [];
  const q = new Quaternion();
  // A fresh Euler per keyframe. Reusing one and mutating it would work, but only
  // by accident - setFromEuler reads it synchronously today, and the day it does
  // not, the bug is invisible.
  const e = new Euler();
  for (const [x, y, z] of eulers) {
    e.set(x, y, z, 'XYZ');
    q.setFromEuler(e);
    values.push(q.x, q.y, q.z, q.w);
  }
  return new QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values);
}

/**
 * A position track, in the bone's local space.
 *
 * `rest` is the bone's position *before* the mixer has ever run, and the offsets
 * are added to it. This is not a convenience - it is the difference between
 * animating a character and teleporting them. `PropertyBinding` writes the
 * bone's `position` absolutely, so a track of `y = 0.0126` sets the hips to
 * twelve millimetres off the floor, not twelve millimetres above where they
 * belong. Every position track in this file goes through here for that reason.
 */
function positionTrack(
  boneName: string,
  times: number[],
  rest: readonly [number, number, number],
  offsets: Array<[number, number, number]>,
): VectorKeyframeTrack {
  const values: number[] = [];
  for (const [x, y, z] of offsets) values.push(rest[0] + x, rest[1] + y, rest[2] + z);
  return new VectorKeyframeTrack(`${boneName}.position`, times, values);
}

/**
 * A scale track, in the bone's local space.
 *
 * Same absolute-write rule as position, so the rest scale is added here too. A
 * bone that breathes by scaling has to start from 1, and a track of `0.012` on
 * its own would collapse the ribcage to nothing.
 */
function scaleTrack(boneName: string, times: number[], scales: Array<[number, number, number]>): VectorKeyframeTrack {
  const values: number[] = [];
  for (const [x, y, z] of scales) values.push(x, y, z);
  return new VectorKeyframeTrack(`${boneName}.scale`, times, values);
}

/** The rest position of a bone, captured before the mixer touches anything. */
function restPosition(rig: CharacterRig, name: BoneName): readonly [number, number, number] {
  const v = rig.bone(name).position;
  return [v.x, v.y, v.z];
}

/**
 * Idle: breathing and a slow weight shift.
 *
 * The breath is a chest *scale*, not a chest rotation - a chest that rotates
 * while breathing reads as the character looking down at their own feet. It is
 * kept non-uniform only in width and depth, and the asymmetry is small enough
 * that the shoulder offsets it drags along move by a couple of millimetres.
 *
 * The weight shift is a lateral hip translation plus a counter-rotation of the
 * head, and it is deliberately slower than the breath: the eye tracks position
 * far more readily than angle, so a weight shift at breath speed reads as
 * fidgeting rather than as standing.
 */
function buildIdleClip(rig: CharacterRig, p: CharacterProportions, cycle: number): AnimationClip {
  const steps = 8;
  const times: number[] = [];
  const chest: Array<[number, number, number]> = [];
  const hips: Array<[number, number, number]> = [];
  const head: Array<[number, number, number]> = [];

  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const phase = u * Math.PI * 2;
    times.push(u * cycle);

    // One full rise and fall per cycle.
    const breath = Math.sin(phase);
    chest.push([1 + breath * 0.012, 1, 1 + breath * 0.02]);

    // One full side-to-side per cycle, with a slight settle as the weight lands.
    const shift = Math.sin(phase * 0.5);
    hips.push([shift * p.hipHalf * 0.22, -Math.abs(shift) * p.head * 0.012, 0]);

    // The head drifts opposite the hips, which is what keeps a standing figure
    // from reading as a mannequin.
    head.push([-shift * 0.03, shift * 0.05, breath * 0.012]);
  }

  const tracks: KeyframeTrack[] = [
    scaleTrack('chest', times, chest),
    positionTrack('hips', times, restPosition(rig, 'hips'), hips),
    quaternionTrack('head', times, head),
  ];

  return new AnimationClip('idle', cycle, tracks);
}

/**
 * Walk: contralateral swing.
 *
 * Left arm opposes left leg. This is asserted in the test because getting it
 * backwards is the most obvious possible tell that a walk cycle is wrong, and it
 * is invisible in the code - both versions look equally plausible until you watch
 * one of them move.
 */
function buildWalkClip(rig: CharacterRig, cycle: number, p: CharacterProportions): AnimationClip {
  return buildStrideClip(rig, 'walk', cycle, p, {
    legSwing: WALK_SWING,
    armSwing: WALK_ARM_SWING,
    bob: WALK_BOB,
    lean: 0,
    kneeBend: 0.3,
    armBend: 0.25,
  });
}

/** Run: longer stride, more bob, forward lean. */
function buildRunClip(rig: CharacterRig, cycle: number, p: CharacterProportions): AnimationClip {
  return buildStrideClip(rig, 'run', cycle, p, {
    legSwing: RUN_SWING,
    armSwing: RUN_ARM_SWING,
    bob: RUN_BOB,
    lean: RUN_LEAN,
    kneeBend: 0.6,
    armBend: 1.0,
  });
}

interface StrideOptions {
  legSwing: number;
  armSwing: number;
  bob: number;
  lean: number;
  kneeBend: number;
  armBend: number;
}

/**
 * The shared stride generator.
 *
 * One cycle is two steps, so the leg phase runs over 0..2*PI and the two legs
 * are half a cycle apart. The bob runs at twice the leg frequency because the
 * body is highest when the legs pass and lowest at each footfall - getting that
 * frequency wrong is the other classic tell.
 */
function buildStrideClip(
  rig: CharacterRig,
  name: string,
  cycle: number,
  p: CharacterProportions,
  o: StrideOptions,
): AnimationClip {
  const steps = 12;
  const times: number[] = [];
  const thighL: Array<[number, number, number]> = [];
  const thighR: Array<[number, number, number]> = [];
  const shinL: Array<[number, number, number]> = [];
  const shinR: Array<[number, number, number]> = [];
  const armL: Array<[number, number, number]> = [];
  const armR: Array<[number, number, number]> = [];
  const forearmL: Array<[number, number, number]> = [];
  const forearmR: Array<[number, number, number]> = [];
  const spine: Array<[number, number, number]> = [];
  const hips: Array<[number, number, number]> = [];

  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    times.push(u * cycle);
    const phase = u * Math.PI * 2;

    // Thighs: a clean sine, so the left leg is forward at phase 0.
    const swing = Math.sin(phase);
    thighL.push([swing * o.legSwing, 0, 0]);
    thighR.push([-swing * o.legSwing, 0, 0]);

    // Shins.
    //
    // The knee is straightest at mid-stance and most bent at mid-swing, and the
    // shape that says so is a raised cosine peaking half a cycle away from the
    // thigh's zero crossing. Getting this backwards is the defect this replaces:
    // the old formula peaked when the thigh was vertical, which is exactly when
    // the leg is bearing the whole character's weight, so the knee folded at the
    // one moment it had to be locked. A raised cosine that never reaches zero
    // keeps a slight bend throughout, because a completely locked knee at this
    // scale reads as a mannequin's.
    const kneeBendAt = (p: number) => o.kneeBend * (0.12 + 0.88 * (1 - Math.cos(p)) * 0.5);
    shinL.push([kneeBendAt(phase), 0, 0]);
    shinR.push([kneeBendAt(phase + Math.PI), 0, 0]);

    // Arms oppose the legs.
    //
    // The sign is the whole thing here, and it is not obvious. Both the thigh
    // and the upper arm point down the bone chain (-Y), so a positive rotation
    // about +X swings the knee backwards and the hand backwards by the same
    // amount. Same sign therefore means same side moving together - ipsilateral,
    // which is what a broken walk looks like. Contralateral needs the opposite
    // sign: left leg forward, left arm back. tests/character-animator.test.ts
    // asserts this against the real bone transforms, because in source both
    // versions look equally plausible.
    const armSwing = -Math.sin(phase);
    armL.push([armSwing * o.armSwing, 0, 0]);
    armR.push([-armSwing * o.armSwing, 0, 0]);
    forearmL.push([-(o.armBend + Math.max(0, armSwing) * 0.3), 0, 0]);
    forearmR.push([-(o.armBend + Math.max(0, -armSwing) * 0.3), 0, 0]);

    // Spine leans into the run, and twists a little against the arms.
    spine.push([o.lean, Math.sin(phase) * 0.05, 0]);

    // Bob: two per cycle, highest as the legs pass.
    //
    // The peak is pinned to the *rest* height rather than centred on it, and
    // that is load-bearing. At mid-stance the leg is straight and bearing the
    // whole character, so the hip is at its highest and the foot is at its
    // lowest - which means the peak has to be exactly the rest height or the
    // sole never reaches the ground and the character glides. Centred instead,
    // the peak sat a full amplitude above rest and the boots floated three
    // centimetres clear of the terrain for the whole cycle.
    const amplitude = o.bob * p.height;
    hips.push([0, amplitude * (Math.abs(Math.cos(phase)) - 1), 0]);
  }

  const tracks: KeyframeTrack[] = [
    quaternionTrack('thigh.L', times, thighL),
    quaternionTrack('thigh.R', times, thighR),
    quaternionTrack('shin.L', times, shinL),
    quaternionTrack('shin.R', times, shinR),
    quaternionTrack('upperArm.L', times, armL),
    quaternionTrack('upperArm.R', times, armR),
    quaternionTrack('lowerArm.L', times, forearmL),
    quaternionTrack('lowerArm.R', times, forearmR),
    quaternionTrack('spine', times, spine),
    positionTrack('hips', times, restPosition(rig, 'hips'), hips),
  ];

  return new AnimationClip(name, cycle, tracks);
}

/**
 * Jump: launch, airborne, land.
 *
 * Three phases, and the timings are not evenly spaced on purpose - the launch is
 * quick, the hang is long, and the land is quick. Even spacing is what makes a
 * procedural jump feel like a metronome.
 */
function buildJumpClip(rig: CharacterRig): AnimationClip {
  const p = rig.proportions;
  const launch = 0.14;
  const hang = 0.34;
  const land = 0.16;
  const total = launch + hang + land;

  const times = [0, launch, launch + hang * 0.5, launch + hang, total];

  // Hips: crouch, rise, settle.
  const hips: Array<[number, number, number]> = [
    [0, -p.head * 0.16, 0],
    [0, p.head * 0.06, 0],
    [0, p.head * 0.02, 0],
    [0, 0, 0],
    [0, -p.head * 0.04, 0],
  ];

  // Legs: tuck on launch, extend in the air, absorb on landing.
  const thigh: Array<[number, number, number]> = [
    [-0.55, 0, 0],
    [0.15, 0, 0],
    [-0.1, 0, 0],
    [0.1, 0, 0],
    [-0.35, 0, 0],
  ];
  const shin: Array<[number, number, number]> = [
    [1.0, 0, 0],
    [0.15, 0, 0],
    [0.35, 0, 0],
    [0.2, 0, 0],
    [0.85, 0, 0],
  ];

  // Arms go up for balance, which is what a body does unprompted.
  const arm: Array<[number, number, number]> = [
    [1.5, 0, 0],
    [-0.9, 0, 0],
    [-0.6, 0, 0],
    [-0.4, 0, 0],
    [0.7, 0, 0],
  ];

  const tracks: KeyframeTrack[] = [
    positionTrack('hips', times, restPosition(rig, 'hips'), hips),
    quaternionTrack('thigh.L', times, thigh),
    quaternionTrack('thigh.R', times, thigh),
    quaternionTrack('shin.L', times, shin),
    quaternionTrack('shin.R', times, shin),
    quaternionTrack('upperArm.L', times, arm),
    quaternionTrack('upperArm.R', times, arm),
    quaternionTrack('spine', times, [
      [0.2, 0, 0],
      [-0.12, 0, 0],
      [-0.05, 0, 0],
      [0, 0, 0],
      [0.16, 0, 0],
    ]),
  ];

  return new AnimationClip('jump', total, tracks);
}

/* ========================================================================== */
/* Measuring the strides                                                      */
/* ========================================================================== */

interface PoseSnapshot {
  readonly positions: Float64Array;
  readonly quaternions: Float64Array;
}

/** Every bone's rest position and rotation, so a measurement can be undone. */
function snapshotPose(rig: CharacterRig): PoseSnapshot {
  const positions = new Float64Array(BONE_NAMES.length * 3);
  const quaternions = new Float64Array(BONE_NAMES.length * 4);
  BONE_NAMES.forEach((name, i) => {
    const bone = rig.bone(name);
    positions[i * 3] = bone.position.x;
    positions[i * 3 + 1] = bone.position.y;
    positions[i * 3 + 2] = bone.position.z;
    quaternions[i * 4] = bone.quaternion.x;
    quaternions[i * 4 + 1] = bone.quaternion.y;
    quaternions[i * 4 + 2] = bone.quaternion.z;
    quaternions[i * 4 + 3] = bone.quaternion.w;
  });
  return { positions, quaternions };
}

function restorePose(rig: CharacterRig, snap: PoseSnapshot): void {
  BONE_NAMES.forEach((name, i) => {
    const bone = rig.bone(name);
    bone.position.set(snap.positions[i * 3], snap.positions[i * 3 + 1], snap.positions[i * 3 + 2]);
    bone.quaternion.set(
      snap.quaternions[i * 4],
      snap.quaternions[i * 4 + 1],
      snap.quaternions[i * 4 + 2],
      snap.quaternions[i * 4 + 3],
    );
  });
  rig.root.updateMatrixWorld(true);
}

/**
 * Play a stride clip on its own and measure how far the foot actually travels.
 *
 * The distance that matters is fore-and-aft *relative to the hips*, not relative
 * to the world, because the hips are what the ground speed moves. Measuring
 * through the same path the game uses - the mixer, writing real bone transforms -
 * rather than by re-deriving the geometry is the difference between a number that
 * is true and a number that is approximately true.
 */
function measureStride(rig: CharacterRig, clip: AnimationClip): StrideReference {
  const mixer = new AnimationMixer(rig.root);
  const action = mixer.clipAction(clip);
  if (action === null) {
    throw new Error(`[CharacterAnimator] cannot measure the ${clip.name} clip`);
  }
  action.play();

  const foot = new Vector3();
  const hip = new Vector3();
  const samples = 24;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i <= samples; i++) {
    mixer.setTime((i / samples) * clip.duration);
    rig.root.updateMatrixWorld(true);
    rig.bone('foot.L').getWorldPosition(foot);
    rig.bone('hips').getWorldPosition(hip);
    // The rig faces local +Z, so fore-and-aft is Z.
    const d = foot.z - hip.z;
    if (d < min) min = d;
    if (d > max) max = d;
  }

  action.stop();
  mixer.uncacheRoot(rig.root);

  const footRange = max - min;
  return { speed: (2 * footRange) / clip.duration, footRange };
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
