/**
 * CharacterMaterials.ts - ASTRA procedural player
 * =============================================================================
 * The four materials the player character is made of: skin, chain mail, leather
 * and steel. No texture files - every one of them is `MeshStandardMaterial` plus
 * an `onBeforeCompile` patch, for the same reason the terrain is (see
 * MaterialFactory.ts): patching the standard material keeps the character lit,
 * fogged, tonemapped and shadowed by exactly the pipeline everything else in the
 * scene uses, and still allows a fully custom surface.
 *
 * The four requirements and how each is met
 * -----------------------------------------
 *   skin      noise for variation, plus a Fresnel rim standing in for subsurface
 *             scatter. A true translucency integral needs a light direction per
 *             texel and a thickness map, neither of which this rig has; the rim
 *             is the cheap read that stops skin looking like painted plastic,
 *             and it is documented as a rim rather than dressed up as SSS.
 *   chain mail a procedural interlocking ring weave: elliptical rings on a
 *             row-sheared lattice, so neighbouring rows interleave instead of
 *             forming a grid. Metallic, with the ring's own curvature pushed
 *             into the normal so the wire catches light along its length.
 *   leather   brown noise-based albedo and roughness, so no two patches read
 *             identically.
 *   steel     high metalness, low roughness, and a normal perturbation from the
 *             same noise so the flat of the blade is not a mirror-perfect
 *             sticker.
 *
 * Two conventions carried over from MaterialFactory.ts
 * ---------------------------------------------------
 * Every injected symbol is prefixed `astra` so it cannot collide with a Three
 * chunk, and `customProgramCacheKey` returns a fixed string per material kind so
 * Three never reuses a program compiled without the patch.
 *
 * On UV scale
 * -----------
 * `CylinderGeometry`'s u runs once around the circumference and v once up the
 * height, so a single "rings per UV unit" number would give rings a completely
 * different physical size on a thigh than on a forearm. Each part therefore
 * carries its own circumference and height in `uAstraMailSize`, and the density
 * uniform is genuinely rings per metre. That is the difference between mail that
 * reads as armour and mail that reads as a texture stretched over a body.
 * =============================================================================
 */

import { Color, MeshStandardMaterial } from 'three';
import { NOISE_GLSL } from './NoiseLibrary';

/* ========================================================================== */
/* Skin                                                                       */
/* ========================================================================== */

export interface SkinMaterialOptions {
  /** Base skin tone. Deliberately earthy, not peach. */
  color?: number;
  /** Strength of the noise variation across the surface, 0..1. */
  variation?: number;
  /** Scale of that noise, in noise units per metre. */
  variationScale?: number;
  /** Width of the Fresnel rim, in metres of surface curvature. */
  rimWidth?: number;
  /** Colour and strength of the rim. This is the subsurface stand-in. */
  rimColor?: number;
  rimStrength?: number;
  roughness?: number;
  metalness?: number;
}

export const DEFAULT_SKIN_OPTIONS = {
  color: 0xb08a68,
  variation: 0.16,
  variationScale: 3.5,
  rimWidth: 0.42,
  rimColor: 0xd98a5e,
  rimStrength: 0.35,
  roughness: 0.62,
  metalness: 0,
} as const;

const SKIN_PROGRAM_KEY = 'astra-skin-v1';

export function createSkinMaterial(options: SkinMaterialOptions = {}): MeshStandardMaterial {
  const merged = { ...DEFAULT_SKIN_OPTIONS, ...options };
  const material = new MeshStandardMaterial({
    color: merged.color,
    roughness: merged.roughness,
    metalness: merged.metalness,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAstraSkinVariation = { value: merged.variation };
    shader.uniforms.uAstraSkinVariationScale = { value: merged.variationScale };
    shader.uniforms.uAstraSkinRimWidth = { value: merged.rimWidth };
    shader.uniforms.uAstraSkinRimColor = { value: new Color(merged.rimColor) };
    shader.uniforms.uAstraSkinRimStrength = { value: merged.rimStrength };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vAstraSkinWorldPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vAstraSkinWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        ${NOISE_GLSL}
        uniform float uAstraSkinVariation;
        uniform float uAstraSkinVariationScale;
        uniform float uAstraSkinRimWidth;
        uniform vec3 uAstraSkinRimColor;
        uniform float uAstraSkinRimStrength;
        varying vec3 vAstraSkinWorldPos;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        // Variation. Two octaves, one slow and one fast: a single octave reads
        // as a stain, two read as skin.
        float astraSkinN = astraFbm2D( vAstraSkinWorldPos.xz * uAstraSkinVariationScale, 11.0, 2, 2.0, 0.5, false ) * 0.5 + 0.5;
        float astraSkinM = astraFbm2D( vAstraSkinWorldPos.zy * uAstraSkinVariationScale * 1.7, 23.0, 2, 2.0, 0.5, false ) * 0.5 + 0.5;
        float astraSkinTone = mix( astraSkinN, astraSkinM, 0.45 ) - 0.5;
        diffuseColor.rgb *= 1.0 + astraSkinTone * uAstraSkinVariation * 2.0;`,
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        // The subsurface stand-in: a Fresnel rim. Light grazing a curved surface
        // is exactly the light that has the most skin to travel through, so
        // warming the silhouette edge is the cheap version of the real thing.
        // It needs no light direction, which is the point - a true translucency
        // term needs one per texel plus a thickness map this rig does not have.
        //
        // This has to go in HERE, before tone mapping and the colour-space
        // encode, and not at dithering_fragment where it is tempting to put it
        // because that is the last chunk in the shader. By the time
        // dithering_fragment runs, tonemapping_fragment and colorspace_fragment
        // have already been applied, so anything added there is added to an
        // sRGB-encoded value and comes out far too bright and hue-shifted.
        // Adding to outgoingLight keeps it linear.
        vec3 astraSkinViewDir = normalize( vViewPosition );
        float astraSkinFacing = abs( dot( normal, astraSkinViewDir ) );
        float astraSkinRim = pow( 1.0 - astraSkinFacing, 3.0 / max( uAstraSkinRimWidth, 0.01 ) );
        outgoingLight += uAstraSkinRimColor * astraSkinRim * uAstraSkinRimStrength;
        #include <opaque_fragment>`,
      );
  };

  material.customProgramCacheKey = () => SKIN_PROGRAM_KEY;
  return material;
}

/* ========================================================================== */
/* Chain mail                                                                 */
/* ========================================================================== */

export interface ChainMailMaterialOptions {
  /** Rings per metre of surface. Roughly 90 on real European 4-in-1. */
  density?: number;
  /** Colour of the metal itself. */
  color?: number;
  /** Radius of a ring's wire, as a fraction of the ring spacing. */
  wireWidth?: number;
  /** How much of the hole between rings shows the layer beneath, 0..1. */
  holeDepth?: number;
  /** Strength of the ring's curvature pushed into the normal. */
  bumpStrength?: number;
  /**
   * The part's circumference and height in metres.
   *
   * A cylinder's u runs once around its circumference and v once up its height,
   * so without this a single "rings per UV unit" number would give rings a
   * completely different physical size on a thigh than on a forearm. Supplying
   * the real size is what makes `density` genuinely rings per metre, and it is
   * why every chain mail part gets its own material instance - they share a
   * compiled program (the cache key is fixed) but not uniform values.
   */
  size?: [number, number];
  roughness?: number;
  metalness?: number;
}

export const DEFAULT_CHAIN_MAIL_OPTIONS = {
  density: 90,
  color: 0x8a8f96,
  wireWidth: 0.16,
  holeDepth: 0.8,
  bumpStrength: 0.055,
  roughness: 0.34,
  metalness: 1,
  size: [1, 1] as [number, number],
} as const;

const CHAIN_MAIL_PROGRAM_KEY = 'astra-chainmail-v1';

/**
 * The ring field, shared by the albedo pass and the bump pass so the two can
 * never disagree about where the wire is.
 *
 * Rows are sheared by half a cell on alternate rows. That single detail is what
 * separates mail from chain-link fencing: without it every ring sits directly
 * above the one below and the weave reads as a grid, and with it each ring
 * falls into the gap left by the row above, which is what 4-in-1 actually does.
 */
const CHAIN_MAIL_FIELD = /* glsl */ `
float astraMailField( vec2 uv, out float outHole ) {
  vec2 p = uv;
  float row = floor( p.y );
  float odd = mod( row, 2.0 );
  float shear = odd * 0.5;
  vec2 q = vec2( fract( p.x + shear ) - 0.5, fract( p.y ) - 0.5 );

  // Elliptical rings, and the ellipse tilts with the row, so the two rows of a
  // column cross rather than stack.
  float tilt = odd < 0.5 ? 1.0 : -1.0;
  float d = length( vec2( q.x * 1.55 * tilt, q.y ) );

  // The wire is a gaussian annulus rather than a hard ring: a hard edge aliases
  // into a staircase at this size, and the wire is only a few pixels across.
  float wire = exp( -pow( ( d - 0.33 ) / max( uAstraMailWireWidth, 0.01 ), 2.0 ) );

  // The hole is dark and shows whatever is underneath.
  outHole = 1.0 - smoothstep( 0.22, 0.31, d );

  // A second, dimmer pass offset by half a cell in both axes gives the weave
  // depth: the rings behind read through the gaps of the rings in front.
  vec2 r = vec2( fract( p.x + 0.5 ) - 0.5, fract( p.y + 0.5 ) - 0.5 );
  float d2 = length( vec2( r.x * 1.55 * -tilt, r.y ) );
  float wire2 = exp( -pow( ( d2 - 0.33 ) / max( uAstraMailWireWidth, 0.01 ), 2.0 ) ) * 0.35;

  return max( wire, wire2 );
}
`;

export function createChainMailMaterial(options: ChainMailMaterialOptions = {}): MeshStandardMaterial {
  const merged = { ...DEFAULT_CHAIN_MAIL_OPTIONS, ...options };
  const material = new MeshStandardMaterial({
    color: merged.color,
    roughness: merged.roughness,
    metalness: merged.metalness,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAstraMailDensity = { value: merged.density };
    shader.uniforms.uAstraMailWireWidth = { value: merged.wireWidth };
    shader.uniforms.uAstraMailHoleDepth = { value: merged.holeDepth };
    shader.uniforms.uAstraMailBump = { value: merged.bumpStrength };
    shader.uniforms.uAstraMailSize = { value: merged.size };

    // The UV has to reach the fragment shader for the ring lattice and for the
    // forward-differenced bump. CylinderGeometry and BoxGeometry both have one,
    // so this is a passthrough rather than a new attribute.
    shader.vertexShader = shader.vertexShader
      .replace( '#include <common>', '#include <common>\nvarying vec2 vAstraMailUv;' )
      .replace( '#include <uv_vertex>', '#include <uv_vertex>\nvAstraMailUv = uv;' );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uAstraMailDensity;
        uniform float uAstraMailWireWidth;
        uniform float uAstraMailHoleDepth;
        uniform float uAstraMailBump;
        uniform vec2 uAstraMailSize;
        varying vec2 vAstraMailUv;
        ${CHAIN_MAIL_FIELD}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        vec2 astraMailP = vAstraMailUv * uAstraMailSize * uAstraMailDensity;
        float astraMailHole;
        float astraMailWire = astraMailField( astraMailP, astraMailHole );
        // The wire is the metal; the hole darkens towards whatever is beneath.
        // Multiplying rather than mixing keeps the wire's own colour intact, so
        // the metal reads as metal rather than as a grey overlay.
        diffuseColor.rgb *= mix( 1.0 - uAstraMailHoleDepth, 1.0, astraMailWire );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        // The wire is polished and the hole is matte shadow. Without this the
        // whole surface has one roughness and the weave disappears the moment
        // the light is not straight on.
        roughnessFactor *= mix( 0.85, 0.55, astraMailWire );`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        // Push the ring's own curvature into the normal, by forward-differencing
        // the same field the albedo used. The wire is a torus cross-section, so
        // its height rises to a crest along the ring's length - that crest is
        // what catches a highlight and makes the mail read as physical objects
        // rather than as a printed pattern.
        {
          vec2 dSTdx = dFdx( vAstraMailUv * uAstraMailSize * uAstraMailDensity );
          vec2 dSTdy = dFdy( vAstraMailUv * uAstraMailSize * uAstraMailDensity );
          float h0;
          float h1;
          float w0 = astraMailField( astraMailP + dSTdx, h0 );
          float w1 = astraMailField( astraMailP + dSTdy, h1 );
          vec2 dHdxy = vec2( w0 - astraMailWire, w1 - astraMailWire ) * uAstraMailBump * 60.0;

          vec3 surf_pos = -vViewPosition;
          vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
          vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
          vec3 R1 = cross( vSigmaY, normal );
          vec3 R2 = cross( normal, vSigmaX );
          float fDet = dot( vSigmaX, R1 );
          vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
          normal = normalize( abs( fDet ) * normal - vGrad );
        }`,
      );
  };

  material.customProgramCacheKey = () => CHAIN_MAIL_PROGRAM_KEY;
  return material;
}

/* ========================================================================== */
/* Leather                                                                    */
/* ========================================================================== */

export interface LeatherMaterialOptions {
  /** Base brown. Earthy, and darker than a saddle so it does not read as orange. */
  color?: number;
  /** Strength of the noise variation across the surface, 0..1. */
  variation?: number;
  /** Scale of that noise, in noise units per metre. */
  variationScale?: number;
  /** How much the roughness varies with the same noise, 0..1. */
  roughnessVariation?: number;
  roughness?: number;
  metalness?: number;
}

export const DEFAULT_LEATHER_OPTIONS = {
  color: 0x5a3f2b,
  variation: 0.28,
  variationScale: 5.0,
  roughnessVariation: 0.3,
  roughness: 0.78,
  metalness: 0,
} as const;

const LEATHER_PROGRAM_KEY = 'astra-leather-v1';

export function createLeatherMaterial(options: LeatherMaterialOptions = {}): MeshStandardMaterial {
  const merged = { ...DEFAULT_LEATHER_OPTIONS, ...options };
  const material = new MeshStandardMaterial({
    color: merged.color,
    roughness: merged.roughness,
    metalness: merged.metalness,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAstraLeatherVariation = { value: merged.variation };
    shader.uniforms.uAstraLeatherVariationScale = { value: merged.variationScale };
    shader.uniforms.uAstraLeatherRoughnessVariation = { value: merged.roughnessVariation };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vAstraLeatherWorldPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vAstraLeatherWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        ${NOISE_GLSL}
        uniform float uAstraLeatherVariation;
        uniform float uAstraLeatherVariationScale;
        uniform float uAstraLeatherRoughnessVariation;
        varying vec3 vAstraLeatherWorldPos;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        // Three octaves: leather has grain at more than one scale, and a single
        // octave reads as a printed texture.
        float astraLeatherN = astraFbm2D( vAstraLeatherWorldPos.xz * uAstraLeatherVariationScale, 31.0, 3, 2.0, 0.5, false ) * 0.5 + 0.5;
        float astraLeatherM = astraFbm2D( vAstraLeatherWorldPos.zy * uAstraLeatherVariationScale * 2.3, 47.0, 2, 2.0, 0.5, false ) * 0.5 + 0.5;
        float astraLeatherTone = mix( astraLeatherN, astraLeatherM, 0.4 ) - 0.5;
        diffuseColor.rgb *= 1.0 + astraLeatherTone * uAstraLeatherVariation * 2.0;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        // Worn leather is shinier where it has been rubbed, and the same noise
        // that varies the colour is a good enough proxy for where that is.
        roughnessFactor *= 1.0 - astraLeatherTone * uAstraLeatherRoughnessVariation * 2.0;`,
      );
  };

  material.customProgramCacheKey = () => LEATHER_PROGRAM_KEY;
  return material;
}

/* ========================================================================== */
/* Steel                                                                      */
/* ========================================================================== */

export interface SteelMaterialOptions {
  color?: number;
  /** Strength of the smithing noise pushed into the normal, 0..1. */
  bumpStrength?: number;
  /** Scale of that noise, in noise units per metre. */
  bumpScale?: number;
  roughness?: number;
  metalness?: number;
}

export const DEFAULT_STEEL_OPTIONS = {
  color: 0xb9bec4,
  bumpStrength: 0.03,
  bumpScale: 26.0,
  roughness: 0.16,
  metalness: 1,
} as const;

const STEEL_PROGRAM_KEY = 'astra-steel-v1';

export function createSteelMaterial(options: SteelMaterialOptions = {}): MeshStandardMaterial {
  const merged = { ...DEFAULT_STEEL_OPTIONS, ...options };
  const material = new MeshStandardMaterial({
    color: merged.color,
    roughness: merged.roughness,
    metalness: merged.metalness,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAstraSteelBump = { value: merged.bumpStrength };
    shader.uniforms.uAstraSteelBumpScale = { value: merged.bumpScale };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vAstraSteelWorldPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vAstraSteelWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        ${NOISE_GLSL}
        uniform float uAstraSteelBump;
        uniform float uAstraSteelBumpScale;
        varying vec3 vAstraSteelWorldPos;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        // A hand-forged blade is not a machined one. The noise is high frequency
        // and low amplitude, which is exactly the difference between a sword and
        // a chrome prop: the highlight stays tight but stops being perfect.
        {
          float h = astraFbm2D( vAstraSteelWorldPos.xz * uAstraSteelBumpScale, 53.0, 2, 2.0, 0.5, false );
          float hx = astraFbm2D( ( vAstraSteelWorldPos.xz + vec2( 0.02, 0.0 ) ) * uAstraSteelBumpScale, 53.0, 2, 2.0, 0.5, false );
          float hy = astraFbm2D( ( vAstraSteelWorldPos.xz + vec2( 0.0, 0.02 ) ) * uAstraSteelBumpScale, 53.0, 2, 2.0, 0.5, false );
          vec2 grad = vec2( hx - h, hy - h ) * uAstraSteelBump * 40.0;

          vec3 surf_pos = -vViewPosition;
          vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
          vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
          vec3 R1 = cross( vSigmaY, normal );
          vec3 R2 = cross( normal, vSigmaX );
          float fDet = dot( vSigmaX, R1 );
          vec3 vGrad = sign( fDet ) * ( grad.x * R1 + grad.y * R2 );
          normal = normalize( abs( fDet ) * normal - vGrad );
        }`,
      );
  };

  material.customProgramCacheKey = () => STEEL_PROGRAM_KEY;
  return material;
}

/* ========================================================================== */
/* The set                                                                    */
/* ========================================================================== */

export interface CharacterMaterials {
  skin: MeshStandardMaterial;
  chainMail: MeshStandardMaterial;
  leather: MeshStandardMaterial;
  steel: MeshStandardMaterial;
}

/**
 * Build all four. Each is a separate material instance, because each part that
 * wears chain mail needs its own `uAstraMailSize` - they share a compiled
 * program (the cache key is fixed per kind) but not uniform values.
 */
export function createCharacterMaterials(
  skin: SkinMaterialOptions = {},
  mail: ChainMailMaterialOptions = {},
  leather: LeatherMaterialOptions = {},
  steel: SteelMaterialOptions = {},
): CharacterMaterials {
  return {
    skin: createSkinMaterial(skin),
    chainMail: createChainMailMaterial(mail),
    leather: createLeatherMaterial(leather),
    steel: createSteelMaterial(steel),
  };
}

/** Dispose every material in a set. Safe to call twice. */
export function disposeCharacterMaterials(materials: CharacterMaterials): void {
  for (const material of Object.values(materials)) material.dispose();
}
