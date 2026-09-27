import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parser } from '@shaderfrog/glsl-parser';
import {
  createFungusMaterial,
  patchFungusShader,
  fungusShaderSources,
  DEFAULT_FUNGUS_MATERIAL_OPTIONS,
  FUNGUS_MATERIAL_PROGRAM_KEY,
  type FungusMaterialOptions,
} from '../src/procedural/FungusMaterial';
import { FUNGUS_KINDS, type FungusKind } from '../src/procedural/FungusGenerator';

/** Apply a patch to Three's own standard-material sources. */
function patched(
  kind: FungusKind,
  options: FungusMaterialOptions = {},
): { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> } {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
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
 * Every `uniform T name;` declaration in a shader source, optionally filtered.
 *
 * The filter matters: Three's own standard shader declares `diffuse`,
 * `opacity`, `roughness` and a dozen more, and those are set by the renderer
 * from the material's properties rather than through `shader.uniforms`. An
 * unfiltered reverse check would demand a uniform for every one of them.
 */
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

/** Every identifier of the form `vAstra*` a shader source reads. */
function usedVaryings(src: string): string[] {
  const out = new Set<string>();
  const re = /\b(vAstra\w+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return [...out];
}

describe('fungus material', () => {
  it('builds one material per kind, each with its own cache key', () => {
    const keys = new Set<string>();
    for (const kind of FUNGUS_KINDS) {
      const material = createFungusMaterial(kind);
      expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect(typeof material.onBeforeCompile).toBe('function');
      keys.add(material.customProgramCacheKey());
      // Every kind is vertex-coloured: the palette lives in the geometry, so
      // one material can serve a green cluster and a purple one.
      expect(material.vertexColors).toBe(true);
      // Never blended. A mushroom is solid and the glow is emissive, so
      // nothing here belongs in the transparent pass.
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
    }
    // A cache key per kind, or Three reuses one program for two different
    // shader pairs and one of them draws with the other's wind block.
    expect(keys.size).toBe(FUNGUS_KINDS.length);
    for (const kind of FUNGUS_KINDS) {
      expect(createFungusMaterial(kind).customProgramCacheKey()).toBe(
        `${FUNGUS_MATERIAL_PROGRAM_KEY}-${kind}`,
      );
    }
  });

  it('declares every uniform it sets, exactly once per shader', () => {
    for (const kind of FUNGUS_KINDS) {
      const shader = patched(kind);
      const set = Object.keys(shader.uniforms);
      // Counted PER SHADER, not across both: a uniform declared in the vertex
      // and the fragment shader is legal GLSL and the two declarations share
      // one location, which is how `uWindTime` ends up in the fragment shader
      // of the glowing kinds - their rim pulse is a function of it.
      for (const [name, src] of [
        ['vertex', shader.vertexShader],
        ['fragment', shader.fragmentShader],
      ] as const) {
        const declared = declaredUniforms(src, ASTRA_UNIFORM);
        for (const uniform of set) {
          const count = declared.filter((d) => d === uniform).length;
          expect(
            count,
            `${kind}/${name}: uniform ${uniform} declared ${count} times`,
          ).toBeLessThanOrEqual(1);
        }
      }
      // And nothing ASTRA declares that is never set, which would read as zero.
      const all = declaredUniforms(shader.vertexShader, ASTRA_UNIFORM).concat(
        declaredUniforms(shader.fragmentShader, ASTRA_UNIFORM),
      );
      for (const name of new Set(all)) {
        expect(set, `${kind}: uniform ${name} is declared but never set`).toContain(name);
      }
    }
  });

  it('declares each varying it adds in the vertex and the fragment shader alike', () => {
    for (const kind of FUNGUS_KINDS) {
      const shader = patched(kind);
      // Only the varyings this module adds. Three declares some of its own
      // under #ifdef, so counting the whole shader would fail on Three's
      // behalf.
      const v = declaredVaryings(shader.vertexShader, ASTRA_VARYING);
      const f = declaredVaryings(shader.fragmentShader, ASTRA_VARYING);
      expect(v.length, `${kind} declares no varyings`).toBeGreaterThan(0);
      expect(new Set(v), `${kind}: vertex/fragment varying mismatch`).toEqual(new Set(f));
    }
  });

  it('never reads a varying the fragment shader does not declare', () => {
    // The failure this catches is real and was made twice while writing the
    // module: the glow block read `vAstraObject`, which only the gill block
    // declares. A missing declaration is a link error, and a link error is a
    // black mushroom with no warning anywhere upstream of it.
    for (const kind of FUNGUS_KINDS) {
      const shader = patched(kind);
      const declared = new Set(declaredVaryings(shader.fragmentShader, ASTRA_VARYING));
      const missing = usedVaryings(shader.fragmentShader).filter(
        (name) => !declared.has(name),
      );
      expect(missing, `${kind}: fragment reads undeclared varyings`).toEqual([]);
    }
  });

  it('parses as GLSL inside Three real standard-material shaders', () => {
    // The only way to catch a syntax error in injected GLSL without a GPU. A
    // mistyped anchor fails silently at build time and produces a black
    // mushroom.
    const problems: string[] = [];
    for (const kind of FUNGUS_KINDS) {
      const shader = patched(kind);
      for (const [name, src] of [
        ['vertex', shader.vertexShader],
        ['fragment', shader.fragmentShader],
      ] as const) {
        try {
          parser.parse(src);
        } catch (error) {
          problems.push(`${kind}/${name}: ${(error as Error).message}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('injects the wind only for the kinds that move', () => {
    // A dead fish and a lump of rot must not pay for a vertex shader they do
    // not use: an unused function still has to be compiled and inlined by the
    // driver.
    const moving: FungusKind[] = ['mushroom', 'pod'];
    const still: FungusKind[] = ['shelf', 'carrion', 'rot'];
    for (const kind of moving) {
      expect(fungusShaderSources(kind).vertexShader, `${kind} has no wind`).toContain(
        'astraFungusWind',
      );
    }
    for (const kind of still) {
      expect(fungusShaderSources(kind).vertexShader, `${kind} has wind`).not.toContain(
        'astraFungusWind',
      );
    }
  });

  it('weights the wind quadratically so nothing detaches from the ground', () => {
    const src = fungusShaderSources('pod');
    // w is 0 at the base, so a quadratic weight leaves the base exactly where
    // it is. A linear weight slides the whole plant sideways.
    expect(src.vertexShader).toContain('clamp( objectPos.y / max( uFungusHeight, 1e-4 ), 0.0, 1.0 )');
    expect(src.vertexShader).toMatch(/w \* w \* 0\.8 \+ w \* 0\.2/);
    // The tip drops as it swings, so the pod does not stretch as it leans.
    expect(src.vertexShader).toContain('transformed.y -= length( offset ) * 0.3');
  });

  it('phases the wind on the instance origin so neighbours never swing together', () => {
    const src = fungusShaderSources('pod');
    expect(src.vertexShader).toContain('instanceOrigin.xz * 0.09');
    // The instance origin is built through modelMatrix plus, when instanced,
    // instanceMatrix - not one or the other, which would put every instance of
    // an InstancedMesh at the same phase.
    expect(src.vertexShader).toContain('modelMatrix[ 3 ].xyz');
    expect(src.vertexShader).toContain('#ifdef USE_INSTANCING');
  });

  it('injects the radial gill mask only for mushrooms', () => {
    // The mask costs noise evaluations and two varyings, and four of the five
    // kinds have no underside to carve.
    expect(fungusShaderSources('mushroom').fragmentShader).toContain('astraFungusGills');
    for (const kind of ['shelf', 'pod', 'carrion', 'rot'] as FungusKind[]) {
      expect(fungusShaderSources(kind).fragmentShader, `${kind} has gills`).not.toContain(
        'astraFungusGills',
      );
    }
  });

  it('radiates the gills from the stalk rather than ringing it', () => {
    const src = fungusShaderSources('mushroom');
    // atan(z, x) gives lines that radiate. A sample of xz would give
    // concentric rings, which is a target rather than a mushroom.
    expect(src.fragmentShader).toContain('atan( p.z, p.x )');
    // And the mask is gated on the surface facing down: a cap seen from above
    // is a smooth dome and should stay one.
    expect(src.fragmentShader).toContain('if ( n.y > -0.15 ) return 1.0;');
  });

  it('glows only the pods and the caps, and never the shelves', () => {
    // The pods are the one thing in the fouled stream that makes its own
    // light. Giving a shelf the same emission would make the inner zone look
    // like a fairground.
    const glowing: FungusKind[] = ['mushroom', 'pod'];
    const dark: FungusKind[] = ['shelf', 'carrion', 'rot'];
    for (const kind of glowing) {
      const src = fungusShaderSources(kind);
      expect(src.fragmentShader, `${kind} has no glow`).toContain('totalEmissiveRadiance +=');
      // The glow is a rim, so a pod reads as a lit droplet rather than as a
      // lightbulb.
      expect(src.fragmentShader).toContain('pow( clamp( 1.0 - facing, 0.0, 1.0 ), uFungusGlowPower )');
      // And it is keyed on where the pod stands in the world, so a cluster
      // pulses unevenly instead of blinking in unison.
      expect(src.fragmentShader).toContain('vAstraOrigin.xz');
    }
    for (const kind of dark) {
      expect(fungusShaderSources(kind).fragmentShader, `${kind} glows`).not.toContain(
        'totalEmissiveRadiance +=',
      );
    }
  });

  it('takes the glow hue from the surface rather than fixing it', () => {
    // A fixed glow colour would flatten the palette the vertex colours are
    // carrying, and a purple pod has to glow purple.
    const src = fungusShaderSources('pod');
    expect(src.fragmentShader).toContain('totalEmissiveRadiance += diffuseColor.rgb * rim');
  });

  it('mixes the per-instance tint against white so strength zero is a no-op', () => {
    // Scaling a tint by zero is not the same as leaving the vertex colour
    // alone, and a strength of zero has to be exactly a no-op.
    const src = fungusShaderSources('pod');
    expect(src.fragmentShader).toContain('mix( vec3( 1.0 ), mix( sickly, bruised, v ), uFungusTint )');
    expect(src.fragmentShader).toContain('clamp( vAstraVariation, 0.0, 1.0 )');
  });

  it('honours option overrides without the globals clobbering the kinds', () => {
    // `windStrength`, `flutterStrength` and `glowStrength` are deliberately
    // absent from the global defaults: a global default would override every
    // kind's own number through the spread, and a rock would get the grass's
    // strength. That exact bug is what the foliage material's own comment
    // warns about.
    const pod = patched('pod');
    expect(pod.uniforms.uWindStrength).toEqual({ value: 0.05 });
    expect(pod.uniforms.uFungusGlow).toEqual({ value: 0.55 });
    expect(pod.uniforms.uFungusGlowPower).toEqual({ value: 2.2 });

    const shelf = patched('shelf');
    expect(shelf.uniforms.uWindStrength).toEqual({ value: 0 });
    expect(shelf.uniforms.uFungusGlow).toEqual({ value: 0 });

    // An explicit override still wins over the kind's own number.
    const loud = patched('pod', { windStrength: 0.4, flutterStrength: 2 });
    expect(loud.uniforms.uWindStrength).toEqual({ value: 0.4 });
    expect(loud.uniforms.uFlutterStrength).toEqual({ value: 2 });
  });

  it('shares one wind uniform object across every kind', () => {
    // One object, one write per frame: the pods and the caps have to move
    // together, and two objects would need two writes and could drift.
    const wind = { value: 0 };
    const pod = patched('pod', { windUniform: wind });
    const mushroom = patched('mushroom', { windUniform: wind });
    expect(pod.uniforms.uWindTime).toBe(wind);
    expect(mushroom.uniforms.uWindTime).toBe(wind);
  });

  it('front side only, because every kind is a closed shell', () => {
    for (const kind of FUNGUS_KINDS) {
      expect(createFungusMaterial(kind).side, `${kind} side`).toBe(THREE.FrontSide);
    }
  });
});
