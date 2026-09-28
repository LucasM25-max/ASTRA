// Static analysis of the hand-written sky shaders.
//
// The shaders are never compiled by a real driver in this test suite - there is
// no GPU and no browser - so a typo in an identifier, a uniform declared in GLSL
// but missing from the material, or a varying that only one stage declares would
// all be invisible here and fatal in the game. Each of those is a link-time or
// compile-time error that produces either a black frame or a silently wrong one,
// with nothing in the log to say so.
//
// None of them can be caught by running the shader, because running it requires
// the thing that is missing. So this checks the source instead: every identifier
// used must be declared, every uniform declared must be provided, and the two
// stages must agree on their varyings.
import { describe, expect, it } from 'vitest';
import { SkySystem } from '../src/renderer/SkySystem';

const GLSL_BUILTINS = new Set([
  // types
  'void','bool','int','uint','float','vec2','vec3','vec4','ivec2','ivec3','ivec4',
  'uvec2','uvec3','uvec4','bvec2','bvec3','bvec4','mat2','mat3','mat4',
  'sampler2D','sampler3D','samplerCube','uniform','attribute','varying','in','out',
  'const','struct','return','if','else','for','while','do','break','continue',
  'discard','precision','highp','mediump','lowp','invariant','flat','smooth','layout',
  // built-in functions
  'radians','degrees','sin','cos','tan','asin','acos','atan','sinh','cosh','tanh',
  'pow','exp','log','exp2','log2','sqrt','inversesqrt','abs','sign','floor','ceil',
  'fract','mod','min','max','clamp','mix','step','smoothstep','length','distance',
  'dot','cross','normalize','faceforward','reflect','refract','matrixCompMult',
  'lessThan','lessThanEqual','greaterThan','greaterThanEqual','equal','notEqual',
  'any','all','not','texture2D','texture','textureLod','textureCube','dFdx','dFdy',
  'fwidth','transpose','inverse','determinant','uintBitsToFloat','floatBitsToUint',
  // vertex-stage built-ins
  'gl_Position','gl_FragColor','gl_FragCoord','gl_PointSize','gl_VertexID',
  'gl_InstanceID','gl_FrontFacing','gl_PointCoord',
  // three.js injected
  'modelMatrix','modelViewMatrix','projectionMatrix','viewMatrix','normalMatrix',
  'cameraPosition','isOrthographic','position','normal','uv','uv1','uv2','tangent',
  'color','instanceMatrix','instanceColor','logDepthBufFC','toneMappingExposure',
  'colorspace_fragment','gl_FragDepth',
  'true','false',
]);

interface Finding { shader: string; kind: string; detail: string; line: number }

function stripComments(src: string): string {
  // Remove block comments first, then line comments, so a // inside a block
  // comment (or a /* inside a line comment) cannot desynchronise the two passes.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  out = out.replace(/\/\/[^\n]*/g, ' ');
  // Preprocessor directives (#include, #define) are not GLSL identifiers.
  out = out.replace(/^\s*#[^\n]*/gm, ' ');
  return out;
}

function analyse(name: string, rawSrc: string): Finding[] {
  const out: Finding[] = [];
  const src = stripComments(rawSrc);
  // 1. Delimiter balance.
  const pairs: [string, string][] = [['{', '}'], ['(', ')'], ['[', ']']];
  for (const [open, close] of pairs) {
    let depth = 0;
    let line = 1;
    for (const ch of src) {
      if (ch === '\n') line++;
      if (ch === open) depth++;
      if (ch === close) depth--;
      if (depth < 0) { out.push({ shader: name, kind: 'delimiter', detail: `stray '${close}'`, line }); break; }
    }
    if (depth !== 0) out.push({ shader: name, kind: 'delimiter', detail: `unbalanced '${open}' (depth ${depth})`, line: -1 });
  }
  // 2. Template-literal leftovers.
  for (const bad of ['${', '`', '\\n']) {
    if (src.includes(bad)) out.push({ shader: name, kind: 'template', detail: `contains ${JSON.stringify(bad)}`, line: -1 });
  }
  // 3. Undeclared identifiers. Collect declarations, then flag any identifier
  //    that is used but never declared and is not a GLSL/three built-in.
  const declared = new Set<string>(GLSL_BUILTINS);
  const declRe = /\b(?:uniform|attribute|varying|in|out)\s+(?:lowp|mediump|highp\s+)?\w+\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) declared.add(m[1]);
  // function parameters and locals: "type name" or "type name = ..."
  const localRe = /\b(?:float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|mat3|mat4)\s+([A-Za-z_]\w*)\s*(?:=|;|,|\))/g;
  while ((m = localRe.exec(src))) declared.add(m[1]);
  // function names declared as "type name("
  const fnRe = /\b(?:float|int|uint|bool|vec2|vec3|vec4|void)\s+([A-Za-z_]\w*)\s*\(/g;
  while ((m = fnRe.exec(src))) declared.add(m[1]);

  // Skip anything preceded by a dot: those are swizzles (.xyz, .xz) and struct
  // members, not identifiers that need declaring.
  const usedRe = /(?<![.\w])([A-Za-z_]\w*)\b/g;
  const lineOf = (idx: number) => src.slice(0, idx).split('\n').length;
  const seen = new Set<string>();
  while ((m = usedRe.exec(src))) {
    const id = m[1];
    if (declared.has(id) || seen.has(id)) continue;
    // Skip member accesses and things that are clearly fine.
    seen.add(id);
    out.push({ shader: name, kind: 'undeclared', detail: id, line: lineOf(m.index) });
  }
  return out;
}

describe('sky shader integrity', () => {
  const sky = new SkySystem();
  const material = sky.mesh.material;

  it('has no undeclared identifiers or unbalanced delimiters', () => {
    const findings = [
      ...analyse('vertex', material.vertexShader as string),
      ...analyse('fragment', material.fragmentShader as string),
    ];
    for (const f of findings) console.log(`${f.shader} ${f.kind} ${f.detail} (line ${f.line})`);
    expect(findings).toEqual([]);
  });

  it('provides every uniform the shaders declare', () => {
    // A uniform declared in GLSL but missing from the material's uniforms object
    // is not a compile error: three.js warns once and leaves the value undefined,
    // which in a colour channel is NaN and NaN is a black frame with nothing in
    // the log. The shader has never been compiled by a real driver here, so this
    // is the only thing standing between a typo and a black sky in the game.
    const provided = new Set(Object.keys(material.uniforms as Record<string, unknown>));
    const missing: string[] = [];
    for (const [stage, src] of [
      ['vertex', material.vertexShader as string],
      ['fragment', material.fragmentShader as string],
    ] as const) {
      const re = /uniform\s+\w+\s+(u[A-Z]\w*)\s*;/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripComments(src)))) {
        if (!provided.has(m[1])) missing.push(`${stage}: ${m[1]}`);
      }
    }
    console.log('uniforms provided:', [...provided].join(', '));
    expect(missing).toEqual([]);
  });

  it('matches its varyings across both stages', () => {
    // three.js compiles every non-raw ShaderMaterial as `#version 300 es` with
    // `#define varying out` in the vertex stage and `#define varying in` in the
    // fragment stage, so the source is written in GLSL1 style and macro-rewritten.
    // That means a varying written by the vertex shader but not declared in the
    // fragment shader links fine and reads as zero - the sky renders wrong with
    // no error at all - so the two lists must match exactly, type included.
    const stage = (src: string) => {
      const re = /varying\s+(vec[234]|float|mat[34])\s+(\w+)\s*;/g;
      const found: Array<[string, string]> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripComments(src)))) found.push([m[2], m[1]]);
      return found;
    };
    const vOut = stage(material.vertexShader as string);
    const fIn = stage(material.fragmentShader as string);
    expect(vOut.length).toBeGreaterThan(0);
    expect(vOut.map(([n]) => n).sort()).toEqual(fIn.map(([n]) => n).sort());
    for (const [name, type] of vOut) {
      const match = fIn.find(([n]) => n === name);
      expect(match, `varying ${name} missing from the fragment shader`).toBeTruthy();
      expect(match?.[1]).toBe(type);
    }
  });
});
