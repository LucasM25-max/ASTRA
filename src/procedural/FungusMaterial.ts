/**
 * FungusMaterial.ts - ASTRA procedural world
 * =============================================================================
 * The materials for everything `FungusGenerator` builds. One factory keyed by
 * kind, for the same reason `FoliageMaterial` is one factory keyed by kind: the
 * five shapes share almost everything and differ in a handful of numbers, and a
 * separate module per kind would be five places to fix the same bug.
 *
 * What the corruption has to look like
 * ------------------------------------
 * The style guide's rule is "corruption progression: subtle, visible, severe,
 * gradual not sudden", and the plan asks for "sickly green/purple, emissive
 * glow". Those pull in opposite directions and the resolution is that the glow
 * is *patchy and low*, not a uniform aura:
 *
 *   pods      the only kind with a real emissive term. A spore pod is the one
 *             thing in the fouled stream that makes its own light, and the
 *             plan calls for "glowing spores" and "unnatural lighting" in the
 *             inner zone. The glow is a rim - strongest where the globe is
 *             seen edge-on - so a pod reads as a lit droplet rather than as a
 *             lightbulb, and it is modulated by noise so a cluster of them
 *             pulses unevenly instead of blinking in unison.
 *   mushrooms a much weaker version of the same rim, and the gills.
 *   shelves   no glow at all. A bracket on a trunk is dead tissue; giving it
 *             the pods' emission would make the whole inner zone look like a
 *             fairground, and the plan's "enormous fungal structures" are
 *             meant to be lit *by* the pods, not to be lamps themselves.
 *
 * Gills
 * -----
 * A mushroom cap is a revolved surface, so it has no UV to hang a gill pattern
 * on and the underside would otherwise be a smooth bowl. The pattern is radial
 * lines in object space - `atan(z, x)` quantised - applied only where the
 * object normal points down. Sampling the angle rather than the position is
 * what makes the lines radiate from the stalk; sampling `xz` directly would
 * give concentric rings, which is a target rather than a mushroom.
 *
 * Per-instance tint
 * -----------------
 * `aVariation` shifts each instance between the sickly green and the bruised
 * purple. Without it a patch of three hundred mushrooms is one colour, which
 * is the repeated-asset tell the style guide exists to avoid.
 * =============================================================================
 */

import {
  FrontSide,
  MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  type Side,
} from 'three';
import { NOISE_GLSL } from './NoiseLibrary';
import type { FungusKind } from './FungusGenerator';

/** Cache key. Bump whenever the injected GLSL changes. */
export const FUNGUS_MATERIAL_PROGRAM_KEY = 'astra-fungus-v1';

/**
 * Defaults for the options that are genuinely global.
 *
 * `windStrength`, `flutterStrength` and `glowStrength` are deliberately
 * absent: they differ per kind, and a global default here would override every
 * kind's own number through the spread in `createFungusMaterial`. That exact
 * bug is what the foliage material's own comment warns about.
 */
export const DEFAULT_FUNGUS_MATERIAL_OPTIONS = {
  noiseSeed: 0,
  /** How strongly `aVariation` shifts the tint. */
  tintStrength: 0.6,
  /** How many gill lines radiate from a mushroom's stalk. */
  gillCount: 26,
} as const;

/** A single float uniform every fungus material can share. */
export interface SharedFloatUniform {
  value: number;
}

export interface FungusMaterialOptions {
  /** World seed for the shader's noise. */
  noiseSeed?: number;
  /** Shared wind time, in seconds. Pass the same object to every material. */
  windUniform?: SharedFloatUniform;
  /** Overrides the per-kind defaults. */
  windStrength?: number;
  /** How much the high-frequency flutter contributes, relative to the gust. */
  flutterStrength?: number;
  /** How strongly `aVariation` shifts the tint. */
  tintStrength?: number;
  /** Gill lines around a mushroom cap. */
  gillCount?: number;
  roughness?: number;
  metalness?: number;
}

/**
 * Per-kind defaults.
 *
 * `wind` gates the whole wind block, including the noise it evaluates: a rock
 * and a dead fish should not pay for a vertex shader they do not use.
 */
const KIND_DEFAULTS: Record<
  FungusKind,
  {
    wind: boolean;
    windStrength: number;
    flutterStrength: number;
    /** Height the wind weight is measured against, in metres. */
    height: number;
    /** Rim-glow strength. Zero for everything but the pods and the caps. */
    glow: number;
    /** How tight the rim is. Higher is a thinner, hotter edge. */
    glowPower: number;
    /** Radial gill lines on a downward-facing surface. */
    gills: boolean;
    alphaTest: number;
    // `number`, not the enum member types: FrontSide is the literal type 2,
    // and inferring the field from the first member makes every later member a
    // type error.
    side: Side;
    roughness: number;
    metalness: number;
  }
> = {
  mushroom: {
    // A mushroom is low and stiff. It moves, but it moves like something with
    // a base, not like a blade of grass.
    wind: true,
    windStrength: 0.014,
    flutterStrength: 0.4,
    height: 0.34,
    glow: 0.05,
    glowPower: 3.0,
    gills: true,
    alphaTest: 0,
    side: FrontSide,
    // Slightly moist: fungus is the one organic thing in the forest that is
    // not dry, and a matte cap reads as felt.
    roughness: 0.68,
    metalness: 0,
  },
  shelf: {
    // A bracket is attached to a trunk along its whole root. It does not sway.
    wind: false,
    windStrength: 0,
    flutterStrength: 0,
    height: 1,
    glow: 0,
    glowPower: 3,
    gills: false,
    alphaTest: 0,
    side: FrontSide,
    roughness: 0.84,
    metalness: 0,
  },
  pod: {
    // A pod nods on a thin stalk, which is the one place in the corruption
    // where the wind is visible as motion rather than as shimmer.
    wind: true,
    windStrength: 0.05,
    flutterStrength: 0.8,
    height: 0.14,
    // The only real emissive term in the forest. Small, because "glowing
    // spores" is a mood and a lightbulb is a prop.
    glow: 0.55,
    glowPower: 2.2,
    gills: false,
    alphaTest: 0,
    side: FrontSide,
    roughness: 0.55,
    metalness: 0,
  },
  carrion: {
    wind: false,
    windStrength: 0,
    flutterStrength: 0,
    height: 1,
    glow: 0,
    glowPower: 3,
    gills: false,
    alphaTest: 0,
    // Both sides would be right here, but the fish is a closed shell and
    // lying on the ground: the underside is never visible, and half the
    // fragments is half the cost.
    side: FrontSide,
    roughness: 0.9,
    metalness: 0,
  },
  rot: {
    wind: false,
    windStrength: 0,
    flutterStrength: 0,
    height: 1,
    glow: 0,
    glowPower: 3,
    gills: false,
    alphaTest: 0,
    side: FrontSide,
    roughness: 0.95,
    metalness: 0,
  },
};

/**
 * Build the material for one kind of corruption geometry.
 *
 * An ordinary `MeshStandardMaterial`, so it can be inspected, disposed and
 * reasoned about like any other. The wind, the gills and the glow live in
 * `onBeforeCompile`, which is why this module also exports
 * `fungusShaderSources`: a test can drive the patch with a stub shader object
 * and assert on exactly what gets injected, with no GPU involved.
 */
export function createFungusMaterial(
  kind: FungusKind,
  options: FungusMaterialOptions = {},
): MeshStandardMaterial {
  const d = KIND_DEFAULTS[kind];
  const o = { ...DEFAULT_FUNGUS_MATERIAL_OPTIONS, ...options };
  const wind = options.windUniform ?? { value: 0 };

  const params: MeshStandardMaterialParameters = {
    vertexColors: true,
    roughness: o.roughness ?? d.roughness,
    metalness: o.metalness ?? d.metalness,
    // Never blended. Everything here is opaque: a mushroom and a bracket are
    // solid, and the glow is emissive rather than transparent.
    transparent: false,
    alphaTest: d.alphaTest,
    depthWrite: true,
    side: d.side,
  };

  const material = new MeshStandardMaterial(params);
  material.onBeforeCompile = (shader) => {
    patchFungusShader(shader, kind, o, wind);
  };
  material.customProgramCacheKey = () => `${FUNGUS_MATERIAL_PROGRAM_KEY}-${kind}`;
  return material;
}

/** Options after defaults have been applied. Wind stays optional, per kind. */
type ResolvedOptions = Omit<FungusMaterialOptions, 'windUniform'>;

/**
 * Patch a Three.js shader pair in place.
 *
 * Exported, and taking a plain object rather than a real shader, so the
 * injection can be unit-tested in Node. A mistyped `#include` anchor fails
 * silently on a GPU and produces a black mushroom, which is the failure mode
 * this exists to catch.
 */
/** The two varyings the gill pattern reads, declared together or not at all. */
const OBJECT_VARYINGS = 'varying vec3 vAstraObject;\n      varying vec3 vAstraObjectNormal;';

export function patchFungusShader(
  shader: {
    vertexShader: string;
    fragmentShader: string;
    uniforms: Record<string, unknown>;
  },
  kind: FungusKind,
  options: ResolvedOptions,
  wind: SharedFloatUniform = { value: 0 },
): void {
  const d = KIND_DEFAULTS[kind];

  // Which varyings the fragment shader needs. The gills read the object-space
  // position and normal; the glow reads the instance's world origin, because a
  // pulse keyed on the pod's own local coordinates would be the same for every
  // pod in the world - a globe four centimetres across spans almost no noise.
  const needsObject = d.gills;
  const needsOrigin = d.glow > 0;

  shader.uniforms.uNoiseSeed = { value: options.noiseSeed };
  shader.uniforms.uWindTime = wind;
  shader.uniforms.uWindStrength = { value: options.windStrength ?? d.windStrength };
  shader.uniforms.uFlutterStrength = { value: options.flutterStrength ?? d.flutterStrength };
  shader.uniforms.uFungusHeight = { value: d.height };
  shader.uniforms.uFungusTint = { value: options.tintStrength };
  shader.uniforms.uFungusGlow = { value: d.glow };
  shader.uniforms.uFungusGlowPower = { value: d.glowPower };
  shader.uniforms.uFungusGills = { value: options.gillCount };

  /* ---------------------------------------------------------------- vertex */

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      attribute float aVariation;
      varying float vAstraVariation;
      ${needsOrigin ? 'varying vec3 vAstraOrigin;' : ''}
      uniform float uWindTime;
      uniform float uWindStrength;
      uniform float uFlutterStrength;
      uniform float uFungusHeight;
      ${d.wind ? `${NOISE_GLSL}

      // Horizontal wind offset for one vertex.
      //
      // w is 0 at the base and 1 at the tip, so a quadratic weight leaves the
      // base exactly where it is. A linear weight slides the whole thing
      // sideways and detaches it from the ground.
      //
      // Declared only for the kinds that move: an unused function still has to
      // be compiled and inlined by the driver, and three of the five kinds
      // would pay for it.
      vec2 astraFungusWind( vec3 objectPos, vec3 instanceOrigin, float time ) {
        float w = clamp( objectPos.y / max( uFungusHeight, 1e-4 ), 0.0, 1.0 );
        vec2 phase = instanceOrigin.xz * 0.09;
        vec2 gustDir = vec2(
          astraSimplex2D( phase + vec2( time * 0.24, 0.0 ), 3.0 ),
          astraSimplex2D( phase + vec2( time * 0.24, 19.0 ), 8.0 )
        );
        float gust = uWindStrength * ( w * w * 0.8 + w * 0.2 );
        float flutter = astraSimplex2D(
          objectPos.xz * 11.0 + vec2( time * 1.4, time * 0.9 ), 7.0
        );
        float flutterAmp = uWindStrength * uFlutterStrength * w * w * flutter;
        return gustDir * ( gust + flutterAmp );
      }` : ''}
    `,
  );

  // Where this instance stands in the world. For an InstancedMesh the instance
  // carries the translation and modelMatrix carries the mesh's own; for a plain
  // Mesh instanceMatrix does not exist and the mesh's own matrix is the whole
  // answer.
  //
  // Written into a local rather than inlined into the wind call's argument
  // list: a preprocessor directive inside an expression is textually legal but
  // it defeats every GLSL parser that is not a real driver, which makes the
  // injection untestable - and an untestable shader patch is exactly the kind
  // of thing that breaks silently on a GPU.
  const originLines = `
        vec3 astraOrigin = modelMatrix[ 3 ].xyz;
        #ifdef USE_INSTANCING
          astraOrigin += instanceMatrix[ 3 ].xyz;
        #endif
        ${needsOrigin ? 'vAstraOrigin = astraOrigin;' : ''}
      `;

  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    /* glsl */ `
      #include <begin_vertex>
      vAstraVariation = aVariation;
      ${originLines}
      ${
        d.wind
          ? `{
          vec2 offset = astraFungusWind( position, astraOrigin, uWindTime );
          transformed.x += offset.x;
          transformed.z += offset.y;
          // The tip drops as it swings. Without this the pod stretches as it
          // leans, and a stalk that grows a centimetre every gust is worse
          // than one that does not move at all.
          transformed.y -= length( offset ) * 0.3;
        }`
          : ''
      }
    `,
  );

  // The gills need the object-space position and normal. Both are captured
  // after `<beginnormal_vertex>` and `<begin_vertex>` have defined their
  // inputs, and BEFORE the wind moves anything: the gill pattern is anchored to
  // the mushroom's own shape, not to wherever the wind has swung it.
  if (needsObject) {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      /* glsl */ `
        #include <beginnormal_vertex>
        vAstraObject = transformed;
        vAstraObjectNormal = objectNormal;
      `,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      /* glsl */ `
        #include <common>
        varying vec3 vAstraObject;
        varying vec3 vAstraObjectNormal;
      `,
    );
  }

  /* -------------------------------------------------------------- fragment */

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      varying float vAstraVariation;
      ${needsOrigin ? 'varying vec3 vAstraOrigin;' : ''}
      ${needsObject ? OBJECT_VARYINGS : ''}
      uniform float uNoiseSeed;
      uniform float uFungusTint;
      uniform float uFungusGlow;
      uniform float uFungusGlowPower;
      uniform float uFungusGills;
      ${needsOrigin ? 'uniform float uWindTime;' : ''}

      ${NOISE_GLSL}
      ${
        needsObject
          ? `
      // Radial gill lines, in object space.
      //
      // atan(z, x) rather than a sample of xz: the lines have to radiate from
      // the stalk, and a position sample gives concentric rings instead -
      // which is a target rather than a mushroom.
      //
      // Only applied where the surface faces DOWN. A cap seen from above is a
      // smooth dome and should stay one; the gills are the part the player
      // sees when they crouch, which is exactly when they should be there.
      float astraFungusGills( vec3 p, vec3 n, float count ) {
        if ( n.y > -0.15 ) return 1.0;
        float angle = atan( p.z, p.x );
        // A second, slower modulation so the lines are not perfectly even:
        // real gills fork and thin out toward the rim.
        float wobble = astraSimplex2D( vec2( angle * 3.0, 0.0 ), uNoiseSeed + 4.0 ) * 0.5 + 0.5;
        float lines = abs( sin( angle * count * 0.5 + wobble * 1.7 ) );
        float depth = smoothstep( 0.0, 0.35, lines );
        // Fade out near the stalk, where the gills converge and would alias
        // into a solid dot.
        float radius = length( p.xz );
        return mix( 0.55, 1.0, smoothstep( 0.0, 0.09, radius ) * depth + 0.25 );
      }`
          : ''
      }
    `,
  );

  // Tint, gills and alpha. `diffuseColor` already holds the vertex colour, so
  // the tint multiplies into it rather than replacing it.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    /* glsl */ `
      #include <map_fragment>

      {
        // Per-instance tint: between the sickly green and the bruised purple.
        // Mixed against white rather than scaled, so a strength of zero is
        // exactly a no-op: scaling a tint by zero is not the same as leaving
        // the vertex colour alone.
        float v = clamp( vAstraVariation, 0.0, 1.0 );
        vec3 sickly = vec3( 0.88, 1.06, 0.72 );
        vec3 bruised = vec3( 1.06, 0.80, 1.02 );
        vec3 tint = mix( vec3( 1.0 ), mix( sickly, bruised, v ), uFungusTint );
        diffuseColor.rgb *= tint;

        ${
          needsObject
            ? `{
          // The gills darken the surface where they are, so the underside
          // reads as ridged rather than as painted stripes.
          float gills = astraFungusGills( vAstraObject, vAstraObjectNormal, uFungusGills );
          diffuseColor.rgb *= gills;
        }`
            : ''
        }
      }
    `,
  );

  // The rim glow. This runs at `<normal_fragment_maps>` rather than at
  // `<map_fragment>` because `normal` and `vViewPosition` do not exist until
  // `<normal_fragment_begin>` has run, and the rim is a function of both.
  if (needsOrigin) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
        #include <normal_fragment_maps>

        {
          // vViewPosition points from the fragment toward the eye, so this is
          // 1 head-on and 0 edge-on.
          vec3 viewDir = normalize( vViewPosition );
          float facing = abs( dot( normal, viewDir ) );
          float rim = pow( clamp( 1.0 - facing, 0.0, 1.0 ), uFungusGlowPower );
          // Modulated by noise keyed on where the pod stands in the world, so
          // a cluster of them pulses unevenly instead of blinking in unison.
          float pulse = astraSimplex2D(
            vAstraOrigin.xz * 0.09 + vec2( uWindTime * 0.21, uWindTime * 0.13 ),
            uNoiseSeed + 9.0
          ) * 0.5 + 0.5;
          // The glow takes the surface's own hue, so a purple pod glows purple
          // and a green one green. A fixed glow colour would flatten the
          // palette the vertex colours are carrying.
          totalEmissiveRadiance += diffuseColor.rgb * rim * uFungusGlow * ( 0.45 + 0.55 * pulse );
        }
      `,
    );
  }
}

/**
 * The shader sources `patchFungusShader` produces for a given kind and option
 * set. Exposed so tests can assert on the injected GLSL without a GPU.
 */
export function fungusShaderSources(
  kind: FungusKind,
  options: FungusMaterialOptions = {},
): {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, unknown>;
} {
  const shader = {
    vertexShader: BASELINE_VERTEX_SHADER,
    fragmentShader: BASELINE_FRAGMENT_SHADER,
    uniforms: {} as Record<string, unknown>,
  };
  patchFungusShader(
    shader,
    kind,
    { ...DEFAULT_FUNGUS_MATERIAL_OPTIONS, ...options },
    options.windUniform,
  );
  return shader;
}

/**
 * Stand-ins carrying only the chunks the patch anchors on. The patch replaces
 * the `#include` lines and leaves everything else untouched, so these need to
 * contain the anchors, not be valid shaders.
 *
 * The real standard-material fragment shader declares `vViewPosition` before
 * `<map_fragment>`, which is why it appears here too: the glow block reads it,
 * and a baseline that omitted it would let a missing declaration through.
 * `vAstraObject` is declared by the patch itself for the kinds with gills.
 */
const BASELINE_VERTEX_SHADER = `#include <common>
void main() {
  #include <beginnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
}
`;

const BASELINE_FRAGMENT_SHADER = `#include <common>
varying vec3 vViewPosition;
varying vec3 vNormal;
void main() {
  vec4 diffuseColor = vec4( 1.0 );
  vec3 totalEmissiveRadiance = vec3( 0.0 );
  float faceDirection = 1.0;
  vec3 normal = vec3( 0.0, 1.0, 0.0 );
  #include <map_fragment>
  #include <normal_fragment_begin>
  #include <normal_fragment_maps>
}
`;
