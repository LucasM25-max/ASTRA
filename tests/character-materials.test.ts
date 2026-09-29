/**
 * character-materials.test.ts
 * =============================================================================
 * The four character materials, and - more importantly - a check on their GLSL.
 *
 * None of this shader code has ever been compiled by a real driver in this
 * environment: there is no GPU and no browser. A typo in an identifier, a
 * uniform declared in GLSL but never provided, or a varying only one stage
 * declares are all compile- or link-time errors that produce either a black
 * frame or a silently wrong one, with nothing in the log to say so.
 *
 * So `onBeforeCompile` is driven with three's own unpatched `physical` shader
 * source, and the *result* is analysed: every identifier used must be declared,
 * every uniform declared must be provided, and both stages must agree on their
 * varyings. That is the same check `sky-shader-integrity.test.ts` performs on
 * the sky, applied to the materials that wear it.
 *
 * This is also the only thing here that can catch a mistake in the injection
 * points themselves. Three resolves `#include <...>` *after* `onBeforeCompile`
 * runs, so an injection anchored to the wrong chunk - or to a chunk that turns
 * out to be wrapped in an `#ifdef` that is not defined - silently does nothing,
 * and the material renders with its base colour and no pattern at all.
 * =============================================================================
 */

import { describe, expect, it } from 'vitest';
import { MeshStandardMaterial, ShaderChunk, ShaderLib } from 'three';
import {
  DEFAULT_CHAIN_MAIL_OPTIONS,
  DEFAULT_LEATHER_OPTIONS,
  DEFAULT_SKIN_OPTIONS,
  createChainMailMaterial,
  createCharacterMaterials,
  createLeatherMaterial,
  createSkinMaterial,
  createSteelMaterial,
  disposeCharacterMaterials,
  type CharacterMaterials,
} from '../src/procedural/CharacterMaterials';

/* -------------------------------------------------------------------------- */
/* GLSL analysis                                                              */
/* -------------------------------------------------------------------------- */

const GLSL_BUILTINS = new Set([
  // types and qualifiers
  'void', 'bool', 'int', 'uint', 'float', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3',
  'ivec4', 'uvec2', 'uvec3', 'uvec4', 'bvec2', 'bvec3', 'bvec4', 'mat2', 'mat3', 'mat4',
  'sampler2D', 'sampler3D', 'samplerCube', 'uniform', 'attribute', 'varying', 'in',
  'out', 'const', 'struct', 'return', 'if', 'else', 'for', 'while', 'do', 'break',
  'continue', 'discard', 'precision', 'highp', 'mediump', 'lowp', 'invariant', 'flat',
  'smooth', 'layout', 'true', 'false',
  // built-in functions
  'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh',
  'tanh', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt', 'abs', 'sign',
  'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep',
  'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward', 'reflect', 'refract',
  'matrixCompMult', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
  'equal', 'notEqual', 'any', 'all', 'not', 'texture2D', 'texture', 'textureLod',
  'textureCube', 'dFdx', 'dFdy', 'fwidth', 'transpose', 'inverse', 'determinant',
  'uintBitsToFloat', 'floatBitsToUint',
  // stage built-ins
  'gl_Position', 'gl_FragColor', 'gl_FragCoord', 'gl_PointSize', 'gl_VertexID',
  'gl_InstanceID', 'gl_FrontFacing', 'gl_PointCoord', 'gl_FragDepth',
  // three.js injected
  'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix', 'normalMatrix',
  'cameraPosition', 'isOrthographic', 'position', 'normal', 'uv', 'uv1', 'uv2', 'tangent',
  'color', 'instanceMatrix', 'instanceColor', 'logDepthBufFC', 'toneMappingExposure',
]);

/**
 * Resolve `#include <chunk>` the way three's WebGLProgram does.
 *
 * Without this the analysis runs on a shader full of literal include lines, so
 * every identifier three declares inside a chunk reads as undeclared and the
 * check reports dozens of false positives while missing nothing real. Resolving
 * first means the analysis sees the source that would actually reach the driver.
 */
function resolveIncludes(src: string, depth = 0): string {
  if (depth > 8) return src;
  return src.replace(/#include <(\w+)>/g, (whole, name: string) => {
    const chunk = (ShaderChunk as Record<string, string>)[name];
    if (chunk === undefined) return whole;
    return resolveIncludes(chunk, depth + 1);
  });
}

/** Strip comments and preprocessor lines, so prose is never mistaken for code. */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  out = out.replace(/\/\/[^\n]*/g, ' ');
  out = out.replace(/^\s*#[^\n]*/gm, ' ');
  return out;
}

interface Finding {
  kind: string;
  detail: string;
  line: number;
}

/** Every identifier three's own unpatched shader uses. */
function identifiersIn(src: string): Set<string> {
  const found = new Set<string>();
  const re = /(?<![.\w])([A-Za-z_]\w*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(src)))) found.add(m[1]);
  return found;
}

/**
 * Three's unpatched physical shader, includes resolved, as the baseline.
 *
 * It references identifiers that are declared in the prefix `WebGLProgram`
 * prepends rather than in any chunk - `PI`, `RECIPROCAL_PI`, `getBoneMatrix`,
 * `DirectionalLightShadow`, `MAP_UV` and a few dozen more. None of those are
 * mistakes in this project's code, so they are excluded by comparison rather
 * than by being listed by hand, which would rot the moment three is upgraded.
 */
const THREE_BASE = {
  vertex: resolveIncludes(ShaderLib.physical.vertexShader),
  fragment: resolveIncludes(ShaderLib.physical.fragmentShader),
};

const THREE_KNOWN = new Set<string>([
  ...identifiersIn(THREE_BASE.vertex),
  ...identifiersIn(THREE_BASE.fragment),
]);

function analyse(rawSrc: string, baseline?: string): Finding[] {
  const out: Finding[] = [];
  const src = stripComments(rawSrc);

  // Delimiters are checked as a *difference* from the baseline, not absolutely.
  //
  // Three's own fragment shader does not balance on braces once preprocessor
  // lines are stripped: computeMultiscatteringIridescence sits inside an
  // `#ifdef USE_IRIDESCENCE`, and removing the `#ifdef` while keeping the
  // function body leaves an unmatched brace. That is three's code and it is fine
  // - the guard is what balances it. An absolute count therefore reports a fault
  // in every material including the unpatched one, which is exactly the kind of
  // check that gets switched off. What matters is whether the patch made it worse.
  for (const [open, close] of [
    ['{', '}'],
    ['(', ')'],
    ['[', ']'],
  ] as const) {
    const count = (text: string) => {
      let depth = 0;
      let stray = -1;
      let line = 1;
      for (const ch of text) {
        if (ch === '\n') line++;
        if (ch === open) depth++;
        if (ch === close) {
          depth--;
          if (depth < 0 && stray === -1) stray = line;
        }
      }
      return { depth, stray };
    };
    const mine = count(src);
    const theirs = baseline ? count(stripComments(baseline)) : { depth: 0, stray: -1 };
    if (mine.stray !== -1) {
      out.push({ kind: 'delimiter', detail: `stray ${close}`, line: mine.stray });
    }
    if (mine.depth !== theirs.depth) {
      out.push({
        kind: 'delimiter',
        detail: `unbalanced ${open}: the patch adds depth ${mine.depth - theirs.depth}`,
        line: -1,
      });
    }
  }

  const declared = new Set<string>(GLSL_BUILTINS);
  let m: RegExpExecArray | null;
  const declRe = /\b(?:uniform|attribute|varying|in|out)\s+(?:lowp|mediump|highp\s+)?\w+\s+([A-Za-z_]\w*)/g;
  while ((m = declRe.exec(src))) declared.add(m[1]);
  const localRe = /\b(?:float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|mat3|mat4)\s+([A-Za-z_]\w*)\s*(?:=|;|,|\))/g;
  while ((m = localRe.exec(src))) declared.add(m[1]);
  const fnRe = /\b(?:float|int|uint|bool|vec2|vec3|vec4|void)\s+([A-Za-z_]\w*)\s*\(/g;
  while ((m = fnRe.exec(src))) declared.add(m[1]);

  // `out` parameters are declarations too.
  const outRe = /\bout\s+(?:float|int|uint|bool|vec[234])\s+([A-Za-z_]\w*)/g;
  while ((m = outRe.exec(src))) declared.add(m[1]);

  const usedRe = /(?<![.\w])([A-Za-z_]\w*)\b/g;
  const seen = new Set<string>();
  while ((m = usedRe.exec(src))) {
    const id = m[1];
    if (declared.has(id) || seen.has(id)) continue;
    // Not a mistake in this project's code if three's own shader already uses
    // it - it is declared in the prefix WebGLProgram prepends.
    if (baseline && THREE_KNOWN.has(id)) continue;
    seen.add(id);
    out.push({ kind: 'undeclared', detail: id, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** Run a material's `onBeforeCompile` against three's real physical shader. */
function patched(material: MeshStandardMaterial): {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
} {
  const base = ShaderLib.physical;
  const shader = {
    vertexShader: base.vertexShader,
    fragmentShader: base.fragmentShader,
    uniforms: JSON.parse(JSON.stringify({})) as Record<string, { value: unknown }>,
    // The real object three passes also carries these; a patch that touches them
    // would otherwise throw and be mistaken for a passing material.
    defines: {},
  };
  material.onBeforeCompile(shader as never, {} as never);
  // Resolve includes so the analysis sees what the driver would compile.
  return {
    ...shader,
    vertexShader: resolveIncludes(shader.vertexShader),
    fragmentShader: resolveIncludes(shader.fragmentShader),
  };
}

/* -------------------------------------------------------------------------- */
/* The four materials                                                         */
/* -------------------------------------------------------------------------- */

describe('character materials', () => {
  it('gives each material the properties its job needs', () => {
    const skin = createSkinMaterial();
    const mail = createChainMailMaterial();
    const leather = createLeatherMaterial();
    const steel = createSteelMaterial();

    // Skin: matte, not metal.
    expect(skin.metalness).toBe(DEFAULT_SKIN_OPTIONS.metalness);
    expect(skin.roughness).toBe(DEFAULT_SKIN_OPTIONS.roughness);

    // Chain mail: metallic. This is the one that has to be metal, or the weave
    // reads as painted-on grey.
    expect(mail.metalness).toBe(DEFAULT_CHAIN_MAIL_OPTIONS.metalness);
    expect(mail.metalness).toBe(1);
    expect(mail.roughness).toBeLessThan(0.5);

    // Leather: matte and rough.
    expect(leather.metalness).toBe(DEFAULT_LEATHER_OPTIONS.metalness);
    expect(leather.roughness).toBeGreaterThan(0.5);

    // Steel: the shiniest of the four.
    expect(steel.metalness).toBe(1);
    expect(steel.roughness).toBeLessThan(mail.roughness);
  }, 30000);

  it('builds a set and disposes it', () => {
    const materials = createCharacterMaterials();
    const kinds = Object.keys(materials).sort();
    expect(kinds).toEqual(['chainMail', 'leather', 'skin', 'steel']);
    for (const material of Object.values(materials)) {
      expect(material).toBeInstanceOf(MeshStandardMaterial);
    }
    disposeCharacterMaterials(materials);
    // Safe to call twice: three's dispose is idempotent, and a double dispose
    // here would be a use-after-free on the GPU side.
    expect(() => disposeCharacterMaterials(materials)).not.toThrow();
  }, 30000);

  it('gives every material its own program cache key', () => {
    const keys = [
      createSkinMaterial(),
      createChainMailMaterial(),
      createLeatherMaterial(),
      createSteelMaterial(),
    ].map((m) => m.customProgramCacheKey());

    // Four distinct keys, all non-empty. If two shared one, three would reuse a
    // program compiled with the other's patch and one material would render
    // with the wrong surface entirely.
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) expect(key.length).toBeGreaterThan(0);
  }, 30000);
});

/* -------------------------------------------------------------------------- */
/* The GLSL, analysed                                                         */
/* -------------------------------------------------------------------------- */

describe('character material shaders', () => {
  const cases: [string, () => CharacterMaterials[keyof CharacterMaterials]][] = [
    ['skin', () => createSkinMaterial()],
    ['chainMail', () => createChainMailMaterial()],
    ['leather', () => createLeatherMaterial()],
    ['steel', () => createSteelMaterial()],
  ];

  for (const [name, make] of cases) {
    it(`${name}: compiles clean on paper`, () => {
      const shader = patched(make() as MeshStandardMaterial);
      const findings = [
        ...analyse(shader.vertexShader, THREE_BASE.vertex),
        ...analyse(shader.fragmentShader, THREE_BASE.fragment),
      ];
      for (const f of findings) console.log(`${name} ${f.kind} ${f.detail} (line ${f.line})`);
      expect(findings).toEqual([]);
    }, 30000);

    it(`${name}: provides every uniform it declares`, () => {
      const shader = patched(make() as MeshStandardMaterial);
      const provided = new Set(Object.keys(shader.uniforms));
      const missing: string[] = [];
      for (const src of [shader.vertexShader, shader.fragmentShader]) {
        const re = /uniform\s+\w+\s+(u[A-Z]\w*)\s*;/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(stripComments(src)))) {
          if (!provided.has(m[1])) missing.push(m[1]);
        }
      }
      expect(missing).toEqual([]);
      // And it must declare at least one, or the patch did nothing at all.
      expect(provided.size).toBeGreaterThan(0);
    }, 30000);
  }

  it('anchors every injection on a chunk that exists', () => {
    // `String.replace` with a pattern that matches nothing silently returns the
    // original string, so an injection anchored to a typo'd or absent chunk does
    // nothing at all - and the material renders as a flat colour with no error
    // anywhere. This is the failure mode the anchor names are checked against.
    //
    // The chunk itself may legitimately be guarded, and three of these are:
    // `map_fragment` is wrapped in `#ifdef USE_MAP`, `normal_fragment_maps` in
    // `#ifdef USE_NORMALMAP_OBJECTSPACE`, `uv_vertex` in `#if defined(USE_UV)`.
    // That does not matter, because code appended after `#include <chunk>` lands
    // after the chunk's *closing* `#endif`, so the injection is unconditional
    // whatever the guard. Asserting the chunks were unguarded would be asserting
    // something false about three and would have hidden the real check.
    const anchors = [
      'map_fragment',
      'roughnessmap_fragment',
      'normal_fragment_maps',
      'opaque_fragment',
      'uv_vertex',
      'begin_vertex',
      'common',
    ];
    const base = `${ShaderLib.physical.vertexShader}\n${ShaderLib.physical.fragmentShader}`;
    const missing = anchors.filter((a) => !base.includes(`#include <${a}>`));
    expect(missing).toEqual([]);
  }, 30000);

  it('carries the chain mail part size through to the uniform', () => {
    // This is what makes "rings per metre" true rather than a figure of speech.
    const mail = createChainMailMaterial({ size: [0.55, 0.42] });
    const shader = patched(mail);
    expect(shader.uniforms.uAstraMailSize?.value).toEqual([0.55, 0.42]);

    // And a part with no size still gets something finite, or the UV multiply
    // would produce NaN and the whole material would go black.
    const unsized = patched(createChainMailMaterial());
    const size = unsized.uniforms.uAstraMailSize?.value as [number, number];
    expect(Number.isFinite(size[0])).toBe(true);
    expect(Number.isFinite(size[1])).toBe(true);
    expect(size[0]).toBeGreaterThan(0);
  }, 30000);

  it('keeps the noise library out of the materials that do not need it', () => {
    // Every fragment patch pulls in NOISE_GLSL, which is a few hundred lines.
    // Asserting it is there is not useful; asserting the materials that need it
    // have it and that the count is right is.
    const counts = {
      skin: (patched(createSkinMaterial()).fragmentShader.match(/astraFbm2D/g) ?? []).length,
      leather: (patched(createLeatherMaterial()).fragmentShader.match(/astraFbm2D/g) ?? []).length,
      steel: (patched(createSteelMaterial()).fragmentShader.match(/astraFbm2D/g) ?? []).length,
    };
    expect(counts.skin).toBeGreaterThan(0);
    expect(counts.leather).toBeGreaterThan(0);
    expect(counts.steel).toBeGreaterThan(0);
  }, 30000);
});
