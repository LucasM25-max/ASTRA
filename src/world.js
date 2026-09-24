import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Sky } from "three/addons/objects/Sky.js";
import {
  WORLD_HALF,
  WATER_Y,
  terrainHeight,
  slopeAt,
  pollutionAt,
  forestMask,
  riverCenterZ,
  riverHalfWidth,
  streamCenterX,
  streamHalfWidth,
} from "./landscape.js";
import { createWater } from "./water.js";

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadTex(loader, url, { srgb = false, wrap = true, aniso = 8 } = {}) {
  const t = loader.load(url);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (wrap) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = aniso;
  return t;
}

function enhanceShadows(root) {
  root.traverse((n) => {
    if (n.isMesh) {
      n.castShadow = true;
      n.receiveShadow = true;
      if (n.material) n.material.shadowSide = THREE.FrontSide;
    }
  });
}

function makeProceduralTree(rng, dead = false) {
  const g = new THREE.Group();
  const h = 4.8 + rng() * 2.6;
  const r0 = 0.18 + rng() * 0.16;
  const bark = new THREE.MeshStandardMaterial({
    color: dead ? 0x4a4034 : 0x4a311f,
    roughness: 0.86,
  });
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 0.22, r0, h, 8), bark);
  trunk.position.y = h * 0.5;
  g.add(trunk);
  const n = dead ? 4 : 6;
  for (let i = 0; i < n; i++) {
    const t = 0.4 + rng() * 0.5;
    const len = h * (0.22 + rng() * 0.28);
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.025, r0 * 0.16, len, 6), bark);
    br.position.set(0, h * t, 0);
    br.rotation.z = (rng() - 0.5) * 1.4;
    br.rotation.y = rng() * Math.PI * 2;
    br.translateY(len * 0.35);
    g.add(br);
  }
  if (!dead) {
    const leaf = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.28 + rng() * 0.08, 0.55, 0.32),
      roughness: 0.62,
    });
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15 + rng() * 0.7, 1), leaf);
      s.position.set((rng() - 0.5) * 1.6, h * (0.62 + rng() * 0.32), (rng() - 0.5) * 1.6);
      s.scale.set(1, 0.75 + rng() * 0.2, 1);
      g.add(s);
    }
  }
  enhanceShadows(g);
  return g;
}

function makeProceduralRock(rng) {
  const geo = new THREE.IcosahedronGeometry(0.7 + rng() * 0.5, 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    v.multiplyScalar(0.85 + rng() * 0.3);
    v.y *= 0.45 + rng() * 0.2;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x6a635a, roughness: 0.82 })
  );
  enhanceShadows(m);
  return m;
}

function makeProceduralBarrel(rng) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6a3a16,
    roughness: 0.55,
    metalness: 0.4,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.95, 14), mat);
  body.position.y = 0.48;
  g.add(body);
  enhanceShadows(g);
  if (rng() > 0.5) g.rotation.z = 1.15;
  return g;
}

function makeProceduralReed(rng) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x5a6a32,
    roughness: 0.72,
    side: THREE.DoubleSide,
  });
  for (let i = 0; i < 7; i++) {
    const h = 0.9 + rng() * 0.8;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, h, 4), mat);
    m.position.set((rng() - 0.5) * 0.3, h * 0.5, (rng() - 0.5) * 0.3);
    m.rotation.z = (rng() - 0.5) * 0.25;
    g.add(m);
  }
  enhanceShadows(g);
  return g;
}

export async function createWorld(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc9bba6);
  scene.fog = new THREE.FogExp2(0xc4b49a, 0.0115);

  const texLoader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const A = Math.min(8, maxAniso);

  const textures = {
    terrainAlbedo: loadTex(texLoader, "/textures/terrain_albedo.jpg", { srgb: true, aniso: A }),
    terrainNor: loadTex(texLoader, "/textures/terrain_nor.jpg", { aniso: A }),
    terrainRough: loadTex(texLoader, "/textures/terrain_rough.jpg", { aniso: A }),
    grass: loadTex(texLoader, "/textures/grass.jpg", { srgb: true, aniso: A }),
    grassNor: loadTex(texLoader, "/textures/grass_nor.jpg", { aniso: A }),
    forest: loadTex(texLoader, "/textures/forest.jpg", { srgb: true, aniso: A }),
    pebbles: loadTex(texLoader, "/textures/pebbles.jpg", { srgb: true, aniso: A }),
    mud: loadTex(texLoader, "/textures/mud.jpg", { srgb: true, aniso: A }),
    bark: loadTex(texLoader, "/textures/bark.jpg", { srgb: true, aniso: A }),
    barkNor: loadTex(texLoader, "/textures/bark_nor.jpg", { aniso: A }),
    barkRough: loadTex(texLoader, "/textures/bark_rough.jpg", { aniso: A }),
    canopy: loadTex(texLoader, "/textures/canopy.jpg", { srgb: true, aniso: A }),
    leaf: loadTex(texLoader, "/textures/leaf.png", { srgb: true, wrap: false, aniso: A }),
    rust: loadTex(texLoader, "/textures/rust.jpg", { srgb: true, aniso: A }),
    rustNor: loadTex(texLoader, "/textures/rust_nor.jpg", { aniso: A }),
    dead: loadTex(texLoader, "/textures/deadgrass.jpg", { srgb: true, aniso: A }),
    moss: loadTex(texLoader, "/textures/moss.jpg", { srgb: true, aniso: A }),
    noise: loadTex(texLoader, "/textures/noise.png", { aniso: 2 }),
    foam: loadTex(texLoader, "/textures/foam.png", { srgb: true, aniso: 4 }),
    blade: loadTex(texLoader, "/textures/grass_blade.png", { srgb: true, wrap: false, aniso: 4 }),
  };
  textures.terrainAlbedo.wrapS = textures.terrainAlbedo.wrapT = THREE.ClampToEdgeWrapping;
  textures.terrainNor.wrapS = textures.terrainNor.wrapT = THREE.ClampToEdgeWrapping;
  textures.terrainRough.wrapS = textures.terrainRough.wrapT = THREE.ClampToEdgeWrapping;

  const sunDir = new THREE.Vector3(0.32, 0.74, 0.58).normalize();

  // --- sky (miniature stage, warm key) ---
  const sky = new Sky();
  sky.scale.setScalar(420);
  sky.material.uniforms.turbidity.value = 3.6;
  sky.material.uniforms.rayleigh.value = 0.85;
  sky.material.uniforms.mieCoefficient.value = 0.006;
  sky.material.uniforms.mieDirectionalG.value = 0.82;
  const sunPos = sunDir.clone().multiplyScalar(100);
  sky.material.uniforms.sunPosition.value.copy(sunPos);
  sky.material.fog = false;
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xb9c8dc, 0x3d2a16, 0.48);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffe0b0, 2.55);
  key.position.copy(sunDir.clone().multiplyScalar(48));
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 4;
  key.shadow.camera.far = 130;
  const s = 46;
  key.shadow.camera.left = -s;
  key.shadow.camera.right = s;
  key.shadow.camera.top = s;
  key.shadow.camera.bottom = -s;
  key.shadow.bias = -0.00022;
  key.shadow.normalBias = 0.035;
  scene.add(key);
  scene.add(key.target);

  const fill = new THREE.DirectionalLight(0x8fb6ff, 0.42);
  fill.position.set(-26, 14, -16);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xfff3dc, 0.38);
  rim.position.set(-14, 10, 18);
  scene.add(rim);

  const amb = new THREE.AmbientLight(0x2a241c, 0.22);
  scene.add(amb);

  // --- terrain ---
  const seg = 196;
  const tgeo = new THREE.PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2, seg, seg);
  tgeo.rotateX(-Math.PI / 2);
  const pos = tgeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z));
  }
  tgeo.computeVertexNormals();
  const tmat = new THREE.MeshStandardMaterial({
    map: textures.terrainAlbedo,
    normalMap: textures.terrainNor,
    roughnessMap: textures.terrainRough,
    roughness: 1,
    metalness: 0.02,
    envMapIntensity: 0.4,
  });
  tmat.normalScale.set(1.1, 1.1);
  const terrain = new THREE.Mesh(tgeo, tmat);
  terrain.receiveShadow = true;
  terrain.castShadow = true;
  scene.add(terrain);

  // --- water ---
  const water = createWater(textures);
  scene.add(water);

  // --- materials for prototypes ---
  const barkMat = new THREE.MeshStandardMaterial({
    map: textures.bark,
    normalMap: textures.barkNor,
    roughnessMap: textures.barkRough,
    roughness: 1,
    metalness: 0.0,
  });
  textures.bark.repeat.set(1.5, 2.2);
  textures.barkNor.repeat.set(1.5, 2.2);
  textures.barkRough.repeat.set(1.5, 2.2);

  const leafMat = new THREE.MeshStandardMaterial({
    map: textures.leaf,
    roughness: 0.58,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.28,
    transparent: false,
  });
  const canopyMat = new THREE.MeshStandardMaterial({
    map: textures.canopy,
    color: 0xd5e8a8,
    roughness: 0.64,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const rustMat = new THREE.MeshStandardMaterial({
    map: textures.rust,
    normalMap: textures.rustNor,
    roughness: 0.55,
    metalness: 0.42,
  });
  const rockMat = new THREE.MeshStandardMaterial({
    map: textures.pebbles,
    roughness: 0.8,
    metalness: 0.04,
  });
  textures.pebbles.repeat.set(2, 2);

  const deadBark = barkMat.clone();
  deadBark.color = new THREE.Color(0x8a7a68);

  const prototypes = {
    trees: [],
    dead: [],
    rocks: [],
    reeds: [],
    ferns: [],
    logs: [],
    barrels: [],
    pipe: null,
    crate: null,
    bean: null,
  };

  try {
    const gltf = await new GLTFLoader().loadAsync("/models/nature.glb");
    const root = gltf.scene;
    const grab = (name) => {
      const o = root.getObjectByName(name);
      if (!o) return null;
      const c = o.clone(true);
      c.position.set(0, 0, 0);
      c.rotation.set(0, 0, 0);
      c.scale.set(1, 1, 1);
      c.traverse((n) => {
        if (!n.isMesh) return;
        n.castShadow = true;
        n.receiveShadow = true;
        const nm = `${n.name} ${n.parent?.name || ""}`.toLowerCase();
        const count = n.geometry?.attributes?.position?.count || 99;
        if (nm.includes("foliage") || nm.includes("leaf") || nm.includes("fern")) {
          n.material = count <= 12 ? leafMat : canopyMat;
        } else if (nm.includes("reed")) {
          n.material = canopyMat.clone();
          n.material.color = new THREE.Color(0x8aa24a);
        } else if (nm.includes("barrel") || nm.includes("pipe") || nm.includes("rust")) {
          n.material = rustMat;
        } else if (nm.includes("rock")) {
          n.material = rockMat;
        } else if (nm.includes("trunk") || nm.includes("bark") || nm.includes("log") || nm.includes("dead")) {
          n.material = nm.includes("dead") ? deadBark : barkMat;
        } else if (nm.includes("crate")) {
          n.material = barkMat;
        }
      });
      return c;
    };
    for (const n of ["TreeOak1", "TreeOak2", "TreeOak3", "TreeOak4"]) {
      const t = grab(n);
      if (t) prototypes.trees.push(t);
    }
    for (const n of ["TreeDead1", "TreeDead2"]) {
      const t = grab(n);
      if (t) prototypes.dead.push(t);
    }
    for (const n of ["Rock1", "Rock2", "Rock3", "Rock4"]) {
      const t = grab(n);
      if (t) prototypes.rocks.push(t);
    }
    for (const n of ["Reed1", "Reed2"]) {
      const t = grab(n);
      if (t) prototypes.reeds.push(t);
    }
    const fern = grab("Fern1");
    if (fern) prototypes.ferns.push(fern);
    const log = grab("Log1");
    if (log) prototypes.logs.push(log);
    for (const n of ["Barrel1", "Barrel2"]) {
      const t = grab(n);
      if (t) prototypes.barrels.push(t);
    }
    prototypes.pipe = grab("Pipe1");
    prototypes.crate = grab("Crate1");
    prototypes.bean = grab("Bean");
  } catch (e) {
    console.warn("GLB missing, using procedural prototypes", e);
  }

  const rng = mulberry32(20260924);
  if (prototypes.trees.length === 0) {
    for (let i = 0; i < 4; i++) prototypes.trees.push(makeProceduralTree(() => rng(), false));
  }
  if (prototypes.dead.length === 0) {
    for (let i = 0; i < 2; i++) prototypes.dead.push(makeProceduralTree(() => rng(), true));
  }
  if (prototypes.rocks.length === 0) {
    for (let i = 0; i < 4; i++) prototypes.rocks.push(makeProceduralRock(() => rng()));
  }
  if (prototypes.reeds.length === 0) prototypes.reeds.push(makeProceduralReed(() => rng()));
  if (prototypes.barrels.length === 0) {
    prototypes.barrels.push(makeProceduralBarrel(() => rng()));
    prototypes.barrels.push(makeProceduralBarrel(() => rng()));
  }

  function placeClone(proto, x, z, { s = 1, yOff = 0, rot = rng() * Math.PI * 2 } = {}) {
    const c = proto.clone(true);
    c.position.set(x, 0, z);
    c.rotation.y = rot;
    c.scale.multiplyScalar(s);
    scene.add(c);
    c.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(c);
    c.position.y += terrainHeight(x, z) - box.min.y + yOff;
    return c;
  }

  // --- woods ---
  let trees = 0;
  for (let i = 0; i < 220 && trees < 58; i++) {
    const x = -18 + rng() * 44;
    const z = -40 + rng() * 36;
    const fm = forestMask(x, z);
    const h = terrainHeight(x, z);
    const sl = slopeAt(x, z);
    const pol = pollutionAt(x, z);
    if (fm < 0.28 || h < WATER_Y + 0.45 || sl > 0.7) continue;
    if (Math.abs(x - streamCenterX(z)) < streamHalfWidth(z) + 1.6) continue;
    if (pol > 0.42) {
      const proto = prototypes.dead[trees % prototypes.dead.length];
      placeClone(proto, x, z, { s: 0.85 + rng() * 0.35 });
    } else {
      const proto = prototypes.trees[trees % prototypes.trees.length];
      placeClone(proto, x, z, { s: 0.82 + rng() * 0.45 });
    }
    trees++;
  }
  // a few meadow trees on the north bank
  for (let i = 0; i < 10; i++) {
    const x = -28 + rng() * 50;
    const z = 22 + rng() * 16;
    if (terrainHeight(x, z) < WATER_Y + 0.5 || slopeAt(x, z) > 0.55) continue;
    const proto = prototypes.trees[i % prototypes.trees.length];
    placeClone(proto, x, z, { s: 0.7 + rng() * 0.4 });
  }
  // extra dead along polluted stream
  for (let i = 0; i < 14; i++) {
    const z = -38 + rng() * 28;
    const sx = streamCenterX(z);
    const x = sx + (rng() > 0.5 ? 1 : -1) * (1.8 + rng() * 2.4);
    if (terrainHeight(x, z) < WATER_Y + 0.3) continue;
    const proto = prototypes.dead[i % prototypes.dead.length];
    placeClone(proto, x, z, { s: 0.7 + rng() * 0.35, rot: rng() * Math.PI * 2 });
  }

  // stepping stones at the shallow ford
  for (let i = 0; i < 9; i++) {
    const x = -20 + (rng() - 0.5) * 6;
    const rz = riverCenterZ(x);
    const z = rz + (i / 8 - 0.5) * riverHalfWidth(x) * 1.6;
    const proto = prototypes.rocks[i % prototypes.rocks.length];
    placeClone(proto, x, z, { s: 0.55 + rng() * 0.4, yOff: 0.02 });
  }

  // --- rocks along banks ---
  for (let i = 0; i < 90; i++) {
    const x = -46 + rng() * 92;
    const rz = riverCenterZ(x);
    const rw = riverHalfWidth(x);
    const side = rng() > 0.5 ? 1 : -1;
    const z = rz + side * (rw + 0.4 + rng() * 2.2);
    if (slopeAt(x, z) > 1.4) continue;
    const proto = prototypes.rocks[i % prototypes.rocks.length];
    placeClone(proto, x, z, { s: 0.35 + rng() * 0.85, yOff: -0.05 });
  }
  for (let i = 0; i < 28; i++) {
    const z = -40 + rng() * 50;
    const sx = streamCenterX(z);
    const x = sx + (rng() > 0.5 ? 1 : -1) * (streamHalfWidth(z) + 0.3 + rng() * 1.1);
    const proto = prototypes.rocks[i % prototypes.rocks.length];
    placeClone(proto, x, z, { s: 0.25 + rng() * 0.45, yOff: -0.04 });
  }

  // --- reeds ---
  if (prototypes.reeds.length) {
    for (let i = 0; i < 70; i++) {
      const x = -46 + rng() * 92;
      const rz = riverCenterZ(x);
      const rw = riverHalfWidth(x);
      const z = rz + (rng() > 0.5 ? 1 : -1) * (rw - 0.2 + rng() * 1.4);
      const pol = pollutionAt(x, z);
      const proto = prototypes.reeds[i % prototypes.reeds.length];
      const c = placeClone(proto, x, z, { s: 0.85 + rng() * 0.5, yOff: -0.05 });
      if (pol > 0.4) {
        c.traverse((n) => {
          if (n.isMesh && n.material) {
            n.material = n.material.clone();
            n.material.color = new THREE.Color(0x6a5a32);
          }
        });
      }
    }
    for (let i = 0; i < 36; i++) {
      const z = -40 + rng() * 48;
      const sx = streamCenterX(z);
      const x = sx + (rng() - 0.5) * 2.4;
      const proto = prototypes.reeds[i % prototypes.reeds.length];
      const c = placeClone(proto, x, z, { s: 0.7 + rng() * 0.4, yOff: -0.06 });
      c.traverse((n) => {
        if (n.isMesh && n.material) {
          n.material = n.material.clone();
          n.material.color = new THREE.Color(0x5a5428);
        }
      });
    }
  }

  if (prototypes.ferns.length) {
    for (let i = 0; i < 40; i++) {
      const x = -16 + rng() * 38;
      const z = -38 + rng() * 30;
      if (forestMask(x, z) < 0.3 || pollutionAt(x, z) > 0.55) continue;
      if (terrainHeight(x, z) < WATER_Y + 0.4) continue;
      placeClone(prototypes.ferns[0], x, z, { s: 0.8 + rng() * 0.6 });
    }
  }

  if (prototypes.logs.length) {
    for (let i = 0; i < 8; i++) {
      const x = -14 + rng() * 34;
      const z = -36 + rng() * 28;
      if (forestMask(x, z) < 0.25) continue;
      placeClone(prototypes.logs[0], x, z, { s: 0.9 + rng() * 0.3, yOff: 0.05 });
    }
  }

  // --- pollution source ---
  const srcZ = -35.5;
  const srcX = streamCenterX(srcZ);
  const dump = new THREE.Group();
  dump.position.set(srcX + 1.6, 0, srcZ - 0.8);
  scene.add(dump);
  if (prototypes.pipe) {
    const pipe = prototypes.pipe.clone(true);
    pipe.rotation.y = Math.PI * 0.6;
    pipe.scale.setScalar(1.15);
    dump.add(pipe);
  }
  if (prototypes.barrels.length) {
    const spots = [
      [0.2, 0.0, 0.4, 0],
      [-0.7, 0.0, -0.2, 0.4],
      [0.9, 0.0, -0.8, 1.2],
      [-0.2, 0.0, -1.3, 1.55],
      [1.4, 0.0, 0.2, 0.2],
      [-1.3, 0.0, 0.6, 0.15],
    ];
    spots.forEach((s, i) => {
      const b = prototypes.barrels[i % prototypes.barrels.length].clone(true);
      b.position.set(s[0], s[1], s[2]);
      b.rotation.set(s[3] > 1 ? 1.25 : 0, rng() * 4, s[3] > 1 ? 0.4 : 0);
      dump.add(b);
    });
  }
  if (prototypes.crate) {
    const cr = prototypes.crate.clone(true);
    cr.position.set(-1.6, 0, -0.4);
    cr.rotation.y = 0.4;
    dump.add(cr);
  }
  dump.updateMatrixWorld(true);
  {
    const box = new THREE.Box3().setFromObject(dump);
    dump.position.y += terrainHeight(srcX + 1.6, srcZ - 0.8) - box.min.y;
  }

  const glow = new THREE.PointLight(0x9dff40, 2.8, 16, 1.8);
  glow.position.set(srcX, terrainHeight(srcX, srcZ) + 1.1, srcZ);
  scene.add(glow);
  const glow2 = new THREE.PointLight(0xc4ff6a, 1.1, 9, 2);
  glow2.position.set(srcX - 0.4, terrainHeight(srcX, srcZ) + 0.4, srcZ + 1.2);
  scene.add(glow2);

  // confluence kicker light
  const spot = new THREE.SpotLight(0xffe0b5, 18, 48, Math.PI / 6.5, 0.55, 1.4);
  spot.position.set(7, 18, 24);
  spot.target.position.set(6, WATER_Y, 14);
  spot.castShadow = false;
  scene.add(spot, spot.target);

  // --- grass instancing ---
  const bladeA = new THREE.PlaneGeometry(0.26, 0.58);
  bladeA.translate(0, 0.29, 0);
  const bladeB = bladeA.clone();
  bladeB.rotateY(Math.PI / 2);
  const grassGeo = mergeGeometries([bladeA, bladeB], false);
  const grassMat = new THREE.MeshStandardMaterial({
    map: textures.blade,
    side: THREE.DoubleSide,
    alphaTest: 0.35,
    roughness: 0.72,
    metalness: 0,
  });
  const dummy = new THREE.Object3D();
  const grassPos = [];
  for (let i = 0; i < 9000; i++) {
    const x = -46 + rng() * 92;
    const z = -46 + rng() * 92;
    const h = terrainHeight(x, z);
    if (h < WATER_Y + 0.12) continue;
    if (slopeAt(x, z) > 0.55) continue;
    const fm = forestMask(x, z);
    if (fm > 0.72 && rng() < 0.55) continue;
    grassPos.push(x, z, h);
  }
  const grass = new THREE.InstancedMesh(grassGeo, grassMat, grassPos.length / 3);
  grass.receiveShadow = true;
  grass.castShadow = false;
  let gi = 0;
  for (let i = 0; i < grassPos.length; i += 3) {
    dummy.position.set(grassPos[i], grassPos[i + 2], grassPos[i + 1]);
    dummy.rotation.set(0, rng() * Math.PI * 2, 0);
    const sc = 0.7 + rng() * 0.8;
    dummy.scale.set(sc, sc * (0.8 + rng() * 0.5), sc);
    dummy.updateMatrix();
    grass.setMatrixAt(gi, dummy.matrix);
    const pol = pollutionAt(grassPos[i], grassPos[i + 1]);
    const col = new THREE.Color();
    if (pol > 0.35) col.setHSL(0.12, 0.35, 0.32);
    else if (forestMask(grassPos[i], grassPos[i + 1]) > 0.4) col.setHSL(0.28, 0.45, 0.28);
    else col.setHSL(0.27 + rng() * 0.05, 0.52, 0.34 + rng() * 0.08);
    grass.setColorAt(gi, col);
    gi++;
  }
  grass.instanceMatrix.needsUpdate = true;
  if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
  grassMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    grassMat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uTime;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vec3 ip = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
         float hgt = uv.y;
         transformed.x += sin(uTime * 1.55 + ip.x * 0.42 + ip.z * 0.31) * 0.12 * hgt * hgt;
         transformed.z += cos(uTime * 1.15 + ip.z * 0.37) * 0.08 * hgt * hgt;`
      );
  };
  scene.add(grass);

  // pollen / dust motes in the key light (miniature atmosphere)
  const moteCount = 420;
  const moteGeo = new THREE.BufferGeometry();
  const motePos = new Float32Array(moteCount * 3);
  for (let i = 0; i < moteCount; i++) {
    motePos[i * 3] = -40 + rng() * 80;
    motePos[i * 3 + 1] = 0.4 + rng() * 7;
    motePos[i * 3 + 2] = -40 + rng() * 80;
  }
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(
    moteGeo,
    new THREE.PointsMaterial({
      color: 0xffe6c4,
      size: 0.045,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    })
  );
  scene.add(motes);

  try {
    const envScene = new THREE.Scene();
    const skyEnv = sky.clone();
    envScene.add(skyEnv);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
  } catch (e) {
    console.warn("env map skipped", e);
  }

  return {
    scene,
    textures,
    water,
    grassMat,
    sunDir,
    key,
    glow,
    motes,
    beanProto: prototypes.bean,
  };
}
