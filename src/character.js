/**
 * The animated humanoid: loads the glTF, owns its AnimationMixer and keeps the
 * right clip playing for what the character is doing.
 *
 * One rule matters more than the rest here: the clips were authored for a walk
 * of 1.13 m/s and a run of 2.45 m/s, so the playback rate is tied to the actual
 * ground speed and the walk/run switch keeps its phase. That is what makes the
 * feet stay planted instead of skating.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GAIT, RUN_AT } from "./config.js";

/** crossfade length per state we blend into, seconds */
const FADE = { idle: 0.24, walk: 0.22, run: 0.18, jump: 0.10, fall: 0.20, land: 0.12 };

const LOOP_ONCE = new Set(["jump", "land"]);

export class Character {
  constructor(gltf) {
    this.mixer = new THREE.AnimationMixer(gltf.scene);
    this.actions = {};
    for (const clip of gltf.animations) {
      const action = this.mixer.clipAction(clip);
      action.setLoop(LOOP_ONCE.has(clip.name) ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = LOOP_ONCE.has(clip.name);
      action.enabled = true;
      action.setEffectiveWeight(0);
      this.actions[clip.name] = action;
    }

    /* The glTF faces +Z (Blender's -Y forward); a three.js object faces -Z.
       Turning the model half a turn makes the wrapper's forward the real one. */
    gltf.scene.rotation.y = Math.PI;
    gltf.scene.traverse((node) => {
      if (node.isMesh || node.isSkinnedMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        node.frustumCulled = false;   // skinned bounds go stale while animating
      }
    });

    this.object3D = new THREE.Group();
    this.object3D.add(gltf.scene);

    this.state = null;
    this.speed = 0;
    this.duration = {};
    for (const [name, action] of Object.entries(this.actions)) {
      this.duration[name] = action.getClip().duration;
    }

    this.play("idle", 0);
  }

  /** Start `name`, crossfading out of whatever is playing. */
  play(name, fade = FADE[name] ?? 0.2, syncPhase = false) {
    const next = this.actions[name];
    if (!next || this.state === name) return;
    const prev = this.state ? this.actions[this.state] : null;

    // remember the stride phase before anything is reset, so a walk <-> run
    // change keeps both legs agreeing about which foot is where
    let phase = null;
    if (prev && syncPhase) {
      const dur = prev.getClip().duration;
      if (dur > 0) phase = (prev.time % dur) / dur;
    }

    next.reset();
    if (phase !== null) next.time = phase * next.getClip().duration;
    next.setEffectiveWeight(1);
    next.play();

    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    this.state = name;
  }

  /**
   * Ground locomotion. The clip is chosen from the actual speed rather than
   * from which key is held, so the legs always agree with the ground: holding
   * Shift while accelerating plays the walk, then hands over to the run.
   */
  setLocomotion(speed) {
    this.speed = speed;
    const name = speed < 0.12 ? "idle" : (speed >= RUN_AT ? "run" : "walk");
    const changed = this.state !== name;
    const inCycle = this.state === "walk" || this.state === "run";
    this.play(name, FADE[name], changed && inCycle && name !== "idle");
    this.matchSpeed();
  }

  /** Playback rate that puts the animation's feet on the ground the body is on. */
  matchSpeed() {
    const walk = this.actions.walk;
    const run = this.actions.run;
    walk.setEffectiveTimeScale(clamp(this.speed / GAIT.walk.speed, 0.45, 1.9));
    run.setEffectiveTimeScale(clamp(this.speed / GAIT.run.speed, 0.5, 1.7));
    this.actions.idle.setEffectiveTimeScale(1);
  }

  /** Rising edge of a jump: the crouch and the drive, launched by the player. */
  beginJump() {
    this.play("jump", FADE.jump);
  }

  /** Airborne: hold the reaching pose, looping until the ground arrives. */
  beginFall() {
    if (this.state !== "fall") this.play("fall", FADE.fall);
  }

  /** Touch down: absorb it, then the player resumes locomotion. */
  beginLand() {
    this.play("land", FADE.land);
  }

  /** Seconds left of the current one-shot clip, 0 when it is looping. */
  timeLeft() {
    const action = this.state ? this.actions[this.state] : null;
    if (!action || !LOOP_ONCE.has(this.state)) return 0;
    return Math.max(0, action.getClip().duration - action.time);
  }

  update(dt) {
    this.mixer.update(dt);
  }
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

export async function loadCharacter(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  return new Character(gltf);
}
