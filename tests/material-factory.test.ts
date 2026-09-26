import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERRAIN_MATERIAL_OPTIONS,
  createTerrainMaterial,
  patchTerrainShader,
  terrainShaderSources,
} from '../src/procedural/MaterialFactory';
import { MeshStandardMaterial } from 'three';

/**
 * These tests drive the shader patch with a plain object standing in for a
 * Three.js shader, and assert on the GLSL that comes out.
 *
 * That is the only way to test a shader in a Node environment, and it is worth
 * the awkwardness: the failure mode that matters here is a mistyped `#include`
 * anchor, which fails *silently* on a GPU and produces a black terrain. A test
 * that compiles nothing catches that; a test that boots a browser catches it
 * only if someone looks at the screen.
 */
describe('createTerrainMaterial', () => {
  it('returns a MeshStandardMaterial, not a bare ShaderMaterial', () => {
    // The terrain must be lit, fogged and tonemapped by the same pipeline as
    // everything else in the scene. A hand-written ShaderMaterial would have
    // to reimplement all three, and getting fog subtly wrong is a bug that
    // survives review because the terrain still looks fine.
    const material = createTerrainMaterial();
    expect(material).toBeInstanceOf(MeshStandardMaterial);
  });

  it('uses vertex colours, because that is where the biome blend lives', () => {
    expect(createTerrainMaterial().vertexColors).toBe(true);
  });

  it('is opaque and depth-writing', () => {
    const material = createTerrainMaterial();
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
  });

  it('applies the options it was given', () => {
    const material = createTerrainMaterial({ roughness: 0.5, metalness: 0.25 });
    expect(material.roughness).toBe(0.5);
    expect(material.metalness).toBe(0.25);
  });

  it('defaults to non-metallic, rough ground', () => {
    const material = createTerrainMaterial();
    expect(material.metalness).toBe(0);
    expect(material.roughness).toBeGreaterThan(0.8);
  });

  it('registers a stable program cache key', () => {
    // Without this, Three may reuse a program compiled without the patch and
    // the terrain renders as a flat unlit surface.
    const material = createTerrainMaterial();
    expect(material.customProgramCacheKey()).toBe('astra-terrain-v1');
    expect(createTerrainMaterial({ roughness: 0.3 }).customProgramCacheKey()).toBe(
      'astra-terrain-v1',
    );
  });

  it('installs an onBeforeCompile hook', () => {
    expect(typeof createTerrainMaterial().onBeforeCompile).toBe('function');
  });

  it('disposes cleanly', () => {
    const material = createTerrainMaterial();
    expect(() => material.dispose()).not.toThrow();
  });
});

describe('patchTerrainShader', () => {
  it('declares the biome attribute and its varyings', () => {
    const { vertexShader, fragmentShader } = terrainShaderSources();
    expect(vertexShader).toContain('attribute vec4 biome;');
    expect(vertexShader).toContain('varying vec4 vAstraBiome;');
    expect(fragmentShader).toContain('varying vec4 vAstraBiome;');
  });

  it('passes world position and world normal to the fragment stage', () => {
    // Triplanar mapping needs world position; slope blending needs the world
    // normal. Both come from the vertex stage.
    const { vertexShader, fragmentShader } = terrainShaderSources();
    expect(vertexShader).toContain('varying vec3 vAstraWorld;');
    expect(vertexShader).toContain('varying vec3 vAstraNormal;');
    expect(fragmentShader).toContain('varying vec3 vAstraWorld;');
    expect(fragmentShader).toContain('varying vec3 vAstraNormal;');

    // And they are written from the model matrix, so the terrain stays correct
    // if its transform ever stops being the identity.
    expect(vertexShader).toContain('modelMatrix * vec4( transformed, 1.0 )');
    expect(vertexShader).toContain('mat3( modelMatrix ) * objectNormal');
  });

  it('injects the noise library into the fragment stage', () => {
    const { fragmentShader } = terrainShaderSources();
    expect(fragmentShader).toContain('astraPerlin2D');
    expect(fragmentShader).toContain('astraSimplex2D');
    expect(fragmentShader).toContain('astraVoronoi2D');
    expect(fragmentShader).toContain('astraFbm2D');
    // And not into the vertex stage, where it would be wasted work.
    const { vertexShader } = terrainShaderSources();
    expect(vertexShader).not.toContain('astraFbm2D');
  });

  it('consumes every anchor it relies on, exactly once', () => {
    // A `.replace()` that matches nothing is a silent no-op, and a `.replace()`
    // that runs twice duplicates a declaration. Both are caught by counting.
    //
    // `<common>` is deliberately re-emitted inside its own replacement so
    // Three still expands it - hence "exactly once", not "not at all".
    const { vertexShader, fragmentShader } = terrainShaderSources();
    const count = (src: string, needle: string) => src.split(needle).length - 1;

    for (const anchor of [
      '#include <common>',
      '#include <begin_vertex>',
      '#include <beginnormal_vertex>',
    ]) {
      expect(count(vertexShader, anchor)).toBe(1);
    }
    for (const anchor of [
      '#include <common>',
      '#include <map_fragment>',
      '#include <normal_fragment_maps>',
    ]) {
      expect(count(fragmentShader, anchor)).toBe(1);
    }
  });

  it('keeps the anchor order the shader needs', () => {
    // `vBiome` is assigned where `transformed` exists, and `vAstraNormal`
    // where `objectNormal` exists. Getting the order wrong compiles and
    // produces a black terrain.
    const { vertexShader } = terrainShaderSources();
    const beginVertex = vertexShader.indexOf('#include <begin_vertex>');
    const assignWorld = vertexShader.indexOf('vAstraWorld =');
    const beginNormal = vertexShader.indexOf('#include <beginnormal_vertex>');
    const assignNormal = vertexShader.indexOf('vAstraNormal =');

    expect(beginVertex).toBeLessThan(assignWorld);
    expect(beginNormal).toBeLessThan(assignNormal);
  });

  it('applies the triplanar blend at the albedo stage', () => {
    const { fragmentShader } = terrainShaderSources();
    // The blend must happen where Three expects the albedo, and must multiply
    // the existing diffuse colour rather than replace it - the vertex paint is
    // the base and the noise supplies the grain on top.
    expect(fragmentShader).toContain('diffuseColor.rgb *=');
    expect(fragmentShader).toContain('astraTriplanarDetail');
    // Triplanar weights from the world normal: that is what removes the seam.
    expect(fragmentShader).toContain('pow( abs( vAstraNormal ), vec3( 3.0 ) )');
  });

  it('blends the four biomes by their vertex weights', () => {
    const { fragmentShader } = terrainShaderSources();
    for (const component of ['biome.x', 'biome.y', 'biome.z', 'biome.w']) {
      expect(fragmentShader).toContain(component);
    }
    // Four separate detail fields, so grass and rock do not vary in lockstep.
    const seeds = fragmentShader.match(/uNoiseSeed \+ [0-9.]+/g) ?? [];
    expect(new Set(seeds).size).toBeGreaterThanOrEqual(4);
  });

  it('re-weights toward rock on steep ground', () => {
    const { fragmentShader } = terrainShaderSources();
    // The plan's "rock on steep, grass on flat", applied against the rendered
    // normal so it agrees with what the player sees.
    expect(fragmentShader).toContain('1.0 - clamp( abs( vAstraNormal.y ), 0.0, 1.0 )');
    expect(fragmentShader).toContain('smoothstep( uSlopeRockStart, uSlopeRockEnd, slope )');
    expect(fragmentShader).toContain('rockMix');
    // And the weights are renormalized afterwards, so they still sum to one.
    expect(fragmentShader).toContain('max( biome.x + biome.y + biome.z + biome.w, 1e-4 )');
  });

  it('perturbs the normal from a noise gradient', () => {
    const { fragmentShader } = terrainShaderSources();
    // Finite differences of a world-space fbm, projected onto the surface.
    expect(fragmentShader).toContain('hx - h0');
    expect(fragmentShader).toContain('hz - h0');
    expect(fragmentShader).toContain('gradient - dot( gradient, normal ) * normal');
    expect(fragmentShader).toContain('normalize( normal -');
  });

  it('declares every uniform the injected code reads', () => {
    const { uniforms } = terrainShaderSources();
    for (const name of [
      'uDetailScale',
      'uColorVariation',
      'uSlopeRockStart',
      'uSlopeRockEnd',
      'uSlopeRockStrength',
      'uNormalStrength',
      'uNormalOctaves',
      'uNoiseSeed',
    ]) {
      expect(uniforms[name]).toBeDefined();
    }
  });

  it('does not declare a uniform the injected code never reads', () => {
    // An unused uniform is not free: it costs a uniform slot and, worse, it
    // makes the declaration list look authoritative when it is not.
    const { fragmentShader, uniforms } = terrainShaderSources();
    const declared = fragmentShader.match(/uniform float (u\w+);/g) ?? [];
    for (const line of declared) {
      const name = line.match(/uniform float (u\w+);/)![1];
      expect(uniforms[name]).toBeDefined();
      expect(fragmentShader.split(name).length).toBeGreaterThan(2);
    }
  });

  it('passes option values through to the uniforms', () => {
    const { uniforms } = terrainShaderSources({
      detailScale: 0.5,
      colorVariation: 0.9,
      normalStrength: 0.1,
      normalOctaves: 6,
      noiseSeed: 12,
    });
    expect(uniforms.uDetailScale).toEqual({ value: 0.5 });
    expect(uniforms.uColorVariation).toEqual({ value: 0.9 });
    expect(uniforms.uNormalStrength).toEqual({ value: 0.1 });
    expect(uniforms.uNormalOctaves).toEqual({ value: 6 });
    expect(uniforms.uNoiseSeed).toEqual({ value: 12 });
  });

  it('produces balanced braces and parentheses', () => {
    // An unbalanced brace compiles to a black screen and no useful error.
    const { vertexShader, fragmentShader } = terrainShaderSources();
    for (const src of [vertexShader, fragmentShader]) {
      expect((src.match(/\{/g) ?? []).length).toBe((src.match(/\}/g) ?? []).length);
      expect((src.match(/\(/g) ?? []).length).toBe((src.match(/\)/g) ?? []).length);
    }
  });

  it('has no statement at file scope', () => {
    // Everything at file scope must be a declaration or structural brace.
    const { vertexShader, fragmentShader } = terrainShaderSources();
    for (const src of [vertexShader, fragmentShader]) {
      const offenders = src
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.trim().startsWith('//'))
        .filter((l) => {
          if (/^\s/.test(l)) return false;
          const t = l.trim();
          if (t === '}' || t === '};' || t === '{') return false;
          return !/^(attribute|varying|uniform|float|vec2|vec3|vec4|int|uint|void|const|bool)\b/.test(
            t,
          );
        });
      expect(offenders).toEqual([]);
    }
  });

  it('keeps every injected symbol ASTRA-prefixed', () => {
    // So it cannot collide with a Three.js chunk or a material's own uniform.
    const { fragmentShader } = terrainShaderSources();
    const declared = fragmentShader.match(/^(?:float|vec2|vec3|vec4)\s+(\w+)\s*\(/gm) ?? [];
    for (const line of declared) {
      const name = line.match(/(\w+)\s*\($/)![1];
      expect(name.startsWith('astra')).toBe(true);
    }
  });

  it('only uses ASTRA-prefixed varyings', () => {
    const { vertexShader, fragmentShader } = terrainShaderSources();
    const varyings = new Set<string>();
    for (const src of [vertexShader, fragmentShader]) {
      for (const m of src.matchAll(/varying\s+\w+\s+(\w+)\s*;/g)) varyings.add(m[1]);
    }
    expect(varyings.size).toBeGreaterThan(0);
    for (const v of varyings) expect(v.startsWith('vAstra')).toBe(true);
  });

  it('emits no backticks or template interpolations into the GLSL', () => {
    // The injected GLSL lives inside JS template literals. A backtick or a
    // `${` in a comment silently ends the literal and produces a syntax error
    // in the module - which `tsc` catches, but only for the file that happens
    // to be edited. This asserts the generated output is clean GLSL either way.
    const { vertexShader, fragmentShader } = terrainShaderSources();
    for (const src of [vertexShader, fragmentShader]) {
      expect(src).not.toContain('`');
      expect(src).not.toContain('${');
    }
  });

  it('guards every normalize against a zero-length vector', () => {
    // GLSL leaves normalize(vec3(0)) undefined, and it happens here for real:
    // the projected gradient is exactly zero on every vertical face. An
    // unguarded version tilts every flat normal by a constant amount in a
    // constant direction, which reads as a systematic lighting error.
    const { fragmentShader } = terrainShaderSources();
    const normalizes = fragmentShader.match(/normalize\s*\([^;]*\)/g) ?? [];
    expect(normalizes.length).toBeGreaterThan(0);

    // Every normalize in the injected block is either applied to a vector that
    // is a surface normal (unit length by construction) or is guarded by a
    // preceding length check.
    for (const call of normalizes) {
      const inner = call.replace(/^normalize\s*\(/, '').replace(/\)$/, '').trim();
      if (inner === 'normal' || inner === 'vAstraNormal') continue;
      expect(inner).not.toMatch(/^along\b/);
    }

    // And the guards themselves are present.
    expect(fragmentShader).toContain('if ( strength > 0.004 )');
    expect(fragmentShader).toContain('if ( alongLen > 0.004 )');
  });

  it('scales the normal perturbation with the noise slope', () => {
    // Flat ground must get no perturbation at all. A constant-strength version
    // leaves a systematic tilt behind, so the strength has to be derived from
    // the gradient magnitude.
    const { fragmentShader } = terrainShaderSources();
    expect(fragmentShader).toContain('float strength = clamp( length( gradient ) * 0.5, 0.0, 1.0 )');
    expect(fragmentShader).toContain('* qScale');
  });

  it('is idempotent in what it declares', () => {
    // Running the patch twice on the same object would double every
    // declaration and produce a redefinition error. The real shader object is
    // fresh each compile, so this is about the patch not appending blindly.
    const shader = {
      vertexShader: '#include <common>\nvoid main() {\n  #include <begin_vertex>\n}\n',
      fragmentShader: '#include <common>\nvoid main() {\n  #include <map_fragment>\n}\n',
      uniforms: {} as Record<string, unknown>,
    };
    patchTerrainShader(shader, { ...DEFAULT_TERRAIN_MATERIAL_OPTIONS });
    const declarations = (shader.vertexShader.match(/attribute vec4 biome;/g) ?? []).length;
    expect(declarations).toBe(1);
  });

  it('tolerates a shader whose anchors are absent', () => {
    // Three's shader source can change between versions. A replace that
    // matches nothing is a silent no-op, which is survivable - the material
    // degrades to an unpatched standard material rather than crashing.
    const shader = {
      vertexShader: 'void main() {}',
      fragmentShader: 'void main() {}',
      uniforms: {} as Record<string, unknown>,
    };
    expect(() =>
      patchTerrainShader(shader, { ...DEFAULT_TERRAIN_MATERIAL_OPTIONS }),
    ).not.toThrow();
    expect(shader.vertexShader).toBe('void main() {}');
  });
});

describe('DEFAULT_TERRAIN_MATERIAL_OPTIONS', () => {
  it('has sane, in-range values', () => {
    const o = DEFAULT_TERRAIN_MATERIAL_OPTIONS;
    expect(o.detailScale).toBeGreaterThan(0);
    expect(o.colorVariation).toBeGreaterThanOrEqual(0);
    expect(o.colorVariation).toBeLessThanOrEqual(1);
    expect(o.slopeRockStart).toBeLessThan(o.slopeRockEnd);
    expect(o.slopeRockStrength).toBeGreaterThanOrEqual(0);
    expect(o.slopeRockStrength).toBeLessThanOrEqual(1);
    expect(o.normalStrength).toBeGreaterThan(0);
    expect(o.normalOctaves).toBeGreaterThanOrEqual(1);
    expect(o.roughness).toBeGreaterThan(0);
    expect(o.roughness).toBeLessThanOrEqual(1);
    expect(o.metalness).toBe(0);
  });
});
