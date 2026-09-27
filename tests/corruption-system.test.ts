import { describe, it, expect, afterEach, vi } from 'vitest';
import { InstancedMesh, Points, PointLight } from 'three';
import {
  CorruptionSystem,
  DEFAULT_FUNGUS_PATCH_RADIUS,
  DEFAULT_SPORE_COUNT,
  DEFAULT_SPORE_RADIUS,
  GROUND_KINDS,
  SPORE_LIFETIME,
  SPORE_STAGE_SHARE,
  CORRUPTION_LIGHT_INTENSITY,
  CORRUPTION_LIGHT_DISTANCE,
  DEFAULT_FUNGUS_TRIANGLE_BUDGET,
  type CorruptionSystemOptions,
} from '../src/world/CorruptionSystem';
import { StreamSpline } from '../src/procedural/StreamSpline';
import { CorruptionField } from '../src/procedural/CorruptionField';
import { FUNGUS_TRIANGLES } from '../src/procedural/FungusGenerator';

/** A stream through the origin, so the default camera stands in the rot. */
const spline = new StreamSpline({
  controlPoints: [
    { x: -200, y: 0, z: -40 },
    { x: -60, y: 0, z: 20 },
    { x: 90, y: 0, z: -20 },
    { x: 220, y: 0, z: 50 },
  ],
});

/** Flat ground with a gentle rise, so nothing is rejected for height. */
const heightAt = (x: number): number => Math.max(0, x) * 0.02;
const normalAt = (): { x: number; y: number; z: number } => ({ x: 0, y: 1, z: 0 });

const open: CorruptionSystem[] = [];

function make(options: Partial<CorruptionSystemOptions> = {}): CorruptionSystem {
  const system = new CorruptionSystem({
    heightAt,
    normalAt,
    spline,
    seed: 7,
    ...options,
  });
  open.push(system);
  return system;
}

/** Build one that is not tracked, so a loop can own its own teardown. */
function untracked(options: Partial<CorruptionSystemOptions> = {}): CorruptionSystem {
  return new CorruptionSystem({ heightAt, normalAt, spline, seed: 7, ...options });
}

afterEach(() => {
  for (const system of open) system.dispose();
  open.length = 0;
});

/** Every InstancedMesh in the group, by name. */
function meshes(system: CorruptionSystem, pattern: RegExp): InstancedMesh[] {
  const out: InstancedMesh[] = [];
  system.group.traverse((child) => {
    if ((child as InstancedMesh).isInstancedMesh && pattern.test(child.name)) {
      out.push(child as InstancedMesh);
    }
  });
  return out;
}

describe('construction', () => {
  it('builds one mesh per ground kind and no shelf', () => {
    const system = make();
    const all = meshes(system, /^corruption-/);
    expect(all.length).toBe(GROUND_KINDS.length);
    for (const kind of GROUND_KINDS) {
      expect(all.map((m) => m.name)).toContain(`corruption-${kind}`);
    }
    // A shelf on the ground is a bracket growing out of nothing: its root sits
    // against a trunk, and `Forest` is what knows where the trunks are.
    expect(all.map((m) => m.name)).not.toContain('corruption-shelf');
    expect(system.stats.byKind.shelf).toBe(0);
  });

  it('builds the spores, the light and the group', () => {
    const system = make();
    expect(system.group.name).toBe('corruption');
    expect(system.spores).toBeInstanceOf(Points);
    expect(system.light).toBeInstanceOf(PointLight);
    expect(system.light.distance).toBe(CORRUPTION_LIGHT_DISTANCE);
    expect(system.light.decay).toBe(2);
    // Built dark. A light that appeared at full strength would recompile every
    // material in the scene the moment it was added.
    expect(system.light.intensity).toBe(0);
  });

  it('builds no spores when the count is zero', () => {
    const system = make({ sporeCount: 0 });
    expect(system.spores).toBeNull();
    expect(system.stats.spores).toBe(0);
    // And the rest of it still works.
    expect(meshes(system, /^corruption-/).length).toBe(GROUND_KINDS.length);
  });

  it('derives its corruption from the spline when none is supplied', () => {
    const system = make();
    const field = new CorruptionField(spline);
    for (const [x, z] of [
      [0, 0],
      [40, 10],
      [-120, 40],
      [200, 200],
    ]) {
      expect(system.intensityAt(x, z)).toBeCloseTo(field.corruptionAt(x, z), 6);
    }
  });

  it('prefers a caller-supplied corruption sampler', () => {
    const system = make({ corruptionAt: (x) => (x > 0 ? 1 : 0) });
    expect(system.intensityAt(10, 0)).toBe(1);
    expect(system.intensityAt(-10, 0)).toBe(0);
  });

  it('clamps a nonsense sampler', () => {
    const system = make({ corruptionAt: (x) => (x > 0 ? Number.NaN : 5) });
    expect(system.intensityAt(10, 0)).toBe(0);
    expect(system.intensityAt(-10, 0)).toBe(1);
  });

  it('is clean when there is no spline and no sampler', () => {
    const system = new CorruptionSystem({ heightAt, normalAt, seed: 3 });
    open.push(system);
    expect(system.intensityAt(0, 0)).toBe(0);
    expect(system.stageAt(0, 0)).toBe(0);
    expect(system.stats.fungus).toBe(0);
    expect(system.stats.spores).toBe(0);
    expect(system.light.intensity).toBe(0);
  });
});

describe('ground fungus', () => {
  it('grows nothing where the forest is clean', () => {
    const system = make({ corruptionAt: () => 0 });
    expect(system.stats.fungus).toBe(0);
    for (const mesh of meshes(system, /^corruption-/)) expect(mesh.count).toBe(0);
  });

  it('grows every ground kind where the ground is rotten', () => {
    const system = make({ corruptionAt: () => 1 });
    expect(system.stats.fungus).toBeGreaterThan(0);
    for (const kind of GROUND_KINDS) {
      expect(system.stats.byKind[kind], `${kind} grew nothing`).toBeGreaterThan(0);
    }
  });

  it('grows more as the corruption rises', () => {
    const counts: number[] = [];
    for (const corruption of [0.15, 0.5, 0.95]) {
      const system = untracked({ corruptionAt: () => corruption });
      counts.push(system.stats.fungus);
      system.dispose();
    }
    expect(counts[1]).toBeGreaterThan(counts[0]);
    expect(counts[2]).toBeGreaterThan(counts[1]);
  });

  it('stands every instance on the ground', () => {
    const system = make({ corruptionAt: () => 0.8 });
    for (const mesh of meshes(system, /^corruption-/)) {
      for (let i = 0; i < mesh.count; i++) {
        const m = mesh.instanceMatrix.array;
        const o = i * 16;
        const x = m[o + 12];
        const y = m[o + 13];
        const z = m[o + 14];
        expect(Number.isFinite(x + y + z)).toBe(true);
        // On the surface, not under it and not floating above it. The scatter
        // puts the origin at `heightAt`, and the geometry's own base is at its
        // local origin, so a tolerance of a few centimetres is the whole answer.
        expect(y).toBeCloseTo(heightAt(x), 3);
        // Inside the patch.
        expect(Math.hypot(x, z)).toBeLessThanOrEqual(DEFAULT_FUNGUS_PATCH_RADIUS + 1);
      }
    }
  });

  it('respects the triangle budget', () => {
    const system = make({ corruptionAt: () => 1 });
    let triangles = 0;
    for (const kind of GROUND_KINDS) {
      triangles += system.stats.byKind[kind] * FUNGUS_TRIANGLES[kind];
    }
    // The budget is a ceiling, not a target: a patch that is only partly rotten
    // places fewer, and the counts are derived from the budget per kind.
    expect(triangles).toBeLessThanOrEqual(DEFAULT_FUNGUS_TRIANGLE_BUDGET * 1.05);
  });

  it('splits the budget between the kinds rather than giving it to one', () => {
    const system = make({ corruptionAt: () => 1 });
    const placed = GROUND_KINDS.map((k) => system.stats.byKind[k]);
    // Every kind has to have room. Without the proportional split the kind with
    // the smallest triangle count takes the whole budget and the patch grows
    // mushrooms and nothing else.
    for (const n of placed) expect(n).toBeGreaterThan(0);
  });

  it('honours a caller override of the counts', () => {
    const system = make({ corruptionAt: () => 1, counts: { mushroom: 12 } });
    expect(system.stats.byKind.mushroom).toBeLessThanOrEqual(12);
  });

  it('ignores a shelf override, because a shelf on the ground is wrong', () => {
    const system = make({ corruptionAt: () => 1, counts: { shelf: 50 } });
    expect(system.stats.byKind.shelf).toBe(0);
    expect(meshes(system, /^corruption-shelf$/).length).toBe(0);
  });

  it('grows the same patch again for the same cell', () => {
    const system = make({ corruptionAt: () => 0.8 });
    const first = meshes(system, /^corruption-/).map((m) => ({
      name: m.name,
      count: m.count,
      matrices: Array.from(m.instanceMatrix.array.slice(0, m.count * 16)),
    }));

    // Walk the camera far enough to force two rebuilds, then come back.
    system.update(0.016, { x: 0, y: 0, z: 0 });
    system.update(0.016, { x: 400, y: 0, z: 400 });
    system.update(0.016, { x: 0, y: 0, z: 0 });

    const second = meshes(system, /^corruption-/).map((m) => ({
      name: m.name,
      count: m.count,
      matrices: Array.from(m.instanceMatrix.array.slice(0, m.count * 16)),
    }));
    expect(second).toEqual(first);
  });

  it('carries a per-instance variation in range', () => {
    const system = make({ corruptionAt: () => 0.9 });
    for (const mesh of meshes(system, /^corruption-/)) {
      const variation = mesh.geometry.getAttribute('aVariation');
      expect(variation).toBeDefined();
      expect(variation.count).toBe(mesh.instanceMatrix.count);
      const array = (variation as unknown as { array: Float32Array }).array;
      for (let i = 0; i < mesh.count; i++) {
        expect(array[i]).toBeGreaterThanOrEqual(0);
        expect(array[i]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('does not rescatter when the camera stays inside one cell', () => {
    const system = make({ corruptionAt: () => 0.8 });
    const before = meshes(system, /^corruption-mushroom$/)[0].instanceMatrix.array.slice();
    for (let i = 0; i < 20; i++) system.update(0.016, { x: 1, y: 0, z: 1 });
    const after = meshes(system, /^corruption-mushroom$/)[0].instanceMatrix.array;
    expect(Array.from(after)).toEqual(Array.from(before));
  });
});

describe('spores', () => {
  it('builds the requested number', () => {
    const system = make();
    expect(system.spores!.geometry.getAttribute('position').count).toBe(DEFAULT_SPORE_COUNT);
  });

  it('keeps every spore above the ground and inside the volume', () => {
    const system = make({ corruptionAt: () => 1 });
    for (let i = 0; i < 40; i++) system.update(0.05, { x: 0, y: 0, z: 0 });
    const position = system.spores!.geometry.getAttribute('position');
    const array = (position as unknown as { array: Float32Array }).array;
    for (let i = 0; i < DEFAULT_SPORE_COUNT; i++) {
      const x = array[i * 3];
      const y = array[i * 3 + 1];
      const z = array[i * 3 + 2];
      expect(Number.isFinite(x + y + z)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(heightAt(x) + 0.04);
      expect(y).toBeLessThanOrEqual(heightAt(x) + 4.3);
    }
  });

  it('moves the spores', () => {
    const system = make({ corruptionAt: () => 1 });
    const read = (): number[] => {
      const a = (system.spores!.geometry.getAttribute('position') as unknown as {
        array: Float32Array;
      }).array;
      return Array.from(a.slice(0, 12));
    };
    const before = read();
    for (let i = 0; i < 10; i++) system.update(0.05, { x: 0, y: 0, z: 0 });
    expect(read()).not.toEqual(before);
  });

  it('shows none of them over clean ground', () => {
    const system = make({ corruptionAt: () => 0 });
    system.update(0.016, { x: 0, y: 0, z: 0 });
    expect(system.stats.spores).toBe(0);
    const array = (system.spores!.geometry.getAttribute('color') as unknown as {
      array: Float32Array;
    }).array;
    for (let i = 0; i < array.length; i++) expect(array[i]).toBe(0);
  });

  it('shows more of them as the stage rises', () => {
    const seen: number[] = [];
    for (const corruption of [0.2, 0.5, 0.95]) {
      const system = untracked({ corruptionAt: () => corruption });
      system.update(0.016, { x: 0, y: 0, z: 0 });
      seen.push(system.stats.spores);
      system.dispose();
    }
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[1]).toBeGreaterThan(seen[0]);
    expect(seen[2]).toBeGreaterThan(seen[1]);
    // And never more than the stage allows.
    expect(seen[2]).toBeLessThanOrEqual(DEFAULT_SPORE_COUNT);
  });

  it('shades the visible ones sickly green where the rot is mild', () => {
    const system = make({ corruptionAt: () => 0.15 });
    system.update(0.016, { x: 0, y: 0, z: 0 });
    const array = (system.spores!.geometry.getAttribute('color') as unknown as {
      array: Float32Array;
    }).array;
    let lit = 0;
    for (let i = 0; i < DEFAULT_SPORE_COUNT; i++) {
      const r = array[i * 3];
      const g = array[i * 3 + 1];
      const b = array[i * 3 + 2];
      if (r + g + b === 0) continue;
      lit++;
      expect(g).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(b);
    }
    expect(lit).toBeGreaterThan(0);
  });

  it('shades them bruised purple where the rot is severe', () => {
    const system = make({ corruptionAt: () => 1 });
    system.update(0.016, { x: 0, y: 0, z: 0 });
    const array = (system.spores!.geometry.getAttribute('color') as unknown as {
      array: Float32Array;
    }).array;
    let lit = 0;
    for (let i = 0; i < DEFAULT_SPORE_COUNT; i++) {
      const r = array[i * 3];
      const g = array[i * 3 + 1];
      const b = array[i * 3 + 2];
      if (r + g + b === 0) continue;
      lit++;
      // The same spore, further gone: red and blue have climbed past green, so
      // the air has moved from sickly to bruised rather than merely brightened.
      expect(b).toBeGreaterThan(g);
      expect(r).toBeGreaterThan(g);
      // And nothing goes above one. The colours are multiplied into an additive
      // blend, so a value over one is a blown-out white pixel.
      expect(Math.max(r, g, b)).toBeLessThanOrEqual(1);
    }
    expect(lit).toBeGreaterThan(0);
  });

  it('recycles a spore that drifts out of the volume', () => {
    const system = make({ corruptionAt: () => 1 });
    // A strong wind, so the spores actually leave the disc rather than orbiting.
    system.update(0.016, { x: 0, y: 0, z: 0 });
    const array = (system.spores!.geometry.getAttribute('position') as unknown as {
      array: Float32Array;
    }).array;
    for (let i = 0; i < DEFAULT_SPORE_COUNT * 4; i++) {
      array[i * 3] = 5000;
      array[i * 3 + 2] = 5000;
    }
    system.update(0.5, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < DEFAULT_SPORE_COUNT; i++) {
      expect(Math.hypot(array[i * 3], array[i * 3 + 2])).toBeLessThan(DEFAULT_SPORE_RADIUS * 2 + 1);
    }
  });

  it('fades a spore in and out over its life', () => {
    // One spore, so the whole colour buffer is that spore's life. With a
    // thousand of them the ages are staggered and the total brightness is
    // stationary, which hides the fade rather than testing it.
    const system = make({ corruptionAt: () => 1, sporeCount: 1 });
    const color = system.spores!.geometry.getAttribute('color') as unknown as {
      array: Float32Array;
    };
    const brightness = (): number => color.array[0] + color.array[1] + color.array[2];

    const seen: number[] = [];
    const steps = 240;
    for (let i = 0; i < steps; i++) {
      system.update(SPORE_LIFETIME / steps, { x: 0, y: 0, z: 0 });
      seen.push(brightness());
    }
    // Over one full lifetime the spore has to go dark, come up, and go dark
    // again: the fade-in at birth and the fade-out at death are what stop it
    // popping into and out of existence. Where in its life it starts is up to
    // the seed, so the assertions are about the shape of the sequence rather
    // than about any particular sample.
    expect(Math.min(...seen)).toBeLessThan(0.05);
    expect(Math.max(...seen)).toBeGreaterThan(0.4);
    // And it must come back after going dark, which is the fade-in doing its
    // job on a recycled spore. A spore that only decayed would satisfy the two
    // assertions above and still pop out of existence.
    let darkAt = -1;
    let revived = false;
    for (let i = 0; i < seen.length; i++) {
      if (seen[i] < 0.05) darkAt = i;
      else if (darkAt >= 0 && seen[i] > 0.4) revived = true;
    }
    expect(darkAt).toBeGreaterThanOrEqual(0);
    expect(revived).toBe(true);
  });

  it('does not move when time does not', () => {
    const system = make({ corruptionAt: () => 1 });
    system.update(0.016, { x: 0, y: 0, z: 0 });
    const before = Array.from(
      (system.spores!.geometry.getAttribute('position') as unknown as { array: Float32Array }).array,
    );
    // A zero delta must not move anything, and a negative one must be ignored
    // outright: the render loop hands this whatever `TimeController` says, and a
    // paused game has to leave the rot hanging in the air.
    system.update(0, { x: 0, y: 0, z: 0 });
    system.update(-1, { x: 0, y: 0, z: 0 });
    system.update(Number.NaN, { x: 0, y: 0, z: 0 });
    const after = Array.from(
      (system.spores!.geometry.getAttribute('position') as unknown as { array: Float32Array }).array,
    );
    expect(after).toEqual(before);
  });
});

describe('the rot light', () => {
  it('stays dark over clean ground', () => {
    const system = make({ corruptionAt: () => 0 });
    system.update(0.016, { x: 0, y: 0, z: 0 });
    expect(system.light.intensity).toBe(0);
  });

  it('burns at full strength in the inner zone', () => {
    const system = make({ corruptionAt: () => 1 });
    system.update(0.016, { x: 0, y: 0, z: 0 });
    expect(system.light.intensity).toBeCloseTo(CORRUPTION_LIGHT_INTENSITY, 6);
  });

  it('scales with the corruption', () => {
    const seen: number[] = [];
    for (const corruption of [0.25, 0.5, 1]) {
      const system = untracked({ corruptionAt: () => corruption });
      system.update(0.016, { x: 0, y: 0, z: 0 });
      seen.push(system.light.intensity);
      system.dispose();
    }
    expect(seen[1]).toBeCloseTo(seen[0] * 2, 6);
    expect(seen[2]).toBeCloseTo(seen[0] * 4, 6);
  });

  it('follows the camera every frame, not on the patch grid', () => {
    const system = make({ corruptionAt: () => 0.5 });
    system.update(0.016, { x: 0, y: 0, z: 0 });
    // Two metres is well inside the twelve-metre patch grid, so a light that
    // only moved on the grid would still be sitting at the origin.
    system.update(0.016, { x: 2, y: 0, z: 0 });
    expect(system.light.position.x).toBeCloseTo(2, 6);
    expect(system.light.position.y).toBeCloseTo(heightAt(2) + 1.6, 6);
  });

  it('can be switched off', () => {
    const system = make({ corruptionAt: () => 1, light: { intensity: 0 } });
    system.update(0.016, { x: 0, y: 0, z: 0 });
    expect(system.light.intensity).toBe(0);
    // And the rest of it still grows.
    expect(system.stats.fungus).toBeGreaterThan(0);
  });

  it('takes a colour', () => {
    const system = make({ light: { color: 0xff00ff } });
    expect(system.light.color.getHex()).toBe(0xff00ff);
  });
});

describe('stage shares', () => {
  it('rises monotonically with the stage', () => {
    expect(SPORE_STAGE_SHARE[0]).toBe(0);
    expect(SPORE_STAGE_SHARE[1]).toBeGreaterThan(SPORE_STAGE_SHARE[0]);
    expect(SPORE_STAGE_SHARE[2]).toBeGreaterThan(SPORE_STAGE_SHARE[1]);
    expect(SPORE_STAGE_SHARE[3]).toBeGreaterThan(SPORE_STAGE_SHARE[2]);
    expect(SPORE_STAGE_SHARE[3]).toBeLessThanOrEqual(1);
  });

  it('reports the stage at the camera', () => {
    const system = make({ corruptionAt: () => 0.5 });
    system.update(0.016, { x: 0, y: 0, z: 0 });
    expect(system.stats.stage).toBe(2);
    expect(system.stats.corruption).toBeCloseTo(0.5, 6);
  });
});

describe('scene membership and disposal', () => {
  it('attaches and detaches its group', () => {
    const system = make();
    const parent = { add: vi.fn(), remove: vi.fn() };
    system.addTo(parent as never);
    expect(parent.add).toHaveBeenCalledWith(system.group);
    system.removeFrom(parent as never);
    expect(parent.remove).toHaveBeenCalledWith(system.group);
  });

  it('disposes everything it built and empties the group', () => {
    const system = make();
    const geometries = meshes(system, /^corruption-/).map((m) => m.geometry);
    expect(geometries.length).toBe(GROUND_KINDS.length);
    system.dispose();
    expect(system.isDisposed).toBe(true);
    expect(system.group.children.length).toBe(0);
    // A second dispose is a no-op rather than a double free.
    expect(() => system.dispose()).not.toThrow();
  });

  it('stops updating once disposed', () => {
    const system = make({ corruptionAt: () => 1 });
    system.dispose();
    // Must not throw, and must not resurrect anything.
    expect(() => system.update(0.016, { x: 0, y: 0, z: 0 })).not.toThrow();
    expect(system.group.children.length).toBe(0);
  });

  it('shares one spore material and one texture between systems', () => {
    const a = make();
    const b = make();
    expect(a.spores!.material).toBe(b.spores!.material);
    expect(a.spores!.material.map).toBe(b.spores!.material.map);
  });
});
