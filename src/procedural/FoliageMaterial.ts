/**
 * FoliageMaterial.ts - ASTRA procedural world
 * =============================================================================
 * The materials for everything `FoliageGenerator` builds. One factory, keyed by
 * kind, because the six kinds share almost everything and differ only in a
 * handful of numbers - a separate module per kind would be six places to fix
 * the same wind bug.
 *
 * Wind
 * ----
 * Displacement happens in the vertex shader, on `transformed`, weighted by how
 * far up the plant the vertex is:
 *
 *   weight = clamp( position.y / uFoliageHeight, 0, 1 )
 *
 * A gust term sweeps the whole field, and a flutter term is keyed on the
 * blade's own position so individual blades are never in lockstep - a field of
 * grass that moves as one sheet is the single most recognisable tell of a
 * cheap wind shader. The gust's phase comes from the instance's world
 * position, so neighbouring clumps are at different points of the wave.
 *
 * The weight is quadratic, so the base of a blade does not move at all. A
 * linear weight slides the whole plant sideways, and a plant that slides
 * sideways detaches from the ground it is standing on.
 *
 * Fern alpha
 * ----------
 * A fern is modelled as two crossed planes, which is a flat card until
 * something carves it. The mask does that: vertical bands from a noise sampled
 * along y alone, which is what makes the pinnae run horizontally around the
 * frond, multiplied by an outline that is bare at the base and pointed at the
 * tip, and by a radial term that keeps the shape inside the frond's own width.
 *
 * It is written into `diffuseColor.a` and discarded by Three's own
 * `alphaTest`, so the fern stays in the opaque pass and depth-sorts correctly
 * against itself and against the grass behind it.
 *
 * Per-instance tint
 * -----------------
 * `aVariation` is an instanced attribute the forest fills from
 * `FoliageInstance.variation`. It shifts the hue toward yellow-green or toward
 * a dry olive, which is what stops nine thousand blades reading as one
 * repeated asset, and it is also where the pollution near the stream shows up:
 * the bank yellows the way the dead trees grey out.
 * =============================================================================
 */

import {
  FrontSide,
  DoubleSide,
  MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  type Side,
} from 'three';
import { NOISE_GLSL } from './NoiseLibrary';
import type { FoliageKind } from './FoliageGenerator';
import { GRASS_HEIGHT, FERN_HEIGHT, FERN_WIDTH, BUSH_RADIUS } from './FoliageGenerator';

/** Cache key. Bump whenever the injected GLSL changes. */
export const FOLIAGE_MATERIAL_PROGRAM_KEY = 'astra-foliage-v2';

/**
 * Defaults for the options that are genuinely global.
 *
 * `windStrength` and `flutterStrength` are deliberately absent: they differ per
 * kind, and putting a global default in here would override every kind's own
 * number through the spread in `createFoliageMaterial`.
 */
export const DEFAULT_FOLIAGE_MATERIAL_OPTIONS = {
  noiseSeed: 0,
  cutout: 0.42,
  tintStrength: 0.55,
  corruptionStrength: 0.7,
} as const;

/** A single float uniform every foliage material can share. */
export interface SharedFloatUniform {
  value: number;
}

export interface FoliageMaterialOptions {
  /** World seed for the shader's noise. */
  noiseSeed?: number;
  /** Shared wind time, in seconds. Pass the same object to every material. */
  windUniform?: SharedFloatUniform;
  /**
   * Shared gust multiplier on the sway amplitude, the same object the tree
   * materials and the ambient audio read.
   *
   * The forest's wind is one event. If the trees bent with a gust and the
   * undergrowth did not, the ground would look calm while the canopy moved -
   * which is not a thing that happens outdoors. So the multiplier is shared
   * rather than modelled twice.
   */
  windStrengthUniform?: SharedFloatUniform;
  /** Overrides the per-kind defaults. */
  windStrength?: number;
  /** How much the high-frequency flutter contributes, relative to the gust. */
  flutterStrength?: number;
  /** Fraction of the frond the alpha mask carves away. Ferns only. */
  cutout?: number;
  /** How strongly `aVariation` shifts the tint. */
  tintStrength?: number;
  /**
   * How strongly the corruption attribute desaturates and yellows the plant.
   *
   * Zero is a no-op, which is what keeps a forest built without a corruption
   * field looking exactly as it did before this option existed.
   */
  corruptionStrength?: number;
  roughness?: number;
  metalness?: number;
}

/**
 * Per-kind defaults.
 *
 * The wind strength is a fraction of the plant's own height per gust, so a
 * blade of grass and a fern move by comparable amounts rather than one being
 * visibly stiffer than the other.
 */
const KIND_DEFAULTS: Record<
  FoliageKind,
  {
    wind: boolean;
    windStrength: number;
    flutterStrength: number;
    height: number;
    alphaTest: number;
    // `number`, not the enum member types: FrontSide and DoubleSide are the
    // literal types 2 and 1, and inferring the field from the first member
    // makes every later member a type error.
    side: Side;
    roughness: number;
    metalness: number;
  }
> = {
  grass: {
    wind: true,
    windStrength: 0.075,
    flutterStrength: 0.5,
    height: GRASS_HEIGHT,
    alphaTest: 0,
    side: DoubleSide,
    roughness: 0.78,
    metalness: 0,
  },
  fern: {
    wind: true,
    windStrength: 0.05,
    flutterStrength: 0.35,
    height: FERN_HEIGHT,
    // A hard threshold, not a blend: the frond stays in the opaque pass and
    // depth-sorts correctly against itself and against the grass behind it.
    alphaTest: 0.5,
    side: DoubleSide,
    roughness: 0.72,
    metalness: 0,
  },
  undergrowth: {
    // A bush sways far less than a blade of grass: it has a trunk's worth of
    // stiffness and none of a blade's leverage.
    wind: true,
    windStrength: 0.012,
    flutterStrength: 0.2,
    height: BUSH_RADIUS * 1.6,
    alphaTest: 0,
    side: FrontSide,
    roughness: 0.86,
    metalness: 0,
  },
  rock: {
    wind: false,
    windStrength: 0,
    flutterStrength: 0,
    height: 1,
    alphaTest: 0,
    side: FrontSide,
    roughness: 0.92,
    metalness: 0,
  },
  branch: {
    wind: false,
    windStrength: 0,
    flutterStrength: 0,
    height: 1,
    alphaTest: 0,
    side: FrontSide,
    roughness: 0.93,
    metalness: 0,
  },
  leaf: {
    wind: false,
    windStrength: 0,
    flutterStrength: 0,
    height: 1,
    alphaTest: 0,
    // Both sides: litter is two flat triangles and is seen from above and from
    // the side in the same frame.
    side: DoubleSide,
    roughness: 0.88,
    metalness: 0,
  },
};

/**
 * Build the material for one kind of foliage.
 *
 * An ordinary `MeshStandardMaterial`, so it can be inspected, disposed and
 * reasoned about like any other. The wind and the mask live in
 * `onBeforeCompile`, which is why this module also exports
 * `foliageShaderSources`: a test can drive the patch with a stub shader object
 * and assert on exactly what gets injected, with no GPU involved.
 */
export function createFoliageMaterial(
  kind: FoliageKind,
  options: FoliageMaterialOptions = {},
): MeshStandardMaterial {
  const d = KIND_DEFAULTS[kind];
  const o = { ...DEFAULT_FOLIAGE_MATERIAL_OPTIONS, ...options };
  const wind = options.windUniform ?? { value: 0 };
  const gust = options.windStrengthUniform ?? { value: 1 };

  const params: MeshStandardMaterialParameters = {
    vertexColors: true,
    roughness: o.roughness ?? d.roughness,
    metalness: o.metalness ?? d.metalness,
    // Never blended. Everything here is either opaque or alpha-tested, and
    // both keep the material out of the transparent pass.
    transparent: false,
    alphaTest: d.alphaTest,
    depthWrite: true,
    side: d.side,
  };

  const material = new MeshStandardMaterial(params);
  material.onBeforeCompile = (shader) => {
    patchFoliageShader(shader, kind, o, wind, gust);
  };
  material.customProgramCacheKey = () => `${FOLIAGE_MATERIAL_PROGRAM_KEY}-${kind}`;
  return material;
}

/** Options after defaults have been applied. Wind stays optional, per kind. */
type ResolvedOptions = Omit<FoliageMaterialOptions, 'windUniform' | 'windStrengthUniform'>;

/**
 * Patch a Three.js shader pair in place.
 *
 * Exported, and taking a plain object rather than a real shader, so the
 * injection can be unit-tested in Node.
 */
export function patchFoliageShader(
  shader: {
    vertexShader: string;
    fragmentShader: string;
    uniforms: Record<string, unknown>;
  },
  kind: FoliageKind,
  options: ResolvedOptions,
  wind: SharedFloatUniform = { value: 0 },
  gust: SharedFloatUniform = { value: 1 },
): void {
  const d = KIND_DEFAULTS[kind];

  shader.uniforms.uNoiseSeed = { value: options.noiseSeed };
  shader.uniforms.uFoliageHeight = { value: d.height };
  shader.uniforms.uWindTime = wind;
  shader.uniforms.uWindStrength = { value: options.windStrength ?? d.windStrength };
  shader.uniforms.uWindGust = gust;
  shader.uniforms.uFlutterStrength = { value: options.flutterStrength ?? d.flutterStrength };
  shader.uniforms.uFoliageTint = { value: options.tintStrength };
  shader.uniforms.uFoliageCorruption = { value: options.corruptionStrength ?? 0 };
  shader.uniforms.uFoliageCutout = { value: options.cutout };

  /* ---------------------------------------------------------------- vertex */

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      attribute float aVariation;
      ${kind === 'rock' ? '' : 'attribute float corruption;'}
      varying float vAstraVariation;
      ${kind === 'rock' ? '' : 'varying float vAstraCorruption;'}
      // Object-space position, captured BEFORE the wind moves it. The fern
      // mask has to be anchored to the frond's own shape, not to wherever the
      // wind has swung it this frame, or the mask would slide across the
      // frond as it swayed.
      varying vec3 vAstraFoliageObject;
      uniform float uWindTime;
      uniform float uWindStrength;
      uniform float uWindGust;
      uniform float uFlutterStrength;
      uniform float uFoliageHeight;
      ${NOISE_GLSL}

      // Horizontal wind offset for one vertex.
      //
      // w is 0 at the plant's base and 1 at its tip, so a quadratic weight
      // leaves the base exactly where it is. A linear weight slides the whole
      // plant sideways and detaches it from the ground.
      vec2 astraFoliageWind( vec3 objectPos, vec3 instanceOrigin, float time ) {
        float w = clamp( objectPos.y / max( uFoliageHeight, 1e-4 ), 0.0, 1.0 );

        // The gust: one broad wave travelling across the world. Phased on the
        // instance origin, so two clumps standing next to each other are at
        // different points of it and never swing together.
        vec2 phase = instanceOrigin.xz * 0.055;
        vec2 gustDir = vec2(
          astraSimplex2D( phase + vec2( time * 0.32, 0.0 ), 3.0 ),
          astraSimplex2D( phase + vec2( time * 0.32, 19.0 ), 8.0 )
        );
        float gust = uWindStrength * uWindGust * ( w * w * 0.75 + w * 0.25 );

        // The flutter: high frequency, keyed on the blade's own position, so
        // each blade has its own. Without it the field moves as one sheet.
        float flutter = astraSimplex2D(
          objectPos.xz * 7.0 + vec2( time * 1.7, time * 1.1 ), 7.0
        );
        float flutterAmp = uWindStrength * uWindGust * uFlutterStrength * w * w * flutter;

        return gustDir * ( gust + flutterAmp );
      }
    `,
  );

  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    /* glsl */ `
      #include <begin_vertex>
      vAstraVariation = aVariation;
      vAstraCorruption = corruption;
      vAstraFoliageObject = transformed;

      {
        // Where this instance stands in the world. For an InstancedMesh the
        // instance carries the translation and modelMatrix carries the mesh's
        // own; for a plain Mesh instanceMatrix does not exist and the mesh's
        // own matrix is the whole answer.
        vec3 instanceOrigin = modelMatrix[ 3 ].xyz;
        #ifdef USE_INSTANCING
          instanceOrigin += instanceMatrix[ 3 ].xyz;
        #endif

        vec2 offset = astraFoliageWind( position, instanceOrigin, uWindTime );
        transformed.x += offset.x;
        transformed.z += offset.y;
        // The tip also drops a little as it swings. Without this the plant
        // stretches as it leans, and a blade that grows a centimetre every
        // gust is worse than one that does not move at all.
        transformed.y -= length( offset ) * 0.3;
      }
    `,
  );

  /* -------------------------------------------------------------- fragment */

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      varying float vAstraVariation;
      ${kind === 'rock' ? '' : 'varying float vAstraCorruption;'}
      varying vec3 vAstraFoliageObject;
      uniform float uNoiseSeed;
      uniform float uFoliageCutout;
      uniform float uFoliageTint;
      uniform float uFoliageHeight;
      uniform float uFoliageCorruption;

      ${NOISE_GLSL}
      ${
        kind === 'fern'
          ? `
      // Fern mask: vertical bands for the pinnae, an outline for the frond.
      //
      // The bands are sampled along y ALONE. Sampling in two dimensions gives
      // blobs, and blobs are foam balls rather than a fern.
      //
      // Declared only for ferns: an unused function still has to be compiled
      // and inlined by the driver, and five of the six kinds would pay for it.
      float astraFernMask( vec3 p, float halfWidth ) {
        float h = clamp( p.y / max( uFoliageHeight, 1e-4 ), 0.0, 1.0 );
        float bands = astraSimplex2D( vec2( h * 22.0, 0.0 ), uNoiseSeed + 2.0 ) * 0.5 + 0.5;
        // Bare at the base where the stem is, and pointed at the tip.
        float outline = smoothstep( 0.0, 0.16, h ) * ( 1.0 - smoothstep( 0.82, 1.0, h ) );
        // Radial, so both crossed planes are trimmed by the same width: |x|
        // alone would leave one plane untouched and the other a sliver.
        float side = 1.0 - smoothstep( 0.55, 1.0, length( p.xz ) / max( halfWidth, 1e-4 ) );
        return clamp( bands * 0.6 + outline * side * 0.55, 0.0, 1.0 );
      }`
          : ''
      }
    `,
  );

  // Tint and mask. `diffuseColor` already holds the vertex colour, so the tint
  // multiplies into it rather than replacing it.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    /* glsl */ `
      #include <map_fragment>

      {
        // Per-instance tint: toward a yellow-green at one end and a dry olive
        // at the other. This is also where the polluted bank shows up, because
        // the scatter raises the variation there.
        // Strength 0 has to be exactly a no-op, so the tint is mixed against
        // white rather than scaled: a strength of zero must leave the vertex
        // colour alone, and scaling a tint by zero is not the same as white.
        float v = clamp( vAstraVariation, 0.0, 1.0 );
        vec3 fresh = vec3( 0.86, 1.04, 0.74 );
        vec3 dry = vec3( 1.10, 0.96, 0.58 );
        vec3 tint = mix( vec3( 1.0 ), mix( fresh, dry, v ), uFoliageTint );
        diffuseColor.rgb *= tint;

        ${
          kind === 'rock'
            ? ''
            : `// The plan's "vegetation: desaturated, yellowed leaf color".
        //
        // The rock is excluded on purpose: a stone does not die, and a grey
        // boulder in the middle of a rotten bank reads as a lighting bug. Dead
        // wood is included - a fallen branch rots like everything else.
        //
        // Toward the plant's own luma and then toward a yellow cast, which is
        // the same two steps the bark and the canopy take and with the same
        // luma weights, so a blade of grass, a trunk and a patch of ground all
        // go over by the same amount in the same frame.
        float c = clamp( vAstraCorruption, 0.0, 1.0 ) * uFoliageCorruption;
        if ( c > 0.001 ) {
          float luma = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          vec3 sick = vec3( luma * 1.18, luma * 1.0, luma * 0.5 );
          diffuseColor.rgb = mix( diffuseColor.rgb, sick, c );
        }`
        }

        ${kind === 'fern' ? `{
          // Biased before thresholding: the raw mask is near zero at the base
          // and the tip, and an unbiased threshold would discard the whole
          // frond rather than trimming it.
          float mask = astraFernMask( vAstraFoliageObject, ${(FERN_WIDTH * 0.5).toFixed(4)} );
          diffuseColor.a = smoothstep( 1.0 - uFoliageCutout, 1.0 - uFoliageCutout + 0.14, mask );
        }` : ''}
      }
    `,
  );
}

/**
 * The shader sources `patchFoliageShader` produces for a given kind and option
 * set. Exposed so tests can assert on the injected GLSL without a GPU.
 */
export function foliageShaderSources(
  kind: FoliageKind,
  options: FoliageMaterialOptions = {},
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
  patchFoliageShader(
    shader,
    kind,
    { ...DEFAULT_FOLIAGE_MATERIAL_OPTIONS, ...options },
    options.windUniform,
    options.windStrengthUniform,
  );
  return shader;
}

/**
 * Stand-ins carrying only the chunks the patch anchors on. The patch replaces
 * the `#include` lines and leaves everything else untouched, so these need to
 * contain the anchors, not be valid shaders.
 */
const BASELINE_VERTEX_SHADER = `#include <common>
void main() {
  #include <beginnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
}
`;

const BASELINE_FRAGMENT_SHADER = `#include <common>
varying vec3 vAstraFoliageObject;
void main() {
  vec4 diffuseColor = vec4( 1.0 );
  #include <map_fragment>
}
`;
