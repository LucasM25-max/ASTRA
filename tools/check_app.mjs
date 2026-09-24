/**
 * Headless check of the app's behaviour: no browser, no WebGL, but the real
 * modules -- the real glTF, the real AnimationMixer, the real player logic.
 *
 *   node tools/check_app.mjs
 *
 * It drives the character through the whole control set (walk, sprint, jump,
 * land) and asserts what the game promises: the right clip for the state, the
 * playback rate matched to the ground speed, the feet on the floor, the body
 * facing the way it moves, and the camera behind it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { Character } from "../src/character.js";
import { createScene } from "../src/environment.js";
import { FollowCamera } from "../src/followCamera.js";
import { Player } from "../src/player.js";
import { GAIT, MOVEMENT } from "../src/config.js";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const STEP = 1 / 60;

/* --------------------------------------------------------------- harness */
const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `   ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// the app only touches these in its event handlers
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
};

class StubTarget {
  constructor() { this.position = new THREE.Vector3(); this.rotation = new THREE.Euler(); }
}

async function loadCharacter() {
  const buffer = await readFile(join(root, "public", "assets", "astra.glb"));
  const gltf = await new GLTFLoader().parseAsync(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), "");
  return { character: new Character(gltf), gltf };
}

/** Lowest world-space point of the skinned mesh, i.e. where the soles are. */
function lowestPoint(character) {
  const vertex = new THREE.Vector3();
  let lowest = Infinity;
  character.object3D.updateMatrixWorld(true);
  character.object3D.traverse((node) => {
    if (!node.isSkinnedMesh) return;
    for (let i = 0; i < node.geometry.attributes.position.count; i++) {
      vertex.fromBufferAttribute(node.geometry.attributes.position, i);
      node.applyBoneTransform(i, vertex);            // needs the vertex as input
      vertex.applyMatrix4(node.matrixWorld);
      if (vertex.y < lowest) lowest = vertex.y;
    }
  });
  return lowest;
}

/* ------------------------------------------------------------------ run */
const { character } = await loadCharacter();

check("clip set", ["idle", "walk", "run", "jump", "fall", "land"]
  .every((name) => character.actions[name]),
  Object.keys(character.actions).sort().join(" "));
check("clip durations", Math.abs(character.duration.walk - GAIT.walk.duration) < 1e-3
  && Math.abs(character.duration.run - GAIT.run.duration) < 1e-3,
  `walk ${character.duration.walk.toFixed(3)}s run ${character.duration.run.toFixed(3)}s`);

/* The wrapper's forward is its -Z, so the visor has to sit on the -Z side of
   the head: that is what makes heading 0 mean "walking towards -Z". */
function centroid(materialName, above) {
  const point = new THREE.Vector3();
  const sum = new THREE.Vector3();
  let count = 0;
  character.object3D.updateMatrixWorld(true);
  character.object3D.traverse((node) => {
    if (!node.isSkinnedMesh || node.material.name !== materialName) return;
    for (let i = 0; i < node.geometry.attributes.position.count; i++) {
      point.fromBufferAttribute(node.geometry.attributes.position, i);
      node.applyBoneTransform(i, point);
      point.applyMatrix4(node.matrixWorld);
      if (point.y > above) { sum.add(point); count++; }
    }
  });
  return count ? sum.divideScalar(count) : null;
}
const visor = centroid("dark", 1.4);
const skull = centroid("light", 1.5);
check("model faces its own forward axis", visor !== null && skull !== null && visor.z < skull.z - 0.05,
  `visor z ${visor?.z.toFixed(3)} vs head z ${skull?.z.toFixed(3)}`);

const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 800);
camera.position.set(0, 2, 5);
camera.updateMatrixWorld(true);
const target = new StubTarget();
const player = new Player(character, camera, { addEventListener() {}, removeEventListener() {} });
const follow = new FollowCamera(camera, { object3D: target }, { addEventListener() {} });

const press = (code) => player._onKeyDown({ code, preventDefault() {} });
const release = (code) => player._onKeyUp({ code });

function simulate(seconds, { onFrame } = {}) {
  const frames = Math.round(seconds / STEP);
  for (let i = 0; i < frames; i++) {
    player.update(STEP);
    character.update(STEP);
    target.position.copy(player.position);
    target.rotation.y = player.heading;
    follow.update(STEP, player.travelDirection());
    onFrame?.(i * STEP);
  }
}

/* --- idle ---------------------------------------------------------------- */
simulate(0.5);
{
  // the first thing a player sees has to be the character, framed, not an
  // empty plane: project the chest through the camera
  const chest = new THREE.Vector3(player.position.x, player.position.y + 1.2, player.position.z);
  const ndc = chest.clone().project(camera);
  check("character is framed on screen at startup",
    Math.abs(ndc.x) < 0.6 && Math.abs(ndc.y) < 0.6 && ndc.z > -1 && ndc.z < 1,
    `ndc (${ndc.x.toFixed(2)}, ${ndc.y.toFixed(2)})`);
}
check("starts idle", character.state === "idle", `state=${character.state}`);
const restLow = lowestPoint(character);
check("soles rest on the floor", Math.abs(restLow) < 0.005, `lowest vertex y = ${restLow.toFixed(4)}`);

/* --- walk ---------------------------------------------------------------- */
press("KeyW");
simulate(1.6);
check("W walks", character.state === "walk", `state=${character.state}`);
check("walks at the animated speed", Math.abs(player.speed - GAIT.walk.speed) < 0.02,
  `${player.speed.toFixed(3)} m/s vs ${GAIT.walk.speed}`);
check("walk clip runs at 1x", Math.abs(character.actions.walk.getEffectiveTimeScale() - 1) < 0.03,
  `timeScale=${character.actions.walk.getEffectiveTimeScale().toFixed(3)}`);
check("moves forward", player.position.z < -1.4,
  `z=${player.position.z.toFixed(2)} after 1.6 s`);
check("body faces the way it moves", Math.abs(player.heading) < 1e-6
  || Math.abs(Math.abs(player.heading) - 0) < 1e-6, `heading=${player.heading.toFixed(3)}`);

let lowestWhileWalking = Infinity;
simulate(1.2, { onFrame: () => { lowestWhileWalking = Math.min(lowestWhileWalking, lowestPoint(character)); } });
check("no foot goes through the floor while walking", lowestWhileWalking > -0.012,
  `lowest vertex y = ${lowestWhileWalking.toFixed(4)}`);

/* --- sprint -------------------------------------------------------------- */
press("ShiftLeft");
simulate(1.2);
check("Shift sprints", character.state === "run", `state=${character.state}`);
check("sprints at the animated speed", Math.abs(player.speed - GAIT.run.speed) < 0.05,
  `${player.speed.toFixed(3)} m/s vs ${GAIT.run.speed}`);
check("run clip runs at 1x", Math.abs(character.actions.run.getEffectiveTimeScale() - 1) < 0.05,
  `timeScale=${character.actions.run.getEffectiveTimeScale().toFixed(3)}`);

/* --- strafing turns the body --------------------------------------------- */
release("KeyW");
press("KeyD");
simulate(0.6);
check("A/D steers the body", Math.abs(player.heading) > 0.5,
  `heading=${player.heading.toFixed(2)} rad`);
release("KeyD");
simulate(0.9);
check("releasing the keys slows to idle", character.state === "idle" && player.speed < 0.1,
  `state=${character.state} speed=${player.speed.toFixed(3)}`);

/* --- jump ---------------------------------------------------------------- */
const jumpSeen = new Set();
press("Space");
player._onKeyUp({ code: "Space" });
simulate(0.01);
check("Space starts the jump", character.state === "jump" && player.jumping,
  `state=${character.state}`);

let apex = 0;
let lowestInAir = Infinity;
simulate(1.6, {
  onFrame: () => {
    jumpSeen.add(character.state);
    apex = Math.max(apex, player.position.y);
    if (!player.grounded) lowestInAir = Math.min(lowestInAir, lowestPoint(character));
  },
});
check("jump -> fall -> land", jumpSeen.has("fall") && jumpSeen.has("land"),
  [...jumpSeen].join(" "));
check("leaves the ground", apex > 0.5, `apex ${apex.toFixed(2)} m`);
check("air time is sane", Math.abs(2 * MOVEMENT.jumpSpeed / MOVEMENT.gravity - 0.69) < 0.1,
  `${(2 * MOVEMENT.jumpSpeed / MOVEMENT.gravity).toFixed(2)} s`);
check("feet stay above the floor in the air", lowestInAir > -0.012,
  `lowest vertex y = ${lowestInAir.toFixed(4)}`);
simulate(1.0);
check("returns to idle after landing", character.state === "idle" && player.grounded,
  `state=${character.state} y=${player.position.y.toFixed(3)}`);

/* --- landing at speed ---------------------------------------------------- */
// Sprint, jump, and keep hold of the keys: the run has to resume without the
// character stalling. Then the same but letting go as the feet touch down: the
// body has to stop where it lands instead of gliding across the floor.
function sprintJumpLand(stopAtTouchdown) {
  release("KeyW");
  release("ShiftLeft");
  simulate(0.4);
  press("KeyW");
  press("ShiftLeft");
  simulate(0.8);                       // up to a full sprint

  press("Space");
  player._onKeyUp({ code: "Space" });

  let touchdown = null;
  let travelled = 0;
  simulate(2.0, {
    onFrame: () => {
      if (touchdown === null && player.grounded && character.state === "land") {
        touchdown = player.position.clone();
        if (stopAtTouchdown) { release("KeyW"); release("ShiftLeft"); }
      }
      if (touchdown) travelled = player.position.distanceTo(touchdown);
    },
  });
  const result = { travelled, state: character.state, speed: player.speed };
  release("KeyW");
  release("ShiftLeft");
  simulate(0.4);
  return result;
}

const keptRunning = sprintJumpLand(false);
check("a running landing keeps running", keptRunning.state === "run" && keptRunning.speed > 2.0,
  `state=${keptRunning.state} speed=${keptRunning.speed.toFixed(2)} m/s`);

const stoppedShort = sprintJumpLand(true);
check("letting go on touchdown does not skate",
  stoppedShort.state === "idle" && stoppedShort.travelled < 0.4,
  `travelled ${stoppedShort.travelled.toFixed(2)} m after the feet touched down, `
  + `state=${stoppedShort.state}`);

/* --- camera -------------------------------------------------------------- */
press("KeyW");
press("ShiftLeft");
simulate(2.0);
const toBody = new THREE.Vector3().subVectors(player.position, camera.position).setY(0).normalize();
const facing = new THREE.Vector3(-Math.sin(player.heading), 0, -Math.cos(player.heading));
check("camera sits behind the character", toBody.dot(facing) > 0.85,
  `dot = ${toBody.dot(facing).toFixed(3)}`);
const toFocus = camera.position.distanceTo(
  new THREE.Vector3(player.position.x, player.position.y + 1.15, player.position.z));
check("camera keeps its distance", Math.abs(toFocus - 4.6) < 0.35, `${toFocus.toFixed(2)} m`);
release("KeyW");
release("ShiftLeft");

/* --- the world itself ---------------------------------------------------- */
const world = createScene();
const props = world.scene.children.filter((node) => node.isMesh
  && node !== world.ground && !node.geometry.type.includes("Sphere"));
check("the world is empty apart from the ground", props.length === 0,
  props.map((n) => n.name || n.geometry.type).join(", ") || "nothing in it");
check("the ground is a flat plane at y = 0",
  world.ground.geometry.type === "PlaneGeometry"
  && Math.abs(world.ground.rotation.x + Math.PI / 2) < 1e-6
  && world.ground.position.y === 0,
  `${world.ground.geometry.parameters.width}x${world.ground.geometry.parameters.height} m`);
check("the ground receives the character's shadow", world.ground.receiveShadow);
check("the key light casts a shadow", world.key.castShadow && world.key.shadow.mapSize.x >= 1024,
  `${world.key.shadow.mapSize.x}px map`);
check("the scene has a camera", world.camera.isPerspectiveCamera);

/* --- long run, for drift and NaN ---------------------------------------- */
press("KeyW");
press("ShiftLeft");
simulate(20, {
  onFrame: () => {
    if (!Number.isFinite(player.position.x + player.position.y + player.position.z
        + player.speed + player.heading)) throw new Error("state went non-finite");
  },
});
check("20 s of running stays finite and on the floor",
  player.position.y === 0 && Math.abs(player.speed - GAIT.run.speed) < 0.05,
  `y=${player.position.y} speed=${player.speed.toFixed(3)} travelled ${player.position.length().toFixed(1)} m`);

console.log();
if (failures.length) {
  console.log(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("all app checks passed");
