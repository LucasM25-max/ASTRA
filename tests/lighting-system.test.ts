import { describe, expect, it, vi } from 'vitest';
import { AmbientLight, DirectionalLight, Group, Scene } from 'three';
import {
  DEFAULT_AMBIENT_COLOR,
  DEFAULT_AMBIENT_INTENSITY,
  DEFAULT_SUN_COLOR,
  DEFAULT_SUN_INTENSITY,
  DEFAULT_SUN_POSITION,
  LightingSystem,
} from '../src/renderer/LightingSystem';

describe('LightingSystem', () => {
  it('creates exactly a directional sun and an ambient fill', () => {
    const lighting = new LightingSystem();

    expect(lighting.sun).toBeInstanceOf(DirectionalLight);
    expect(lighting.ambient).toBeInstanceOf(AmbientLight);

    expect(lighting.sun.type).toBe('DirectionalLight');
    expect(lighting.ambient.type).toBe('AmbientLight');
    expect(lighting.group.children).toHaveLength(3); // sun, sun target, ambient
  });

  it('uses a warm sun and a cool ambient fill', () => {
    const lighting = new LightingSystem();

    expect(lighting.sun.color.getHex()).toBe(DEFAULT_SUN_COLOR);
    expect(lighting.sun.intensity).toBe(DEFAULT_SUN_INTENSITY);
    expect(lighting.ambient.color.getHex()).toBe(DEFAULT_AMBIENT_COLOR);
    expect(lighting.ambient.intensity).toBe(DEFAULT_AMBIENT_INTENSITY);

    // Rule 6 of the style guide: warm sun, cool shadows. The sun must be warmer
    // (more red than blue) and the ambient fill cooler (more blue than red).
    const sun = lighting.sun.color;
    expect(sun.r).toBeGreaterThan(sun.b);

    const ambient = lighting.ambient.color;
    expect(ambient.b).toBeGreaterThan(ambient.r);
  });

  it('places the sun high and off to one side, aimed at the origin', () => {
    const lighting = new LightingSystem();

    expect(lighting.sun.position.toArray()).toEqual([
      DEFAULT_SUN_POSITION.x,
      DEFAULT_SUN_POSITION.y,
      DEFAULT_SUN_POSITION.z,
    ]);
    // Angled rather than straight overhead, so the light rakes across the plane.
    expect(lighting.sun.position.y).toBeGreaterThan(Math.abs(lighting.sun.position.x));
    expect(lighting.sun.target.position.toArray()).toEqual([0, 0, 0]);
  });

  it('accepts overrides', () => {
    const lighting = new LightingSystem({
      sunColor: 0xffffff,
      sunIntensity: 1,
      sunPosition: { x: 1, y: 2, z: 3 },
      ambientColor: 0x000000,
      ambientIntensity: 0,
    });

    expect(lighting.sun.color.getHex()).toBe(0xffffff);
    expect(lighting.sun.intensity).toBe(1);
    expect(lighting.sun.position.toArray()).toEqual([1, 2, 3]);
    expect(lighting.ambient.intensity).toBe(0);
  });

  it('can re-point the sun at runtime', () => {
    const lighting = new LightingSystem();
    lighting.setSunPosition(10, 20, 30);
    expect(lighting.sun.position.toArray()).toEqual([10, 20, 30]);
  });

  it('attaches to and detaches from a scene as one unit', () => {
    const scene = new Scene();
    const lighting = new LightingSystem();

    lighting.addTo(scene);
    expect(scene.children).toContain(lighting.group);
    expect(scene.getObjectByName('sun')).toBe(lighting.sun);
    expect(scene.getObjectByName('ambient')).toBe(lighting.ambient);
    expect(lighting.group).toBeInstanceOf(Group);

    lighting.removeFrom(scene);
    expect(scene.children).not.toContain(lighting.group);
  });

  it('disposes both lights', () => {
    const lighting = new LightingSystem();
    const disposeSun = vi.spyOn(lighting.sun, 'dispose');
    const disposeAmbient = vi.spyOn(lighting.ambient, 'dispose');

    lighting.dispose();

    expect(disposeSun).toHaveBeenCalledTimes(1);
    expect(disposeAmbient).toHaveBeenCalledTimes(1);
  });
});
