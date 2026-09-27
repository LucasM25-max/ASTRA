import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parser } from '@shaderfrog/glsl-parser';
import {
  createFoliageMaterial,
  patchFoliageShader,
  foliageShaderSources,
  DEFAULT_FOLIAGE_MATERIAL_OPTIONS,
  FOLIAGE_MATERIAL_PROGRAM_KEY,
} from '../src/procedural/FoliageMaterial';
import { FOLIAGE_KINDS, GRASS_HEIGHT, FERN_HEIGHT, BUSH_RADIUS } from '../src/procedural/FoliageGenerator';

/** Apply a patch to Three's own standard-material sources. */
function patched(
  kind: (typeof FOLIAGE_KINDS)[number],
): { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> } {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {} as Record<string, unknown>,
  };
  patchFoliageShader(shader, kind, { ...DEFAULT_FOLIAGE_MATERIAL_OPTIONS });
  return shader;
}

/** Every `uniform T name;` declaration, filtered to the ASTRA ones. */
function declaredUniforms(src: string): string[] {
  const out: string[] = [];
  const re = /uniform\s+\w+\s+(\w+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) if (/^u/.test(m[1])) out.push(m[1]);
  return out;
}

/** Every `varying T name;` declaration, filtered to the ASTRA ones. */
function declaredVaryings(src: string): string[] {
  const out: string[] = [];
  const re = /varying\s+\w+\s+(\w+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) if (/^vAstra/.test(m[1])) out.push(m[1]);
  return out;
}

/** Every function definition name. */
function definedFunctions(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:\w+\s+)*?(\w+)\s*\([^;]*\)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe('foliage material factory', () => {
  it('builds a standard material for every kind', () => {
    for (const kind of FOLIAGE_KINDS) {
      const material = createFoliageMaterial(kind);
      expect(material, kind).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect(typeof material.onBeforeCompile, kind).toBe('function');
      // Distinct per kind, so Three never reuses a program compiled for one
      // kind of plant while drawing another.
      expect(material.customProgramCacheKey(), kind).toContain(kind);
      expect(material.customProgramCacheKey(), kind).toContain(FOLIAGE_MATERIAL_PROGRAM_KEY);
      // Never blended: everything is opaque or alpha-tested, and both keep the
      // material out of the transparent pass.
      expect(material.transparent, kind).toBe(false);
      expect(material.vertexColors, kind).toBe(true);
    }
  });

  it('alpha-tests ferns only', () => {
    for (const kind of FOLIAGE_KINDS) {
      const material = createFoliageMaterial(kind);
      if (kind === 'fern') {
        expect(material.alphaTest).toBeGreaterThan(0);
        expect(material.alphaTest).toBeLessThan(1);
      } else {
        expect(material.alphaTest).toBe(0);
      }
    }
  });

  it('shows both sides of a ribbon and one side of a solid', () => {
    // A grass blade is a flat ribbon: invisible edge-on unless the material is
    // double-sided. A rock is solid: the inside is never visible, and half the
    // fragments is half the cost.
    expect(createFoliageMaterial('grass').side).toBe(THREE.DoubleSide);
    expect(createFoliageMaterial('fern').side).toBe(THREE.DoubleSide);
    expect(createFoliageMaterial('leaf').side).toBe(THREE.DoubleSide);
    expect(createFoliageMaterial('undergrowth').side).toBe(THREE.FrontSide);
    expect(createFoliageMaterial('rock').side).toBe(THREE.FrontSide);
    expect(createFoliageMaterial('branch').side).toBe(THREE.FrontSide);
  });

  it('moves grass, ferns and undergrowth but not rocks, branches or litter', () => {
    const moving = ['grass', 'fern', 'undergrowth'];
    const still = ['rock', 'branch', 'leaf'];
    for (const kind of FOLIAGE_KINDS) {
      const shader = patched(kind);
      const strength = (shader.uniforms.uWindStrength as { value: number }).value;
      if (moving.includes(kind)) expect(strength, kind).toBeGreaterThan(0);
      if (still.includes(kind)) expect(strength, kind).toBe(0);
    }
  });

  it('scales the wind to each plant own height', () => {
    // A bush sways far less than a blade of grass, and a fern in between: the
    // strengths are fractions of each plant's own height, not one global value.
    const grass = (patched('grass').uniforms.uFoliageHeight as { value: number }).value;
    const fern = (patched('fern').uniforms.uFoliageHeight as { value: number }).value;
    const bush = (patched('undergrowth').uniforms.uFoliageHeight as { value: number }).value;
    expect(grass).toBeCloseTo(GRASS_HEIGHT, 6);
    expect(fern).toBeCloseTo(FERN_HEIGHT, 6);
    expect(bush).toBeCloseTo(BUSH_RADIUS * 1.6, 6);
  });
});

describe('foliage wind shader', () => {
  it('weights the displacement by height up the plant', () => {
    const src = foliageShaderSources('grass');
    expect(src.vertexShader).toContain('objectPos.y / max( uFoliageHeight, 1e-4 )');
    // The guard matters: a zero uFoliageHeight would divide by zero and the
    // whole displacement would become NaN, which silently deletes the plant.
    expect(src.vertexShader).toContain('max( uFoliageHeight, 1e-4 )');
  });

  it('plants the base by making the weight quadratic', () => {
    const src = foliageShaderSources('grass');
    // w * w * 0.75 + w * 0.25 leaves a little linear term, but the dominant
    // part is quadratic, so the base is still fixed.
    expect(src.vertexShader).toContain('w * w * 0.75 + w * 0.25');
  });

  it('keys the gust on the instance world position', () => {
    const src = foliageShaderSources('grass');
    expect(src.vertexShader).toContain('instanceOrigin.xz * 0.055');
    expect(src.vertexShader).toContain('instanceMatrix[ 3 ].xyz');
    expect(src.vertexShader).toContain('modelMatrix[ 3 ].xyz');
    expect(src.vertexShader).toContain('#ifdef USE_INSTANCING');
  });

  it('flutters individual blades out of step', () => {
    const src = foliageShaderSources('grass');
    // Keyed on the blade's own position at a much higher frequency than the
    // gust: without it the field moves as one sheet, which is the most
    // recognisable tell of a cheap wind shader.
    expect(src.vertexShader).toContain('objectPos.xz * 7.0');
    expect(src.vertexShader).toContain('uFlutterStrength');
  });

  it('drops the tip as it swings', () => {
    const src = foliageShaderSources('grass');
    // Otherwise the plant stretches as it leans, and a blade that grows a
    // centimetre every gust is worse than one that does not move at all.
    expect(src.vertexShader).toContain('transformed.y -= length( offset ) * 0.3');
  });

  it('shares one time uniform across every material', () => {
    const wind = { value: 0 };
    const stubs = FOLIAGE_KINDS.map((kind) => {
      const s = { vertexShader: '', fragmentShader: '', uniforms: {} as Record<string, unknown> };
      patchFoliageShader(s, kind, { ...DEFAULT_FOLIAGE_MATERIAL_OPTIONS }, wind);
      return s;
    });
    for (const s of stubs) expect(s.uniforms.uWindTime).toBe(wind);
    wind.value = 2.25;
    for (const s of stubs) expect((s.uniforms.uWindTime as { value: number }).value).toBe(2.25);
  });
});

describe('foliage alpha and tint', () => {
  it('carves the fern with vertical bands', () => {
    const src = foliageShaderSources('fern');
    expect(src.fragmentShader).toContain('astraFernMask');
    // Sampled along y ALONE: two dimensions gives blobs, and blobs are foam
    // balls rather than a fern.
    expect(src.fragmentShader).toContain('astraSimplex2D( vec2( h * 22.0, 0.0 )');
  });

  it('trims the fern radially, so both crossed planes are cut alike', () => {
    const src = foliageShaderSources('fern');
    // |x| alone would leave one plane untouched and the other a sliver.
    expect(src.fragmentShader).toContain('length( p.xz ) / max( halfWidth, 1e-4 )');
  });

  it('emits the fern mask only for ferns', () => {
    for (const kind of FOLIAGE_KINDS) {
      const src = foliageShaderSources(kind);
      if (kind === 'fern') expect(src.fragmentShader).toContain('astraFernMask');
      else expect(src.fragmentShader).not.toContain('astraFernMask');
    }
  });

  it('anchors the fern mask to the frond before the wind moves it', () => {
    const src = foliageShaderSources('fern');
    // Captured before the offset is applied, or the mask would slide across
    // the frond as it swayed.
    const vertex = src.vertexShader;
    const captureAt = vertex.indexOf('vAstraFoliageObject = transformed;');
    const windAt = vertex.indexOf('astraFoliageWind( position');
    expect(captureAt).toBeGreaterThan(-1);
    expect(windAt).toBeGreaterThan(-1);
    expect(captureAt).toBeLessThan(windAt);
  });

  it('makes a tint strength of zero exactly a no-op', () => {
    // Mixing against white, not scaling: a strength of zero has to leave the
    // vertex colour alone.
    const src = foliageShaderSources('grass', { tintStrength: 0 });
    expect(src.fragmentShader).toContain('mix( vec3( 1.0 ), mix( fresh, dry, v ), uFoliageTint )');
  });

  it('reads the per-instance tint from an instanced attribute', () => {
    const src = foliageShaderSources('grass');
    expect(src.vertexShader).toContain('attribute float aVariation;');
    expect(src.vertexShader).toContain('vAstraVariation = aVariation;');
    expect(src.fragmentShader).toContain('vAstraVariation');
  });
});

describe('foliage corruption', () => {
  it('declares the corruption attribute and its varying', () => {
    for (const kind of FOLIAGE_KINDS) {
      const shader = patched(kind);
      if (kind === 'rock') {
        // The rock declares none of it: a stone does not die, and a varying
        // nobody reads is a warning on some drivers and dead weight on all.
        expect(shader.vertexShader).not.toContain('attribute float corruption;');
        expect(shader.fragmentShader).not.toContain('vAstraCorruption');
        continue;
      }
      expect(shader.vertexShader.match(/attribute float corruption;/g)?.length).toBe(1);
      expect(shader.vertexShader.match(/varying float vAstraCorruption;/g)?.length).toBe(1);
      expect(shader.fragmentShader.match(/varying float vAstraCorruption;/g)?.length).toBe(1);
      expect(shader.fragmentShader).toContain('uniform float uFoliageCorruption;');
    }
  });

  it('writes the varying before the wind moves the vertex', () => {
    const v = patched('grass').vertexShader;
    const write = v.indexOf('vAstraCorruption = corruption;');
    // The CALL, not the definition: `astraFoliageWind` is declared in
    // `<common>`, which is injected before `<begin_vertex>`, so searching for
    // the bare name finds the function and not the place it is used.
    const call = v.indexOf('= astraFoliageWind(');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(write);
  });

  it('desaturates every living kind toward its own luma and yellows it', () => {
    for (const kind of FOLIAGE_KINDS) {
      if (kind === 'rock') continue;
      const f = patched(kind).fragmentShader;
      const block = f.slice(f.indexOf('#include <map_fragment>'));
      // The same luma weights the bark, the canopy and the terrain use, so a
      // blade of grass and a trunk go over by the same amount in the same frame.
      expect(block).toContain('vec3( 0.2126, 0.7152, 0.0722 )');
      expect(block).toContain('vec3 sick = vec3( luma * 1.18, luma * 1.0, luma * 0.5 );');
      expect(block).toContain('diffuseColor.rgb = mix( diffuseColor.rgb, sick, c );');
    }
  });

  it('leaves the rock alone', () => {
    // A stone does not die. A grey boulder in the middle of a rotten bank reads
    // as a lighting bug rather than as blight.
    const f = patched('rock').fragmentShader;
    expect(f).not.toContain('vec3 sick');
    expect(f).not.toContain('vAstraCorruption');
  });

  it('rots dead wood along with everything else', () => {
    // A fallen branch is organic. Excluding it would leave bright splinters of
    // clean timber all over the foul bank.
    const f = patched('branch').fragmentShader;
    expect(f).toContain('vec3 sick = vec3( luma * 1.18, luma * 1.0, luma * 0.5 );');
  });

  it('is a no-op at strength zero', () => {
    const shader = {
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
      uniforms: {} as Record<string, unknown>,
    };
    patchFoliageShader(shader, 'grass', {
      ...DEFAULT_FOLIAGE_MATERIAL_OPTIONS,
      corruptionStrength: 0,
    });
    // The strength multiplies the clamp rather than gating the block, so zero
    // takes `c` to zero and the mix is exactly the original colour.
    expect(shader.uniforms.uFoliageCorruption).toEqual({ value: 0 });
    expect(shader.fragmentShader).toContain('* uFoliageCorruption');
  });

  it('parses as GLSL for every kind', () => {
    for (const kind of FOLIAGE_KINDS) {
      const shader = patched(kind);
      expect(() => parser.parse(shader.vertexShader)).not.toThrow();
      expect(() => parser.parse(shader.fragmentShader)).not.toThrow();
    }
  });

  it('defaults to a visible strength', () => {
    expect(DEFAULT_FOLIAGE_MATERIAL_OPTIONS.corruptionStrength).toBeGreaterThan(0);
    expect(DEFAULT_FOLIAGE_MATERIAL_OPTIONS.corruptionStrength).toBeLessThanOrEqual(1);
  });
});

describe('foliage shader hygiene', () => {
  it('declares every uniform it sets, exactly once', () => {
    for (const kind of FOLIAGE_KINDS) {
      const shader = patched(kind);
      const set = Object.keys(shader.uniforms);
      // Counted per shader, not across both: a uniform declared in the vertex
      // AND the fragment shader is legal GLSL and shares one location, which is
      // how Three itself handles the standard material's own uniforms.
      for (const [what, src] of [
        ['vertex', shader.vertexShader],
        ['fragment', shader.fragmentShader],
      ] as const) {
        const declared = declaredUniforms(src);
        for (const name of new Set(declared)) {
          const count = declared.filter((d) => d === name).length;
          expect(count, `${kind}/${what}: uniform ${name} declared ${count} times`).toBe(1);
          expect(set, `${kind}/${what}: uniform ${name} declared but never set`).toContain(name);
        }
      }
    }
  });

  it('declares each varying in the vertex and the fragment shader alike', () => {
    for (const kind of FOLIAGE_KINDS) {
      const shader = patched(kind);
      const v = declaredVaryings(shader.vertexShader);
      const f = declaredVaryings(shader.fragmentShader);
      expect(v.length, kind).toBeGreaterThan(0);
      expect(v, kind).toEqual(f);
    }
  });

  it('parses as GLSL inside Three real standard-material shaders', () => {
    // The only way to catch a syntax error in injected GLSL without a GPU. A
    // mistyped anchor fails silently at build time and produces a plant that
    // is simply not there.
    const problems: string[] = [];
    for (const kind of FOLIAGE_KINDS) {
      const shader = patched(kind);
      for (const [what, src] of [
        ['vertex', shader.vertexShader],
        ['fragment', shader.fragmentShader],
      ] as const) {
        try {
          parser.parse(src, { quiet: true });
        } catch (e) {
          problems.push(`${kind}/${what}: ${(e as Error).message}`);
        }
      }
    }
    expect(problems).toEqual([]);
    // Six kinds x two shaders of Three's full standard material is slow enough
    // to need a real timeout; the default 5 s is not enough.
  }, 180000);

  it('defines every astra function it calls', () => {
    for (const kind of FOLIAGE_KINDS) {
      const src = foliageShaderSources(kind);
      for (const shader of [src.vertexShader, src.fragmentShader]) {
        const defined = new Set(definedFunctions(shader));
        const calls = new Set<string>();
        const re = /\b(astra\w+)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(shader)) !== null) calls.add(m[1]);
        for (const call of calls) {
          expect(defined.has(call), `${kind}: ${call} is called but not defined`).toBe(true);
        }
      }
    }
  });

  it('does not re-declare anything Three already declares', () => {
    const baseline = THREE.ShaderLib.physical.fragmentShader;
    const existing = new Set([
      ...declaredUniforms(baseline),
      ...declaredVaryings(baseline),
      ...definedFunctions(baseline),
    ]);
    for (const kind of FOLIAGE_KINDS) {
      const src = foliageShaderSources(kind);
      for (const shader of [src.vertexShader, src.fragmentShader]) {
        for (const name of declaredUniforms(shader)) {
          expect(existing.has(name), `${kind}: uniform ${name} collides with Three`).toBe(false);
        }
        for (const name of declaredVaryings(shader)) {
          expect(existing.has(name), `${kind}: varying ${name} collides with Three`).toBe(false);
        }
      }
    }
  });
});

describe('foliage material options', () => {
  it('routes every option into a uniform', () => {
    const shader = {
      vertexShader: '',
      fragmentShader: '',
      uniforms: {} as Record<string, unknown>,
    };
    patchFoliageShader(
      shader,
      'grass',
      {
        noiseSeed: 17,
        windStrength: 0.2,
        flutterStrength: 0.9,
        cutout: 0.7,
        tintStrength: 0.3,
        roughness: 0.5,
        metalness: 0.4,
      },
    );
    expect(shader.uniforms.uNoiseSeed).toEqual({ value: 17 });
    expect(shader.uniforms.uWindStrength).toEqual({ value: 0.2 });
    expect(shader.uniforms.uFlutterStrength).toEqual({ value: 0.9 });
    expect(shader.uniforms.uFoliageCutout).toEqual({ value: 0.7 });
    expect(shader.uniforms.uFoliageTint).toEqual({ value: 0.3 });

    const material = createFoliageMaterial('grass', { roughness: 0.5, metalness: 0.4 });
    expect(material.roughness).toBe(0.5);
    expect(material.metalness).toBe(0.4);
  });

  it('falls back to the per-kind defaults', () => {
    const shader = {
      vertexShader: '',
      fragmentShader: '',
      uniforms: {} as Record<string, unknown>,
    };
    patchFoliageShader(shader, 'fern', { ...DEFAULT_FOLIAGE_MATERIAL_OPTIONS });
    // The fern is stiffer than the grass by default.
    expect((shader.uniforms.uWindStrength as { value: number }).value).toBeLessThan(
      (patched('grass').uniforms.uWindStrength as { value: number }).value,
    );
  });
});
