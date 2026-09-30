/**
 * TreeMaterial.ts - ASTRA procedural world
 * =============================================================================
 * The two materials a tree needs: bark and leaves. Both are
 * `MeshStandardMaterial` plus an `onBeforeCompile` patch, for the reasons
 * `MaterialFactory.ts` sets out at length - patching keeps the tree lit,
 * fogged, shadowed and tonemapped by the same pipeline as the terrain, and
 * still allows a surface that is entirely procedural.
 *
 * Bark
 * ----
 * Voronoi cells in object-space XZ. A Voronoi cell is constant in the axis it
 * was computed in, so each cell is a *vertical column* of bark, which is what
 * makes the plates run up the trunk instead of wrapping it into rings. The
 * ridge between cells is `f2 - f1`, the distance to the second-nearest feature
 * point - zero at a plate centre, largest on the seam. An fbm stretched along
 * the same axis supplies the fibre on top.
 *
 * The height field is differentiated into a normal by the same derivation
 * Three uses for bump maps (`cross` products of `dFdx`/`dFdy` of the view
 * position). Doing it that way rather than by hand keeps the perturbation in
 * view space, where `normal` lives at that point in the shader, and needs no
 * extra matrix to convert between spaces.
 *
 * Leaves
 * ------
 * The green-to-yellow ramp is already baked into the canopy's vertex colours by
 * `TreeGenerator`, so the material only has to leave it alone. What it adds:
 *
 *   subsurface  a view-dependent emissive lift. A leaf seen edge-on is a thin
 *               sliver of tissue, so more light passes through it than comes
 *               back; the term is `pow(1 - |N.V|, power) * strength`. That is
 *               the whole of the approximation - one dot product, and it makes
 *               the crown glow at its silhouette without pretending to be a
 *               light transport simulation.
 *   cutouts     an object-space mask written into `diffuseColor.a`, discarded
 *               by Three's own `alphaTest`. The canopy blobs are closed
 *               icospheres, so without this the crown is one solid lump; with
 *               it, the mask carves gaps between leaf clusters, which is the
 *               "alpha-tested edges" the plan asks for. Because it is a
 *               `discard` and not a blend, the crown stays in the opaque pass
 *               and keeps correct depth sorting against itself.
 *
 * Wind
 * ----
 * Both materials share one sway function and one time uniform, so the trunk and
 * the crown move as one tree. The amplitude is quadratic in the height above
 * the tree's own base, which plants the trunk and swings the crown without a
 * separate bend skeleton. The phase comes from the instance's world position,
 * so no two trees in the forest move in step.
 *
 * Every injected symbol is prefixed `astra`, and `customProgramCacheKey`
 * returns a fixed string per material, so Three never reuses a program
 * compiled without the patch.
 * =============================================================================
 */

import { FrontSide, DoubleSide, MeshStandardMaterial, type MeshStandardMaterialParameters } from 'three';
import { NOISE_GLSL } from './NoiseLibrary';

/** Cache keys. Bump whenever the injected GLSL changes. */
export const BARK_PROGRAM_KEY = 'astra-bark-v2';
export const LEAF_PROGRAM_KEY = 'astra-leaf-v2';

/** A single float uniform both materials can share, so one write drives both. */
export interface SharedFloatUniform {
  value: number;
}

export interface BarkMaterialOptions {
  /** Size of a bark plate, in noise units per metre. */
  plateScale?: number;
  /** Height of the ridge between plates, in height units. */
  plateDepth?: number;
  /** Strength of the noise-driven normal perturbation. */
  normalStrength?: number;
  /** How much the large-scale mottling modulates the bark colour. */
  colorVariation?: number;
  /** World seed for the shader's noise. */
  noiseSeed?: number;
  roughness?: number;
  metalness?: number;
  /** Shared wind time, in seconds. Pass the same object to both materials. */
  windUniform?: SharedFloatUniform;
  /**
   * Shared gust multiplier on the sway amplitude. Pass the same object to both
   * materials and to the ambient audio.
   *
   * This is the seam that keeps the sound of the wind and the movement of the
   * trees the same event. The GLSL sway function and the audio both scale off
   * this one number, so a gust that bends the canopy is by construction the gust
   * that swells the wind layer - there is no second model of the wind that can
   * drift out of agreement with the first.
   */
  windStrengthUniform?: SharedFloatUniform;
  /** Peak sway at ten metres up, in metres. Zero disables the sway. */
  windStrength?: number;
  /**
   * Height of this tree type, in metres.
   *
   * Only the leaf material uses it, and only to normalise the droop: the
   * canopy of a 10 m oak and of a 3 m sapling must fall by comparable
   * *fractions*, or the sapling is flattened outright while the oak barely
   * moves. Zero disables the droop.
   */
  treeHeight?: number;
  /**
   * How far a fully corrupted canopy drops, as a fraction of the tree's own
   * height. Zero disables the droop.
   */
  corruptionDroop?: number;
}

export interface LeafMaterialOptions {
  /** Size of the leaf-cluster mask, in noise units per metre. */
  clusterScale?: number;
  /** Fraction of the canopy the mask carves away. */
  cutout?: number;
  /** Strength of the view-dependent subsurface lift. */
  sssStrength?: number;
  /** How tightly the subsurface lift hugs the silhouette. */
  sssPower?: number;
  /** World seed for the shader's noise. */
  noiseSeed?: number;
  roughness?: number;
  metalness?: number;
  /** Shared wind time, in seconds. Pass the same object to both materials. */
  windUniform?: SharedFloatUniform;
  /**
   * Shared gust multiplier on the sway amplitude. Pass the same object to both
   * materials and to the ambient audio.
   *
   * This is the seam that keeps the sound of the wind and the movement of the
   * trees the same event. The GLSL sway function and the audio both scale off
   * this one number, so a gust that bends the canopy is by construction the gust
   * that swells the wind layer - there is no second model of the wind that can
   * drift out of agreement with the first.
   */
  windStrengthUniform?: SharedFloatUniform;
  /** Peak sway at ten metres up, in metres. Zero disables the sway. */
  windStrength?: number;
  /** Height of this tree type, in metres. Used to normalise the droop. */
  treeHeight?: number;
  /** How far a fully corrupted canopy drops, as a fraction of its height. */
  corruptionDroop?: number;
  /**
   * How far a fully corrupted crown twists about the tree's own axis, radians.
   *
   * The plan's "twisted trees" in the inner zone. Zero disables it.
   */
  corruptionTwist?: number;
}

/** Defaults, exported so tests and the debug overlay can read them. */
export const DEFAULT_BARK_MATERIAL_OPTIONS = {
  plateScale: 1.6,
  plateDepth: 1.0,
  normalStrength: 0.9,
  colorVariation: 0.22,
  noiseSeed: 0,
  roughness: 0.92,
  metalness: 0,
  windStrength: 0.05,
  treeHeight: 0,
  corruptionDroop: 0,
} as const;

export const DEFAULT_LEAF_MATERIAL_OPTIONS = {
  clusterScale: 3.4,
  cutout: 0.34,
  sssStrength: 0.55,
  sssPower: 2.4,
  noiseSeed: 0,
  roughness: 0.68,
  metalness: 0,
  windStrength: 0.05,
  treeHeight: 0,
  corruptionDroop: 0.14,
  // Seven degrees at the top of the crown. Enough to change the silhouette of
  // a whole oak, small enough that the crown's own blobs - a metre and a bit
  // across - still sit over the branches that hold them.
  corruptionTwist: 0.12,
} as const;

/**
 * The shared sway block, injected into the vertex shader.
 *
 * Written as one constant because the bark and the leaf materials must agree
 * exactly: two slightly different sway functions put the crown beside the
 * branch that holds it, and the seam shows as a floating canopy.
 */
const SWAY_GLSL = /* glsl */ `
  // The wind uniforms are declared HERE, once, and nowhere else. Declaring
  // them again at either injection site is a redefinition, and GLSL rejects
  // the whole program rather than warning about it.
  uniform float uWindTime;
  uniform float uWindStrength;
  uniform float uWindGust;

  // Horizontal sway for a vertex h metres above its own tree's base.
  //
  // Quadratic in h, so the amplitude is zero at the ground and grows only
  // where there is something to move. A linear ramp would shear the trunk
  // sideways at the base, and a fixed offset would translate the whole tree.
  //
  // The phase is the instance's world position, so two trees standing next to
  // each other are at different points of the wave and never swing together.
  //
  // uWindGust scales the whole amplitude rather than adding to it, so a calm
  // moment is still calm - it is the same wind, quieter - rather than the same
  // wind plus a wobble. It is written once per frame from JavaScript by the
  // forest, and the ambient audio reads the same value, which is what makes the
  // sound and the movement one event rather than two that happen to coincide.
  vec2 astraSway( float h, vec3 instanceOrigin ) {
    vec2 phase = instanceOrigin.xz * 0.09;
    float amp = uWindStrength * uWindGust * h * h * 0.012;
    vec2 dir = vec2(
      astraSimplex2D( phase + vec2( uWindTime * 0.4, 0.0 ), 3.0 ),
      astraSimplex2D( phase + vec2( uWindTime * 0.4, 19.0 ), 8.0 )
    );
    return dir * amp;
  }
`;

/** Options after defaults have been applied. */
type ResolvedBark = Required<Omit<BarkMaterialOptions, 'windUniform' | 'windStrengthUniform'>>;
type ResolvedLeaf = Required<Omit<LeafMaterialOptions, 'windUniform' | 'windStrengthUniform'>>;

/**
 * Build the bark material.
 *
 * An ordinary `MeshStandardMaterial`, so it can be inspected, disposed and
 * reasoned about like any other. The custom surface lives in
 * `onBeforeCompile`, which is why this module also exports
 * `barkShaderSources`: a test can drive the patch with a stub shader object and
 * assert on exactly what gets injected, with no GPU involved.
 */
export function createBarkMaterial(options: BarkMaterialOptions = {}): MeshStandardMaterial {
  const o = { ...DEFAULT_BARK_MATERIAL_OPTIONS, ...options };
  const wind = options.windUniform ?? { value: 0 };

  const params: MeshStandardMaterialParameters = {
    // The dead tree's bark and its fungal clusters are vertex-coloured, so the
    // shader has a real base albedo to modulate. Living bark is white, which
    // leaves the colour entirely to the noise ramp below.
    vertexColors: true,
    roughness: o.roughness,
    metalness: o.metalness,
    // Bark is opaque, always. Saying so keeps it out of the transparent pass.
    transparent: false,
    alphaTest: 0,
    depthWrite: true,
    // Front side only: the tube is closed at the tip and buried at the base,
    // so the inside is never visible, and half the fragments is half the cost.
    side: FrontSide,
  };

  const gust = options.windStrengthUniform ?? { value: 1 };
  const material = new MeshStandardMaterial(params);
  material.onBeforeCompile = (shader) => {
    patchBarkShader(shader, o, wind, gust);
  };
  material.customProgramCacheKey = () => BARK_PROGRAM_KEY;
  return material;
}

/**
 * Build the leaf material.
 *
 * `alphaTest` rather than `transparent`: the cutout mask is a hard threshold,
 * and a hard threshold keeps the crown in the opaque pass where it is depth
 * sorted correctly against itself. Blending the same mask would need the
 * canopy sorted back-to-front every frame and would still show the inside of
 * the far wall of every blob.
 */
export function createLeafMaterial(options: LeafMaterialOptions = {}): MeshStandardMaterial {
  const o = { ...DEFAULT_LEAF_MATERIAL_OPTIONS, ...options };
  const wind = options.windUniform ?? { value: 0 };

  const params: MeshStandardMaterialParameters = {
    vertexColors: true,
    roughness: o.roughness,
    metalness: o.metalness,
    transparent: false,
    // Three emits the discard for this, so the mask only has to be written
    // into diffuseColor.a.
    alphaTest: 0.5,
    depthWrite: true,
    // Both sides: the cutouts open windows through the crown, and through a
    // window you see the far wall of the blob rather than the sky.
    side: DoubleSide,
  };

  const gust = options.windStrengthUniform ?? { value: 1 };
  const material = new MeshStandardMaterial(params);
  material.onBeforeCompile = (shader) => {
    patchLeafShader(shader, o, wind, gust);
  };
  material.customProgramCacheKey = () => LEAF_PROGRAM_KEY;
  return material;
}

/**
 * Patch the bark shader pair in place.
 *
 * Exported, and taking a plain object rather than a real shader, so the
 * injection can be unit-tested in Node. A mistyped `#include` anchor fails
 * silently on a GPU and produces a black tree, which is the failure mode this
 * exists to catch.
 */
export function patchBarkShader(
  shader: {
    vertexShader: string;
    fragmentShader: string;
    uniforms: Record<string, unknown>;
  },
  options: ResolvedBark,
  wind: SharedFloatUniform = { value: 0 },
  gust: SharedFloatUniform = { value: 1 },
): void {
  shader.uniforms.uPlateScale = { value: options.plateScale };
  shader.uniforms.uPlateDepth = { value: options.plateDepth };
  shader.uniforms.uBarkNormalStrength = { value: options.normalStrength };
  shader.uniforms.uBarkColorVariation = { value: options.colorVariation };
  shader.uniforms.uNoiseSeed = { value: options.noiseSeed };
  shader.uniforms.uWindTime = wind;
  shader.uniforms.uWindStrength = { value: options.windStrength };
  shader.uniforms.uWindGust = gust;
  /* ---------------------------------------------------------------- vertex */

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      varying vec3 vAstraObject;
      attribute float corruption;
      varying float vAstraCorruption;
      ${NOISE_GLSL}
      ${SWAY_GLSL}
    `,
  );

  // `<beginnormal_vertex>` defines `objectNormal` and runs first, so the
  // capture goes here, before the sway moves `transformed`.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    /* glsl */ `
      #include <begin_vertex>
      vAstraObject = transformed;
      vAstraCorruption = corruption;

      {
        // Where this tree stands in the world. For an InstancedMesh the
        // instance carries the translation and modelMatrix carries the mesh's
        // own; for a plain Mesh instanceMatrix does not exist and the mesh's
        // own matrix is the whole answer.
        vec3 instanceOrigin = modelMatrix[ 3 ].xyz;
        #ifdef USE_INSTANCING
          instanceOrigin += instanceMatrix[ 3 ].xyz;
        #endif
        vec2 offset = astraSway( max( transformed.y, 0.0 ), instanceOrigin );
        // Applied in object space, which is correct because the amplitude is
        // measured along the tree's own height and the phase is already in
        // world space.
        transformed.x += offset.x;
        transformed.z += offset.y;
      }
    `,
  );

  /* -------------------------------------------------------------- fragment */

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      varying vec3 vAstraObject;
      varying float vAstraCorruption;
      uniform float uPlateScale;
      uniform float uPlateDepth;
      uniform float uBarkNormalStrength;
      uniform float uBarkColorVariation;
      uniform float uNoiseSeed;

      ${NOISE_GLSL}

      // Bark height at one point of the tree, in object space.
      //
      // The Voronoi lookup uses only x and z, so a cell is constant in y: the
      // plates are vertical columns and run up the trunk. Including y in the
      // lookup is the single easiest way to ruin this - it turns every plate
      // into a blob and the trunk into a knobbly tube.
      float astraBarkHeight( vec3 p ) {
        vec2 vor = astraVoronoi2D( p.xz * uPlateScale, uNoiseSeed );
        // f2 - f1 is zero on a plate centre and largest on the seam between
        // two plates. That is the ridge, and it is free: the Voronoi already
        // computed both distances.
        float ridge = clamp( vor.y - vor.x, 0.0, 1.0 );
        // Fibre: sampled in a plane that stretches along y, so the streaks run
        // the same way the plates do.
        float grain = astraFbm2D(
          vec2( p.x + p.z, p.y * 4.0 ) * uPlateScale * 3.0,
          uNoiseSeed + 3.0, 3, 2.0, 0.5, true
        );
        return ridge * 0.72 + grain * 0.28;
      }
    `,
  );

  // Modulate the albedo. `diffuseColor` already holds the vertex colour, so
  // this multiplies rather than overwrites: the dead tree's grey bark and its
  // green fungal clusters survive, because a grey times a brown is still grey.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    /* glsl */ `
      #include <map_fragment>

      {
        float h = astraBarkHeight( vAstraObject );

        // A brown ramp rather than a grey one: bark is dark in the crevices
        // and light on the plate faces, and the difference between the two is
        // what makes the plates read without any texture.
        vec3 barkLow = vec3( 0.15, 0.10, 0.068 );
        vec3 barkHigh = vec3( 0.44, 0.32, 0.21 );
        vec3 bark = mix( barkLow, barkHigh, smoothstep( 0.12, 0.88, h ) );

        // Large-scale mottling, so two trunks do not end up the same tone and
        // the forest floor does not read as one repeated asset.
        float mottle = astraFbm2D(
          vAstraObject.xz * uPlateScale * 0.3,
          uNoiseSeed + 7.0, 3, 2.0, 0.5, true
        );
        bark *= 1.0 + mottle * uBarkColorVariation;

        // The plan's "bark color shifts to grey" on the trees nearest the
        // stream. Desaturated toward its own luma rather than darkened: a
        // trunk that only gets darker reads as shadow, and a trunk that reads
        // as shadow is a lighting bug rather than a dying tree.
        float c = clamp( vAstraCorruption, 0.0, 1.0 );
        if ( c > 0.001 ) {
          float luma = dot( bark, vec3( 0.2126, 0.7152, 0.0722 ) );
          // A hair cool, so the grey is bark-grey and not concrete-grey.
          vec3 grey = vec3( luma ) * vec3( 0.94, 0.96, 0.93 );
          // Then a sickly cast on top, from the same family the fungus
          // materials use, so the trunk and the shelves growing out of it are
          // visibly the same rot rather than two unrelated looks.
          grey = mix( grey, vec3( 0.30, 0.34, 0.20 ), c * 0.45 );
          bark = mix( bark, grey, c * 0.85 );
        }

        diffuseColor.rgb *= bark;
      }
    `,
  );

  // Perturb the normal. This is Three's own bump-map derivation, kept verbatim
  // in shape so that the perturbation stays in view space, where `normal`
  // lives at this point in the shader. Re-deriving it by hand in object space
  // is how the perturbation ends up rotated by the camera.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_maps>',
    /* glsl */ `
      #include <normal_fragment_maps>

      {
        float h = astraBarkHeight( vAstraObject );

        vec3 vSigmaX = dFdx( - vViewPosition );
        vec3 vSigmaY = dFdy( - vViewPosition );
        vec3 vN = normal;
        vec3 R1 = cross( vSigmaY, vN );
        vec3 R2 = cross( vN, vSigmaX );
        float fDet = dot( vSigmaX, R1 );
        // sign(fDet) flips with the winding of the face on screen; without it
        // the ridge lights from the wrong side on every other triangle.
        vec3 vGrad = sign( fDet ) * ( dFdx( h ) * R1 + dFdy( h ) * R2 );
        // abs(fDet) rescales the gradient into the same units as the normal,
        // which is what stops the perturbation strength depending on how
        // close the tree is to the camera.
        vec3 perturbed = normalize( abs( fDet ) * vN - vGrad * uBarkNormalStrength * uPlateDepth );

        // normalize() of a zero vector is undefined in GLSL, and vGrad is
        // exactly zero wherever the bark height is locally flat - which is
        // most of a trunk. The length guard is load-bearing, not defensive.
        float gradLen = length( vGrad );
        if ( gradLen > 1e-8 ) {
          normal = perturbed;
        }
      }
    `,
  );
}

/**
 * Patch the leaf shader pair in place.
 *
 * Exported for the same reason as `patchBarkShader`.
 */
export function patchLeafShader(
  shader: {
    vertexShader: string;
    fragmentShader: string;
    uniforms: Record<string, unknown>;
  },
  options: ResolvedLeaf,
  wind: SharedFloatUniform = { value: 0 },
  gust: SharedFloatUniform = { value: 1 },
): void {
  shader.uniforms.uClusterScale = { value: options.clusterScale };
  shader.uniforms.uLeafCutout = { value: options.cutout };
  shader.uniforms.uLeafSssStrength = { value: options.sssStrength };
  shader.uniforms.uLeafSssPower = { value: options.sssPower };
  shader.uniforms.uNoiseSeed = { value: options.noiseSeed };
  shader.uniforms.uWindTime = wind;
  shader.uniforms.uWindStrength = { value: options.windStrength };
  shader.uniforms.uWindGust = gust;
  // These two are read with `?? 0` rather than taken raw: a caller spreading
  // `{ treeHeight: undefined }` over the defaults would otherwise put
  // `undefined` into the uniform, and `clamp( y / undefined )` is a NaN that
  // silently deletes the entire canopy.
  shader.uniforms.uTreeHeight = { value: options.treeHeight ?? 0 };
  shader.uniforms.uTreeDroop = { value: options.corruptionDroop ?? 0 };
  shader.uniforms.uTreeTwist = { value: options.corruptionTwist ?? 0 };

  /* ---------------------------------------------------------------- vertex */

  // The same block the bark material injects, character for character. The
  // crown and the trunk have to move together or the seam between them shows.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      varying vec3 vAstraObject;
      varying vec3 vAstraObjectNormal;
      attribute float corruption;
      varying float vAstraCorruption;
      uniform float uTreeHeight;
      uniform float uTreeDroop;
      uniform float uTreeTwist;
      ${NOISE_GLSL}
      ${SWAY_GLSL}
    `,
  );

  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    /* glsl */ `
      #include <begin_vertex>
      vAstraObject = transformed;
      vAstraObjectNormal = objectNormal;
      vAstraCorruption = corruption;

      {
        // The canopy droops: the plan's "canopy droops (vertex displacement)"
        // on the trees nearest the stream.
        //
        // The weight is QUADRATIC in the height above the tree's own base, so
        // the trunk does not move at all and only the crown falls. A linear
        // weight bows the whole tree, and a tree that bows from its roots reads
        // as a bendy prop rather than as a dying one.
        //
        // uTreeHeight does two jobs. It normalises the SHAPE of the fall, so
        // the weight is one at every tree's own crown whatever its size, and it
        // scales the MAGNITUDE, so the fall is a fraction of this tree's height
        // rather than a fixed number of metres. Without it a 10 m oak and a 3 m
        // sapling both sink 0.14 m, which flattens the sapling and leaves the
        // oak looking untouched. With it the oak loses 1.4 m and the sapling
        // 0.42 m, and both read as the same wilting.
        //
        // The height is normalised by uTreeHeight rather than by the geometry's
        // bounding box, because the material is shared by every tree of a type
        // and the shader has no access to which type it is drawing.
        float c = clamp( corruption, 0.0, 1.0 );
        if ( c > 0.001 && ( uTreeDroop > 0.0 || uTreeTwist > 0.0 ) ) {
          float h = clamp( transformed.y / max( uTreeHeight, 1e-4 ), 0.0, 1.0 );
          if ( uTreeDroop > 0.0 ) {
            float fall = c * uTreeDroop * uTreeHeight * h * h;
            transformed.y -= fall;
            // And the crown closes up as it falls, so the silhouette narrows. A
            // crown that only sinks keeps its spread and reads as a smaller tree
            // rather than a wilting one.
            transformed.xz *= 1.0 - c * 0.12 * h * h;
          }
          if ( uTreeTwist > 0.0 ) {
            // The crown twists: the plan's "twisted trees" in the inner zone. A
            // trunk that spirals reads as something that grew wrong rather than
            // as something that was broken, which is a different story from the
            // droop's.
            //
            // The rotation is about the tree's own axis through its base, and
            // its angle grows with the height, so the trunk does not move and
            // only the crown turns. Applied to the canopy alone and never to the
            // bark: the trunk collider is a straight vertical capsule, and a
            // trunk that visibly spiralled away from it would be a collision bug
            // rather than a look.
            float twist = c * uTreeTwist * h;
            float ts = sin( twist );
            float tc = cos( twist );
            transformed.xz = vec2(
              transformed.x * tc - transformed.z * ts,
              transformed.x * ts + transformed.z * tc
            );
          }
        }
      }

      {
        vec3 instanceOrigin = modelMatrix[ 3 ].xyz;
        #ifdef USE_INSTANCING
          instanceOrigin += instanceMatrix[ 3 ].xyz;
        #endif
        vec2 offset = astraSway( max( transformed.y, 0.0 ), instanceOrigin );
        transformed.x += offset.x;
        transformed.z += offset.y;
      }
    `,
  );

  /* -------------------------------------------------------------- fragment */

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    /* glsl */ `
      #include <common>
      varying vec3 vAstraObject;
      varying vec3 vAstraObjectNormal;
      varying float vAstraCorruption;
      uniform float uClusterScale;
      uniform float uLeafCutout;
      uniform float uLeafSssStrength;
      uniform float uLeafSssPower;
      uniform float uNoiseSeed;

      ${NOISE_GLSL}

      // Leaf-cluster mask in object space, 0 where there is no leaf and 1 in
      // the middle of a clump.
      //
      // Two octaves of fbm at two scales: the low frequency decides where the
      // clumps are, the high one breaks their edges up. A single octave gives
      // smooth blobs that read as foam balls.
      float astraLeafMask( vec3 p ) {
        float low = astraFbm2D( p * uClusterScale, uNoiseSeed + 1.0, 2, 2.0, 0.5, true );
        float high = astraFbm2D( p * uClusterScale * 3.7, uNoiseSeed + 5.0, 2, 2.0, 0.5, true );
        return clamp( low * 0.65 + high * 0.35, 0.0, 1.0 );
      }
    `,
  );

  // Write the mask into the alpha. Three emits the discard for `alphaTest`, so
  // nothing else is needed and the crown stays in the opaque pass.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    /* glsl */ `
      #include <map_fragment>

      {
        // The mask is centred on zero, so it has to be biased before it can be
        // thresholded: a raw fbm is negative half the time and would discard
        // half the crown for no visible reason.
        float mask = astraLeafMask( vAstraObject ) * 0.5 + 0.5;
        diffuseColor.a = smoothstep( 1.0 - uLeafCutout, 1.0 - uLeafCutout + 0.12, mask );

        // A slight darkening toward the cut edges, so a hole reads as a gap
        // between leaves with shade in it rather than as a punched-out hole
        // with sky showing through.
        diffuseColor.rgb *= 0.82 + 0.18 * smoothstep( 0.0, 0.35, mask );

        // Undersides of leaves are in shade. The object normal is used rather
        // than the world normal because the tree's own up is what a leaf hangs
        // from, and the instance rotation would otherwise swing the term
        // around with the tree.
        float up = clamp( vAstraObjectNormal.y * 0.5 + 0.5, 0.0, 1.0 );
        diffuseColor.rgb *= 0.72 + 0.28 * up;

        // The plan's "vegetation: desaturated, yellowed leaf color".
        //
        // Toward the leaf's own luma first and then toward a yellow cast, for
        // the same reason the bark goes toward its own luma: a crown that only
        // gets darker reads as unlit, and a crown that only gets more saturated
        // reads as a different tree. What has to read is the same tree going
        // over.
        float c = clamp( vAstraCorruption, 0.0, 1.0 );
        if ( c > 0.001 ) {
          float luma = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          vec3 yellowed = vec3( luma * 1.22, luma * 1.02, luma * 0.42 );
          // A grey-green at the far end, so a fully corrupted crown is not
          // merely yellow but visibly unwell.
          yellowed = mix( yellowed, vec3( luma * 0.62, luma * 0.70, luma * 0.40 ), c * 0.6 );
          diffuseColor.rgb = mix( diffuseColor.rgb, yellowed, c * 0.75 );
        }
      }
    `,
  );

  // The subsurface lift. This runs at `<normal_fragment_maps>` rather than at
  // `<map_fragment>` because `normal` does not exist until
  // `<normal_fragment_begin>` has run, and the lift is a function of it.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_maps>',
    /* glsl */ `
      #include <normal_fragment_maps>

      {
        // vViewPosition points from the fragment toward the eye, so this is
        // 1 head-on and 0 edge-on.
        vec3 viewDir = normalize( vViewPosition );
        float facing = abs( dot( normal, viewDir ) );
        float sss = pow( clamp( 1.0 - facing, 0.0, 1.0 ), uLeafSssPower ) * uLeafSssStrength;
        // Added as emission, not as albedo: an albedo lift would brighten the
        // crown uniformly and read as a lighter green, whereas the whole point
        // is that the glow only appears where the leaf is seen edge-on.
        totalEmissiveRadiance += diffuseColor.rgb * sss;
      }
    `,
  );
}

/**
 * The shader sources `patchBarkShader` produces for a given option set.
 *
 * Exposed so tests can assert on the injected GLSL without a GPU.
 */
export function barkShaderSources(options: BarkMaterialOptions = {}): {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, unknown>;
} {
  const shader = {
    vertexShader: BASELINE_VERTEX_SHADER,
    fragmentShader: BASELINE_FRAGMENT_SHADER,
    uniforms: {} as Record<string, unknown>,
  };
  patchBarkShader(
    shader,
    { ...DEFAULT_BARK_MATERIAL_OPTIONS, ...options },
    options.windUniform,
    options.windStrengthUniform,
  );
  return shader;
}

/** The shader sources `patchLeafShader` produces for a given option set. */
export function leafShaderSources(options: LeafMaterialOptions = {}): {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, unknown>;
} {
  const shader = {
    vertexShader: BASELINE_VERTEX_SHADER,
    fragmentShader: BASELINE_FRAGMENT_SHADER,
    uniforms: {} as Record<string, unknown>,
  };
  patchLeafShader(
    shader,
    { ...DEFAULT_LEAF_MATERIAL_OPTIONS, ...options },
    options.windUniform,
    options.windStrengthUniform,
  );
  return shader;
}

/**
 * Stand-ins carrying only the chunks the patches anchor on. The patches
 * replace the `#include` lines and leave everything else untouched, so these
 * need to contain the anchors, not be valid shaders.
 *
 * The real standard-material fragment shader declares `vViewPosition` before
 * `<map_fragment>`, which is why it appears here too: the leaf patch reads it,
 * and a baseline that omitted it would let a missing declaration through.
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
