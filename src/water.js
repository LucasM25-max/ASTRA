import * as THREE from "three";
import {
  WORLD_HALF,
  WATER_Y,
  lerp,
  riverCenterZ,
  riverHalfWidth,
  streamCenterX,
  streamHalfWidth,
  pollutionAt,
} from "./landscape.js";

const VERT = /* glsl */ `
attribute float aPollution;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;
varying float vPol;
varying float vAcross;

void main() {
  vUv = uv;
  vPol = aPollution;
  vAcross = abs(uv.y - 0.5) * 2.0;
  vec3 p = position;
  float calm = mix(1.0, 0.35, vPol);
  p.y += sin(position.x * 1.35 + uTime * 1.55) * 0.018 * calm;
  p.y += sin(position.z * 1.7 + uTime * 1.2) * 0.014 * calm;
  p.y += sin((position.x + position.z) * 0.45 + uTime * 0.7) * 0.01 * calm;
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform sampler2D uNoise;
uniform sampler2D uFoam;
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;
varying float vPol;
varying float vAcross;

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 flow = vUv;
  flow.x += uTime * mix(0.035, 0.012, vPol);
  float n1 = texture2D(uNoise, flow * vec2(6.0, 2.2)).r;
  float n2 = texture2D(uNoise, flow * vec2(13.0, 5.0) + vec2(-uTime * 0.02, 0.15)).g;
  vec3 N = normalize(vN + vec3((n1 - 0.5) * 0.55, 0.0, (n2 - 0.5) * 0.45));
  vec3 V = normalize(uCamPos - vWorld);
  float ndv = max(dot(N, V), 0.0);
  float fres = pow(1.0 - ndv, 3.6);

  vec3 cleanDeep = vec3(0.045, 0.145, 0.155);
  vec3 cleanShal = vec3(0.16, 0.40, 0.36);
  vec3 polDeep = vec3(0.10, 0.11, 0.035);
  vec3 polShal = vec3(0.27, 0.29, 0.07);

  float shallow = smoothstep(0.28, 0.98, vAcross);
  vec3 clean = mix(cleanDeep, cleanShal, shallow);
  vec3 pol = mix(polDeep, polShal, shallow);
  vec3 col = mix(clean, pol, vPol);

  float oil = smoothstep(0.28, 0.95, vPol) * (0.35 + 0.65 * n1);
  vec3 oilCol = hsv2rgb(vec3(fract(n2 * 1.4 + ndv * 0.4 + uTime * 0.015), 0.62, 0.72));
  col = mix(col, mix(col, oilCol, 0.55), oil * (0.25 + fres * 0.75));

  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), mix(260.0, 36.0, vPol));
  vec3 specCol = mix(vec3(1.0, 0.94, 0.82), vec3(0.55, 0.62, 0.28), vPol);
  col += specCol * spec * mix(0.95, 0.28, vPol);
  col += vec3(0.55, 0.68, 0.82) * fres * mix(0.28, 0.08, vPol);
  col += vec3(0.08, 0.1, 0.04) * max(dot(N, L), 0.0) * 0.25;

  float foamEdge = smoothstep(0.7, 1.0, vAcross);
  float foamN = texture2D(uFoam, vWorld.xz * 0.18 + vec2(uTime * 0.02, 0.0)).a;
  float foam = foamEdge * (0.4 + 0.6 * foamN);
  foam += smoothstep(0.45, 1.0, vPol) * smoothstep(0.5, 0.95, vAcross) * 0.55;
  vec3 foamCol = mix(vec3(0.86, 0.91, 0.9), vec3(0.52, 0.5, 0.26), vPol);
  col = mix(col, foamCol, clamp(foam, 0.0, 0.85));

  float alpha = mix(0.82, 0.94, vPol);
  alpha = mix(alpha, 0.96, foam);
  gl_FragColor = vec4(col, alpha);
}
`;

function ribbon({
  samples,
  across,
  getPoint,
  getHalfWidth,
  alongScale,
}) {
  const pos = [];
  const uv = [];
  const pol = [];
  const nrm = [];
  const idx = [];
  const cols = across + 1;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const { x, z, tx, tz } = getPoint(t);
    const len = Math.hypot(tx, tz) || 1;
    const nx = -tz / len;
    const nz = tx / len;
    const hw = getHalfWidth(t, x, z);
    for (let j = 0; j <= across; j++) {
      const u = j / across;
      const side = (u - 0.5) * 2;
      const px = x + nx * side * hw;
      const pz = z + nz * side * hw;
      pos.push(px, WATER_Y, pz);
      uv.push(t * alongScale, u);
      pol.push(pollutionAt(px, pz));
      nrm.push(0, 1, 0);
    }
  }
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("aPollution", new THREE.Float32BufferAttribute(pol, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function createWater(textures) {
  const group = new THREE.Group();
  group.name = "Water";

  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.28, 0.78, 0.55).normalize() },
    uCamPos: { value: new THREE.Vector3() },
    uNoise: { value: textures.noise },
    uFoam: { value: textures.foam },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const riverGeo = ribbon({
    samples: 180,
    across: 14,
    alongScale: 10,
    getPoint(t) {
      const x = lerp(-WORLD_HALF + 1.2, WORLD_HALF - 1.2, t);
      const z = riverCenterZ(x);
      const x2 = x + 0.45;
      return { x, z, tx: 0.45, tz: riverCenterZ(x2) - z };
    },
    getHalfWidth(t, x) {
      return riverHalfWidth(x) * 0.99;
    },
  });

  const streamGeo = ribbon({
    samples: 110,
    across: 8,
    alongScale: 7,
    getPoint(t) {
      const z = lerp(-42.5, 16.5, t);
      const x = streamCenterX(z);
      const z2 = z + 0.4;
      return { x, z, tx: streamCenterX(z2) - x, tz: 0.4 };
    },
    getHalfWidth(t, x, z) {
      const rz = riverCenterZ(x);
      if (z > rz + 0.8) return 0.15;
      return streamHalfWidth(z) * 1.05;
    },
  });

  const river = new THREE.Mesh(riverGeo, mat);
  const stream = new THREE.Mesh(streamGeo, mat);
  river.renderOrder = 2;
  stream.renderOrder = 2;
  group.add(river, stream);

  group.userData.uniforms = uniforms;
  group.userData.update = (time, camera, sunDir) => {
    uniforms.uTime.value = time;
    uniforms.uCamPos.value.copy(camera.position);
    if (sunDir) uniforms.uSunDir.value.copy(sunDir);
  };
  return group;
}
