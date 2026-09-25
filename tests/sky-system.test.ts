import { describe, expect, it, vi } from 'vitest';
import { BackSide, Color, Scene, ShaderMaterial, SphereGeometry } from 'three';
import {
  DEFAULT_DRIFT_SPEED,
  DEFAULT_HORIZON_COLOR,
  DEFAULT_SKY_RADIUS,
  DEFAULT_ZENITH_COLOR,
  SKY_DRIFT_AMPLITUDE,
  SkySystem,
} from '../src/renderer/SkySystem';

describe('SkySystem', () => {
  it('builds a dome large enough to enclose the world', () => {
    const sky = new SkySystem();

    expect(sky.mesh.geometry).toBeInstanceOf(SphereGeometry);
    expect(sky.mesh.geometry.parameters.radius).toBe(DEFAULT_SKY_RADIUS);
    // Must sit inside the camera's far plane (2000) or it would be clipped.
    expect(sky.mesh.geometry.parameters.radius).toBeLessThan(2000);
    expect(sky.mesh.geometry.parameters.radius).toBeGreaterThan(100);
  });

  it('is drawn from the inside so the gradient is visible', () => {
    const sky = new SkySystem();
    expect(sky.mesh.material.side).toBe(BackSide);
  });

  it('is exempt from fog and never occludes the world', () => {
    const sky = new SkySystem();

    // Critical: the dome sits at 900m, far beyond the fog's far plane, so with
    // fog enabled it would be flattened into a single flat colour.
    expect(sky.mesh.material.fog).toBe(false);
    expect(sky.mesh.material.depthWrite).toBe(false);
    expect(sky.mesh.frustumCulled).toBe(false);
  });

  it('gradients from a white horizon to a blue zenith', () => {
    const sky = new SkySystem();
    const { uniforms } = sky.mesh.material;

    const horizon = uniforms.uHorizonColor.value as Color;
    const zenith = uniforms.uZenithColor.value as Color;

    expect(horizon.getHex()).toBe(DEFAULT_HORIZON_COLOR);
    expect(zenith.getHex()).toBe(DEFAULT_ZENITH_COLOR);

    // Horizon is the brighter, less saturated end; zenith is the blue end.
    expect(horizon.r + horizon.g + horizon.b).toBeGreaterThan(
      zenith.r + zenith.g + zenith.b,
    );
    expect(zenith.b).toBeGreaterThan(zenith.r);
  });

  it('uses a custom ShaderMaterial with the expected uniforms', () => {
    const sky = new SkySystem({ falloff: 1.5 });
    const { material } = sky.mesh;

    expect(material).toBeInstanceOf(ShaderMaterial);
    expect(material.uniforms.uFalloff.value).toBe(1.5);
    expect(material.uniforms.uDrift.value).toBe(0);
    expect(material.vertexShader).toContain('vWorldPosition');
    expect(material.fragmentShader).toContain('uHorizonColor');
    // The shader must convert its linear output back to sRGB, or the sky
    // renders visibly too dark.
    expect(material.fragmentShader).toContain('colorspace_fragment');
  });

  it('advances its own clock with game time', () => {
    const sky = new SkySystem();

    expect(sky.elapsedTime).toBe(0);

    sky.update(0.5);
    expect(sky.elapsedTime).toBeCloseTo(0.5, 6);

    sky.update(0.25);
    expect(sky.elapsedTime).toBeCloseTo(0.75, 6);
  });

  it('ignores zero, negative and non-finite deltas', () => {
    const sky = new SkySystem();

    sky.update(0);
    sky.update(-1);
    sky.update(Number.NaN);
    sky.update(Number.POSITIVE_INFINITY);

    expect(sky.elapsedTime).toBe(0);
    expect(sky.mesh.material.uniforms.uDrift.value).toBe(0);
  });

  it('drifts the gradient within its amplitude', () => {
    const sky = new SkySystem();

    // A quarter of the way through the cycle the drift should be at its peak.
    const quarterCycle = Math.PI / 2 / DEFAULT_DRIFT_SPEED;
    sky.update(quarterCycle);

    const drift = sky.mesh.material.uniforms.uDrift.value as number;
    expect(Math.abs(drift)).toBeGreaterThan(SKY_DRIFT_AMPLITUDE * 0.9);
    expect(Math.abs(drift)).toBeLessThanOrEqual(SKY_DRIFT_AMPLITUDE);
  });

  it('can hold the drift still', () => {
    const sky = new SkySystem({ driftSpeed: 0 });

    sky.update(10);
    expect(sky.elapsedTime).toBeCloseTo(10, 6);
    expect(sky.mesh.material.uniforms.uDrift.value).toBe(0);
  });

  it('jumps straight to a point in the drift cycle', () => {
    const sky = new SkySystem();

    sky.setTime(0);
    const atZero = sky.mesh.material.uniforms.uDrift.value as number;

    sky.setTime(1000);
    expect(sky.elapsedTime).toBe(1000);
    expect(sky.mesh.material.uniforms.uDrift.value).not.toBe(atZero);

    // Negative time is clamped rather than driving the sine backwards.
    sky.setTime(-5);
    expect(sky.elapsedTime).toBe(0);
  });

  it('recolours at runtime', () => {
    const sky = new SkySystem();
    sky.setColors(0x0000ff, 0xffffff);

    expect((sky.mesh.material.uniforms.uZenithColor.value as Color).getHex()).toBe(0x0000ff);
    expect((sky.mesh.material.uniforms.uHorizonColor.value as Color).getHex()).toBe(0xffffff);
  });

  it('attaches to and detaches from a scene', () => {
    const scene = new Scene();
    const sky = new SkySystem();

    sky.addTo(scene);
    expect(scene.children).toContain(sky.mesh);
    expect(scene.getObjectByName('sky')).toBe(sky.mesh);

    sky.removeFrom(scene);
    expect(scene.children).not.toContain(sky.mesh);
  });

  it('releases its GPU resources on dispose', () => {
    const sky = new SkySystem();
    const disposeGeometry = vi.spyOn(sky.mesh.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(sky.mesh.material, 'dispose');

    sky.dispose();

    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
  });
});
