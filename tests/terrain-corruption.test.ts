import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parser } from '@shaderfrog/glsl-parser';
import {
  generateTerrain,
  buildTerrainGeometry,
  TERRAIN_SIZE,
  TERRAIN_RESOLUTION,
} from '../src/procedural/TerrainGenerator';
import {
  createTerrainMaterial,
  patchTerrainShader,
  DEFAULT_TERRAIN_MATERIAL_OPTIONS,
} from '../src/procedural/MaterialFactory';
import { Terrain } from '../src/world/Terrain';
import { CorruptionField, corruptionIntensity } from '../src/procedural/CorruptionField';

/** Apply the patch to Three's own standard-material sources. */
function patched(corruptionStrength: number): {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, unknown>;
} {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {} as Record<string, unknown>,
  };
  patchTerrainShader(shader, { ...DEFAULT_TERRAIN_MATERIAL_OPTIONS, corruptionStrength });
  return shader;
}

describe('the terrain corruption field', () => {
  const data = generateTerrain({ seed: 7, resolution: 96, size: 300 });

  it('is baked per vertex, at the resolution the terrain was built at', () => {
    expect(data.corruption).toHaveLength(data.resolution * data.resolution);
    for (const c of data.corruption) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it('agrees with CorruptionField over the same spline', () => {
    // The ground, the bark and the fungus all have to answer the same
    // question, and this is the assertion that they do. Sampled at the
    // terrain's own vertices, where the two are supposed to be identical
    // rather than merely similar.
    // Same lattice and same influence as the terrain used, so the two are
    // sampling the same points and the comparison is exact rather than
    // approximate. With different resolutions the two lattices disagree by a
    // cell, which shows up as a corruption difference of about a thousandth -
    // enough to fail a tight tolerance and not enough to see.
    const field = new CorruptionField(data.spline, {
      size: data.size,
      resolution: data.resolution,
      maxInfluence: 90,
    });
    const step = data.size / (data.resolution - 1);
    const half = data.size / 2;
    let checked = 0;
    for (let i = 0; i < data.resolution; i += 7) {
      for (let j = 0; j < data.resolution; j += 7) {
        const x = -half + j * step;
        const z = -half + i * step;
        const baked = data.corruption[i * data.resolution + j];
        // The field is a 128-lattice and the terrain a 96-lattice, so they do
        // not sample at the same points. What has to hold is that they agree
        // wherever both are meaningful.
        expect(baked).toBeCloseTo(corruptionIntensity(
          data.distanceToStream[i * data.resolution + j],
          field.pollutionAt(x, z),
        ), 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('reaches severe corruption in the channel and nothing on the far hills', () => {
    // The plan's inner zone has to exist somewhere on the terrain, or the
    // shader has nothing to draw.
    let max = 0;
    for (const c of data.corruption) max = Math.max(max, c);
    expect(max).toBeGreaterThan(0.7);

    // A corner of the map is far from any part of the stream.
    const corner = data.corruption[data.resolution - 1];
    expect(corner).toBe(0);
  });

  it('covers a minority of the terrain', () => {
    let corrupted = 0;
    for (const c of data.corruption) if (c > 0.08) corrupted++;
    const share = corrupted / data.corruption.length;
    expect(share).toBeGreaterThan(0.01);
    expect(share).toBeLessThan(0.35);
  });

  it('honours overrides without the defaults leaking through', () => {
    // Spreading `{ reachMin: undefined }` over the defaults replaces 12 with
    // undefined and makes the reach NaN - which is not a thrown error, just a
    // corruption array full of NaN that reaches the GPU as a black terrain.
    const wide = generateTerrain({
      seed: 7,
      resolution: 48,
      size: 300,
      corruption: { reachMax: 90 },
    });
    let wideCorrupted = 0;
    for (const c of wide.corruption) if (c > 0.08) wideCorrupted++;
    let baseCorrupted = 0;
    for (const c of generateTerrain({ seed: 7, resolution: 48, size: 300 }).corruption) {
      if (c > 0.08) baseCorrupted++;
    }
    expect(wideCorrupted).toBeGreaterThan(baseCorrupted);

    const none = generateTerrain({
      seed: 7,
      resolution: 48,
      size: 300,
      corruption: { reachMin: 0.001, reachMax: 0.002 },
    });
    let noneCorrupted = 0;
    for (const c of none.corruption) if (c > 0.08) noneCorrupted++;
    expect(noneCorrupted).toBe(0);
  });

  it('reaches the geometry as a one-float attribute', () => {
    const geometry = buildTerrainGeometry(data);
    const attribute = geometry.getAttribute('corruption');
    expect(attribute).toBeTruthy();
    expect(attribute!.count).toBe(data.resolution * data.resolution);
    expect(attribute!.itemSize).toBe(1);
    // And the values are the ones that were baked, not resampled.
    const array = attribute!.array as Float32Array;
    expect(array[0]).toBeCloseTo(data.corruption[0], 6);
    expect(array[array.length - 1]).toBeCloseTo(data.corruption[data.corruption.length - 1], 6);
  });

  it('reaches the façade the WorldScene builds', () => {
    // The point of baking it in the generator: `Terrain` needs no new option
    // and no new wiring, so the overlay simply exists.
    const terrain = new Terrain({ seed: 7, resolution: 64, size: 200 });
    expect(terrain.mesh.geometry.getAttribute('corruption')).toBeTruthy();
    const material = terrain.mesh.material as THREE.MeshStandardMaterial;
    expect(material.customProgramCacheKey()).toBe('astra-terrain-v1-corrupt');
  });

  it('costs one float per vertex', () => {
    // The alternative - evaluating the corruption in the fragment shader -
    // would need the spline walked per fragment. 590 kB at the shipped
    // resolution is the price of not doing that.
    const bytes = TERRAIN_RESOLUTION * TERRAIN_RESOLUTION * 4;
    expect(bytes).toBeLessThan(1024 * 1024);
    expect(TERRAIN_SIZE).toBe(500);
  });
});

describe('the terrain fungal overlay shader', () => {
  it('injects nothing when the strength is zero', () => {
    // A caller that does not want corruption must not pay for it: no varying,
    // no attribute, no uniforms, no second injection point.
    const shader = patched(0);
    expect(shader.vertexShader).not.toContain('vAstraCorruption');
    expect(shader.vertexShader).not.toContain('attribute float corruption');
    expect(shader.fragmentShader).not.toContain('astraCorruptionWeight');
    expect(Object.keys(shader.uniforms)).not.toContain('uCorruptionStrength');
    expect(Object.keys(shader.uniforms)).not.toContain('uCorruptionScale');
    expect(Object.keys(shader.uniforms)).not.toContain('uCorruptionDarken');
  });

  it('declares and passes the attribute when the strength is positive', () => {
    const shader = patched(1);
    expect(shader.vertexShader).toContain('attribute float corruption');
    expect(shader.vertexShader).toContain('varying float vAstraCorruption');
    expect(shader.vertexShader).toContain('vAstraCorruption = corruption');
    expect(shader.fragmentShader).toContain('varying float vAstraCorruption');
  });

  it('declares every uniform it sets, once per shader', () => {
    const shader = patched(1);
    const set = Object.keys(shader.uniforms);
    for (const [name, src] of [
      ['vertex', shader.vertexShader],
      ['fragment', shader.fragmentShader],
    ] as const) {
      const declared = [...src.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)]
        .map((m) => m[1])
        .filter((n) => n.startsWith('u'));
      for (const uniform of set) {
        expect(
          declared.filter((d) => d === uniform).length,
          `${name}: ${uniform}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('parses as GLSL inside Three real standard-material shaders', () => {
    // The only way to catch a syntax error in injected GLSL without a GPU.
    // `roughnessFactor` in particular is declared by `<roughnessmap_fragment>`
    // and does not exist when `<map_fragment>` runs, so reading it at the
    // colour stage would be a compile error that no TypeScript check can see.
    const problems: string[] = [];
    for (const strength of [0, 1]) {
      const shader = patched(strength);
      for (const [name, src] of [
        ['vertex', shader.vertexShader],
        ['fragment', shader.fragmentShader],
      ] as const) {
        try {
          parser.parse(src);
        } catch (error) {
          problems.push(`strength=${strength} ${name}: ${(error as Error).message}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('reads the roughness at the chunk that declares it', () => {
    const shader = patched(1);
    // The roughness block must come after `<roughnessmap_fragment>`, which is
    // the only place `roughnessFactor` exists.
    const roughnessAt = shader.fragmentShader.indexOf('#include <roughnessmap_fragment>');
    const roughnessRead = shader.fragmentShader.indexOf('roughnessFactor = clamp');
    expect(roughnessAt).toBeGreaterThan(-1);
    expect(roughnessRead).toBeGreaterThan(roughnessAt);
    // And the colour block, which is where the weight is first computed, comes
    // before it.
    expect(shader.fragmentShader.indexOf('astraCorruptionWeight')).toBeLessThan(roughnessAt);
  });

  it('shifts the ground toward the rot colour AND darkens it', () => {
    // A stain that only shifts the hue still looks like clean ground that has
    // been tinted. The darkening is what reads as dead.
    const shader = patched(1);
    expect(shader.fragmentShader).toContain('mix( diffuseColor.rgb, rot, weight * 0.8 )');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb *= 1.0 - weight * uCorruptionDarken');
  });

  it('uses a stain scale far larger than the terrain detail', () => {
    // The overlay is a broad stain across the bank, not grain. At terrain
    // detail scale it would read as moss rather than as rot.
    expect(DEFAULT_TERRAIN_MATERIAL_OPTIONS.corruptionScale).toBeLessThan(
      DEFAULT_TERRAIN_MATERIAL_OPTIONS.detailScale,
    );
  });

  it('keys its program on the corruption flag, not just the version', () => {
    // The patch injects a different program when corruption is on. A fixed key
    // would let Three hand the corrupted material a program compiled for the
    // clean one, which reads a `corruption` attribute the geometry does not
    // have and draws as black.
    const clean = createTerrainMaterial({ corruptionStrength: 0 });
    const corrupt = createTerrainMaterial({ corruptionStrength: 1 });
    expect(corrupt.customProgramCacheKey()).not.toBe(clean.customProgramCacheKey());
    expect(corrupt.customProgramCacheKey()).toBe('astra-terrain-v1-corrupt');
    expect(clean.customProgramCacheKey()).toBe('astra-terrain-v1');
  });
});
