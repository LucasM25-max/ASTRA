/**
 * ASTRA -- a humanoid walking around an empty world.
 *
 * Wiring only: the world lives in environment.js, the character in
 * character.js, the controls in player.js and the camera in followCamera.js.
 */

import { ASSET } from "./config.js";
import { Character, loadCharacter } from "./character.js";
import { createEnvironment } from "./environment.js";
import { FollowCamera } from "./followCamera.js";
import { Player } from "./player.js";

const MAX_STEP = 0.05;   // seconds; a tab that was in the background jumps back

async function boot() {
  const canvas = document.getElementById("view");

  let world;
  try {
    world = createEnvironment(canvas);
  } catch (error) {
    console.error("[astra] this browser could not provide a WebGL context", error);
    return;
  }

  let character;
  try {
    character = await loadCharacter(ASSET);
  } catch (error) {
    console.error(`[astra] could not load ${ASSET}`, error);
    return;
  }
  world.scene.add(character.object3D);

  const camera = new FollowCamera(world.camera, character, canvas);
  const player = new Player(character, world.camera, canvas);

  let previous = performance.now();
  function frame(now) {
    const dt = Math.min((now - previous) / 1000, MAX_STEP);
    previous = now;

    player.update(dt);
    character.update(dt);
    camera.update(dt, player.travelDirection());
    world.trackShadow(player.position);
    world.renderer.render(world.scene, world.camera);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // handy from the console, and what tools/check_app.mjs exercises headlessly
  window.astra = { character, player, camera, world, Character };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
