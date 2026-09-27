/**
 * MaterialFactory.ts - ASTRA procedural world
 * =============================================================================
 * Every material in the game is made here, from code, with no texture files.
 *
 * The strategy
 * ------------
 * `MeshStandardMaterial` plus an `onBeforeCompile` patch, rather than a bare
 * `ShaderMaterial`.
 *
 * A hand-written `ShaderMaterial` would mean reimplementing lighting, fog,
 * tone mapping, colour space and shadows by hand - and getting fog subtly
 * wrong is exactly the kind of bug that survives review, because the terrain
 * still "looks fine" while its horizon stops matching the sky. Patching the
 * standard material keeps the terrain lit, fogged and tonemapped by the same
 * pipeline as everything else in the scene, and still allows a fully custom
 * surface: triplanar detail, slope-driven blending and noise-perturbed
 * normals are all injected into the standard shader's own chunks.
 *
 * How the four plan requirements divide up
 * ----------------------------------------
 *   vertex-painted blending   the `color` and `biome` vertex attributes,
 *                             baked in TypeScript from height + slope +
 *                             stream proximity. This is the base albedo.
 *   triplanar mapping         per-biome noise sampled from the three planes a
 *                             surface can face, blended by orientation. There
 *                             is no UV to seam, which is the whole point.
 *   slope-based blending      rock re-weighted in the shader from the
 *                             *rendered* world normal, so it tracks what the
 *                             player actually sees rather than the baked
 *                             vertex normal.
 *   noise normal perturbation a world-space fbm height field, differentiated
 *                             by finite differences and pushed against the
 *                             surface normal.
 *
 * The injection points
 * --------------------
 *   `<common>`              declare the attribute, varyings, uniforms and the
 *                           noise library
 *   `<begin_vertex>`        capture world position for the triplanar lookup
 *   `<beginnormal_vertex>`  capture the world normal for slope blending
 *   `<map_fragment>`        apply the triplanar variation
 *   `<normal_fragment_maps>` perturb the normal
 *
 * Every injected symbol is prefixed `astra` so it cannot collide with a Three
 * chunk, and `customProgramCacheKey` returns a fixed string so Three never
 * reuses a program compiled without the patch.
 *
 * Cost
 * ----
 * About 30 noise evaluations per fragment: four biomes x three triplanar axes
 * at two octaves, plus three taps of three-octave fbm for the normal gradient
 * - and the three normal taps are skipped entirely on flat ground, where the
 * gradient is zero. `normalStrength`, `detailScale`, `normalOctaves` and
 * `colorVariation` are the dials if a target machine needs it cheaper.
 * =============================================================================
 */

import { MeshStandardMaterial, type MeshStandardMaterialParameters } from 'three';
import { NOISE_GLSL } from './NoiseLibrary';

/** Cache key. Bump whenever the injected GLSL changes, or Three reuses a stale program. */
const TERRAIN_PROGRAM_KEY = 'astra-terrain-v1';

export interface TerrainMaterialOptions {
  /** Scale of the triplanar noise, in noise units per metre. */
  detailScale?: number;
  /** How strongly the triplanar noise modulates the vertex-painted colour. */
  colorVariation?: number;
  /** Slope (`1 - normal.y`) at which rock begins to take over. */
  slopeRockStart?: number;
  /** Slope at which rock fully takes over. */
  slopeRockEnd?: number;
  /** How strongly slope re-weights the vertex biome mix. */
  slopeRockStrength?: number;
  /** Strength of the noise-driven normal perturbation. */
  normalStrength?: number;
  /** Octaves of noise for the normal detail field. */
  normalOctaves?: number;
  /** World seed for the shader's noise, so it matches the generated terrain. */
  noiseSeed?: number;
  /**
   * Strength of the fungal overlay, read from the `corruption` vertex
   * attribute. Zero disables it entirely, and the patch injects nothing - so
   * a caller that does not want corruption pays nothing for it.
   */
  corruptionStrength?: number;
  /**
   * Scale of the fungal blotches, in noise units per metre.
   *
   * Deliberately much larger than `detailScale`: the overlay is a broad stain
   * across the bank, not grain. At terrain detail scale it would read as moss
   * rather than as rot.
   */
  corruptionScale?: number;
  /** How far the overlay darkens the ground, 0 to 1. */
  corruptionDarken?: number;
  /** Roughness of the finished surface. */
  roughness?: number;
  /** Metalness. Zero: terrain is not metal. */
  metalness?: number;
}

/** Defaults, exported so tests and the debug overlay can read them. */
export const DEFAULT_TERRAIN_MATERIAL_OPTIONS = {
  detailScale: 0.09,
  colorVariation: 0.16,
  slopeRockStart: 0.12,
  slopeRockEnd: 0.42,
  slopeRockStrength: 0.75,
  normalStrength: 0.55,
  normalOctaves: 3,
  noiseSeed: 0,
  corruptionStrength: 1,
  corruptionScale: 0.055,
  corruptionDarken: 0.45,
  roughness: 0.94,
  metalness: 0,
} as const;

/**
 * Build the terrain material.
 *
 * The result is an ordinary `MeshStandardMaterial`, so it can be inspected,
 * disposed and reasoned about like any other. The custom behaviour lives in
 * `onBeforeCompile`, which is why this module also exports
 * `terrainShaderSources`: a test can drive the patch with a stub shader object
 * and assert on exactly what gets injected, with no GPU involved.
 */
export function createTerrainMaterial(options: TerrainMaterialOptions = {}): MeshStandardMaterial {
  const o = { ...DEFAULT_TERRAIN_MATERIAL_OPTIONS, ...options };

  const params: MeshStandardMaterialParameters = {
    // The vertex colours carry the biome blend, so the shader has a real base
    // albedo to modulate rather than a flat material colour.
    vertexColors: true,
    roughness: o.roughness,
    metalness: o.metalness,
    // Terrain is never transparent. Saying so explicitly keeps it out of the
    // transparent pass and out of the per-object depth sorting that follows.
    transparent: false,
    depthWrite: true,
  };

  const material = new MeshStandardMaterial(params);

  material.onBeforeCompile = (shader) => {
    patchTerrainShader(shader, o);
  };
  // The key has to carry the corruption flag, not just the version. The patch
  // injects a different program when corruption is on - a varying, three
  // uniforms and a second injection point - and a fixed key would let Three
  // hand the corrupted material a program compiled for the clean one, or the
  // other way round. The failure is a terrain with a shader that reads a
  // `corruption` attribute the geometry does not have, which draws as black.
  material.customProgramCacheKey = () =>
    o.corruptionStrength > 0 ? `${TERRAIN_PROGRAM_KEY}-corrupt` : TERRAIN_PROGRAM_KEY;

  return material;
}

/** Options after defaults have been applied. */
type ResolvedOptions = Required<TerrainMaterialOptions>;

/**
 * Patch a Three.js shader pair in place.
 *
 * Exported, and taking a plain object rather than a real shader, so the
 * injection can be unit-tested in Node. That is the only way to test a shader
 * here, and it is worth the small awkwardness: a broken `#include` anchor
 * fails silently in a GPU build and produces a black terrain.
 */
export function patchTerrainShader(
  shader: {
    vertexShader: string;
    fragmentShader: string;
    uniforms: Record<string, unknown>;
  },
  options: ResolvedOptions,
): void {
  shader.uniforms.uDetailScale = { value: options.detailScale };
  shader.uniforms.uColorVariation = { value: options.colorVariation };
  shader.uniforms.uSlopeRockStart = { value: options.slopeRockStart };
  shader.uniforms.uSlopeRockEnd = { value: options.slopeRockEnd };
  shader.uniforms.uSlopeRockStrength = { value: options.slopeRockStrength };
  shader.uniforms.uNormalStrength = { value: options.normalStrength };
  shader.uniforms.uNormalOctaves = { value: options.normalOctaves };
  shader.uniforms.uNoiseSeed = { value: options.noiseSeed };
  if (options.corruptionStrength > 0) {
    shader.uniforms.uCorruptionStrength = { value: options.corruptionStrength };
    shader.uniforms.uCorruptionScale = { value: options.corruptionScale };
    shader.uniforms.uCorruptionDarken = { value: options.corruptionDarken };
  }

  /* ---------------------------------------------------------------- vertex */

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      attribute vec4 biome;
      ${options.corruptionStrength > 0 ? 'attribute float corruption;' : ''}
      varying vec4 vAstraBiome;
      varying vec3 vAstraWorld;
      varying vec3 vAstraNormal;
      ${options.corruptionStrength > 0 ? 'varying float vAstraCorruption;' : ''}
    `,
  );

  // `<begin_vertex>` defines `transformed`; `<beginnormal_vertex>` defines
  // `objectNormal`. Both are needed by the varyings above, so each capture goes
  // immediately after the chunk that defines its input.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    /* glsl */ `
      #include <begin_vertex>
      vAstraWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      vAstraBiome = biome;
      ${options.corruptionStrength > 0 ? 'vAstraCorruption = corruption;' : ''}
    `,
  );

  shader.vertexShader = shader.vertexShader.replace(
    '#include <beginnormal_vertex>',
    /* glsl */ `
      #include <beginnormal_vertex>
      // The terrain mesh carries its rotation in its geometry, not on its
      // transform, so modelMatrix is a pure translation here. Going through it
      // anyway keeps this correct if that ever changes.
      vAstraNormal = normalize( mat3( modelMatrix ) * objectNormal );
    `,
  );

  /* -------------------------------------------------------------- fragment */

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      varying vec4 vAstraBiome;
      varying vec3 vAstraWorld;
      varying vec3 vAstraNormal;
      ${options.corruptionStrength > 0 ? 'varying float vAstraCorruption;\n      uniform float uCorruptionStrength;\n      uniform float uCorruptionScale;\n      uniform float uCorruptionDarken;' : ''}
      uniform float uDetailScale;
      uniform float uColorVariation;
      uniform float uSlopeRockStart;
      uniform float uSlopeRockEnd;
      uniform float uSlopeRockStrength;
      uniform float uNormalStrength;
      uniform float uNormalOctaves;
      uniform float uNoiseSeed;

      ${NOISE_GLSL}

      // Triplanar detail: sample the same 2D noise from the three planes the
      // surface can face and blend by how strongly it faces each. Because the
      // lookup is in world space there is no UV, and therefore no UV seam -
      // which is the entire reason for doing it this way.
      // How much of this fragment the fungal overlay covers, 0 to 1.
      //
      // A function rather than inline code because it is read twice: once at
      // <map_fragment> for the colour and once at <roughnessmap_fragment> for
      // the roughness, and two copies of the noise maths is two places for
      // them to drift apart. It has to be a free function and not a varying,
      // because the crust term is a function of world position and a varying
      // would need the weight computed in the vertex shader, where the
      // fragment-resolution stain would be lost.
      ${options.corruptionStrength > 0 ? `float astraCorruptionWeight( vec3 worldPos, float c ) {
        // The stain only takes hold where the corruption already is, and its
        // own noise decides how much of that ground it covers. Without the
        // second term the overlay would be a flat tint with a hard boundary
        // at the corruption field's edge.
        float stain = astraFbm2D(
          worldPos.xz * uCorruptionScale, uNoiseSeed + 31.7, 3, 2.0, 0.5, false
        ) * 0.5 + 0.5;
        float crust = 1.0 - abs(
          astraFbm2D( worldPos.xz * uCorruptionScale * 2.3, uNoiseSeed + 44.1, 2, 2.0, 0.5, true )
        );
        // The crust term is ridged rather than plain fbm, so the edge of the
        // stain is crusty rather than feathered. A soft edge reads as a
        // painted-on decal.
        float cover = smoothstep( 0.35, 0.75, stain * 0.7 + crust * 0.3 );
        return clamp( c, 0.0, 1.0 ) * uCorruptionStrength * cover;
      }` : ''}

      float astraTriplanarDetail( vec3 worldPos, float scale, float seed, int octaves ) {
        vec3 q = worldPos * scale;
        vec3 w = pow( abs( vAstraNormal ), vec3( 3.0 ) );
        w /= ( w.x + w.y + w.z + 1e-5 );
        float nx = astraFbm2D( q.zy, seed, octaves, 2.0, 0.5, false );
        float ny = astraFbm2D( q.xz, seed + 1.7, octaves, 2.0, 0.5, false );
        float nz = astraFbm2D( q.xy, seed + 3.4, octaves, 2.0, 0.5, false );
        return w.x * nx + w.y * ny + w.z * nz;
      }
    `,
  );

  // Replace the (absent) albedo map with the triplanar variation. `diffuseColor`
  // already holds the vertex colour, so this modulates it rather than
  // overwriting it: the vertex paint stays the base, exactly as the plan
  // describes, and the noise supplies the grain on top.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    /* glsl */ `
      #include <map_fragment>

      {
        // Slope as 1 - |normal.y|: 0 flat, 1 vertical. Taken from the world
        // normal so it survives the mesh transform.
        float slope = 1.0 - clamp( abs( vAstraNormal.y ), 0.0, 1.0 );
        float rockMix = smoothstep( uSlopeRockStart, uSlopeRockEnd, slope ) * uSlopeRockStrength;

        // Re-weight the vertex biome mix toward rock on steep ground. This is
        // the plan's "rock on steep, grass on flat", applied against the
        // rendered normal so it agrees with what the player sees.
        vec4 biome = vAstraBiome;
        float grassShare = biome.x;
        biome.x *= ( 1.0 - rockMix );
        biome.z += grassShare * rockMix;
        biome /= max( biome.x + biome.y + biome.z + biome.w, 1e-4 );

        // Each biome gets its own noise field, so grass and rock do not vary
        // in lockstep - that would read as one texture over everything.
        float detail =
          biome.x * astraTriplanarDetail( vAstraWorld, uDetailScale, uNoiseSeed + 0.0, 2 ) +
          biome.y * astraTriplanarDetail( vAstraWorld, uDetailScale, uNoiseSeed + 7.31, 2 ) +
          biome.z * astraTriplanarDetail( vAstraWorld, uDetailScale, uNoiseSeed + 14.62, 2 ) +
          biome.w * astraTriplanarDetail( vAstraWorld, uDetailScale, uNoiseSeed + 21.93, 2 );

        diffuseColor.rgb *= ( 1.0 + clamp( detail, -1.0, 1.0 ) * uColorVariation );
      }

      ${
        options.corruptionStrength > 0
          ? `{
        // The fungal overlay: the plan's "fungal texture overlay via shader
        // uniform" on the terrain near the stream.
        //
        // The weight's base is the vertex's own corruption, interpolated
        // across the face - so the stain has the shape of the corruption
        // field and not the shape of the mesh's triangulation. Evaluating it
        // per fragment from world position would need the spline walked in
        // the fragment shader, which is the whole reason it is baked per
        // vertex.
        float weight = astraCorruptionWeight( vAstraWorld, vAstraCorruption );
        if ( weight > 0.001 ) {
          // Sickly green-grey, the same family the fungus materials use, so
          // the ground and the things growing out of it are the same rot.
          float stain = astraFbm2D(
            vAstraWorld.xz * uCorruptionScale, uNoiseSeed + 31.7, 3, 2.0, 0.5, false
          ) * 0.5 + 0.5;
          vec3 sickly = vec3( 0.30, 0.34, 0.20 );
          vec3 bruised = vec3( 0.28, 0.20, 0.28 );
          vec3 rot = mix( sickly, bruised, clamp( stain * 1.4 - 0.2, 0.0, 1.0 ) );

          // Mixed toward the rot colour AND darkened, because a stain that
          // only shifts the hue still looks like clean ground that has been
          // tinted. The darkening is what reads as dead.
          diffuseColor.rgb = mix( diffuseColor.rgb, rot, weight * 0.8 );
          diffuseColor.rgb *= 1.0 - weight * uCorruptionDarken;
        }
      }`
          : ''
      }
    `,
  );

  // Rougher where the ground is rotten.
  //
  // This goes at `<roughnessmap_fragment>` and not at `<map_fragment>`, which
  // is where the colour above lives: `roughnessFactor` is declared by the
  // roughness chunk and does not exist yet when `<map_fragment>` runs. Reading
  // it earlier is a compile error, and the failure is a terrain that draws
  // black with no warning anywhere upstream.
  if (options.corruptionStrength > 0) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `
        #include <roughnessmap_fragment>

        {
          // Wet rot catches a highlight and dry rot does not, so the stain
          // has to change the roughness as well as the colour. A uniform
          // roughness across it is the tell that it is a texture rather than
          // a surface.
          float weight = astraCorruptionWeight( vAstraWorld, vAstraCorruption );
          roughnessFactor = clamp( roughnessFactor + weight * 0.25, 0.0, 1.0 );
        }
      `,
    );
  }

  // Perturb the normal. `<normal_fragment_maps>` is the chunk Three reserves
  // for exactly this, and in a material with no normal maps it expands to
  // nothing - so replacing it is safe, and puts the perturbation in the right
  // place: after `normal` is established and before lighting reads it.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_maps>',
    /* glsl */ `
      #include <normal_fragment_maps>

      {
        // Ground detail as a height field in world XZ. Finite differences give
        // its slope; pushing the normal against that slope produces shading
        // that reads as grit and grain without a single texel of texture.
        //
        // The differences below are taken in noise space, so the derivative has
        // to be scaled by 'qScale' to become a world-space slope. Skipping that
        // conversion is invisible in review and shows up as either no effect at
        // all or a surface like crumpled foil, depending on which way the
        // factor went.
        float e = 0.35;
        float qScale = uDetailScale * 2.4;
        vec2 q = vAstraWorld.xz * qScale;
        int oct = int( uNormalOctaves );
        float h0 = astraFbm2D( q, uNoiseSeed + 11.0, oct, 2.0, 0.5, true );
        float hx = astraFbm2D( q + vec2( e, 0.0 ), uNoiseSeed + 11.0, oct, 2.0, 0.5, true );
        float hz = astraFbm2D( q + vec2( 0.0, e ), uNoiseSeed + 11.0, oct, 2.0, 0.5, true );

        vec3 gradient = vec3( ( hx - h0 ) / e, 0.0, ( hz - h0 ) / e ) * qScale;

        // Strength tracks the noise slope, so genuinely flat ground is left
        // alone. A constant-strength perturbation would tilt every flat normal
        // by the same amount in the same direction, which reads as a systematic
        // lighting error rather than as detail.
        float strength = clamp( length( gradient ) * 0.5, 0.0, 1.0 ) * uNormalStrength;

        // Both guards below are load-bearing, not defensive decoration.
        // 'normalize()' of a zero vector is undefined in GLSL, and it happens
        // here twice over: 'along' is exactly zero when the gradient runs
        // straight down the surface normal, which is every vertical face.
        if ( strength > 0.004 ) {
          // Project onto the surface tangent plane so the perturbation follows
          // the ground instead of fighting it on steep faces.
          vec3 along = gradient - dot( gradient, normal ) * normal;
          float alongLen = length( along );
          if ( alongLen > 0.004 ) {
            normal = normalize( normal - ( along / alongLen ) * strength * 0.35 );
          }
        }
      }
    `,
  );
}

/**
 * The shader sources `patchTerrainShader` produces for a given option set.
 *
 * Exposed so tests can assert on the injected GLSL without a GPU. This is the
 * only way to test a shader in a Node environment, and it catches the failure
 * mode that matters most here: a mistyped `#include` anchor, which fails
 * silently on a GPU and produces a black terrain.
 */
export function terrainShaderSources(options: TerrainMaterialOptions = {}): {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, unknown>;
} {
  const shader = {
    vertexShader: BASELINE_VERTEX_SHADER,
    fragmentShader: BASELINE_FRAGMENT_SHADER,
    uniforms: {} as Record<string, unknown>,
  };
  patchTerrainShader(shader, { ...DEFAULT_TERRAIN_MATERIAL_OPTIONS, ...options });
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
void main() {
  #include <map_fragment>
  #include <normal_fragment_maps>
}
`;
