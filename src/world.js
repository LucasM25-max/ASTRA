/**
 * Sector 1: The First Fork and Journey Upstream.
 *
 * Loads the 3D photorealistic greybox world into the Three.js scene, attaching
 * ground relief, the flow-carved water surface, vegetation, limestone rock,
 * weathered props, and the cave threshold.
 *
 * Also provides the exact floor collision for the player so they can walk
 * the 1.5 km corridor from the High Ery water meadow to the corrupted cave.
 */

import * as THREE from "three";
import { parseGeoToGeometries } from "./world/loader.js";
import { FORK, ERY, BRIDGE_S } from "./world/geography.js";
import { terrainHeight, channelShape } from "./world/relief.js";

export class WorldSector01 {
  constructor(environment) {
    this.env = environment;
    this.group = new THREE.Group();
    this.manifest = null;
    this.spawn = { position: new THREE.Vector3(-135.5, 89.57, -8.8), heading: -Math.PI / 2 };
    this.bridge = null;
  }

  /**
   * Exact ground and structure elevation at any (x, z) coordinate.
   * Evaluates the analytical terrain field in microseconds and accounts
   * for elevated wooden decks like the footbridge and landing stage.
   */
  getFloorHeight(x, z) {
    let floor = terrainHeight(x, z);

    // Footbridge deck over the First Fork
    if (this.bridge) {
      const dx = x - this.bridge.x, dz = z - this.bridge.z;
      const along = dx * this.bridge.tx + dz * this.bridge.tz;
      const across = dx * this.bridge.nx + dz * this.bridge.nz;
      if (Math.abs(along) <= this.bridge.halfSpan && Math.abs(across) <= this.bridge.halfWidth) {
        floor = Math.max(floor, this.bridge.deckY);
      }
    }

    return floor;
  }

  async load() {
    const scene = this.env.scene;

    // Cache footbridge dimensions for exact collision
    const bF = FORK.at(BRIDGE_S);
    const c = channelShape(bF.x, bF.z, FORK);
    const halfSpan = Math.max(c.edge, c.w * 1.25) + 2.4;
    this.bridge = {
      x: bF.x, z: bF.z, tx: bF.tx, tz: bF.tz, nx: bF.nx, nz: bF.nz,
      halfSpan, halfWidth: 1.1, deckY: Math.max(c.bank, c.ws + 0.55) + 0.08,
    };

    // Load manifest
    try {
      const res = await fetch("./assets/world/manifest.json");
      if (res.ok) {
        this.manifest = await res.json();
        if (this.manifest.route && this.manifest.route.length > 0) {
          const r0 = this.manifest.route[0];
          const r1 = this.manifest.route[1] ?? r0;
          this.spawn.position.set(r0.x, r0.y, r0.z);
          this.spawn.heading = Math.atan2(r1.x - r0.x, -(r1.z - r0.z));
        }
      }
    } catch {
      // Manifest load optional; fallback coordinates already initialized
    }

    // P1 ground truth: the height-blended triplanar terrain over the procedural
    // PBR library, with a greybox fallback if anything about it fails -- a
    // working plain world beats a blank page on any GPU.
    let groundMat;
    let waterMat;
    try {
      const maxAniso = this.env.renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
      const library = buildMaterialLibrary({ anisotropy: Math.min(8, maxAniso) });
      this.footprints = new Footprints();
      groundMat = createTerrainMaterial(library, this.footprints);
      waterMat = createWaterMaterial();
      this.waterMaterial = waterMat;
    } catch (err) {
      console.warn("[astra-world] P1 materials unavailable, using greybox fallback", err);
      groundMat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.94, metalness: 0.02, flatShading: true,
      });
      waterMat = new THREE.MeshStandardMaterial({
        vertexColors: true, color: 0x426673, transparent: true, opacity: 0.88,
        roughness: 0.16, metalness: 0.12,
      });
    }

    const standingMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.90,
      metalness: 0.0,
    });

    const propsMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.0,
    });

    // Load the pre-compiled geometry files
    const geoFiles = [
      { name: "ground", file: "ground.geo", material: groundMat, receiveShadow: true },
      { name: "water", file: "water.geo", material: waterMat, receiveShadow: true },
      { name: "standing", file: "standing.geo", material: standingMat, castShadow: true, receiveShadow: true },
      { name: "props", file: "props.geo", material: propsMat, castShadow: true, receiveShadow: true },
    ];

    for (const item of geoFiles) {
      try {
        const resp = await fetch(`./assets/world/${item.file}`);
        if (!resp.ok) continue;
        const buf = await resp.arrayBuffer();
        const { geometries } = parseGeoToGeometries(buf);
        const geom = geometries[item.name];
        if (!geom) continue;

        const mesh = new THREE.Mesh(geom, item.material);
        mesh.castShadow = item.castShadow ?? false;
        mesh.receiveShadow = item.receiveShadow ?? false;
        mesh.frustumCulled = false;
        this.group.add(mesh);
      } catch (err) {
        console.warn(`[astra-world] Could not load ${item.file}:`, err);
      }
    }

    // Replace the default ground plane with the rich 3D world
    if (this.env.ground) {
      this.env.ground.visible = false;
    }
    scene.add(this.group);

    // Tune atmosphere and lighting for outdoor river valley
    scene.fog = new THREE.Fog(0xc8d5df, 140, 750);
    if (this.env.key) {
      this.env.key.intensity = 2.6;
      this.env.key.color.setHex(0xffeed6);
      this.env.key.shadow.camera.near = 0.5;
      this.env.key.shadow.camera.far = 80;
      this.env.key.shadow.camera.left = -16;
      this.env.key.shadow.camera.right = 16;
      this.env.key.shadow.camera.top = 16;
      this.env.key.shadow.camera.bottom = -16;
      this.env.key.shadow.bias = -0.0004;
      this.env.key.shadow.normalBias = 0.04;
    }

    return this;
  }

  /**
   * Per-frame world life: the water ripple's clock and the footprint tile
   * following the walker. Called from the main loop; safe to skip headlessly.
   */
  update(dt, player) {
    this.elapsed += dt;
    if (this.waterMaterial?.userData.timeUniform) {
      this.waterMaterial.userData.timeUniform.value = this.elapsed;
    }
    if (this.footprints && player) {
      this.footprints.update(dt, player, (x, z) => {
        const lvl = waterLevel(x, z);
        return {
          moisture: moisture(x, z),
          above: lvl === null ? 8 : terrainHeight(x, z) - lvl,
        };
      });
    }
  }
}

/** Helper to instantiate and attach the sector to the environment. */
export async function loadWorld(environment) {
  const world = new WorldSector01(environment);
  await world.load();
  return world;
}
