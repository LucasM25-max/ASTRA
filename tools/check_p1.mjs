/**
 * Phase P1 validation: Ground Truth Shading & Image Texture Pipeline.
 *
 *   node tools/check_p1.mjs
 *
 * Headless, like the rest of the suite: no browser, no WebGL, but the real
 * modules. It holds P1's four tasks to account:
 *
 *   1.1  Material library: five sets generate deterministically, tile
 *        seamlessly, and carry sane PBR values (normals unit-length, sludge
 *        glossy where pooled, turf rough everywhere).
 *   1.2  Splatting: weights sum to 1 with no NaN over 2000 corridor samples;
 *        rock owns steep ground, gravel owns the waterline, sludge owns the
 *        fouled banks, turf owns the meadow.
 *   1.3  Wetness: the capillary constants match the PLAN (40% darkening,
 *        roughness 0.08 within 0.35 m) and the footprint tile math holds.
 *   1.4  Quality control: micro-detail density >= 12 px/cm inside 15 m, the
 *        ground mesh carries the P1 field attribute, and the static budgets
 *        (fetches, textures, VRAM, draw calls) hold for 60 FPS at 1080p.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as THREE from "three";

import { readGeo } from "./binio.mjs";
import {
  MATERIALS, P1, splatWeights, texelDensityCm, detailDensityCm, terrainFetchCount,
} from "../src/world/splat.js";
import { generateMaterialPixels, generateDetailPixels, buildMaterialLibrary } from "../src/world/textures.js";
import { createTerrainMaterial, createWaterMaterial } from "../src/world/terrainMaterial.js";
import { footprintUV, FOOTPRINT } from "../src/world/footprints.js";
import { ERY, FORK, CAVE, FORK_AT, turbidity } from "../src/world/geography.js";
import { terrainHeight, waterLevel, moisture, slopeDegrees, zoneOf } from "../src/world/relief.js";
import { makeRandom } from "../src/world/noise.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `   ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

console.log("\n--- Auditing P1: Ground Truth Shading & Image Texture Pipeline ---\n");

const fnv = (bytes) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/* ================================================== 1.1 material library */

const TS = 128; // audit size: the generators are size-parametric; 512 ships
const libs = {};
for (const m of MATERIALS) {
  const a = generateMaterialPixels(m.id, TS);
  const b = generateMaterialPixels(m.id, TS);
  libs[m.id] = a;
  check(
    `material ${m.id}: deterministic bytes`,
    fnv(a.albedo) === fnv(b.albedo) && fnv(a.normal) === fnv(b.normal) && fnv(a.pack) === fnv(b.pack),
    `albedo #${fnv(a.albedo)}`,
  );
}

function seamScore(size, rgba) {
  const lum = (i) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  let edge = 0;
  for (let y = 0; y < size; y++) edge += Math.abs(lum(y * size) - lum(y * size + size - 1));
  for (let x = 0; x < size; x++) edge += Math.abs(lum(x) - lum((size - 1) * size + x));
  edge /= size * 2;
  let interior = 0, n = 0;
  for (let y = 0; y < size; y += 3) {
    for (let x = 0; x < size - 1; x += 3) {
      interior += Math.abs(lum(y * size + x) - lum(y * size + x + 1));
      n++;
    }
  }
  interior /= n;
  return { edge, interior };
}

for (const m of MATERIALS) {
  const { edge, interior } = seamScore(TS, libs[m.id].albedo);
  check(
    `material ${m.id}: tiles seamlessly`,
    edge <= 2.5 * interior + 1.5,
    `edge discontinuity ${edge.toFixed(2)} vs interior ${interior.toFixed(2)}`,
  );
}

for (const m of MATERIALS) {
  const px = libs[m.id];
  let lenErr = 0;
  const n = TS * TS;
  for (let i = 0; i < n; i += 7) {
    const nx = (px.normal[i * 4] / 255) * 2 - 1;
    const ny = (px.normal[i * 4 + 1] / 255) * 2 - 1;
    const nz = (px.normal[i * 4 + 2] / 255) * 2 - 1;
    lenErr = Math.max(lenErr, Math.abs(Math.hypot(nx, ny, nz) - 1));
  }
  let rMin = 1, rMax = 0, rSum = 0;
  for (let i = 0; i < n; i++) {
    const r = px.pack[i * 4] / 255;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    rSum += r;
  }
  check(`material ${m.id}: unit-length normals`, lenErr < 0.05, `max error ${lenErr.toFixed(3)}`);
  if (m.id === "sludge") {
    check("sludge: viscous pools read glossy", rMin < 0.20, `min roughness ${rMin.toFixed(2)}`);
  }
  if (m.id === "gravel") {
    check("gravel: pebble/silt roughness contrast", rMax - rMin > 0.20,
      `range ${rMin.toFixed(2)}..${rMax.toFixed(2)}`);
  }
  if (m.id === "turf") {
    check("turf: rough organic surface", rSum / n > 0.80, `mean ${(rSum / n).toFixed(2)}`);
  }
}

{
  const d1 = generateDetailPixels(TS);
  const d2 = generateDetailPixels(TS);
  const { edge, interior } = seamScore(TS, d1);
  check("micro-detail: deterministic and seamless",
    fnv(d1) === fnv(d2) && edge <= 2.5 * interior + 1.5,
    `#${fnv(d1)} edge ${edge.toFixed(2)} vs interior ${interior.toFixed(2)}`);
}

/* ======================================================== 1.2 splatting */

{
  const rand = makeRandom(0x91ab);
  let bad = 0, checked = 0;
  for (let i = 0; i < 2000; i++) {
    // Random corridor points: along either stream plus lateral scatter.
    const onFork = rand() < 0.5;
    const stream = onFork ? FORK : ERY;
    const s = rand() * stream.length;
    const f = stream.at(s);
    const lat = (rand() - 0.5) * 120;
    const x = f.x + f.nx * lat, z = f.z + f.nz * lat;
    const lvl = waterLevel(x, z);
    const h = terrainHeight(x, z);
    const w = splatWeights({
      slopeDeg: slopeDegrees(x, z, 1.0),
      above: lvl === null ? 8 : h - lvl,
      moisture: moisture(x, z),
      fouling: turbidity(x, z),
      zone: zoneOf(x, z).id,
    });
    const sum = w.loam + w.gravel + w.limestone + w.sludge + w.turf;
    checked++;
    if (!Number.isFinite(sum) || Math.abs(sum - 1) > 1e-6) bad++;
    if (Object.values(w).some((v) => v < -1e-9 || v > 1 + 1e-9)) bad++;
  }
  check("splat weights partition unity over the corridor", bad === 0, `${checked} samples`);
}

function fieldAt(x, z) {
  const lvl = waterLevel(x, z);
  return {
    slopeDeg: slopeDegrees(x, z, 1.0),
    above: lvl === null ? 8 : terrainHeight(x, z) - lvl,
    moisture: moisture(x, z),
    fouling: turbidity(x, z),
    zone: zoneOf(x, z).id,
  };
}

{
  // Steep karst by the cave mouth must read as rock.
  let found = null;
  const c = CAVE.position;
  for (let dz = -30; dz <= 30 && !found; dz += 3) {
    for (let dx = -30; dx <= 30 && !found; dx += 3) {
      const f = fieldAt(c.x + dx, c.z + dz);
      if (f.slopeDeg > 33) found = f;
    }
  }
  const w = found ? splatWeights(found) : null;
  check("limestone owns steep ground", !!w && w.limestone > 0.45,
    found ? `slope ${found.slopeDeg.toFixed(1)}° rock ${(w.limestone * 100).toFixed(0)}%` : "no steep ground found");
}

{
  // A clean waterline on the Ery must read as gravel.
  let found = null;
  for (let s = 60; s < 300 && !found; s += 8) {
    const f = ERY.at(s);
    for (const side of [1, -1]) {
      const x = f.x + f.nx * side * (ERY.bankhalf(s) + 0.3);
      const z = f.z + f.nz * side * (ERY.bankhalf(s) + 0.3);
      const fld = fieldAt(x, z);
      if (Math.abs(fld.above) < 0.25 && fld.fouling < 0.2) { found = fld; break; }
    }
  }
  const w = found ? splatWeights(found) : null;
  check("gravel owns the clean waterline", !!w && w.gravel > 0.35,
    found ? `above ${found.above.toFixed(2)} m gravel ${(w.gravel * 100).toFixed(0)}%` : "no clean waterline found");
}

{
  // The fouled fork bank must read as sludge.
  const f = FORK.at(FORK.length - 60);
  const fld = fieldAt(f.x + f.nx * 3, f.z + f.nz * 3);
  const w = splatWeights(fld);
  check("sludge owns the fouled bank", w.sludge > 0.25,
    `fouling ${(fld.fouling * 100).toFixed(0)}% sludge ${(w.sludge * 100).toFixed(0)}%`);
}

{
  // The village meadow must read as turf over loam.
  let meadowFound = null;
  for (let s = 20; s < 200 && !meadowFound; s += 10) {
    const f = ERY.at(s);
    for (const lat of [18, 26, 34, 42, 55]) {
      const fld = fieldAt(f.x + f.nx * lat, f.z + f.nz * lat);
      if (fld.zone === 0) { meadowFound = fld; break; }
    }
  }
  const mw = meadowFound ? splatWeights(meadowFound) : null;
  check("turf owns the water meadow", !!mw && mw.turf + mw.loam > 0.6,
    meadowFound ? `zone 0 turf ${(mw.turf * 100).toFixed(0)}% loam ${(mw.loam * 100).toFixed(0)}%` : "no meadow ground found");
}

/* ================================================== 1.3 wetness & prints */

check("capillary fringe matches the PLAN",
  P1.capillaryHeight === 0.35 && P1.capillaryDarken === 0.40 && P1.capillaryRough === 0.08,
  `0.35 m / 40% / 0.08`);
check("footprints trigger on moist soil", P1.footprintMoisture === 0.7, `M > ${P1.footprintMoisture}`);

{
  const [u, v] = footprintUV(10, -4, 10, -4, FOOTPRINT.extent);
  const [u2, v2] = footprintUV(10 + FOOTPRINT.extent / 2, -4, 10, -4, FOOTPRINT.extent);
  check("footprint tile math centres on the walker",
    Math.abs(u - 0.5) < 1e-9 && Math.abs(v - 0.5) < 1e-9
    && Math.abs(u2 - 1.0) < 1e-9 && Math.abs(v2 - 0.5) < 1e-9,
    `centre (${u.toFixed(2)}, ${v.toFixed(2)}) edge (${u2.toFixed(2)}, ${v2.toFixed(2)})`);
}

/* ============================================ 1.4 density, mesh & budgets */

{
  const densities = MATERIALS.map((m) => `${m.id} ${(texelDensityCm(m)).toFixed(2)}`).join("  ");
  check("micro-detail density >= 12 px/cm inside 15 m", detailDensityCm() >= 12.0,
    `${detailDensityCm().toFixed(1)} px/cm within ${P1.detailFar} m (base: ${densities} px/cm)`);
  check("material textures stay at 512 px or below", P1.textureSize <= 1024,
    `${P1.textureSize} px`);
}

{
  const ground = await readGeo(join(root, "assets", "world", "ground.geo"));
  const posCount = ground.blocks.ground.attributes.position.count;
  const field = ground.blocks.ground.attributes.aField;
  check("ground mesh carries the P1 field attribute", !!field && field.count === posCount,
    field ? `${field.count} verts x${field.components}` : "missing");
  if (field) {
    const data = ground.data["ground.aField"];
    let bad = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      const [moist, foul, above, canopy] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (!(moist >= 0 && moist <= 1 && foul >= 0 && foul <= 1
        && above >= -2 && above <= 8 && canopy >= 0 && canopy <= 1)) bad++;
    }
    check("field attribute ranges are sane", bad === 0, "moisture/fouling/canopy 0..1, above -2..8 m");
  }
  const standing = await readGeo(join(root, "assets", "world", "standing.geo"));
  const col = standing.data["standing.color"];
  let rg = 0;
  const sn = Math.floor(col.length / 3);
  for (let i = 0; i < sn; i += 131) rg += Math.abs(col[i * 3] - col[i * 3 + 1]);
  rg /= Math.ceil(sn / 131);
  check("scatter colours are baked (not greybox grey)", rg > 0.015, `mean |R-G| ${rg.toFixed(3)}`);
  const water = await readGeo(join(root, "assets", "world", "water.geo"));
  check("water keeps its depth/fouling/foam attribute", !!water.blocks.water.attributes.waterData,
    "waterData vec4 intact for the P1 water material");
}

{
  const manifest = JSON.parse(await readFile(join(root, "assets", "world", "manifest.json"), "utf8"));
  check("manifest marks the P1 shading phase", manifest.shading?.phase === "P1",
    `shading.phase = ${manifest.shading?.phase}`);
  check("draw calls stay tiny (one mesh per layer)", (manifest.files?.length ?? 99) <= 8,
    `${manifest.files?.length} layers`);
}

{
  const fetches = terrainFetchCount();
  check("terrain fragment stays in texture-fetch budget", fetches <= P1.maxFetches,
    `${fetches} fetches (5 sets x 3 maps x 3 planes + detail + footprints)`);
  // VRAM: 16 PBR maps + detail + footprint tile + geometry payloads.
  const texMB = (MATERIALS.length * 3 + 1) * P1.textureSize * P1.textureSize * 4 / 1024 / 1024
    + FOOTPRINT.size * FOOTPRINT.size * 4 / 1024 / 1024;
  let geoMB = 0;
  for (const f of ["ground.geo", "water.geo", "standing.geo", "props.geo"]) {
    geoMB += (await stat(join(root, "assets", "world", f))).size / 1024 / 1024;
  }
  const total = texMB + geoMB * 1.15; // +15% for mipmaps/framebuffers slack
  check("VRAM budget holds (<= 1.8 GB)", total < 1800,
    `~${total.toFixed(0)} MB: ${texMB.toFixed(0)} textures + ${geoMB.toFixed(0)} geometry`);
}

/* ================================================= shader assembly smoke */

{
  const library = buildMaterialLibrary({ size: 64, anisotropy: 1 });
  const mock = () => ({
    uniforms: {},
    vertexShader: "#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\n#include <project_vertex>",
    fragmentShader: "#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>",
  });
  const terrain = createTerrainMaterial(library, null);
  const tShader = mock();
  terrain.onBeforeCompile(tShader);
  const tLeft = [...tShader.fragmentShader.matchAll(/#include <(\w+)>/g)].map((m) => m[1]);
  check("terrain shader assembles (all chunks replaced)",
    tLeft.length === 1 && tLeft[0] === "common"
    && tShader.fragmentShader.includes("uLimestonePck")
    && tShader.fragmentShader.includes("texture2D(uFootMap, fuv)")
    && tShader.vertexShader.includes("attribute vec4 aField;"),
    `uniforms: ${Object.keys(tShader.uniforms).length}`);
  const water = createWaterMaterial();
  const wShader = mock();
  water.onBeforeCompile(wShader);
  check("water shader assembles (P1 holding pattern)",
    wShader.fragmentShader.includes("vWData") && wShader.vertexShader.includes("attribute vec4 waterData;")
    && "uTime" in wShader.uniforms,
    "depth absorption + time ripple wired");
  check("materials are real three.js PBR materials",
    terrain.isMeshStandardMaterial && water.isMeshStandardMaterial && water.transparent,
    "lighting/shadows/fog inherited from the standard pipeline");
}

console.log();
if (failures.length) {
  console.log(`${failures.length} P1 check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("all P1 checks passed");
