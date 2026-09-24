/**
 * Tunables for the whole scene.
 *
 * The locomotion speeds are not guesses: they are measured from the exported
 * animation by tools/verify_clips.py, which reports how fast the ground travels
 * under a planted foot. Moving the character at exactly that speed is what
 * stops the feet from skating. Re-run that tool and paste the GAIT table here
 * after any change to tools/build_character.py.
 */

/** Metres per second the gait animation actually walks / runs at. */
export const GAIT = {
  walk: { speed: 1.13, duration: 1.0 },
  run: { speed: 2.45, duration: 0.667 },
  idle: { duration: 3.0 },
  jump: { duration: 0.5 },
  fall: { duration: 0.8 },
  land: { duration: 0.467 },
};

/** Above this speed the run clip takes over from the walk (walk is 1.13). */
export const RUN_AT = 1.45;

export const MOVEMENT = {
  /** how fast the character reaches its target speed (higher = snappier) */
  accelerate: 9.0,
  brake: 14.0,
  /** the landing absorb scrubs momentum off this fast (a hard, short stop) */
  absorbBrake: 26.0,
  /** steering: radians per second the body swings towards the input */
  turn: 10.0,
  /** horizontal control retained while airborne (1 = full, 0 = none) */
  airControl: 0.35,
  /** a jump leaves the ground this far into the jump clip ... */
  launchTime: 0.27,
  /** ... with this much upward speed (0.59 m apex, 0.69 s in the air) */
  jumpSpeed: 3.4,
  gravity: 9.81,
};

export const CAMERA = {
  distance: 4.6,
  /** the camera looks at the character's chest from this height behind it */
  targetHeight: 1.15,
  startPitch: 0.17,
  /** how quickly it swings in behind the character and follows it */
  yawFollow: 2.2,
  positionFollow: 9.0,
  /** mouse drag orbits by this much per pixel */
  dragSpeed: 0.005,
  minPitch: -0.25,
  maxPitch: 0.95,
};

export const ASSET = "./public/assets/astra.glb";
