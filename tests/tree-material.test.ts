import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parser } from '@shaderfrog/glsl-parser';
import {
  createBarkMaterial,
  createLeafMaterial,
  patchBarkShader,
  patchLeafShader,
  barkShaderSources,
  leafShaderSources,
  DEFAULT_BARK_MATERIAL_OPTIONS,
  DEFAULT_LEAF_MATERIAL_OPTIONS,
  BARK_PROGRAM_KEY,
  LEAF_PROGRAM_KEY,
  type BarkMaterialOptions,
  type LeafMaterialOptions,
} from '../src/procedural/TreeMaterial';

/** Apply a patch to Three's own standard-material sources. */
function patched(
  patch: (shader: {
    vertexShader: string;
    fragmentShader: string;
    uniforms: Record<string, unknown>;
  }) => void,
): { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> } {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {} as Record<string, unknown>,
  };
  patch(shader);
  return shader;
}

/**
 * Every `uniform T name;` declaration in a shader source, optionally filtered
 * to the ones the ASTRA patches declare.
 *
 * The filter matters: Three's own standard shader declares `diffuse`,
 * `opacity`, `roughness` and a dozen more, and those are set by the renderer
 * from the material's properties rather than through `shader.uniforms`. An
 * unfiltered reverse check would demand a uniform for every one of them.
 */
/** Resolve options against a patch's own defaults, exactly as the patch does. */
function barkOptions(
  o: BarkMaterialOptions = {},
): Required<Omit<BarkMaterialOptions, 'windUniform' | 'windStrengthUniform'>> {
  return { ...DEFAULT_BARK_MATERIAL_OPTIONS, ...o };
}
function leafOptions(
  o: LeafMaterialOptions = {},
): Required<Omit<LeafMaterialOptions, 'windUniform' | 'windStrengthUniform'>> {
  return { ...DEFAULT_LEAF_MATERIAL_OPTIONS, ...o };
}

function declaredUniforms(src: string, only = /^$/): string[] {
  const out: string[] = [];
  const re = /uniform\s+\w+\s+(\w+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) if (only.test(m[1])) out.push(m[1]);
  return out;
}

/** Every `varying T name;` declaration, optionally filtered the same way. */
function declaredVaryings(src: string, only = /^$/): string[] {
  const out: string[] = [];
  const re = /varying\s+\w+\s+(\w+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) if (only.test(m[1])) out.push(m[1]);
  return out;
}

/**
 * The symbols the ASTRA patches own.
 *
 * Three's own standard-material uniforms are named after the property they
 * carry - `diffuse`, `opacity`, `roughness`, `map` - and never with a `u`
 * prefix, while every uniform this module declares starts with one. That makes
 * `/^u/` an exact filter rather than a heuristic.
 */
const ASTRA_UNIFORM = /^u/;
const ASTRA_VARYING = /^vAstra/;

/** Every function definition name in a shader source. */
function definedFunctions(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:\w+\s+)*?(\w+)\s*\([^;]*\)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe('bark material', () => {
  it('is a standard material with a patch and a cache key', () => {
    const material = createBarkMaterial();
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(typeof material.onBeforeCompile).toBe('function');
    expect(material.customProgramCacheKey()).toBe(BARK_PROGRAM_KEY);
    // The dead tree's bark and its fungal clusters are vertex-coloured.
    expect(material.vertexColors).toBe(true);
    // Opaque, front side only: the tube is closed at the tip and buried at
    // the base, so the inside is never visible.
    expect(material.transparent).toBe(false);
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.alphaTest).toBe(0);
  });

  it('declares every uniform it sets, exactly once', () => {
    const shader = patched((s) => patchBarkShader(s, { ...DEFAULT_BARK_MATERIAL_OPTIONS }));
    const set = Object.keys(shader.uniforms);
    const declared = declaredUniforms(shader.vertexShader, ASTRA_UNIFORM).concat(
      declaredUniforms(shader.fragmentShader, ASTRA_UNIFORM),
    );
    for (const name of set) {
      // The wind uniforms are declared once in the shared sway block; the rest
      // once at their own injection site. Anything more is a redefinition, and
      // GLSL rejects the whole program rather than warning about it.
      const count = declared.filter((d) => d === name).length;
      expect(count, `uniform ${name} declared ${count} times`).toBe(1);
    }
    // And nothing ASTRA declares that is never set, which would read as zero.
    for (const name of new Set(declared)) {
      expect(set, `uniform ${name} is declared but never set`).toContain(name);
    }
  });

  it('declares each varying in the vertex and the fragment shader alike', () => {
    const shader = patched((s) => patchBarkShader(s, { ...DEFAULT_BARK_MATERIAL_OPTIONS }));
    // Only the varyings this module adds. Three declares some of its own under
    // #ifdef, so counting the whole shader would fail on Three's behalf.
    const v = declaredVaryings(shader.vertexShader, ASTRA_VARYING);
    const f = declaredVaryings(shader.fragmentShader, ASTRA_VARYING);
    expect(v.length).toBeGreaterThan(0);
    expect(v).toEqual(f);
  });

  it('injects the bark height field and the sway function', () => {
    const src = barkShaderSources();
    expect(src.fragmentShader).toContain('astraBarkHeight');
    expect(src.fragmentShader).toContain('astraVoronoi2D');
    expect(src.vertexShader).toContain('astraSway');
    // The plates come from an XZ Voronoi lookup, so they are vertical columns.
    // Sampling y as well would turn every plate into a blob.
    expect(src.fragmentShader).toContain('astraVoronoi2D( p.xz * uPlateScale');
  });

  it('parses as GLSL inside Three real standard-material shaders', () => {
    // The only way to catch a syntax error in injected GLSL without a GPU. A
    // mistyped anchor fails silently at build time and produces a black tree.
    const problems: string[] = [];
    for (const [name, shader] of [
      ['bark', patched((s) => patchBarkShader(s, { ...DEFAULT_BARK_MATERIAL_OPTIONS }))],
      ['leaf', patched((s) => patchLeafShader(s, { ...DEFAULT_LEAF_MATERIAL_OPTIONS }))],
    ] as const) {
      for (const [kind, src] of [
        ['vertex', shader.vertexShader],
        ['fragment', shader.fragmentShader],
      ] as const) {
        try {
          parser.parse(src, { quiet: true });
        } catch (e) {
          problems.push(`${name}/${kind}: ${(e as Error).message}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('perturbs the normal with Three own bump-map derivation', () => {
    const src = barkShaderSources();
    // cross products of dFdx/dFdy of the view position, so the perturbation
    // stays in view space where `normal` lives at that point.
    expect(src.fragmentShader).toContain('dFdx( - vViewPosition )');
    expect(src.fragmentShader).toContain('cross( vSigmaY, vN )');
    // sign(fDet) flips with the on-screen winding; without it the ridge lights
    // from the wrong side on every other triangle.
    expect(src.fragmentShader).toContain('sign( fDet )');
    // normalize() of a zero vector is undefined in GLSL and the gradient is
    // exactly zero wherever the bark is locally flat, which is most of a trunk.
    expect(src.fragmentShader).toContain('if ( gradLen > 1e-8 )');
  });

  it('modulates the vertex colour rather than overwriting it', () => {
    const src = barkShaderSources();
    // diffuseColor.rgb *= ... keeps the dead tree's grey bark grey, and its
    // green fungal clusters green.
    expect(src.fragmentShader).toMatch(/diffuseColor\.rgb \*=\s*bark/);
  });

  it('routes the option values into uniforms', () => {
    const options: BarkMaterialOptions = {
      plateScale: 2.5,
      plateDepth: 0.4,
      normalStrength: 0.3,
      colorVariation: 0.5,
      noiseSeed: 12,
      roughness: 0.5,
      metalness: 0.2,
      windStrength: 0.02,
    };
    const shader = patched((s) => patchBarkShader(s, { ...DEFAULT_BARK_MATERIAL_OPTIONS, ...options }));
    expect(shader.uniforms.uPlateScale).toEqual({ value: 2.5 });
    expect(shader.uniforms.uPlateDepth).toEqual({ value: 0.4 });
    expect(shader.uniforms.uBarkNormalStrength).toEqual({ value: 0.3 });
    expect(shader.uniforms.uBarkColorVariation).toEqual({ value: 0.5 });
    expect(shader.uniforms.uNoiseSeed).toEqual({ value: 12 });

    const material = createBarkMaterial(options);
    expect(material.roughness).toBe(0.5);
    expect(material.metalness).toBe(0.2);
  });

  it('takes defaults for anything omitted', () => {
    const shader = patched((s) => patchBarkShader(s, { ...DEFAULT_BARK_MATERIAL_OPTIONS }));
    expect(shader.uniforms.uPlateScale).toEqual({ value: DEFAULT_BARK_MATERIAL_OPTIONS.plateScale });
    expect(shader.uniforms.uNoiseSeed).toEqual({ value: DEFAULT_BARK_MATERIAL_OPTIONS.noiseSeed });
  });
});

describe('leaf material', () => {
  it('is a standard material that alpha-tests and shows both sides', () => {
    const material = createLeafMaterial();
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material.vertexColors).toBe(true);
    // A hard threshold, not a blend: the crown stays in the opaque pass and
    // keeps correct depth sorting against itself.
    expect(material.transparent).toBe(false);
    expect(material.alphaTest).toBeGreaterThan(0);
    expect(material.alphaTest).toBeLessThan(1);
    // The cutouts open windows through the crown, and through a window you
    // see the far wall of the blob rather than the sky.
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.customProgramCacheKey()).toBe(LEAF_PROGRAM_KEY);
  });

  it('declares every uniform it sets, exactly once', () => {
    const shader = patched((s) => patchLeafShader(s, { ...DEFAULT_LEAF_MATERIAL_OPTIONS }));
    const set = Object.keys(shader.uniforms);
    const declared = declaredUniforms(shader.vertexShader, ASTRA_UNIFORM).concat(
      declaredUniforms(shader.fragmentShader, ASTRA_UNIFORM),
    );
    for (const name of set) {
      const count = declared.filter((d) => d === name).length;
      expect(count, `uniform ${name} declared ${count} times`).toBe(1);
    }
    for (const name of new Set(declared)) {
      expect(set, `uniform ${name} is declared but never set`).toContain(name);
    }
  });

  it('declares each varying in the vertex and the fragment shader alike', () => {
    const shader = patched((s) => patchLeafShader(s, { ...DEFAULT_LEAF_MATERIAL_OPTIONS }));
    const v = declaredVaryings(shader.vertexShader, ASTRA_VARYING);
    const f = declaredVaryings(shader.fragmentShader, ASTRA_VARYING);
    expect(v.length).toBeGreaterThan(0);
    expect(v).toEqual(f);
  });

  it('writes the cluster mask into the alpha for Three own alphatest', () => {
    const src = leafShaderSources();
    expect(src.fragmentShader).toContain('astraLeafMask');
    // Biased before thresholding: a raw fbm is negative half the time and
    // would discard half the crown for no visible reason.
    expect(src.fragmentShader).toMatch(/diffuseColor\.a\s*=\s*smoothstep/);
    // The discard itself is Three's, driven by the material's alphaTest.
    expect(THREE.ShaderLib.physical.fragmentShader).toContain('#include <alphatest_fragment>');
  });

  it('adds the subsurface lift where the normal exists', () => {
    const src = leafShaderSources();
    // The lift needs `normal`, which does not exist until
    // <normal_fragment_begin> has run - so it cannot live at <map_fragment>.
    expect(src.fragmentShader).toContain('totalEmissiveRadiance +=');
    expect(src.fragmentShader).toContain('abs( dot( normal, viewDir ) )');
    expect(src.fragmentShader).toContain('vViewPosition');
    // Added as emission rather than albedo: an albedo lift would brighten the
    // crown uniformly and read as a lighter green.
    expect(src.fragmentShader).not.toMatch(/diffuseColor\.rgb \+= diffuseColor\.rgb \* sss/);
  });

  it('shades the undersides of leaves', () => {
    const src = leafShaderSources();
    // From the OBJECT normal, so the term does not swing around with the
    // tree's instance rotation.
    expect(src.fragmentShader).toContain('vAstraObjectNormal.y');
  });

  it('routes the option values into uniforms', () => {
    const options: LeafMaterialOptions = {
      clusterScale: 5,
      cutout: 0.5,
      sssStrength: 0.2,
      sssPower: 4,
      noiseSeed: 9,
      roughness: 0.4,
      metalness: 0.1,
      windStrength: 0.01,
    };
    const shader = patched((s) => patchLeafShader(s, { ...DEFAULT_LEAF_MATERIAL_OPTIONS, ...options }));
    expect(shader.uniforms.uClusterScale).toEqual({ value: 5 });
    expect(shader.uniforms.uLeafCutout).toEqual({ value: 0.5 });
    expect(shader.uniforms.uLeafSssStrength).toEqual({ value: 0.2 });
    expect(shader.uniforms.uLeafSssPower).toEqual({ value: 4 });
    expect(shader.uniforms.uNoiseSeed).toEqual({ value: 9 });

    const material = createLeafMaterial(options);
    expect(material.roughness).toBe(0.4);
    expect(material.metalness).toBe(0.1);
  });

  it('keeps the leaf ramp to the vertex colours', () => {
    // The green-to-yellow gradient is baked by TreeGenerator, so the material
    // must not re-tint the crown. It only ever multiplies.
    const src = leafShaderSources();
    expect(src.fragmentShader).toMatch(/diffuseColor\.rgb \*=/);
    expect(src.fragmentShader).not.toMatch(/diffuseColor\.rgb\s*=\s*vec3/);
  });
});

describe('shared wind', () => {
  it('moves the trunk and the crown with one function', () => {
    const bark = barkShaderSources();
    const leaf = leafShaderSources();
    // Character for character: two slightly different sway functions put the
    // crown beside the branch that holds it.
    const swayOf = (src: string): string => {
      const start = src.indexOf('vec2 astraSway(');
      const end = src.indexOf('}', src.indexOf('return dir * amp;', start)) + 1;
      return src.slice(start, end);
    };
    expect(swayOf(bark.vertexShader)).toBe(swayOf(leaf.vertexShader));
  });

  it('shares one time uniform between the two materials', () => {
    const wind = { value: 0 };
    const barkStub = { vertexShader: '', fragmentShader: '', uniforms: {} as Record<string, unknown> };
    const leafStub = { vertexShader: '', fragmentShader: '', uniforms: {} as Record<string, unknown> };
    patchBarkShader(barkStub, { ...DEFAULT_BARK_MATERIAL_OPTIONS }, wind);
    patchLeafShader(leafStub, { ...DEFAULT_LEAF_MATERIAL_OPTIONS }, wind);
    // The SAME object, not two objects holding the same number: one write has
    // to move both materials, or the crown drifts out of its branches.
    expect(barkStub.uniforms.uWindTime).toBe(wind);
    expect(leafStub.uniforms.uWindTime).toBe(wind);
    const barkTime = (barkStub.uniforms.uWindTime as { value: number }).value;
    const leafTime = (leafStub.uniforms.uWindTime as { value: number }).value;

    expect(barkTime).toBe(0);
    expect(leafTime).toBe(0);
    wind.value = 3.5;
    expect((barkStub.uniforms.uWindTime as { value: number }).value).toBe(3.5);
    expect((leafStub.uniforms.uWindTime as { value: number }).value).toBe(3.5);
  });

  it('plants the trunk by making the amplitude quadratic in height', () => {
    const src = barkShaderSources();
    // h * h, not h: a linear ramp shears the trunk sideways at the base.
    expect(src.vertexShader).toContain('h * h');
    expect(src.vertexShader).toContain('max( transformed.y, 0.0 )');
  });

  it('phases the sway off the instance world position', () => {
    const src = barkShaderSources();
    // instanceMatrix carries the translation for an InstancedMesh; modelMatrix
    // carries the mesh's own. Without the sum, every tree sways in step.
    expect(src.vertexShader).toContain('instanceMatrix[ 3 ].xyz');
    expect(src.vertexShader).toContain('modelMatrix[ 3 ].xyz');
    expect(src.vertexShader).toContain('#ifdef USE_INSTANCING');
  });

  it('disables the sway when the strength is zero', () => {
    const src = barkShaderSources({ windStrength: 0 });
    expect(src.uniforms.uWindStrength).toEqual({ value: 0 });
    // amp is strength * gust * h * h * 0.012, so zero strength is zero
    // amplitude whatever the gust happens to be doing.
    expect(src.vertexShader).toContain('uWindStrength * uWindGust * h * h * 0.012');
  });
});

describe('the shared gust multiplier', () => {
  it('defaults to one, so a forest built without one sways exactly as before', () => {
    // This is the compatibility guarantee. Every material created without an
    // explicit gust gets its own { value: 1 } object, which is the identity for
    // the multiplication - so Step 2.8 added a dimension to the wind without
    // changing the behaviour of anything that does not use it.
    for (const src of [barkShaderSources(), leafShaderSources()]) {
      expect(src.uniforms.uWindGust).toEqual({ value: 1 });
    }
  });

  it('shares one object between the two materials when one is passed', () => {
    const gust = { value: 0.4 };
    const bark = patched((s) => patchBarkShader(s, barkOptions(), { value: 0 }, gust));
    const leaf = patched((s) => patchLeafShader(s, leafOptions(), { value: 0 }, gust));
    // Identity, not equality: two { value: 0.4 } objects would pass an equality
    // check and still be two gusts.
    expect(bark.uniforms.uWindGust).toBe(leaf.uniforms.uWindGust);
    expect(bark.uniforms.uWindGust).toBe(gust);
  });

  it('scales the sway amplitude linearly in both materials', () => {
    // The point of the gust is that it scales the whole amplitude rather than
    // adding to it, so a calm moment is the same wind, quieter. A test that only
    // checked that the uniform exists would not catch an additive
    // implementation, which would make a calm moment lean sideways instead.
    for (const [name, src] of [
      ['bark', barkShaderSources()],
      ['leaf', leafShaderSources()],
    ] as const) {
      // Every line that mentions the gust. Matching the lines rather than a
      // hardcoded expression keeps this honest if the sway maths is retuned:
      // what is being asserted is that each use is a multiplication, not what
      // it is multiplied into.
      // Comments are stripped first: the sway block's own documentation names
      // the uniform, and a prose line is not an implementation.
      const lines = src.vertexShader
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .filter((l) => l.includes('uWindGust'));
      expect(lines.length, `${name} uses the gust`).toBeGreaterThan(0);
      for (const line of lines) {
        // The declaration itself carries no arithmetic, so it is exempt.
        if (/uniform\s+float\s+uWindGust\s*;/.test(line)) continue;
        expect(line, `${name} multiplies by the gust`).toMatch(/\*\s*uWindGust/);
        expect(line, `${name} does not add to the gust`).not.toMatch(/[+-]\s*uWindGust/);
      }
    }
  });
});

describe('injected symbol hygiene', () => {
  it('defines every astra function it calls', () => {
    for (const src of [barkShaderSources(), leafShaderSources()]) {
      for (const shader of [src.vertexShader, src.fragmentShader]) {
        const defined = new Set(definedFunctions(shader));
        const calls = new Set<string>();
        const re = /\b(astra\w+)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(shader)) !== null) calls.add(m[1]);
        for (const call of calls) {
          expect(defined.has(call), `${call} is called but not defined`).toBe(true);
        }
      }
    }
  });

  it('prefixes every injected symbol with astra', () => {
    // The one exception is the wind uniforms, which are declared in the shared
    // sway block and named uWind* because both materials must agree on them.
    for (const src of [barkShaderSources(), leafShaderSources()]) {
      for (const shader of [src.vertexShader, src.fragmentShader]) {
        for (const name of declaredUniforms(shader)) {
          expect(ASTRA_UNIFORM.test(name), `uniform ${name} is not astra-prefixed`).toBe(true);
        }
        for (const name of declaredVaryings(shader)) {
          expect(ASTRA_VARYING.test(name), `varying ${name} is not astra-prefixed`).toBe(true);
        }
      }
    }
  });

  it('does not re-declare anything Three already declares', () => {
    // vViewPosition is declared by Three's own fragment shader before
    // <map_fragment>. Declaring it again is a redefinition.
    const baseline = THREE.ShaderLib.physical.fragmentShader;
    const existing = new Set([
      ...declaredUniforms(baseline),
      ...declaredVaryings(baseline),
      ...definedFunctions(baseline),
    ]);
    for (const src of [barkShaderSources(), leafShaderSources()]) {
      for (const shader of [src.fragmentShader, src.vertexShader]) {
        for (const name of declaredUniforms(shader, ASTRA_UNIFORM)) {
          expect(existing.has(name), `uniform ${name} collides with a Three declaration`).toBe(false);
        }
        for (const name of declaredVaryings(shader, ASTRA_VARYING)) {
          expect(existing.has(name), `varying ${name} collides with a Three declaration`).toBe(false);
        }
      }
    }
  });
});
