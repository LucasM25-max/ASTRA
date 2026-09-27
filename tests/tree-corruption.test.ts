import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parser } from '@shaderfrog/glsl-parser';
import {
  createBarkMaterial,
  createLeafMaterial,
  patchBarkShader,
  patchLeafShader,
  DEFAULT_BARK_MATERIAL_OPTIONS,
  DEFAULT_LEAF_MATERIAL_OPTIONS,
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

/** Resolve options against a patch's own defaults, exactly as the patch does. */
function barkOptions(o: BarkMaterialOptions = {}): Required<Omit<BarkMaterialOptions, 'windUniform'>> {
  return { ...DEFAULT_BARK_MATERIAL_OPTIONS, ...o };
}
function leafOptions(o: LeafMaterialOptions = {}): Required<Omit<LeafMaterialOptions, 'windUniform'>> {
  return { ...DEFAULT_LEAF_MATERIAL_OPTIONS, ...o };
}

/** Parse a shader, returning the AST or a descriptive failure. */
function parse(src: string): unknown {
  return parser.parse(src);
}

/**
 * The block of a shader between two anchors, inclusive of both.
 *
 * Used to prove that an injection landed at the include it claims to have
 * landed at rather than merely somewhere in the file.
 */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, `anchor ${from} missing`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `anchor ${to} missing after ${from}`).toBeGreaterThan(a);
  return src.slice(a, b + to.length);
}

describe('bark corruption colour', () => {
  it('declares the corruption attribute and its varying in the vertex shader', () => {
    const v = patched((s) =>
      patchBarkShader(s, barkOptions(), { value: 0 }),
    ).vertexShader;
    expect(v).toContain('attribute float corruption;');
    expect(v).toContain('varying float vAstraCorruption;');
    // Exactly one of each: a second declaration is a link error on some
    // drivers and a silent shadow on the rest.
    expect(v.match(/attribute float corruption;/g)?.length).toBe(1);
    expect(v.match(/varying float vAstraCorruption;/g)?.length).toBe(1);
  });

  it('declares the same varying in the fragment shader', () => {
    const f = patched((s) =>
      patchBarkShader(s, barkOptions(), { value: 0 }),
    ).fragmentShader;
    expect(f.match(/varying float vAstraCorruption;/g)?.length).toBe(1);
  });

  it('writes the varying before the sway moves the vertex', () => {
    const v = patched((s) =>
      patchBarkShader(s, barkOptions(), { value: 0 }),
    ).vertexShader;
    const write = v.indexOf('vAstraCorruption = corruption;');
    const sway = v.indexOf('transformed.x += offset.x;');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(sway).toBeGreaterThan(write);
  });

  it('grey-shifts the bark at the colour stage, multiplying the vertex colour', () => {
    const f = patched((s) =>
      patchBarkShader(s, barkOptions(), { value: 0 }),
    ).fragmentShader;
    const block = between(f, '#include <map_fragment>', '#include <normal_fragment_maps>');
    // The whole corruption term lives inside the colour block, after the mottle
    // and before the multiply, so it modulates the bark rather than replacing
    // the dead tree's grey vertex colour or the fungal clusters on it.
    expect(block).toContain('float c = clamp( vAstraCorruption, 0.0, 1.0 );');
    expect(block).toContain('bark = mix( bark, grey, c * 0.85 );');
    expect(block).toContain('diffuseColor.rgb *= bark;');
    expect(block.indexOf('float c = clamp( vAstraCorruption')).toBeLessThan(
      block.indexOf('diffuseColor.rgb *= bark;'),
    );
  });

  it('desaturates toward the bark own luma rather than darkening it', () => {
    const f = patched((s) =>
      patchBarkShader(s, barkOptions(), { value: 0 }),
    ).fragmentShader;
    // Rec. 709 luma on the already-shaded bark, not on the vertex colour: the
    // grey has to be the tone of this plate, not the tone of the albedo.
    expect(f).toContain(
      'float luma = dot( bark, vec3( 0.2126, 0.7152, 0.0722 ) );',
    );
    // A cool grey rather than a neutral one, so it reads as bark and not as
    // concrete.
    expect(f).toContain('vec3( 0.94, 0.96, 0.93 )');
    // And a sickly cast at full corruption, from the same family the fungus
    // materials use.
    expect(f).toContain('grey = mix( grey, vec3( 0.30, 0.34, 0.20 ), c * 0.45 );');
  });

  it('does nothing at all when the vertex carries no corruption', () => {
    const f = patched((s) =>
      patchBarkShader(s, barkOptions(), { value: 0 }),
    ).fragmentShader;
    // The guard is what makes the attribute optional: a mesh with no corruption
    // attribute reads the generic value zero from WebGL, and zero must be a
    // no-op rather than a full-strength grey.
    expect(f).toContain('if ( c > 0.001 ) {');
    expect(f).toContain('clamp( vAstraCorruption, 0.0, 1.0 )');
  });

  it('parses as GLSL inside Three real standard-material fragment shader', () => {
    const f = patched((s) =>
      patchBarkShader(s, barkOptions(), { value: 0 }),
    ).fragmentShader;
    expect(() => parse(f)).not.toThrow();
  });
});

describe('leaf corruption', () => {
  it('declares the same corruption attribute and varying in the vertex shader', () => {
    const v = patched((s) =>
      patchLeafShader(s, leafOptions(), { value: 0 }),
    ).vertexShader;
    expect(v.match(/attribute float corruption;/g)?.length).toBe(1);
    expect(v.match(/varying float vAstraCorruption;/g)?.length).toBe(1);
    // The droop uniforms are declared alongside it.
    expect(v).toContain('uniform float uTreeHeight;');
    expect(v).toContain('uniform float uTreeDroop;');
  });

  it('declares the varying in the fragment shader', () => {
    const f = patched((s) =>
      patchLeafShader(s, leafOptions(), { value: 0 }),
    ).fragmentShader;
    expect(f.match(/varying float vAstraCorruption;/g)?.length).toBe(1);
  });

  it('writes the varying before the droop reads it and before the sway', () => {
    const v = patched((s) =>
      patchLeafShader(s, leafOptions(), { value: 0 }),
    ).vertexShader;
    const write = v.indexOf('vAstraCorruption = corruption;');
    const droop = v.indexOf('float fall = c * uTreeDroop * uTreeHeight * h * h;');
    const sway = v.indexOf('transformed.x += offset.x;');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(droop).toBeGreaterThan(write);
    // The sway has to come last: the droop changes the height the sway reads,
    // and applying it the other way round makes the crown swing around a point
    // it is no longer attached to.
    expect(sway).toBeGreaterThan(droop);
  });

  it('weights the droop quadratically in normalised height', () => {
    const v = patched((s) =>
      patchLeafShader(s, leafOptions(), { value: 0 }),
    ).vertexShader;
    const block = between(v, '#include <begin_vertex>', 'vec2 offset = astraSway');
    // Normalised by the tree's own height, and guarded against a zero height.
    expect(block).toContain('transformed.y / max( uTreeHeight, 1e-4 )');
    expect(block).toContain('float fall = c * uTreeDroop * uTreeHeight * h * h;');
    // Quadratic, not linear: a linear weight bows the trunk as well as the
    // crown, and a trunk that bows from its roots reads as a bendy prop rather
    // than as a dying tree.
    expect(block).not.toContain('float fall = c * uTreeDroop * h;');
  });

  it('twists the crown about the tree own axis, and only the crown', () => {
    const v = patched((s) =>
      patchLeafShader(s, leafOptions({ treeHeight: 10 }), { value: 0 }),
    ).vertexShader;
    const block = between(v, '#include <begin_vertex>', 'vec2 offset = astraSway');
    // The angle grows with the normalised height, so the trunk does not turn at
    // all and only the crown does. A constant angle would spin the whole tree
    // about its base, which is a different and much wronger effect.
    expect(block).toContain('float twist = c * uTreeTwist * h;');
    expect(block).toContain('float ts = sin( twist );');
    expect(block).toContain('float tc = cos( twist );');
    // Written out as an explicit 2D rotation rather than as a mat2 multiply: the
    // column-major convention makes `mat2( c, s, -s, c )` easy to get backwards,
    // and a backwards twist is invisible in review.
    expect(block).toContain('transformed.x * tc - transformed.z * ts');
    expect(block).toContain('transformed.x * ts + transformed.z * tc');
    // And it is in the leaf shader only. The bark never twists: the trunk
    // collider is a straight vertical capsule, and a trunk that spiralled away
    // from it would be a collision bug rather than a look.
    const bark = patched((s) => patchBarkShader(s, barkOptions(), { value: 0 }));
    expect(bark.vertexShader).not.toContain('uTreeTwist');
    expect(bark.vertexShader).not.toContain('float twist');
  });

  it('parses as GLSL with the twist on', () => {
    const v = patched((s) =>
      patchLeafShader(
        s,
        leafOptions({ treeHeight: 10, corruptionDroop: 0.14, corruptionTwist: 0.12 }),
        { value: 0 },
      ),
    ).vertexShader;
    expect(() => parse(v)).not.toThrow();
  });

  it('drops the canopy downward and narrows it as it falls', () => {
    const v = patched((s) =>
      patchLeafShader(s, leafOptions(), { value: 0 }),
    ).vertexShader;
    const block = between(v, '#include <begin_vertex>', 'vec2 offset = astraSway');
    expect(block).toContain('transformed.y -= fall;');
    // The crown closes up too: a crown that only sinks keeps its spread and
    // reads as a smaller tree rather than a wilting one.
    expect(block).toContain('transformed.xz *= 1.0 - c * 0.12 * h * h;');
  });

  it('is a no-op when the droop is zero or the corruption is zero', () => {
    const v = patched((s) =>
      patchLeafShader(s, leafOptions(), { value: 0 }),
    ).vertexShader;
    // The guard covers both terms, so a caller that disables the droop and the
    // twist gets exactly the unpatched vertex positions back rather than a
    // canopy that still sinks or turns.
    expect(v).toContain('if ( c > 0.001 && ( uTreeDroop > 0.0 || uTreeTwist > 0.0 ) ) {');
  });

  it('parses as GLSL inside Three real standard-material vertex shader', () => {
    const v = patched((s) =>
      patchLeafShader(s, leafOptions(), { value: 0 }),
    ).vertexShader;
    expect(() => parse(v)).not.toThrow();
  });

  it('yellowes the leaves at the colour stage, after the underside shading', () => {
    const f = patched((s) =>
      patchLeafShader(s, leafOptions(), { value: 0 }),
    ).fragmentShader;
    const underside = f.indexOf('diffuseColor.rgb *= 0.72 + 0.28 * up;');
    const yellow = f.indexOf('vec3 yellowed = vec3( luma * 1.22, luma * 1.02, luma * 0.42 );');
    expect(underside).toBeGreaterThanOrEqual(0);
    expect(yellow).toBeGreaterThan(underside);
    // Toward the leaf's own luma and then toward yellow, so a crown that only
    // gets darker reads as unlit rather than as dying.
    expect(f).toContain('float luma = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );');
    expect(f).toContain('diffuseColor.rgb = mix( diffuseColor.rgb, yellowed, c * 0.75 );');
    // And a grey-green at full strength, so severe corruption is not merely
    // yellow.
    expect(f).toContain(
      'yellowed = mix( yellowed, vec3( luma * 0.62, luma * 0.70, luma * 0.40 ), c * 0.6 );',
    );
  });
});

describe('corruption options', () => {
  it('leaves the bark droop off by default and the leaf droop on', () => {
    // The bark gets no droop at all: the plan droops the canopy, and a trunk
    // that sinks reads as the tree settling into the ground.
    expect(DEFAULT_BARK_MATERIAL_OPTIONS.corruptionDroop).toBe(0);
    expect(DEFAULT_LEAF_MATERIAL_OPTIONS.corruptionDroop).toBe(0.14);
    // And the twist is on by default, at seven degrees at the top of the crown:
    // enough to change a whole oak's silhouette, small enough that the crown's
    // own blobs still sit over the branches that hold them.
    expect(DEFAULT_LEAF_MATERIAL_OPTIONS.corruptionTwist).toBeCloseTo(0.12, 6);
    // The bark has no twist option at all, rather than one that defaults to
    // zero: a trunk that spirals would leave the vertical capsule collider.
    expect('corruptionTwist' in DEFAULT_BARK_MATERIAL_OPTIONS).toBe(false);
  });

  it('leaves both tree heights at zero by default, which disables the droop', () => {
    // Zero is the safe default: the guard makes the normalisation a no-op
    // rather than a division by zero, so a caller that forgets the height gets
    // an undrooped tree rather than a NaN canopy.
    expect(DEFAULT_BARK_MATERIAL_OPTIONS.treeHeight).toBe(0);
    expect(DEFAULT_LEAF_MATERIAL_OPTIONS.treeHeight).toBe(0);
  });

  it('routes the droop options into uniforms', () => {
    const shader = patched((s) =>
      patchLeafShader(
        s,
        leafOptions({ treeHeight: 10.1, corruptionDroop: 0.2, corruptionTwist: 0.3 }),
        { value: 0 },
      ),
    );
    expect(shader.uniforms.uTreeHeight).toEqual({ value: 10.1 });
    expect(shader.uniforms.uTreeDroop).toEqual({ value: 0.2 });
    expect(shader.uniforms.uTreeTwist).toEqual({ value: 0.3 });
  });

  it('survives an explicit undefined override instead of producing a NaN', () => {
    // Spreading `{ treeHeight: undefined }` over the defaults replaces the
    // default with undefined, and `clamp( y / undefined )` is a NaN that
    // silently deletes the entire canopy.
    const hole: LeafMaterialOptions = { treeHeight: undefined, corruptionDroop: undefined };
    const shader = patched((s) =>
      patchLeafShader(s, { ...DEFAULT_LEAF_MATERIAL_OPTIONS, ...hole }, { value: 0 }),
    );
    expect(shader.uniforms.uTreeHeight).toEqual({ value: 0 });
    expect(shader.uniforms.uTreeDroop).toEqual({ value: 0 });
  });

  it('builds materials that carry the droop uniforms through the compile patch', () => {
    const bark = createBarkMaterial({ treeHeight: 7.5 });
    const leaf = createLeafMaterial({ treeHeight: 7.5, corruptionDroop: 0.2 });
    // onBeforeCompile is what assigns the uniforms, so drive it with a stub to
    // confirm the values the real material will hand the GPU.
    const uniforms: Record<string, { value: unknown }> = {};
    bark.onBeforeCompile({
      uniforms,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as never, undefined as never);
    leaf.onBeforeCompile({
      uniforms,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as never, undefined as never);
    expect(uniforms.uTreeHeight.value).toBe(7.5);
    expect(uniforms.uTreeDroop.value).toBe(0.2);
    expect(uniforms.uTreeTwist.value).toBe(0.12);
    bark.dispose();
    leaf.dispose();
  });
});

describe('shared corruption contract', () => {
  it('names the attribute the same thing the terrain material names it', () => {
    // One field, one name. The terrain declares `attribute float corruption;`
    // and bakes the value per vertex; the tree declares the same name and reads
    // it from an instanced buffer. Two different names for one quantity is how
    // the two end up disagreeing about what "corrupted" means.
    const bark = patched((s) => patchBarkShader(s, barkOptions(), { value: 0 }));
    const leaf = patched((s) => patchLeafShader(s, leafOptions(), { value: 0 }));
    for (const s of [bark.vertexShader, leaf.vertexShader]) {
      expect(s).toContain('attribute float corruption;');
    }
  });

  it('uses the same luma weights as the terrain overlay', () => {
    // Rec. 709 everywhere: a trunk, a crown and a patch of ground that turn
    // grey by three different formulae drift apart in the same frame.
    const bark = patched((s) => patchBarkShader(s, barkOptions(), { value: 0 }));
    const leaf = patched((s) => patchLeafShader(s, leafOptions(), { value: 0 }));
    const luma = 'vec3( 0.2126, 0.7152, 0.0722 )';
    expect(bark.fragmentShader).toContain(luma);
    expect(leaf.fragmentShader).toContain(luma);
  });

  it('keeps the sway identical between the two materials', () => {
    // The existing contract, re-asserted next to the droop: the droop is added
    // between the two materials' shared blocks, and it must not have disturbed
    // the one thing they have to agree on character for character.
    const bark = patched((s) => patchBarkShader(s, barkOptions(), { value: 0 }));
    const leaf = patched((s) => patchLeafShader(s, leafOptions(), { value: 0 }));
    const swayOf = (src: string): string => {
      const a = src.indexOf('float astraSway(');
      const b = src.indexOf('}', src.indexOf('return', a)) + 1;
      return src.slice(a, b);
    };
    expect(swayOf(bark.vertexShader)).toBe(swayOf(leaf.vertexShader));
  });
});

describe('droop arithmetic', () => {
  /**
   * The shader's own formula, evaluated on the CPU.
   *
   * This is a restatement of the GLSL rather than an execution of it, so it is
   * only worth what the assertions below are worth: that the weights are
   * monotonic in height, that they are zero at the base, and that they are
   * bounded by the droop fraction. Those three properties are what stop the
   * droop from turning a sapling inside out.
   */
  const droop = (
    y: number,
    treeHeight: number,
    corruption: number,
    droopFraction: number,
  ): number =>
    corruption *
    droopFraction *
    treeHeight *
    Math.pow(Math.min(Math.max(y / treeHeight, 0), 1), 2);

  it('leaves the base of the tree exactly where it was', () => {
    expect(droop(0, 10, 1, 0.14)).toBe(0);
    expect(droop(0, 10, 0.5, 0.14)).toBe(0);
  });

  it('rises monotonically with height', () => {
    let previous = -1;
    for (let y = 0; y <= 10; y += 0.5) {
      const d = droop(y, 10, 1, 0.14);
      expect(d).toBeGreaterThanOrEqual(previous);
      previous = d;
    }
  });

  it('never moves the crown further than the droop fraction of the height', () => {
    for (const corruption of [0, 0.25, 0.5, 0.75, 1]) {
      expect(droop(10, 10, corruption, 0.14)).toBeCloseTo(1.4 * corruption, 10);
      // Above the top of the tree the weight is clamped, so the crown does not
      // keep falling for vertices that should not exist.
      expect(droop(40, 10, corruption, 0.14)).toBeCloseTo(1.4 * corruption, 10);
    }
  });

  it('loses the same fraction of every tree height', () => {
    // A 10 m oak at full corruption loses 1.4 m and a 3 m sapling loses 0.42 m:
    // both 14%, which is what multiplying by uTreeHeight buys. Without it the
    // sapling and the oak would both lose 0.14 m and only the sapling would
    // read as wilting.
    expect(droop(10, 10, 1, 0.14) / 10).toBeCloseTo(droop(3, 3, 1, 0.14) / 3, 10);
    expect(droop(10, 10, 1, 0.14)).toBeCloseTo(1.4, 10);
    expect(droop(3, 3, 1, 0.14)).toBeCloseTo(0.42, 10);
  });

  it('is a no-op when the height is zero', () => {
    // The default. uTreeHeight multiplies the fall as well as normalising it,
    // so a caller that never sets the height gets an undrooped tree rather
    // than one that falls by a fixed number of metres.
    expect(droop(10, 0, 1, 0.14)).toBe(0);
  });

  it('does nothing below the guard threshold', () => {
    // The shader skips the block entirely below 0.001, so the smallest
    // corruption that matters is invisible rather than a 0.1% sag.
    expect(droop(10, 10, 0.0005, 0.14)).toBeLessThan(0.001);
  });

  it('twists by an angle that grows with height and nothing at the base', () => {
    const twist = (y: number, treeHeight: number, c: number, t: number): number =>
      c * t * Math.min(1, Math.max(0, y / treeHeight));
    expect(twist(0, 10, 1, 0.12)).toBe(0);
    expect(twist(10, 10, 1, 0.12)).toBeCloseTo(0.12, 10);
    // Monotonic, so the crown turns progressively rather than all at once.
    let previous = -1;
    for (let y = 0; y <= 10; y += 0.5) {
      const a = twist(y, 10, 1, 0.12);
      expect(a).toBeGreaterThanOrEqual(previous);
      previous = a;
    }
    // Clamped above the top of the tree, so a vertex that should not exist does
    // not keep turning.
    expect(twist(40, 10, 1, 0.12)).toBeCloseTo(0.12, 10);
  });

  it('keeps the crown over its branches at full twist', () => {
    // The crown's blobs are a bit over a metre across, so a top-of-crown twist
    // of seven degrees at the oak's three-metre canopy radius moves a blob by
    // about a third of a metre - well inside its own radius. This is the number
    // that justifies the default: any larger and the leaves leave the branches.
    const displacement = Math.sin(0.12) * 3.1;
    expect(displacement).toBeLessThan(1.15);
    expect(displacement).toBeGreaterThan(0.2);
  });
});
