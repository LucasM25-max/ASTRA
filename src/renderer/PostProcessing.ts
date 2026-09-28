/**
 * PostProcessing.ts - ASTRA renderer
 * =============================================================================
 * The frame as the player sees it: the scene is rendered once, then graded.
 *
 * This is where the plan's Step 2.5 list lands, and it is the module that
 * decides whether the world looks like a game or like a tech demo. A raw
 * Three.js render is a correct image and a dead one - linear-light values
 * pushed straight at the screen, no highlight rolloff, no colour opinion, every
 * light at full strength. Everything below exists to give it an opinion.
 *
 * The chain, in order:
 *
 *   RenderPass      the scene, into a multisampled target that also carries a
 *                   depth texture
 *   AtmospherePass  volumetric fog and god rays, reconstructed from that depth
 *   UnrealBloomPass the sun's edge and the fungal glow, and nothing else
 *   GradePass       colour grade and vignette, in linear light
 *   OutputPass      ACES filmic tone map, then sRGB
 *
 * Three of those orderings are load-bearing and easy to get wrong:
 *
 *  - Tone mapping goes last of the grading, not first. Bloom and the grade both
 *    have to work in linear light: bloom a tone-mapped image and the highlights
 *    it should be catching are already clipped to white; grade a tone-mapped
 *    image and the grade fights the curve instead of shaping it.
 *
 *  - Antialiasing is MSAA on the render target, not a post-pass. Four samples
 *    on the target is cheaper than FXAA and better than it for geometric edges,
 *    which is the only kind of edge a forest has. A post-process AA would also
 *    have to run after the tone map, on the LDR image, and would smooth the
 *    grade's own gradients along with the geometry.
 *
 *  - Fog and god rays are ONE pass, not two. Both need to rebuild a world
 *    position from the depth buffer, and only the buffer `RenderPass` just drew
 *    into has a depth texture - the composer's second buffer gets its own, empty
 *    one. A second depth-reading pass would therefore read a blank depth map and
 *    silently do nothing. Merging them also means one depth reconstruction per
 *    pixel instead of two.
 *
 * The fog is a post-process rather than a material patch. Three's own `Fog` is
 * applied per material in the fragment shader, which would mean patching every
 * procedural material in the project - terrain, bark, canopy, foliage, fungus,
 * water, sky - and then keeping all seven in step. Doing it once, from the depth
 * buffer, is one place to get it wrong instead of seven, and it is the only way
 * to get a height falloff and a valley floor out of a distance fog anyway.
 * =============================================================================
 */

import {
  ACESFilmicToneMapping,
  Color,
  DataTexture,
  DepthTexture,
  type Matrix4,
  RGBAFormat,
  type Scene,
  type Camera,
  type WebGLRenderer,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * The warm, slightly desaturated cinematic grade the plan asks for.
 *
 * The desaturation is the part that does the work. Saturated colour reads as
 * cheap long before anything else does, and the earthy palette in the style
 * guide only holds together if the grade refuses to let anything get loud.
 */
export interface GradeOptions {
  exposure: number;
  temperature: number;
  saturation: number;
  lift: number;
  shoulder: number;
  shoulderStrength: number;
  vignette: number;
  vignetteRadius: number;
}

export const DEFAULT_GRADE: GradeOptions = {
  /** Multiply applied to the whole image, in linear light. Defaults to 1.04. */
  exposure: 1.04,
  /** Warm-cool balance, -1 cool to 1 warm. Defaults to 0.14. */
  temperature: 0.14,
  /** Chroma scale, 0 grey to 1 untouched. Defaults to 0.82. */
  saturation: 0.82,
  /** Black lift, in linear light. Defaults to 0.012. */
  lift: 0.012,
  /** Linear value the highlights start rolling off at. Defaults to 0.8. */
  shoulder: 0.8,
  /** How hard the shoulder presses. Defaults to 3.4. */
  shoulderStrength: 3.4,
  /** Vignette strength, 0 none to 1 heavy. Defaults to 0.2. */
  vignette: 0.2,
  /** Vignette radius, as a fraction of the half-diagonal. Defaults to 0.55. */
  vignetteRadius: 0.55,
};

/** Bloom: subtle, and aimed at the two things in this world that actually glow. */
export interface BloomOptions {
  strength: number;
  radius: number;
  threshold: number;
}

export const DEFAULT_BLOOM: BloomOptions = {
  strength: 0.4,
  radius: 0.5,
  /**
   * Linear value above which a pixel blooms. High on purpose - bloom that
   * starts at 0.5 washes the whole forest out and turns every leaf into a
   * light source. Only the sun's rim and the corruption's pods are above this.
   */
  threshold: 0.78,
};

/**
 * Screen-space god rays through the canopy.
 *
 * A radial blur towards the sun's screen position, with a depth test per tap so
 * a shaft stops at the first tree it hits rather than bleeding through the
 * canopy. This is the "screen-space approximation for performance" the plan
 * offers as the alternative to a real volumetric pass - a real one needs the
 * depth prepass and the shadow map both re-rendered per sample, which is not a
 * thing an integrated GPU does at 60fps.
 */
export interface GodRayOptions {
  samples: number;
  length: number;
  intensity: number;
  focus: number;
}

export const DEFAULT_GOD_RAYS: GodRayOptions = {
  /** Taps along each shaft. Defaults to 20. */
  samples: 20,
  /** How far the shafts reach, as a fraction of the screen. Defaults to 0.5. */
  length: 0.5,
  /** Peak brightness. Defaults to 0.34. */
  intensity: 0.34,
  /** 0 spreads the shafts wide, 1 pins them to the sun. Defaults to 0.85. */
  focus: 0.85,
};

/** Fog defaults, in one place so they can be tuned together. */
export interface FogShaderOptions {
  density: number;
  heightBase: number;
  heightFalloff: number;
  valleyBoost: number;
  valleyWidth: number;
  corruptionTint: number;
  drift: number;
}

export const DEFAULT_FOG_SHADER: FogShaderOptions = {
  /** Extinction per metre at the reference height. Defaults to 0.0052. */
  density: 0.0052,
  /** Height at which the fog is at full strength, in metres. Defaults to -3. */
  heightBase: -3,
  /**
   * Metres of height over which the fog thins to nothing. Defaults to 9.
   *
   * This is the number that decides whether the world has ground fog or a
   * uniform haze, and it is easy to set wrong. At 30 the falloff is so gentle
   * that a camera 34 m up still looks INTO a solid bank: the far field came back
   * with a luminance standard deviation of 2.4 - a flat white wall with no
   * structure and no colour left in it - because the mist was as thick 30 m up
   * as it was on the ground.
   *
   * At 9 the mist is a bank you see OVER. From the same camera the valley floor
   * is in fog and the ridges above it are clear, which is the depth layering the
   * style guide's "volumetric fog" is asking for; a haze that fills the frame
   * from horizon to horizon is not volumetric, it is a white sheet.
   */
  heightFalloff: 9,
  /** Extra density in the stream bed. Defaults to 3.4. */
  valleyBoost: 3.4,
  /** How far from the water the mist is felt, in metres. Defaults to 38. */
  valleyWidth: 38,
  /** How much the corruption shifts the haze. Defaults to 0.6. */
  corruptionTint: 0.6,
  /** Amplitude of the slow drift. Defaults to 1. */
  drift: 1,
};

/**
 * The grade and the vignette, in one pass.
 *
 * They share a pass because they both read the same pixel and one of them is
 * four lines of arithmetic. Splitting them would be two full-screen reads of
 * the frame for what is, in the end, one look.
 */
export const GradeShader = {
  name: 'AstraGradeShader',
  uniforms: {
    tDiffuse: { value: null as unknown },
    uExposure: { value: DEFAULT_GRADE.exposure },
    uTemperature: { value: DEFAULT_GRADE.temperature },
    uSaturation: { value: DEFAULT_GRADE.saturation },
    uLift: { value: DEFAULT_GRADE.lift },
    uShoulder: { value: DEFAULT_GRADE.shoulder },
    uShoulderStrength: { value: DEFAULT_GRADE.shoulderStrength },
    uVignette: { value: DEFAULT_GRADE.vignette },
    uVignetteRadius: { value: DEFAULT_GRADE.vignetteRadius },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uTemperature;
    uniform float uSaturation;
    uniform float uLift;
    uniform float uShoulder;
    uniform float uShoulderStrength;
    uniform float uVignette;
    uniform float uVignetteRadius;

    varying vec2 vUv;

    void main() {
      vec3 colour = texture2D( tDiffuse, vUv ).rgb;

      // Exposure first, in linear light. Everything after this assumes the
      // image is at roughly the brightness it will be displayed at.
      colour *= uExposure;

      // Temperature as a channel gain rather than a hue rotation. A hue rotation
      // swings the greens towards orange, which is the last thing an earthy
      // palette needs.
      colour.r *= 1.0 + uTemperature * 0.5;
      colour.g *= 1.0 + uTemperature * 0.08;
      colour.b *= 1.0 - uTemperature * 0.35;

      // Saturation around the Rec.709 luma, so the greens stay where they are.
      float luma = dot( colour, vec3( 0.2126, 0.7152, 0.0722 ) );
      colour = mix( vec3( luma ), colour, uSaturation );

      // Lift the blacks a touch. A crushed black in a forest reads as a hole in
      // the image; a lifted one reads as air.
      colour = max( colour, vec3( 0.0 ) ) + uLift;

      // A soft shoulder on the highlights, before the tone map gets them. This
      // is what stops a sunlit rock from going to a flat white disk.
      float peak = max( max( colour.r, colour.g ), colour.b );
      if ( peak > uShoulder ) {
        float over = ( peak - uShoulder ) / max( 1.0 - uShoulder, 1e-4 );
        float pressed = 1.0 - exp( -over * uShoulderStrength );
        colour *= mix( 1.0, uShoulder / peak, clamp( pressed, 0.0, 1.0 ) );
      }

      // Vignette. Very subtle, and radius-based rather than a hard circle, so
      // the corners fall off without a visible edge to the falloff.
      float radius = length( vUv - 0.5 ) * 1.41421356;
      float falloff = smoothstep( uVignetteRadius, uVignetteRadius + 0.45, radius );
      colour *= 1.0 - uVignette * falloff;

      gl_FragColor = vec4( max( colour, vec3( 0.0 ) ), 1.0 );
    }
  `,
};

/**
 * The air: volumetric fog, and god rays through the canopy.
 *
 * Both are in one pass for the reason given at the top of the file - only the
 * buffer `RenderPass` drew into has a depth texture, and both effects need to
 * rebuild a world position from it.
 *
 * Three things make the fog read as air rather than as a grey wash:
 *
 *  1. It is exponential in height, not linear in distance. Fog that thickens
 *     with distance alone looks like a gradient painted on the lens; fog that
 *     also sits in the valley floor looks like weather.
 *
 *  2. It is denser in the stream bed. The mask's red channel is 1 in the water
 *     and 0 away from it, so the mist the plan asks for pools where the plan
 *     asks for it.
 *
 *  3. It is tinted by the corruption. The green channel of the same mask drives
 *     a shift towards a sickly yellow-green, so the air itself goes over as the
 *     player walks upstream. That is the plan's "slightly greenish tint in
 *     corrupted areas", and doing it in the air rather than on the geometry is
 *     what keeps it from looking like everything was painted green.
 */
export const AtmosphereShader = {
  name: 'AstraAtmosphereShader',
  uniforms: {
    tDiffuse: { value: null as unknown },
    tDepth: { value: null as unknown },
    /** Inverse of the camera's projection-view matrix. */
    uProjectionInverse: { value: null as unknown as Matrix4 | null },
    uCameraPosition: { value: new Vector3() },
    uTime: { value: 0 },

    /* fog */
    uDensity: { value: DEFAULT_FOG_SHADER.density },
    uHeightBase: { value: DEFAULT_FOG_SHADER.heightBase },
    uHeightFalloff: { value: DEFAULT_FOG_SHADER.heightFalloff },
    uValleyBoost: { value: DEFAULT_FOG_SHADER.valleyBoost },
    uMask: { value: null as unknown },
    uMaskHalfSize: { value: 250 },
    uHazeColor: { value: new Color(0xc6d2d6) },
    uCorruptionTint: { value: DEFAULT_FOG_SHADER.corruptionTint },
    uCorruptionColor: { value: new Color(0x707c48) },
    uDrift: { value: DEFAULT_FOG_SHADER.drift },

    /* god rays */
    /** The sun in normalised device coordinates. Off screen means no rays. */
    uSunNdc: { value: new Vector2(2, 2) },
    uSamples: { value: DEFAULT_GOD_RAYS.samples },
    uRayLength: { value: DEFAULT_GOD_RAYS.length },
    uRayIntensity: { value: DEFAULT_GOD_RAYS.intensity },
    uRayFocus: { value: DEFAULT_GOD_RAYS.focus },
    uRayDecay: { value: 0.93 },
    uRayWeight: { value: 0.5 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform mat4 uProjectionInverse;
    uniform vec3 uCameraPosition;
    uniform float uTime;

    uniform float uDensity;
    uniform float uHeightBase;
    uniform float uHeightFalloff;
    uniform float uValleyBoost;
    uniform sampler2D uMask;
    uniform float uMaskHalfSize;
    uniform vec3 uHazeColor;
    uniform float uCorruptionTint;
    uniform vec3 uCorruptionColor;
    uniform float uDrift;

    uniform vec2 uSunNdc;
    uniform int uSamples;
    uniform float uRayLength;
    uniform float uRayIntensity;
    uniform float uRayFocus;
    uniform float uRayDecay;
    uniform float uRayWeight;

    varying vec2 vUv;

    /** World position of a fragment at this uv and depth. */
    vec3 worldAt( vec2 uv, float depth ) {
      vec4 point = uProjectionInverse * vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
      return point.xyz / point.w;
    }

    void main() {
      vec4 colour = texture2D( tDiffuse, vUv );
      float depth = texture2D( tDepth, vUv ).x;

      // The sky dome writes no depth, so a far-plane depth here means
      // "background" and the fog leaves it alone. Without this the sky gets
      // fogged too and the horizon disappears.
      bool sky = depth >= 0.9999;
      vec3 world = worldAt( vUv, sky ? 1.0 : depth );

      /* ---------------------------------------------------------------- fog */

      if ( ! sky ) {
        vec3 toFragment = world - uCameraPosition;
        float distance = length( toFragment );

        // Exponential in height. Below the base the fog is at full strength and
        // this term is clamped to 1, which is what pools it in the valley floor.
        float height = world.y - uHeightBase;
        float heightFactor = exp( -max( height, 0.0 ) / max( uHeightFalloff, 1e-3 ) );

        // The world mask, sampled by XZ. Outside the mask's box the fog thins
        // out rather than stopping, so the world's edge never shows as a wall.
        vec2 maskUv = world.xz / ( uMaskHalfSize * 2.0 ) + 0.5;
        vec2 mask = vec2( 0.0 );
        if ( maskUv.x > 0.0 && maskUv.x < 1.0 && maskUv.y > 0.0 && maskUv.y < 1.0 ) {
          mask = texture2D( uMask, maskUv ).rg;
        }
        float valley = clamp( mask.r, 0.0, 1.0 );

        // A slow drift, so the mist is never perfectly still. Sampled from the
        // world position rather than the uv, which keeps it anchored to the
        // ground instead of sliding across the screen with the camera.
        float drift = 1.0 + uDrift * 0.18 * sin( uTime * 0.21 + world.x * 0.05 + world.z * 0.037 );
        float density = uDensity * heightFactor * ( 1.0 + uValleyBoost * valley ) * drift;
        float amount = 1.0 - exp( -density * distance );

        float corruption = clamp( mask.g, 0.0, 1.0 );
        vec3 haze = mix( uHazeColor, uCorruptionColor, corruption * uCorruptionTint );

        colour.rgb = mix( colour.rgb, haze, clamp( amount, 0.0, 1.0 ) );
      }

      /* ----------------------------------------------------------- god rays */

      // Off screen, or intensity off: no rays and no work.
      if ( uRayIntensity > 0.0 && uSunNdc.x >= -1.2 && uSunNdc.x <= 1.2 && uSunNdc.y >= -1.2 && uSunNdc.y <= 1.2 ) {
        float pixelDistance = length( world - uCameraPosition );

        vec2 sunUv = uSunNdc * 0.5 + 0.5;
        vec2 delta = ( sunUv - vUv ) * uRayLength / float( uSamples );

        float illumination = 1.0;
        float sum = 0.0;
        vec2 sampleUv = vUv;
        for ( int i = 0; i < 64; i ++ ) {
          if ( i >= uSamples ) break;

          // A sample only contributes if it is sky and further away than the
          // pixel being shaded. Anything closer is a leaf in the way, and the
          // shaft ends there.
          float sampleDepth = texture2D( tDepth, sampleUv ).x;
          bool sampleSky = sampleDepth >= 0.9999;
          vec3 sampleWorld = worldAt( sampleUv, sampleSky ? 1.0 : sampleDepth );
          float sampleDistance = length( sampleWorld - uCameraPosition );

          float contributes = sampleSky ? step( pixelDistance, sampleDistance ) : 0.0;
          sum += texture2D( tDiffuse, sampleUv ).r * contributes * illumination;

          illumination *= uRayDecay;
          sampleUv += delta;
        }

        sum /= float( uSamples );

        // The focus term falls off with the angle from the sun, so the shafts
        // are tight near the sun's screen position and smear outwards.
        float angular = 1.0 - clamp( length( vUv - sunUv ) / max( uRayLength, 1e-3 ), 0.0, 1.0 );
        float shaped = pow( clamp( angular, 0.0, 1.0 ), mix( 4.0, 0.4, clamp( uRayFocus, 0.0, 1.0 ) ) );
        sum *= shaped * uRayWeight;

        colour.rgb += vec3( sum * uRayIntensity );
      }

      gl_FragColor = colour;
    }
  `,
};

export interface PostProcessingOptions {
  /** The scene to render. */
  scene: Scene;
  /** The camera to render it through. */
  camera: Camera;
  /**
   * A top-down mask of the world: R is valley density (1 in the stream bed, 0
   * away from it) and G is corruption (0 clean, 1 fully rotted). Both are
   * sampled by world XZ, so it must cover the same box the terrain does.
   */
  atmosphereMask?: DataTexture | null;
  /** World-space half-size the atmosphere mask covers, in metres. */
  atmosphereMaskHalfSize?: number;
  grade?: Partial<GradeOptions>;
  bloom?: Partial<BloomOptions> & { enabled?: boolean };
  godRays?: Partial<GodRayOptions> & { enabled?: boolean };
  fog?: Partial<FogShaderOptions>;
  /** MSAA samples on the composer target. 0 disables it. Defaults to 4. */
  samples?: number;
  /** Turn the whole chain off and render the scene straight to the canvas. */
  enabled?: boolean;
}

export class PostProcessing {
  readonly composer: EffectComposer;
  readonly renderTarget: WebGLRenderTarget;

  private readonly gradePass: ShaderPass;
  /** Public so the pipeline can attach a world mask after construction. */
  readonly atmospherePass: ShaderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly outputPass: OutputPass;

  private time = 0;
  private enabled: boolean;
  private disposed = false;

  constructor(renderer: WebGLRenderer, camera: Camera, scene: Scene, options: PostProcessingOptions) {
    this.enabled = options.enabled ?? true;

    // A render target with its own depth texture. The atmosphere pass rebuilds
    // world position from that depth, so without one it has nothing to read -
    // and Three's default composer target has no depth texture at all. The depth
    // is resolved out of the multisampled buffer on unbind, which is what makes
    // MSAA and a depth texture work together here.
    const size = renderer.getDrawingBufferSize(new Vector2());
    const width = Math.max(1, Math.floor(size.x));
    const height = Math.max(1, Math.floor(size.y));
    const samples = Math.max(0, Math.floor(options.samples ?? 4));

    this.renderTarget = new WebGLRenderTarget(width, height, {
      type: UnsignedByteType,
      format: RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      samples,
      depthTexture: new DepthTexture(width, height),
    });

    this.composer = new EffectComposer(renderer, this.renderTarget);
    this.composer.setPixelRatio(renderer.getPixelRatio());

    // ACES filmic, per the plan. OutputPass reads this off the renderer every
    // frame, so it is the one setting that has to live on the renderer rather
    // than in the chain.
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;

    this.composer.addPass(new RenderPass(scene, camera));

    // The atmosphere pass comes immediately after the render pass, while the
    // read buffer is still the one the scene was drawn into. See the note at
    // the top of the file.
    this.atmospherePass = new ShaderPass(AtmosphereShader);
    if (options.atmosphereMask) {
      this.atmospherePass.uniforms.uMask.value = options.atmosphereMask;
    }
    this.atmospherePass.uniforms.uMaskHalfSize.value = options.atmosphereMaskHalfSize ?? 250;
    this.applyFog(options.fog);
    this.applyGodRays({ ...options.godRays });
    this.composer.addPass(this.atmospherePass);

    this.bloomPass = new UnrealBloomPass(
      new Vector2(width, height),
      options.bloom?.strength ?? DEFAULT_BLOOM.strength,
      options.bloom?.radius ?? DEFAULT_BLOOM.radius,
      options.bloom?.threshold ?? DEFAULT_BLOOM.threshold,
    );
    this.bloomPass.enabled = options.bloom?.enabled !== false;
    this.composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.applyGrade(options.grade);
    this.composer.addPass(this.gradePass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
  }

  /* ---------------------------------------------------------------------- */
  /* Tuning                                                                 */
  /* ---------------------------------------------------------------------- */

  applyGrade(grade: Partial<GradeOptions> = {}): void {
    const merged = { ...DEFAULT_GRADE, ...grade };
    const u = this.gradePass.uniforms;
    u.uExposure.value = merged.exposure;
    u.uTemperature.value = merged.temperature;
    u.uSaturation.value = merged.saturation;
    u.uLift.value = merged.lift;
    u.uShoulder.value = merged.shoulder;
    u.uShoulderStrength.value = merged.shoulderStrength;
    u.uVignette.value = merged.vignette;
    u.uVignetteRadius.value = merged.vignetteRadius;
  }

  applyFog(fog: Partial<FogShaderOptions> = {}): void {
    const merged = { ...DEFAULT_FOG_SHADER, ...fog };
    const u = this.atmospherePass.uniforms;
    u.uDensity.value = merged.density;
    u.uHeightBase.value = merged.heightBase;
    u.uHeightFalloff.value = merged.heightFalloff;
    u.uValleyBoost.value = merged.valleyBoost;
    u.uCorruptionTint.value = merged.corruptionTint;
    u.uDrift.value = merged.drift;
  }

  applyGodRays(rays: Partial<GodRayOptions> & { enabled?: boolean } = {}): void {
    const u = this.atmospherePass.uniforms;
    u.uSamples.value = Math.max(1, Math.floor(rays.samples ?? DEFAULT_GOD_RAYS.samples));
    u.uRayLength.value = rays.length ?? DEFAULT_GOD_RAYS.length;
    u.uRayIntensity.value =
      rays.enabled === false ? 0 : (rays.intensity ?? DEFAULT_GOD_RAYS.intensity);
    u.uRayFocus.value = rays.focus ?? DEFAULT_GOD_RAYS.focus;
  }

  /** Resize every pass's target. Call on canvas resize. */
  setSize(width: number, height: number): void {
    this.composer.setSize(Math.max(1, width), Math.max(1, height));
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /* ---------------------------------------------------------------------- */
  /* Per frame                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Feed the chain the things it needs that change every frame.
   *
   * `sunWorldPosition` is where the sun is, in world space. It is projected to
   * find the centre of the light shafts; when it is off screen the shader skips
   * the rays entirely, which is the correct behaviour and needs no special case
   * here.
   */
  update(delta: number, camera: Camera, sunWorldPosition?: Vector3): void {
    if (this.disposed) return;
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.time += delta;

    const u = this.atmospherePass.uniforms;
    u.uTime.value = this.time;
    u.uProjectionInverse.value = camera.projectionMatrixInverse;
    u.uCameraPosition.value = camera.getWorldPosition(u.uCameraPosition.value as Vector3);

    if (sunWorldPosition) {
      const ndc = sunWorldPosition.clone().project(camera);
      (u.uSunNdc.value as Vector2).set(ndc.x, ndc.y);
    } else {
      // No sun means no rays, and putting the sun off screen is how the shader
      // is told that.
      (u.uSunNdc.value as Vector2).set(2, 2);
    }
  }

  render(): void {
    if (this.disposed) return;
    this.composer.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The composer was constructed WITH this target as its renderTarget1, so it
    // owns it and disposes it. Disposing it here as well is redundant - Three
    // drops a texture's dispose listener the first time round, so it happens to
    // be harmless today, but it is the kind of thing that stops being harmless
    // the day a memory counter is decremented before the listener is removed.
    this.composer.dispose();
    // The depth texture is not owned by the composer, only by the target, and
    // the renderer only frees it when it handles the target's dispose event. If
    // that never happens - a lost context, a renderer that was already torn
    // down - the explicit call is what stops a multisampled depth buffer
    // outliving the page.
    this.renderTarget.depthTexture?.dispose();
    this.bloomPass.dispose();
    this.atmospherePass.dispose();
    this.gradePass.dispose();
    this.outputPass.dispose();
  }
}

/**
 * Build the top-down atmosphere mask: R is valley density, G is corruption.
 *
 * Both channels come from the same walk over the world, so the mist that pools
 * in the stream bed and the mist that goes green in the rot are exactly
 * co-located. That matters: the corruption is strongest in the valley, and two
 * masks built from different lattices would visibly disagree about where the
 * foul air is.
 */
export function buildAtmosphereMask(
  sample: (x: number, z: number) => { readonly distance: number; readonly corruption: number },
  options: { size?: number; resolution?: number; valleyWidth?: number } = {},
): DataTexture {
  const size = options.size ?? 500;
  const resolution = Math.max(2, Math.floor(options.resolution ?? 256));
  const valleyWidth = Math.max(0.5, options.valleyWidth ?? DEFAULT_FOG_SHADER.valleyWidth);
  const half = size / 2;
  const data = new Uint8Array(resolution * resolution * 4);

  for (let j = 0; j < resolution; j++) {
    const z = -half + (j / (resolution - 1)) * size;
    for (let i = 0; i < resolution; i++) {
      const x = -half + (i / (resolution - 1)) * size;
      const { distance, corruption } = sample(x, z);
      // Smoothstep DOWN from the water's edge, so the mist's edge is a bank
      // rather than a wall. A hard cut would read as a rendered plane.
      //
      // The subtraction is the whole point and it is easy to lose: `distance /
      // valleyWidth` ramps UP with distance, which puts the densest mist on the
      // ridge and none at all in the stream bed - the exact opposite of what the
      // red channel promises, and invisible in every test that checks the fog
      // formula rather than the mask.
      const t = Math.min(1, Math.max(0, 1 - distance / valleyWidth));
      const valley = t * t * (3 - 2 * t);
      const o = (j * resolution + i) * 4;
      data[o] = Math.round(Math.min(1, Math.max(0, valley)) * 255);
      data[o + 1] = Math.round(Math.min(1, Math.max(0, corruption)) * 255);
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }

  const texture = new DataTexture(data, resolution, resolution, RGBAFormat, UnsignedByteType);
  texture.name = 'astra-atmosphere-mask';
  texture.needsUpdate = true;
  return texture;
}
