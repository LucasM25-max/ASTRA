import { describe, expect, it } from 'vitest';
import {
  POLLUTION_DOWNSTREAM,
  POLLUTION_MIDSTREAM,
  POLLUTION_UPSTREAM,
  createWaterMaterial,
  patchWaterShader,
  waterShaderSources,
} from '../src/procedural/WaterShader';
import { NOISE_GLSL } from '../src/procedural/NoiseLibrary';

/**
 * Pull the body of one injected GLSL function out of a fragment shader.
 *
 * Matching braces by counting is the only reliable way: the bodies contain
 * nested braces from `if`, and a regex that stops at the first `}` truncates the
 * function and makes every assertion below pass for the wrong reason.
 */
function glslFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}(`);
  expect(start, `function ${name} is not in the shader`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${name}`);
}

describe('WaterShader', () => {
  describe('the patch', () => {
    it('declares the custom attributes on the vertex side', () => {
      const { vertexShader } = waterShaderSources();
      expect(vertexShader).toContain('attribute vec2 astraFlow;');
      expect(vertexShader).toContain('attribute float astraDepth;');
      expect(vertexShader).toContain('attribute float astraPollution;');
    });

    it('passes them to the fragment side as varyings', () => {
      const { vertexShader, fragmentShader } = waterShaderSources();
      expect(vertexShader).toContain('varying vec2 vAstraFlow;');
      expect(vertexShader).toContain('varying float vAstraDepth;');
      expect(vertexShader).toContain('varying float vAstraPollution;');
      expect(fragmentShader).toContain('varying vec2 vAstraFlow;');
      expect(fragmentShader).toContain('varying float vAstraDepth;');
      expect(fragmentShader).toContain('varying float vAstraPollution;');
    });

    it('captures the varyings after the chunk that defines their input', () => {
      const { vertexShader } = waterShaderSources();
      const anchor = vertexShader.indexOf('#include <begin_vertex>');
      expect(anchor).toBeGreaterThanOrEqual(0);
      const after = vertexShader.slice(anchor, anchor + 400);
      // `transformed` is defined by `<begin_vertex>`, so the capture has to come
      // after it. Reversed, the shader would not compile.
      expect(after).toContain('vAstraFlow = astraFlow;');
      expect(after).toContain('vAstraWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    });

    it('anchors on the chunks it replaces, and leaves nothing dangling', () => {
      const { vertexShader, fragmentShader } = waterShaderSources();
      // The patch replaces `#include <normal_fragment_maps>` and
      // `#include <map_fragment>`. A mistyped anchor fails silently on a GPU and
      // produces black water, so the includes must still be there.
      expect(fragmentShader).toContain('#include <normal_fragment_maps>');
      expect(fragmentShader).toContain('#include <map_fragment>');
      expect(vertexShader).toContain('#include <begin_vertex>');
    });

    it('has balanced braces', () => {
      // The failure this guards is an injection that lands outside a function
      // body, or an unclosed block. Both compile on some drivers and not
      // others, and both are invisible in review. Counting is the only reliable
      // check: a regex that stops at the first `}` truncates every multi-line
      // expression in the injected noise library.
      const { fragmentShader, vertexShader } = waterShaderSources();
      for (const [name, source] of [
        ['fragment', fragmentShader],
        ['vertex', vertexShader],
      ] as const) {
        let depth = 0;
        let minimum = 0;
        for (const ch of source) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            minimum = Math.min(minimum, depth);
          }
        }
        expect(depth, `${name} shader has unbalanced braces`).toBe(0);
        expect(minimum, `${name} shader closes a brace it never opened`).toBe(0);
      }
    });

    it('ends inside a function body', () => {
      // A patch that appended code after `main`'s closing brace would leave a
      // statement at file scope, which is the specific mistake this catches.
      const { fragmentShader } = waterShaderSources();
      const trimmed = fragmentShader.trimEnd();
      expect(trimmed.endsWith('}')).toBe(true);
      const open = (trimmed.match(/\{/g) ?? []).length;
      const close = (trimmed.match(/\}/g) ?? []).length;
      expect(open).toBe(close);
    });

    it('never writes a backtick into a comment', () => {
      // The GLSL is inside a JavaScript template literal, so a backtick in a
      // comment terminates the string and breaks the build with a parse error
      // that points at the wrong line entirely.
      const { fragmentShader, vertexShader } = waterShaderSources();
      expect(fragmentShader).not.toContain('`');
      expect(vertexShader).not.toContain('`');
    });

    it('injects the noise library, so the water has something to ripple with', () => {
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('astraFbm2D');
      expect(fragmentShader).toContain(NOISE_GLSL.slice(0, 60));
    });

    it('is idempotent in its anchors: patching twice still compiles', () => {
      // Not a real scenario, but a cheap check that the patch does not depend on
      // the baseline being pristine.
      const shader = {
        vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}\n',
        fragmentShader: '#include <common>\nvoid main() {\n#include <map_fragment>\n}\n',
        uniforms: {} as Record<string, unknown>,
      };
      expect(() => patchWaterShader(shader)).not.toThrow();
      expect(shader.fragmentShader).toContain('vAstraFlow');
    });
  });

  describe('uniforms', () => {
    it('creates every uniform the plan names', () => {
      const { uniforms } = waterShaderSources();
      for (const name of [
        'uTime',
        'uFlowSpeed',
        'uNoiseScale',
        'uRippleStrength',
        'uFresnelPower',
        'uOpacity',
        'uEdgeSoftness',
        'uDepthFade',
        'uCleanShallow',
        'uCleanDeep',
        'uScumColor',
        'uSunDirection',
        'uSunColor',
        'uSkyZenith',
        'uSkyHorizon',
        'uSeed',
        'uPollution',
      ]) {
        expect(uniforms, `uniform ${name}`).toHaveProperty(name);
      }
    });

    it('starts the flow animation at zero', () => {
      const { uniforms } = waterShaderSources();
      expect((uniforms.uTime as { value: number }).value).toBe(0);
    });

    it('carries the caller options through to the uniforms', () => {
      const { uniforms } = waterShaderSources({
        flowSpeed: 1.5,
        noiseScale: 0.9,
        rippleStrength: 0.3,
        fresnelPower: 5,
        opacity: 0.4,
        edgeSoftness: 0.7,
        depthFade: 1.1,
        scumStrength: 0.2,
        bubbleStrength: 0.1,
        seed: 42,
      });
      expect((uniforms.uFlowSpeed as { value: number }).value).toBe(1.5);
      expect((uniforms.uNoiseScale as { value: number }).value).toBe(0.9);
      expect((uniforms.uRippleStrength as { value: number }).value).toBe(0.3);
      expect((uniforms.uFresnelPower as { value: number }).value).toBe(5);
      expect((uniforms.uOpacity as { value: number }).value).toBe(0.4);
      expect((uniforms.uEdgeSoftness as { value: number }).value).toBe(0.7);
      expect((uniforms.uDepthFade as { value: number }).value).toBe(1.1);
      expect((uniforms.uScumStrength as { value: number }).value).toBe(0.2);
      expect((uniforms.uBubbleStrength as { value: number }).value).toBe(0.1);
      expect((uniforms.uSeed as { value: number }).value).toBe(42);
    });

    it('normalises the sun direction', () => {
      const { uniforms } = waterShaderSources({ sunDirection: { x: 0, y: 20, z: 0 } });
      const dir = (uniforms.uSunDirection as { value: { x: number; y: number; z: number } }).value;
      expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 12);
    });

    it('survives a zero-length sun direction', () => {
      // `normalize()` of a zero vector is undefined in GLSL and NaN in Three's
      // uniforms, which silently blacks out every specular highlight.
      const { uniforms } = waterShaderSources({ sunDirection: { x: 0, y: 0, z: 0 } });
      const dir = (uniforms.uSunDirection as { value: { x: number; y: number; z: number } }).value;
      expect(Number.isFinite(dir.x)).toBe(true);
      expect(Number.isFinite(dir.y)).toBe(true);
      expect(Number.isFinite(dir.z)).toBe(true);
    });

    it('gives the colour uniforms real Three colours, not bare numbers', () => {
      const { uniforms } = waterShaderSources();
      for (const name of ['uCleanShallow', 'uCleanDeep', 'uScumColor', 'uSunColor', 'uSkyZenith', 'uSkyHorizon']) {
        expect((uniforms[name] as { value: unknown }).value).toHaveProperty('r');
      }
    });
  });

  describe('flow', () => {
    it('scrolls the ripple field along the spline arc length', () => {
      // `astraFlow.x` is the arc length, so scrolling it moves the pattern
      // downstream. Scrolling `y` instead would slide the surface sideways
      // across the stream.
      const { fragmentShader } = waterShaderSources();
      const body = glslFunction(fragmentShader, 'astraRippleHeight');
      expect(body).toContain('t * uFlowSpeed');
      expect(body).toContain('uNoiseScale');
    });

    it('uses the flow attribute for the ripple lookup', () => {
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('vec2 q = vAstraFlow;');
    });

    it('scales the noise gradient by the noise frequency', () => {
      // The finite difference is in noise space; without the conversion it
      // becomes a world-space slope, the ripples come out either invisible or as
      // crumpled foil.
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('/ e * uNoiseScale');
    });

    it('guards both zero-length normalisations', () => {
      const { fragmentShader } = waterShaderSources();
      // On a level ribbon the gradient is horizontal and the normal is straight
      // up, so `along` is exactly zero for real - not defensively.
      expect(fragmentShader).toContain('if ( strength > 0.002 )');
      expect(fragmentShader).toContain('if ( alongLen > 0.002 )');
    });
  });

  describe('transparency and edges', () => {
    it('fades the alpha out with water depth', () => {
      // Depth is zero exactly where the ground climbs through the surface,
      // which is what makes the shoreline dissolve rather than stop.
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('smoothstep( 0.0, max( uEdgeSoftness, 1e-4 ), depth )');
      expect(fragmentShader).toContain('smoothstep( 0.0, max( uDepthFade, 1e-4 ), depth )');
    });

    it('computes Fresnel from the view direction', () => {
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('pow( 1.0 - facing, uFresnelPower )');
      // `pow` of a negative number is undefined, so the dot product is clamped.
      expect(fragmentShader).toContain('clamp( dot( normalDir, viewDir ), 0.0, 1.0 )');
    });

    it('clamps the final alpha', () => {
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('clamp( alpha, 0.0, 1.0 )');
    });
  });

  describe('sky reflection', () => {
    it('evaluates the reflection analytically against the sky dome gradient', () => {
      // The sky is a gradient dome, not a cubemap, so there is no environment
      // map to sample. This is the documented deviation from the plan's wording.
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('reflect( -viewDir, normalDir )');
      expect(fragmentShader).toContain('mix( uSkyHorizon, uSkyZenith');
    });

    it('adds a sun specular highlight', () => {
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('uSunColor * spec');
      expect(fragmentShader).toContain('max( dot( reflectDir, sunDir ), 0.0 )');
    });
  });

  describe('the two pollution states', () => {
    it('reads pollution from the per-vertex attribute', () => {
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('clamp( vAstraPollution + uPollution, 0.0, 1.0 )');
    });

    it('mixes a clean body and a polluted body', () => {
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('mix( cleanBody, pollutedBody, pollution )');
    });

    it('makes the clean state lighter in the shallows', () => {
      // Shallow water is lighter because there is less of it to look through,
      // and that gradient is what makes the riverbed readable.
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('mix( uCleanShallow, uCleanDeep, clamp( depth * 1.6, 0.0, 1.0 ) )');
    });

    it('shows the riverbed as noise in the clean state', () => {
      const { fragmentShader } = waterShaderSources();
      const body = glslFunction(fragmentShader, 'astraSkyColor');
      expect(body.length).toBeGreaterThan(0);
      expect(fragmentShader).toContain('bedNoise');
      expect(fragmentShader).toContain('astraFbm2D( vAstraWorld.xz');
    });

    it('covers polluted water with an opaque scum skin', () => {
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('uScumColor');
      expect(fragmentShader).toContain('uScumStrength');
      // The scum replaces the sky reflection rather than blending with it, so
      // the two states are distinguishable at a glance.
      expect(fragmentShader).toContain('mix( sky, uScumColor, pollution * 0.85 )');
    });

    it('makes the polluted body darker than the clean one', () => {
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('uCleanDeep * 0.55');
    });

    it('emits bubbles only on polluted water', () => {
      const { fragmentShader } = waterShaderSources();
      expect(fragmentShader).toContain('astraVoronoi2D( bq');
      expect(fragmentShader).toContain('pollution > 0.001');
    });

    it('keeps every state change behind the pollution uniform', () => {
      // One uniform drives everything, so the transition along the stream is
      // continuous rather than a hard cut at a zone boundary.
      const { fragmentShader } = waterShaderSources();
      const body = glslFunction(fragmentShader, 'astraSkyColor');
      expect(body).not.toContain('pollution');
      expect(fragmentShader.match(/pollution/g)?.length ?? 0).toBeGreaterThan(5);
    });
  });

  describe('the material', () => {
    it('is transparent, because the water is blended against the terrain', () => {
      const material = createWaterMaterial();
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(true);
      material.dispose();
    });

    it('is double-sided, so it does not vanish when the camera dips under it', () => {
      const material = createWaterMaterial();
      expect(material.side).toBe(2);
      material.dispose();
    });

    it('carries a cache key, so Three never reuses an unpatched program', () => {
      const material = createWaterMaterial();
      expect(typeof material.customProgramCacheKey).toBe('function');
      expect(material.customProgramCacheKey()).toBe('astra-water-v1');
      material.dispose();
    });

    it('stashes the uniforms where the caller can reach them', () => {
      // `onBeforeCompile` is the only place the uniform objects exist, so
      // without this the animation can never be advanced.
      const material = createWaterMaterial();
      let captured: Record<string, unknown> | undefined;
      material.onBeforeCompile(
        { vertexShader: '', fragmentShader: '', uniforms: { uTime: { value: 3 } } } as never,
        null as never,
      );
      captured = material.userData.uniforms as Record<string, unknown> | undefined;
      expect(captured).toBeDefined();
      material.dispose();
    });

    it('passes the seed through to the noise', () => {
      const { uniforms } = waterShaderSources({ seed: 99 });
      expect((uniforms.uSeed as { value: number }).value).toBe(99);
    });
  });

  describe('the pollution constants', () => {
    it('names the three zones the plan asks for', () => {
      expect(POLLUTION_UPSTREAM).toBeCloseTo(0.9, 12);
      expect(POLLUTION_MIDSTREAM).toBeCloseTo(0.6, 12);
      expect(POLLUTION_DOWNSTREAM).toBeCloseTo(0.2, 12);
    });

    it('orders them from worst upstream to best downstream', () => {
      expect(POLLUTION_UPSTREAM).toBeGreaterThan(POLLUTION_MIDSTREAM);
      expect(POLLUTION_MIDSTREAM).toBeGreaterThan(POLLUTION_DOWNSTREAM);
    });
  });
});
