/**
 * Terrain.ts - ASTRA world
 * =============================================================================
 * The ground the player stands on.
 *
 * Step 1.2 asks for a flat 100m x 100m plane with a basic green material, and
 * that is exactly what this is - a placeholder. Step 2.1 replaces the flat
 * geometry with displaced FBM noise and the plain material with the procedural
 * terrain shader; everything above this class (WorldScene, the player, the
 * camera) is written against the mesh, not against the flatness, so that swap
 * is a change inside this file rather than a change across the codebase.
 *
 * The plane is built in the XY plane (Three's PlaneGeometry default) and rotated
 * onto XZ, so the mesh normal points along world +Y - the convention every
 * later system (ground raycasts, slope maths, heightfields) depends on.
 * =============================================================================
 */

import {
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Object3D,
} from 'three';

/** Side length of the playable ground, in metres. */
export const TERRAIN_SIZE = 100;

/** Muted, earthy grass green - see Astra style guide rules 1 and 7. */
export const DEFAULT_GROUND_COLOR = 0x5a7a3f;

export interface TerrainOptions {
  /** Side length in metres. Defaults to 100. */
  size?: number;
  /** Base colour as a hex value. Defaults to `DEFAULT_GROUND_COLOR`. */
  color?: number;
  roughness?: number;
  metalness?: number;
}

export class Terrain {
  readonly mesh: Mesh<PlaneGeometry, MeshStandardMaterial>;

  private readonly size: number;

  constructor(options: TerrainOptions = {}) {
    this.size = options.size ?? TERRAIN_SIZE;

    const geometry = new PlaneGeometry(this.size, this.size, 1, 1);

    const material = new MeshStandardMaterial({
      color: options.color ?? DEFAULT_GROUND_COLOR,
      roughness: options.roughness ?? 0.92,
      metalness: options.metalness ?? 0,
    });

    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'terrain';

    // Lay the XY plane flat on the XZ plane: normal becomes world +Y.
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(0, 0, 0);

    // Harmless until shadow maps arrive in Step 2.5, and correct when they do.
    this.mesh.receiveShadow = true;
    // Rendered from both sides so the ground never disappears if the camera
    // dips below y=0 during a jump or a camera-collision pull-in.
    this.mesh.material.side = DoubleSide;
  }

  /** Side length in metres. */
  get sizeMetres(): number {
    return this.size;
  }

  /** World-space normal of the ground: straight up. */
  get normal(): { readonly x: number; readonly y: number; readonly z: number } {
    return { x: 0, y: 1, z: 0 };
  }

  addTo(parent: Object3D): void {
    parent.add(this.mesh);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.mesh);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
