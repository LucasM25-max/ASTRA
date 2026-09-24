import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { createWorld } from "./world.js";
import { Player, makeBeanFallback } from "./player.js";

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.38 },
    uWarm: { value: 0.16 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uWarm;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 p = vUv * 2.0 - 1.0;
      float v = 1.0 - dot(p, p) * uVignette;
      c.rgb *= v;
      c.rgb *= mix(vec3(1.0), vec3(1.08, 1.0, 0.88), uWarm);
      c.rgb = mix(c.rgb, vec3(dot(c.rgb, vec3(0.3, 0.5, 0.2))), -0.08);
      c.rgb = pow(max(c.rgb, 0.0), vec3(0.96));
      gl_FragColor = c;
    }
  `,
};

async function boot() {
  const canvas = document.getElementById("c");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.12, 220);
  camera.position.set(-4.2, 7.2, 33.4);

  const world = await createWorld(renderer);
  const { scene, water, grassMat, sunDir, glow, motes } = world;

  let bean = world.beanProto;
  if (bean) {
    bean.position.set(0, 0, 0);
    bean.scale.setScalar(1);
    bean.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = true;
        n.receiveShadow = true;
      }
    });
  } else {
    bean = makeBeanFallback();
  }

  const player = new Player(scene, camera, bean);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.22, 0.48, 0.84);
  composer.addPass(bloom);
  const bokeh = new BokehPass(scene, camera, {
    focus: 12,
    aperture: 0.00022,
    maxblur: 0.0095,
  });
  composer.addPass(bokeh);
  composer.addPass(new ShaderPass(GradeShader));
  const smaa = new SMAAPass(window.innerWidth, window.innerHeight);
  composer.addPass(smaa);
  composer.addPass(new OutputPass());

  window.addEventListener("resize", () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.setSize(w, h);
  });

  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    player.update(dt);
    water.userData.update(t, camera, sunDir);
    if (grassMat.userData.shader) {
      grassMat.userData.shader.uniforms.uTime.value = t;
    }
    glow.intensity = 2.2 + Math.sin(t * 1.7) * 0.55;
    if (motes) {
      motes.rotation.y = t * 0.012;
      const arr = motes.geometry.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 1] += Math.sin(t * 0.4 + arr[i]) * 0.0008;
      }
      motes.geometry.attributes.position.needsUpdate = true;
    }
    tmp.copy(player.position).sub(camera.position);
    const dist = tmp.length();
    if (bokeh.uniforms && bokeh.uniforms.focus) {
      bokeh.uniforms.focus.value = THREE.MathUtils.damp(bokeh.uniforms.focus.value, dist, 2.4, dt);
    }
    composer.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error(err);
});
