import { describe, expect, it, vi } from 'vitest';
import { DoubleSide, MeshStandardMaterial, Scene, Vector3 } from 'three';
import {
  DEFAULT_GROUND_COLOR,
  TERRAIN_SIZE,
  Terrain,
} from '../src/world/Terrain';

describe('Terrain', () => {
  it('builds a flat plane of the requested size', () => {
    const terrain = new Terrain();
    const { geometry } = terrain.mesh;

    expect(geometry.parameters.width).toBe(TERRAIN_SIZE);
    expect(geometry.parameters.height).toBe(TERRAIN_SIZE);
    expect(terrain.sizeMetres).toBe(100);
  });

  it('lays the plane flat on the XZ plane with an upward normal', () => {
    const terrain = new Terrain();

    expect(terrain.mesh.rotation.x).toBeCloseTo(-Math.PI / 2, 10);
    expect(terrain.normal).toEqual({ x: 0, y: 1, z: 0 });

    // PlaneGeometry lies in the XY plane with its normal along +Z. Rotating by
    // -90 degrees about X maps (0,0,1) -> (0,1,0), so the surface faces up.
    terrain.mesh.updateMatrixWorld();
    const normal = new Vector3(0, 0, 1).applyQuaternion(terrain.mesh.quaternion);
    expect(normal.x).toBeCloseTo(0, 6);
    expect(normal.y).toBeCloseTo(1, 6);
    expect(normal.z).toBeCloseTo(0, 6);

    // And the plane's extent must run along X and Z, not along Y: the local
    // corner (50, 50, 0) lands flat on the ground at y = 0.
    const corner = terrain.mesh.localToWorld(new Vector3(50, 50, 0));
    expect(corner.y).toBeCloseTo(0, 6);
    expect(Math.abs(corner.x)).toBeCloseTo(50, 6);
    expect(Math.abs(corner.z)).toBeCloseTo(50, 6);
  });

  it('sits at the origin so the player spawns on top of it', () => {
    const terrain = new Terrain();
    expect(terrain.mesh.position.toArray()).toEqual([0, 0, 0]);
  });

  it('uses a basic green material', () => {
    const terrain = new Terrain();
    const { material } = terrain.mesh;

    expect(material).toBeInstanceOf(MeshStandardMaterial);
    // Round-trips through sRGB, so this is the exact green that was asked for.
    expect(material.color.getHex()).toBe(DEFAULT_GROUND_COLOR);

    const { r, g, b } = material.color;
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(material.metalness).toBe(0);
    expect(material.roughness).toBeGreaterThan(0.5);
  });

  it('is visible from both sides so the ground never disappears', () => {
    const terrain = new Terrain();
    expect(terrain.mesh.material.side).toBe(DoubleSide);
    expect(terrain.mesh.receiveShadow).toBe(true);
  });

  it('accepts a custom size and colour', () => {
    const terrain = new Terrain({ size: 50, color: 0xff0000 });
    expect(terrain.mesh.geometry.parameters.width).toBe(50);
    expect(terrain.sizeMetres).toBe(50);
    expect(terrain.mesh.material.color.getHex()).toBe(0xff0000);
  });

  it('attaches to and detaches from a scene', () => {
    const scene = new Scene();
    const terrain = new Terrain();

    terrain.addTo(scene);
    expect(scene.children).toContain(terrain.mesh);
    expect(scene.getObjectByName('terrain')).toBe(terrain.mesh);

    terrain.removeFrom(scene);
    expect(scene.children).not.toContain(terrain.mesh);
  });

  it('releases its GPU resources on dispose', () => {
    const terrain = new Terrain();
    const disposeGeometry = vi.spyOn(terrain.mesh.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(terrain.mesh.material, 'dispose');

    terrain.dispose();

    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
  });
});
