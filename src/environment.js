/**
 * The world: a plain ground plane with nothing on it, a soft sky and the
 * lighting that shapes the character. No props, no obstacles, no UI.
 */

import * as THREE from "three";

const SKY_TOP = new THREE.Color(0x9fb4c8);
const SKY_BOTTOM = new THREE.Color(0xd7dde2);
const GROUND = new THREE.Color(0x8d949b);

/** A back-facing sphere whose vertex colours fade from horizon to zenith. */
function skyDomeGeometry(radius) {
  const geometry = new THREE.SphereGeometry(radius, 32, 16);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const height = position.getY(i) / radius;                 // -1 .. 1
    const t = THREE.MathUtils.smoothstep(height, -0.05, 0.55);
    color.copy(SKY_BOTTOM).lerp(SKY_TOP, t);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Renderer settings: soft shadows, filmic tone mapping, crisp on retina. */
export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  return renderer;
}

/**
 * The world itself: sky, one ground plane and the lights. It is deliberately
 * possible to build without a renderer, so tests can inspect it headlessly.
 */
export function createScene() {
  const scene = new THREE.Scene();
  scene.background = SKY_BOTTOM.clone();
  scene.fog = new THREE.Fog(SKY_BOTTOM, 45, 190);

  // A gradient dome, so the empty world still reads as a place. The gradient
  // is painted into vertex colours rather than a custom shader, which keeps the
  // whole scene on three's standard material pipeline.
  const dome = new THREE.Mesh(skyDomeGeometry(400), new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  }));
  dome.frustumCulled = false;
  scene.add(dome);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: GROUND, roughness: 0.96, metalness: 0.0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const key = new THREE.DirectionalLight(0xfff3e2, 2.4);
  key.position.set(6, 11, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 60;
  key.shadow.camera.left = -9;
  key.shadow.camera.right = 9;
  key.shadow.camera.top = 9;
  key.shadow.camera.bottom = -9;
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  scene.add(key.target);

  scene.add(new THREE.HemisphereLight(0xbcd3e8, 0x6d747a, 1.15));
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  const camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 0.1, 800,
  );

  /* Keep the shadow frustum centred on the character, so the shadow stays
     crisp however far it walks from the origin. */
  function trackShadow(target) {
    key.target.position.set(target.x, 0, target.z);
    key.target.updateMatrixWorld();
    key.position.set(target.x + 6, 11, target.z + 5);
  }

  return { scene, camera, ground, key, trackShadow };
}

/** Everything the app needs: a renderer, the world, and a resize handler. */
export function createEnvironment(canvas) {
  const renderer = createRenderer(canvas);
  const world = createScene();

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    world.camera.aspect = w / h;
    world.camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  return { renderer, ...world, resize };
}
