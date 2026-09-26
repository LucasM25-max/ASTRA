/**
 * WaterShader.ts - ASTRA procedural world
 * =============================================================================
 * The stream's water surface, built the same way as the terrain: a
 * `MeshStandardMaterial` with an `onBeforeCompile` patch rather than a
 * hand-written `ShaderMaterial`.
 *
 * Why patch instead of writing a shader
 * ------------------------------------
 * A bare `ShaderMaterial` would mean reimplementing lighting, fog, tone mapping
 * and colour space by hand, and the failure mode is invisible in review: the
 * water still looks like water while its horizon stops matching the sky and its
 * fog stops matching the hills. Patching the standard material keeps the water
 * lit, fogged and tonemapped by exactly the same pipeline as everything else.
 * `MaterialFactory` establishes this pattern for terrain; this file follows it
 * and is re-exported from there, which is what the plan's "WaterShader.ts via
 * MaterialFactory" asks for.
 *
 * The six things the plan asks the water shader to do
 * ---------------------------------------------------
 *   animated flow          the noise field is scrolled along the spline's own
 *                          arc length, which is the `astraFlow.x` attribute, so
 *                          the surface travels downstream rather than sliding
 *                          sideways across it.
 *   Fresnel transparency   reflection strength rises toward grazing angles, so
 *                          the water is mirror-like at a distance and see
 *                          -through when the player looks straight down.
 *   soft edge blending     alpha falls off with water depth, which is zero
 *                          exactly where the ground climbs through the surface.
 *                          The shoreline therefore dissolves instead of ending
 *                          on a hard line.
 *   pre-baked sky          the sky is a gradient dome (`SkySystem`), not a
 *                          cubemap, so there is no environment map to sample.
 *                          The reflection is evaluated analytically against the
 *                          same zenith/horizon pair the dome is built from. This
 *                          is a deliberate deviation from the plan's wording:
 *                          it is cheaper than a cubemap, cannot go stale when
 *                          the sky changes, and matches the dome exactly.
 *   noise normal distortion a world-space fbm height field, differentiated by
 *                          finite differences, scrolled by the flow.
 *   all procedural         no texture files anywhere.
 *
 * Pollution
 * ---------
 * One `uPollution` uniform drives both visual states, per vertex from
 * `astraPollution`, so the transition along the stream is continuous rather
 * than a hard cut at a zone boundary:
 *
 *   CLEAN    0.0  blue-green, the riverbed shows through as noise, ripples read
 *                 as moving water.
 *   POLLUTED 1.0  greenish-brown, darker, an opaque scum skin on top, and a
 *                 spore/bubble speckle.
 *
 * Cost
 * ----
 * Three fbm taps for the ripple gradient, two for the bed and the scum, one
 * hash for the bubbles: six noise evaluations per fragment, all of them cheap
 * two-octave calls. `rippleStrength`, `noiseScale` and `bubbleStrength` are the
 * dials if a target machine needs it cheaper.
 * =============================================================================
 */

import { Color, DoubleSide, MeshStandardMaterial, type MeshStandardMaterialParameters } from 'three';
import { NOISE_GLSL } from './NoiseLibrary';

/** Cache key. Bump whenever the injected GLSL changes, or Three reuses a stale program. */
const WATER_PROGRAM_KEY = 'astra-water-v1';

/**
 * Peak of the per-vertex pollution along the default stream.
 *
 * Upstream, by the cave, is the worst; downstream, by the village, is the best.
 * These are the numbers the plan names.
 */
export const POLLUTION_UPSTREAM = 0.9;
export const POLLUTION_MIDSTREAM = 0.6;
export const POLLUTION_DOWNSTREAM = 0.2;

export interface WaterMaterialOptions {
  /** World position the flow animation is measured from, in seconds. */
  /** Metres per second the surface texture travels downstream. */
  flowSpeed?: number;
  /** Noise cells per metre across the surface. Larger is choppier. */
  noiseScale?: number;
  /** How far the ripples tilt the surface normal, 0 to 1. */
  rippleStrength?: number;
  /** Fresnel exponent. Higher is a tighter, shinier edge. */
  fresnelPower?: number;
  /** Peak opacity of the water, before the depth falloff. */
  opacity?: number;
  /** Depth in metres over which the shoreline fades in. */
  edgeSoftness?: number;
  /** Depth in metres at which the riverbed is fully visible through the water. */
  depthFade?: number;
  /** Colour of clean shallow water, seen looking down through it. */
  cleanShallow?: number;
  /** Colour of clean deep water, seen looking down through it. */
  cleanDeep?: number;
  /** Colour of the scum skin that covers polluted water. */
  scumColor?: number;
  /** How visible the scum and the bubbles are at full pollution, 0 to 1. */
  scumStrength?: number;
  /** How visible the bubble/spore speckle is at full pollution, 0 to 1. */
  bubbleStrength?: number;
  /** Direction *towards* the sun, normalised. */
  sunDirection?: { x: number; y: number; z: number };
  /** Colour of direct sunlight, used for the specular highlight. */
  sunColor?: number;
  /** Sky colour straight up. Must match `SkySystem`. */
  skyZenith?: number;
  /** Sky colour at the horizon. Must match `SkySystem`. */
  skyHorizon?: number;
  /** World seed, so the same world always ripples the same way. */
  seed?: number;
}

const DEFAULT_WATER_OPTIONS: Required<WaterMaterialOptions> = {
  flowSpeed: 0.55,
  noiseScale: 0.42,
  rippleStrength: 0.55,
  fresnelPower: 3.4,
  opacity: 0.82,
  edgeSoftness: 0.22,
  depthFade: 0.5,
  cleanShallow: 0x2e6b62,
  cleanDeep: 0x12333f,
  scumColor: 0x6b6a35,
  scumStrength: 0.85,
  bubbleStrength: 0.5,
  sunDirection: { x: 0.5145, y: 0.8018, z: 0.3436 },
  sunColor: 0xfff1d6,
  skyZenith: 0x4a7ea8,
  skyHorizon: 0xe8eef2,
  seed: 0,
};

/**
 * Create the stream's water material.
 *
 * `transparent` is set because the water is blended against the terrain beneath
 * it, and `depthWrite` is left on: without it the water would not occlude the
 * point sprites that drift on its surface, and they would show through from
 * below.
 */
export function createWaterMaterial(options: WaterMaterialOptions = {}): MeshStandardMaterial {
  const o = { ...DEFAULT_WATER_OPTIONS, ...options };

  const params: MeshStandardMaterialParameters = {
    // The vertex attributes carry the flow, depth and pollution; the base
    // colour is uniform and is modulated entirely in the shader.
    vertexColors: false,
    color: 0xffffff,
    roughness: 0.16,
    metalness: 0.0,
    transparent: true,
    depthWrite: true,
    // The ribbon is a single-sided sheet seen from above; rendering the back
    // face too stops it vanishing when the camera dips below the surface while
    // wading.
    side: DoubleSide,
  };

  const material = new MeshStandardMaterial(params);
  material.onBeforeCompile = (shader) => {
    patchWaterShader(shader, o);
    // Keep a handle on the uniform objects the patch created. `onBeforeCompile`
    // is the only place they exist, and without this the caller has no way to
    // advance `uTime` - which is the whole animation.
    material.userData.uniforms = shader.uniforms;
  };
  material.customProgramCacheKey = () => WATER_PROGRAM_KEY;
  return material;
}

/** The shape `patchWaterShader` needs from a Three shader pair. */
export interface WaterShaderTarget {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, unknown>;
}

/**
 * Patch a Three.js shader pair in place.
 *
 * Exported, and taking a plain object rather than a real shader, so the
 * injection can be unit-tested in Node. A mistyped `#include` anchor fails
 * silently on a GPU and produces black water, so it is worth being able to
 * assert on exactly what was injected.
 */
export function patchWaterShader(shader: WaterShaderTarget, options: WaterMaterialOptions = {}): void {
  const o = { ...DEFAULT_WATER_OPTIONS, ...options };

  const sun = o.sunDirection;
  const sunLength = Math.hypot(sun.x, sun.y, sun.z) || 1;
  const sunDir = { x: sun.x / sunLength, y: sun.y / sunLength, z: sun.z / sunLength };

  shader.uniforms.uTime = { value: 0 };
  shader.uniforms.uFlowSpeed = { value: o.flowSpeed };
  shader.uniforms.uNoiseScale = { value: o.noiseScale };
  shader.uniforms.uRippleStrength = { value: o.rippleStrength };
  shader.uniforms.uFresnelPower = { value: o.fresnelPower };
  shader.uniforms.uOpacity = { value: o.opacity };
  shader.uniforms.uEdgeSoftness = { value: o.edgeSoftness };
  shader.uniforms.uDepthFade = { value: o.depthFade };
  shader.uniforms.uCleanShallow = { value: new Color(o.cleanShallow) };
  shader.uniforms.uCleanDeep = { value: new Color(o.cleanDeep) };
  shader.uniforms.uScumColor = { value: new Color(o.scumColor) };
  shader.uniforms.uScumStrength = { value: o.scumStrength };
  shader.uniforms.uBubbleStrength = { value: o.bubbleStrength };
  shader.uniforms.uSunDirection = { value: sunDir };
  shader.uniforms.uSunColor = { value: new Color(o.sunColor) };
  shader.uniforms.uSkyZenith = { value: new Color(o.skyZenith) };
  shader.uniforms.uSkyHorizon = { value: new Color(o.skyHorizon) };
  shader.uniforms.uSeed = { value: o.seed };
  // Static for the life of the material: the per-vertex attribute carries the
  // variation along the stream, and the uniform only exists so a caller can
  // force one state for a test or a debug view.
  shader.uniforms.uPollution = { value: 0 };

  /* ---------------------------------------------------------------- vertex */

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      // Arc length and offset across the flow, from StreamGenerator. The first
      // component is what the flow scrolls along, so the animation follows the
      // spline instead of drifting across it.
      attribute vec2 astraFlow;
      attribute float astraDepth;
      attribute float astraPollution;
      varying vec2 vAstraFlow;
      varying float vAstraDepth;
      varying float vAstraPollution;
      varying vec3 vAstraWorld;
    `,
  );

  // `<begin_vertex>` defines `transformed`, which is what the world position
  // needs, so the capture goes immediately after it.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    /* glsl */ `
      #include <begin_vertex>
      vAstraFlow = astraFlow;
      vAstraDepth = astraDepth;
      vAstraPollution = astraPollution;
      vAstraWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    `,
  );

  /* -------------------------------------------------------------- fragment */

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      varying vec2 vAstraFlow;
      varying float vAstraDepth;
      varying float vAstraPollution;
      varying vec3 vAstraWorld;

      uniform float uTime;
      uniform float uFlowSpeed;
      uniform float uNoiseScale;
      uniform float uRippleStrength;
      uniform float uFresnelPower;
      uniform float uOpacity;
      uniform float uEdgeSoftness;
      uniform float uDepthFade;
      uniform vec3 uCleanShallow;
      uniform vec3 uCleanDeep;
      uniform vec3 uScumColor;
      uniform float uScumStrength;
      uniform float uBubbleStrength;
      uniform vec3 uSunDirection;
      uniform vec3 uSunColor;
      uniform vec3 uSkyZenith;
      uniform vec3 uSkyHorizon;
      uniform float uSeed;
      uniform float uPollution;

      ${NOISE_GLSL}

      // Sky colour for a view direction, evaluated analytically against the
      // same zenith/horizon pair the sky dome is built from. The dome is a
      // gradient, not a cubemap, so there is no environment map to sample and
      // this is both cheaper and exact.
      vec3 astraSkyColor( vec3 dir ) {
        // 0 at the horizon, 1 straight up. Squaring it matches how the dome
        // shader ramps its own gradient, so the reflection agrees with the sky
        // above it rather than being a slightly different blue.
        float up = clamp( dir.y, 0.0, 1.0 );
        return mix( uSkyHorizon, uSkyZenith, up * up );
      }

      // Height of the ripple field at a point on the surface. Scrolled along the
      // spline's arc length, which is the flow direction, and slowly across it
      // so the pattern is not a set of parallel stripes running downstream.
      float astraRippleHeight( vec2 q, float t ) {
        vec2 flow = vec2( t * uFlowSpeed, t * uFlowSpeed * 0.15 );
        vec2 p = ( q - flow ) * uNoiseScale;
        return astraFbm2D( p, uSeed + 3.1, 2, 2.0, 0.5, true );
      }
    `,
  );

  // `<normal_fragment_maps>` is the chunk Three reserves for normal
  // perturbation. In a material with no normal maps it expands to nothing, so
  // replacing it is safe and lands the ripples after `normal` is established
  // and before any lighting reads it.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_maps>',
    /* glsl */ `
      #include <normal_fragment_maps>

      {
        // Two octaves of simplex at a fairly large scale: enough to read as
        // moving water, not so much that the surface looks like corrugated
        // iron. A third tap on the other axis gives the gradient.
        float e = 0.09;
        vec2 q = vAstraFlow;
        float h0 = astraRippleHeight( q, uTime );
        float hx = astraRippleHeight( q + vec2( e, 0.0 ), uTime );
        float hz = astraRippleHeight( q + vec2( 0.0, e ), uTime );

        // The gradient is in noise space, so it has to be scaled by the noise
        // frequency to become a world-space slope. Skipping that turns the
        // ripples into either nothing at all or crumpled foil.
        vec2 slope = vec2( hx - h0, hz - h0 ) / e * uNoiseScale;

        // Both guards are load-bearing. 'normalize()' of a zero vector is
        // undefined in GLSL, and 'along' is exactly zero whenever the gradient
        // runs straight down the normal - which on a level ribbon is common,
        // because the ribbon's own normal is straight up and the gradient is
        // horizontal almost everywhere.
        float strength = clamp( length( slope ) * 0.35, 0.0, 1.0 ) * uRippleStrength;
        if ( strength > 0.002 ) {
          vec3 along = vec3( slope.x, 0.0, slope.y );
          float alongLen = length( along );
          if ( alongLen > 0.002 ) {
            normal = normalize( normal - ( along / alongLen ) * strength * 0.28 );
          }
        }
      }
    `,
  );

  // Colour, opacity and the two pollution states. `<map_fragment>` runs before
  // lighting and is where `diffuseColor` is finalised, so this is the right
  // place to set the water's albedo and alpha.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    /* glsl */ `
      #include <map_fragment>

      {
        float pollution = clamp( vAstraPollution + uPollution, 0.0, 1.0 );

        vec3 viewDir = normalize( vViewPosition );
        vec3 normalDir = normalize( normal );

        // Fresnel: how much of the view is a grazing one. At a distance the
        // water is nearly mirror; looking straight down it is nearly clear and
        // the bed shows through. Guarded because 'dot' of a normal pointing
        // straight at the camera can overshoot 1 and 'pow' of a negative number
        // is undefined.
        float facing = clamp( dot( normalDir, viewDir ), 0.0, 1.0 );
        float fresnel = pow( 1.0 - facing, uFresnelPower );

        // Depth of the water here, from the per-vertex attribute. Zero exactly
        // where the ground climbs through the surface, which is what makes the
        // shoreline dissolve rather than stop.
        float depth = max( vAstraDepth, 0.0 );
        float shore = smoothstep( 0.0, max( uEdgeSoftness, 1e-4 ), depth );

        // ---- CLEAN -------------------------------------------------------
        // The bed shows through as noise, more strongly where the water is
        // shallow. Two fbm taps at different scales so it reads as gravel and
        // weed rather than as one texture.
        float bedFine = astraFbm2D( vAstraWorld.xz * 0.55, uSeed + 2.2, 2, 2.0, 0.5, false );
        float bedCoarse = astraFbm2D( vAstraWorld.xz * 0.13, uSeed + 5.9, 2, 2.0, 0.5, false );
        float bedNoise = bedFine * 0.65 + bedCoarse * 0.35;

        // Shallow water is lighter because there is less of it to look through.
        vec3 cleanBody = mix( uCleanShallow, uCleanDeep, clamp( depth * 1.6, 0.0, 1.0 ) );

        // The bed shows through more strongly where the water is shallow, and
        // not at all once it is deep enough to be opaque in its own right. Both
        // terms have to be there: without the depth term the gravel reads as
        // strongly in the middle of the channel as at the shore, and without the
        // shallow term the shoreline has no bed to show.
        float bedVisibility = smoothstep( 0.0, max( uDepthFade, 1e-4 ), depth );
        cleanBody *= ( 1.0 + bedNoise * 0.22 * bedVisibility );

        // ---- POLLUTED ----------------------------------------------------
        // Brownish-green, and darker: the scum absorbs rather than scatters.
        vec3 pollutedBody = mix( uCleanDeep * 0.55, uScumColor * 0.85, 0.55 + 0.45 * bedNoise );

        vec3 body = mix( cleanBody, pollutedBody, pollution );

        // ---- SKIN ---------------------------------------------------------
        // Clean water takes a sky reflection. Polluted water takes an opaque
        // scum layer instead, which is the clearest single signal of the two
        // states and the one the tutorial's villagers would notice first.
        vec3 reflectDir = reflect( -viewDir, normalDir );
        vec3 sky = astraSkyColor( reflectDir );

        // Specular glint off the sun, on the ripple normal so it breaks up
        // into moving highlights rather than sitting in one blob.
        vec3 sunDir = normalize( uSunDirection );
        float spec = pow( max( dot( reflectDir, sunDir ), 0.0 ), 48.0 );

        float skinMix = mix( fresnel, pollution * uScumStrength, 0.72 );
        vec3 reflection = mix( sky, uScumColor, pollution * 0.85 ) + uSunColor * spec * 0.35;
        body = mix( body, reflection, clamp( skinMix, 0.0, 1.0 ) );

        // ---- BUBBLES / SPORES --------------------------------------------
        // Only on polluted water. Points scattered in a scrolled noise field,
        // so they drift downstream with the flow, with a fade in from zero so
        // clean water has none at all.
        if ( uBubbleStrength > 0.0 && pollution > 0.001 ) {
          vec2 bq = ( vAstraFlow - vec2( uTime * uFlowSpeed * 1.4, 0.0 ) ) * 1.9;
          vec2 cell = astraVoronoi2D( bq, uSeed + 17.0 );
          // One highlight per cell: nearest cell point, brightest at its centre.
          float bubble = 1.0 - smoothstep( 0.0, 0.32, cell.x );
          // Only some cells carry one, so they are scattered rather than a grid.
          float carry = step( 0.62, astraFbm2D( floor( bq ) + 0.5, uSeed + 3.0, 1, 2.0, 0.5, false ) * 0.5 + 0.5 );
          float amount = bubble * carry * pollution * uBubbleStrength;
          body = mix( body, vec3( 0.86, 0.9, 0.78 ), amount * 0.55 );
        }

        diffuseColor.rgb *= body;

        // ---- ALPHA -------------------------------------------------------
        // Opaque where the water is deep enough to read as water, fading out
        // through the shoreline. Fresnel thins it a little at grazing angles,
        // which is what makes a distant stream read as a bright line rather
        // than a solid ribbon.
        float alpha = uOpacity * shore * mix( 1.0, 0.55, fresnel );
        diffuseColor.a *= clamp( alpha, 0.0, 1.0 );
      }
    `,
  );
}

/**
 * The shader sources `patchWaterShader` produces for a given option set.
 *
 * Exposed so tests can assert on the injected GLSL without a GPU.
 */
export function waterShaderSources(options: WaterMaterialOptions = {}): {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, unknown>;
} {
  const shader: WaterShaderTarget = {
    vertexShader: BASELINE_WATER_VERTEX_SHADER,
    fragmentShader: BASELINE_WATER_FRAGMENT_SHADER,
    uniforms: {},
  };
  patchWaterShader(shader, options);
  return shader;
}

/**
 * Stand-ins carrying only the chunks the patch anchors on. The patch replaces
 * the `#include` lines and leaves everything else untouched, so these need to
 * contain the anchors, not be valid shaders.
 */
const BASELINE_WATER_VERTEX_SHADER = `#include <common>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
}
`;

const BASELINE_WATER_FRAGMENT_SHADER = `#include <common>
void main() {
  #include <normal_fragment_maps>
  #include <map_fragment>
}
`;
