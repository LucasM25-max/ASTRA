/**
 * Phase P1, Tasks 1.2-1.3: the ground-truth terrain material.
 *
 * A MeshStandardMaterial with the ground shading injected via onBeforeCompile:
 * field-driven splatting of the five PBR sets (splat.js), height-blended with
 * contrast k = 0.2, triplanar on slopes over ~22 degrees and planar below,
 * world-space macro variation against tiling, near-field micro-detail, and the
 * capillary wetness fringe above the waterline. Lighting, shadows, fog and tone
 * mapping stay on three.js's standard pipeline -- only the albedo, roughness
 * and normal *inputs* to it are ours.
 *
 * This file also holds the water surface material: a P1 holding pattern, not
 * P3. It reads the waterData attribute P0 already emits (depth, fouling, foam,
 * branch) for Beer-Lambert-ish absorption and a gentle time ripple. Flow
 * advection, the confluence mixing layer and foam physics belong to P3 and are
 * marked TODO there.
 */

import * as THREE from "three";
import { MATERIALS, P1, SPLAT_GLSL } from "./splat.js";

const cap = (id) => id.charAt(0).toUpperCase() + id.slice(1);

/* ------------------------------------------------- terrain shader assembly */

function terrainUniformDeclarations() {
  let out = "";
  for (const m of MATERIALS) {
    const k = cap(m.id);
    out += `uniform sampler2D u${k}Alb;\nuniform sampler2D u${k}Nrm;\nuniform sampler2D u${k}Pck;\n`;
  }
  return out;
}

/** Triplanar sample of one material set; declares alb_<id>, nW_<id>, pck_<id>. */
function materialSampleGLSL(material) {
  const id = material.id;
  const k = cap(id);
  const s = (1 / material.tile).toFixed(5);
  return /* glsl */`
  vec3 albT_${id} = texture2D(u${k}Alb, wp.xz * ${s}).rgb;
  vec3 nrmT_${id} = texture2D(u${k}Nrm, wp.xz * ${s}).rgb * 2.0 - 1.0;
  vec3 pckT_${id} = texture2D(u${k}Pck, wp.xz * ${s}).rgb;
  vec3 albX_${id} = texture2D(u${k}Alb, vec2(wp.z, wp.y) * ${s}).rgb;
  vec3 nrmX_${id} = texture2D(u${k}Nrm, vec2(wp.z, wp.y) * ${s}).rgb * 2.0 - 1.0;
  vec3 pckX_${id} = texture2D(u${k}Pck, vec2(wp.z, wp.y) * ${s}).rgb;
  vec3 albZ_${id} = texture2D(u${k}Alb, vec2(wp.x, wp.y) * ${s}).rgb;
  vec3 nrmZ_${id} = texture2D(u${k}Nrm, vec2(wp.x, wp.y) * ${s}).rgb * 2.0 - 1.0;
  vec3 pckZ_${id} = texture2D(u${k}Pck, vec2(wp.x, wp.y) * ${s}).rgb;
  vec3 alb_${id} = albT_${id} * tw.y + albX_${id} * tw.x + albZ_${id} * tw.z;
  vec3 nW_${id} = normalize(
      vec3(nrmT_${id}.x, nrmT_${id}.z, nrmT_${id}.y) * tw.y
    + vec3(sx * nrmX_${id}.z, nrmX_${id}.y, nrmX_${id}.x) * tw.x
    + vec3(nrmZ_${id}.x, nrmZ_${id}.y, sz * nrmZ_${id}.z) * tw.z);
  vec3 pck_${id} = pckT_${id} * tw.y + pckX_${id} * tw.x + pckZ_${id} * tw.z;
`;
}

function heightBlendGLSL() {
  const h = (id, w) => {
    const m = MATERIALS.find((mm) => mm.id === id);
    return `float hB_${id} = pck_${id}.g * ${m.heightScale.toFixed(2)} + ${w};`;
  };
  return /* glsl */`
  ${h("loam", "wLoam")}
  ${h("gravel", "wGravel")}
  ${h("limestone", "wRock")}
  ${h("sludge", "wSludge")}
  ${h("turf", "wTurf")}
  float peak = max(max(hB_loam, hB_gravel), max(max(hB_limestone, hB_sludge), hB_turf));
  float blendK = ${P1.heightBlendK.toFixed(2)};
  wLoam = clamp((hB_loam - peak + blendK) / blendK, 0.0, 1.0);
  wGravel = clamp((hB_gravel - peak + blendK) / blendK, 0.0, 1.0);
  wRock = clamp((hB_limestone - peak + blendK) / blendK, 0.0, 1.0);
  wSludge = clamp((hB_sludge - peak + blendK) / blendK, 0.0, 1.0);
  wTurf = clamp((hB_turf - peak + blendK) / blendK, 0.0, 1.0);
  float wSum2 = wLoam + wGravel + wRock + wSludge + wTurf;
  wLoam /= wSum2; wGravel /= wSum2; wRock /= wSum2; wSludge /= wSum2; wTurf /= wSum2;
  vec3 alb = alb_loam * wLoam + alb_gravel * wGravel + alb_limestone * wRock
    + alb_sludge * wSludge + alb_turf * wTurf;
  vec3 nB = nW_loam * wLoam + nW_gravel * wGravel + nW_limestone * wRock
    + nW_sludge * wSludge + nW_turf * wTurf;
  float rough = pck_loam.r * wLoam + pck_gravel.r * wGravel + pck_limestone.r * wRock
    + pck_sludge.r * wSludge + pck_turf.r * wTurf;
  float aoM = pck_loam.b * wLoam + pck_gravel.b * wGravel + pck_limestone.b * wRock
    + pck_sludge.b * wSludge + pck_turf.b * wTurf;
`;
}

const NOISE_GLSL = /* glsl */`
float p1Hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float p1Noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(p1Hash(i), p1Hash(i + vec2(1.0, 0.0)), u.x),
    mix(p1Hash(i + vec2(0.0, 1.0)), p1Hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const TERRAIN_VERTEX_PREFIX = /* glsl */`
attribute vec4 aField;
attribute float zone;
varying vec3 vP1WorldPos;
varying vec3 vP1NormalW;
varying vec4 vP1Field;
varying float vP1Zone;
`;

const TERRAIN_VERTEX_MAIN = /* glsl */`
vP1WorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vP1NormalW = normalize(mat3(modelMatrix) * objectNormal);
vP1Field = aField;
vP1Zone = zone;
`;

function terrainFragmentPrefix() {
  return /* glsl */`
varying vec3 vP1WorldPos;
varying vec3 vP1NormalW;
varying vec4 vP1Field;
varying float vP1Zone;
${terrainUniformDeclarations()}
uniform sampler2D uDetail;
uniform sampler2D uFootMap;
uniform vec2 uFootCenter;
uniform float uFootExtent;
float gP1Rough = 1.0;
vec3 gP1Nrm = vec3(0.0, 1.0, 0.0);
${NOISE_GLSL}
`;
}

function terrainMainGLSL() {
  const samples = MATERIALS.map(materialSampleGLSL).join("\n");
  return /* glsl */`
{
  vec3 wp = vP1WorldPos;
  vec3 wn = normalize(vP1NormalW);
  float slopeDeg = degrees(acos(clamp(wn.y, -1.0, 1.0)));
  float tri = smoothstep(${P1.triplanarStart.toFixed(1)}, ${P1.triplanarEnd.toFixed(1)}, slopeDeg);
  vec3 twRaw = pow(abs(wn), vec3(4.0));
  twRaw /= max(twRaw.x + twRaw.y + twRaw.z, 1e-4);
  vec3 tw = mix(vec3(0.0, 1.0, 0.0), twRaw, tri);
  float sx = wn.x >= 0.0 ? 1.0 : -1.0;
  float sz = wn.z >= 0.0 ? 1.0 : -1.0;
${samples}
  float moist = vP1Field.x;
  float foul = vP1Field.y;
  float above = vP1Field.z;
  float canopy = vP1Field.w;
  float zone = vP1Zone;
${SPLAT_GLSL}
${heightBlendGLSL()}
  // Macro variation: two low-frequency world-space octaves break tiling along
  // the 1.6 km corridor without touching the authored material response.
  float macro = p1Noise(wp.xz * 0.005) * 0.65 + p1Noise(wp.xz * 0.021 + 7.3) * 0.35;
  alb *= 0.93 + 0.14 * macro;
  alb *= 0.95 + 0.10 * p1Noise(wp.xz * 0.12 + 3.1);
  // Near-field micro-detail: sub-centimetre grain inside 15 m of the camera.
  float dCam = distance(wp, cameraPosition);
  float det = (1.0 - smoothstep(${P1.detailNear.toFixed(1)}, ${P1.detailFar.toFixed(1)}, dCam)) * (1.0 - tri);
  vec4 detS = texture2D(uDetail, wp.xz / ${P1.detailTile.toFixed(2)});
  alb *= 0.94 + 0.12 * detS.r;
  vec3 nW = normalize(mix(wn, nB, 0.85)
    + vec3(detS.g - 0.5, 0.0, detS.b - 0.5) * (0.6 * det));
  // Capillary fringe and moisture absorption (Task 1.3).
  float cap = 1.0 - smoothstep(0.02, ${P1.capillaryHeight.toFixed(2)}, above);
  alb *= 1.0 - ${P1.capillaryDarken.toFixed(2)} * cap;
  alb *= 1.0 - 0.22 * moist;
  rough = mix(rough, ${P1.capillaryRough.toFixed(2)}, cap);
  rough *= 1.0 - 0.35 * moist;
  float subm = 1.0 - smoothstep(-0.25, 0.0, above);
  alb *= 1.0 - 0.45 * subm;
  rough = mix(rough, 0.10, subm);
  // Diegetic footprints on wet ground, stamped by footprints.js.
  vec2 fuv = (wp.xz - uFootCenter) / uFootExtent + 0.5;
  float foot = 0.0;
  if (fuv.x > 0.0 && fuv.x < 1.0 && fuv.y > 0.0 && fuv.y < 1.0) {
    foot = texture2D(uFootMap, fuv).a;
  }
  foot *= smoothstep(-0.05, 0.05, above);
  alb *= 1.0 - 0.32 * foot;
  rough = mix(rough, 0.38, foot * 0.7);
  // Shade of the canopy overhead, then the baked per-material occlusion.
  alb *= 1.0 - 0.10 * canopy;
  alb *= mix(1.0, aoM, 0.9);
  diffuseColor.rgb = alb;
  gP1Rough = rough;
  gP1Nrm = nW;
}
`;
}

/**
 * The P1 ground material. `library` is buildMaterialLibrary's product;
 * `footprints` is a Footprints instance (or null, which leaves a blank map).
 */
export function createTerrainMaterial(library, footprints = null) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
  });
  const uniforms = {};
  for (const m of MATERIALS) {
    const k = cap(m.id);
    uniforms[`u${k}Alb`] = { value: library.maps[m.id].albedo };
    uniforms[`u${k}Nrm`] = { value: library.maps[m.id].normal };
    uniforms[`u${k}Pck`] = { value: library.maps[m.id].pack };
  }
  uniforms.uDetail = { value: library.detail };
  uniforms.uFootMap = { value: footprints ? footprints.texture : null };
  uniforms.uFootCenter = { value: footprints ? footprints.centerV2 : new THREE.Vector2(0, 0) };
  uniforms.uFootExtent = { value: footprints ? footprints.extent : 26 };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${TERRAIN_VERTEX_PREFIX}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${TERRAIN_VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${terrainFragmentPrefix()}`)
      .replace("#include <map_fragment>", terrainMainGLSL())
      .replace(
        "#include <roughnessmap_fragment>",
        "float roughnessFactor = clamp(gP1Rough, 0.03, 1.0);",
      )
      .replace(
        "#include <normal_fragment_maps>",
        "normal = normalize((viewMatrix * vec4(gP1Nrm, 0.0)).xyz);",
      );
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => "astra-p1-terrain-1";
  return material;
}

/* ------------------------------------------------------------- water (P1) */

/**
 * P1 water: depth absorption, fouling tint, foam whitening and a gentle time
 * ripple, all from the waterData attribute. P3 replaces the ripple with the
 * advected flow field, the Kelvin-Helmholtz mixing layer and depth-buffer
 * contact foam -- the attribute layout is already the one P3 needs.
 */
export function createWaterMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.12,
    metalness: 0.0,
    transparent: true,
    opacity: 0.92,
  });
  const timeUniform = { value: 0 };
  material.userData.timeUniform = timeUniform;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 waterData;
varying vec4 vWData;
varying vec3 vWPos;`,
      )
      // P0 emits no normals for the water; it is a level surface by construction.
      .replace(
        "#include <beginnormal_vertex>",
        "vec3 objectNormal = vec3(0.0, 1.0, 0.0);",
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
vWData = waterData;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec4 vWData;
varying vec3 vWPos;
uniform float uTime;
float gWFoam = 0.0;`,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */`
{
  float wDepth = vWData.x;
  float wFoul = clamp(vWData.y * 1.2, 0.0, 1.0);
  float wFoam = clamp(vWData.z, 0.0, 1.0);
  vec3 shallow = vec3(0.42, 0.40, 0.30);
  vec3 deep = mix(vec3(0.05, 0.16, 0.15), vec3(0.09, 0.06, 0.02), wFoul);
  float absorb = 1.0 - exp(-wDepth * mix(2.2, 5.5, wFoul));
  vec3 wcol = mix(shallow, deep, clamp(absorb, 0.0, 1.0));
  vec3 Vv = normalize(cameraPosition - vWPos);
  float fres = 0.04 + 0.96 * pow(1.0 - max(Vv.y, 0.0), 3.0);
  wcol = mix(wcol, vec3(0.72, 0.79, 0.84), clamp(fres * 0.75, 0.0, 1.0));
  wcol = mix(wcol, vec3(0.88, 0.90, 0.88), wFoam * 0.85);
  diffuseColor.rgb = wcol;
  gWFoam = wFoam;
}`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "float roughnessFactor = 0.10 + gWFoam * 0.55;",
      )
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */`
{
  vec3 ripN = normalize(vec3(
    sin(vWPos.x * 3.1 + uTime * 1.7) * 0.06 + sin(vWPos.z * 4.3 - uTime * 1.3) * 0.04,
    1.0,
    cos(vWPos.z * 2.7 + uTime * 1.1) * 0.06 + cos(vWPos.x * 3.7 - uTime * 0.9) * 0.04));
  normal = normalize((viewMatrix * vec4(ripN, 0.0)).xyz);
}`,
      );
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => "astra-p1-water-1";
  return material;
}
