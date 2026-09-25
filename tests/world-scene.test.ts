import { describe, expect, it, vi } from 'vitest';
import { Fog, Scene } from 'three';
import { DEFAULT_FOG_COLOR, DEFAULT_FOG_FAR, DEFAULT_FOG_NEAR, WorldScene } from '../src/world/WorldScene';

describe('WorldScene', () => {
  it('populates the scene with terrain, sky and lights', () => {
    const scene = new Scene();
    const world = new WorldScene({ scene });

    expect(scene.children).toContain(world.terrain.mesh);
    expect(scene.children).toContain(world.sky.mesh);
    expect(scene.children).toContain(world.lighting.group);

    expect(scene.getObjectByName('terrain')).toBe(world.terrain.mesh);
    expect(scene.getObjectByName('sky')).toBe(world.sky.mesh);
    expect(scene.getObjectByName('sun')).toBe(world.lighting.sun);
    expect(scene.getObjectByName('ambient')).toBe(world.lighting.ambient);
  });

  it('adds linear fog for depth', () => {
    const scene = new Scene();
    const world = new WorldScene({ scene });

    expect(scene.fog).toBeInstanceOf(Fog);
    const fog = world.fog;
    expect(fog).not.toBeNull();
    expect(fog?.near).toBe(DEFAULT_FOG_NEAR);
    expect(fog?.far).toBe(DEFAULT_FOG_FAR);
    expect(fog?.color.getHex()).toBe(DEFAULT_FOG_COLOR);
  });

  it('tunes the fog so the 100m plane dissolves instead of ending', () => {
    // The camera sits at z = 8, so the plane's far edge is 58m away and its
    // nearest edge 42m. The far edge must be almost fully fogged.
    const scene = new Scene();
    const world = new WorldScene({ scene });

    const fogAt = (distance: number): number => {
      const { near, far } = world.fog as Fog;
      return Math.min(Math.max((distance - near) / (far - near), 0), 1);
    };

    expect(fogAt(42)).toBeGreaterThan(0.3); // some haze on the near ground
    expect(fogAt(42)).toBeLessThan(0.7); // ...but still clearly visible
    expect(fogAt(58)).toBeGreaterThan(0.85); // the far edge is nearly gone
    expect(fogAt(200)).toBe(1); // anything past the plane is fully fogged
  });

  it('accepts fog overrides', () => {
    const scene = new Scene();
    const world = new WorldScene({ scene, fog: { near: 1, far: 2, color: 0x123456 } });

    expect(world.fog?.near).toBe(1);
    expect(world.fog?.far).toBe(2);
    expect(world.fog?.color.getHex()).toBe(0x123456);
  });

  it('advances the sky with the game delta it is given', () => {
    const scene = new Scene();
    const world = new WorldScene({ scene });

    expect(world.elapsedTime).toBe(0);

    world.update(0.016);
    expect(world.elapsedTime).toBeCloseTo(0.016, 6);
    expect(world.sky.elapsedTime).toBeCloseTo(0.016, 6);
  });

  it('does nothing when handed a zero delta, so a paused world is frozen', () => {
    const scene = new Scene();
    const world = new WorldScene({ scene });

    world.update(0.016);
    const elapsed = world.elapsedTime;

    world.update(0);
    expect(world.elapsedTime).toBe(elapsed);
    expect(world.sky.elapsedTime).toBe(elapsed);
  });

  it('ignores negative and non-finite deltas', () => {
    const scene = new Scene();
    const world = new WorldScene({ scene });

    world.update(-1);
    world.update(Number.NaN);

    expect(world.elapsedTime).toBe(0);
  });

  it('tears everything down on dispose', () => {
    const scene = new Scene();
    const world = new WorldScene({ scene });

    const disposeTerrain = vi.spyOn(world.terrain.mesh.geometry, 'dispose');
    const disposeSky = vi.spyOn(world.sky.mesh.geometry, 'dispose');
    const disposeLights = vi.spyOn(world.lighting.sun, 'dispose');

    world.dispose();

    expect(scene.children).toHaveLength(0);
    expect(scene.fog).toBeNull();
    expect(world.isDisposed).toBe(true);
    expect(disposeTerrain).toHaveBeenCalledTimes(1);
    expect(disposeSky).toHaveBeenCalledTimes(1);
    expect(disposeLights).toHaveBeenCalledTimes(1);

    // A disposed world must stay inert.
    world.update(1);
    expect(world.elapsedTime).toBe(0);

    // And disposing twice must not double-free.
    expect(() => world.dispose()).not.toThrow();
    expect(disposeTerrain).toHaveBeenCalledTimes(1);
  });
});
