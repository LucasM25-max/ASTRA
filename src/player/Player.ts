/**
 * Player.ts - ASTRA player
 * =============================================================================
 * The player character: a capsule mesh standing on a dynamic capsule collider.
 *
 * Step 1.3 asks for a placeholder for the character model, and this is it - one
 * capsule, no rig, no animation. Phase 4 replaces the mesh with the real
 * procedurally generated character; everything above this class (the movement
 * controller, the camera, the encounter system) is written against the capsule
 * and the body, not against the mesh, so that swap is a change in this file.
 *
 * Two objects, one transform
 * --------------------------
 * The physics body and the render mesh are deliberately kept separate and are
 * only ever reconciled in `syncMesh()`, which the render loop calls once per
 * frame. The simulation owns *position*; visual rotation is owned by whoever
 * is animating the character (the movement controller in Step 1.4 turns the
 * mesh to face its direction of travel). That split matters because the
 * collider's rotation is locked - see `PhysicsWorld.createCapsuleBody` - so
 * letting physics drive the mesh's rotation would freeze the character facing
 * one way forever.
 *
 * The mesh and the collider are built to identical dimensions, which is not an
 * accident: `CapsuleGeometry(radius, 2 * halfHeight)` and
 * `ColliderDesc.capsule(halfHeight, radius)` both describe a capsule of total
 * height `2 * halfHeight + 2 * radius`, centred on the origin. The player test
 * asserts this, because a collider that disagrees with its mesh is one of the
 * hardest bugs to spot by eye.
 * =============================================================================
 */

import {
  CapsuleGeometry,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Object3D,
} from 'three';
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import type { PhysicsWorld, Vec3 } from '../physics/PhysicsWorld';

/** Radius of the capsule, in metres. */
export const PLAYER_RADIUS = 0.35;

/** Total height of the capsule, in metres. A bit under the average human. */
export const PLAYER_HEIGHT = 1.8;

/**
 * Half-height of the capsule's cylindrical section: the total height minus the
 * two hemispherical caps, halved.
 */
export const PLAYER_HALF_HEIGHT = (PLAYER_HEIGHT - 2 * PLAYER_RADIUS) / 2;

/** Where the player appears when the world loads, per the Step 1.3 spec. */
export const PLAYER_SPAWN = { x: 0, y: 1, z: 0 } as const;

/**
 * Muted slate. Deliberately not the hero's eventual palette - it reads as
 * "placeholder" against both the green ground and the blue sky, which is the
 * point at this stage.
 */
export const PLAYER_COLOR = 0x77808f;

export interface PlayerOptions {
  /** An initialised physics world to create the body in. */
  physics: PhysicsWorld;
  /** Initial position of the capsule's centre. Defaults to `PLAYER_SPAWN`. */
  spawn?: Vec3;
  /** Capsule radius in metres. Defaults to `PLAYER_RADIUS`. */
  radius?: number;
  /** Total capsule height in metres. Defaults to `PLAYER_HEIGHT`. */
  height?: number;
  /** Mesh colour. Defaults to `PLAYER_COLOR`. */
  color?: number;
  /** Collider friction. Defaults to Rapier's own 0.5. */
  friction?: number;
  /** Linear velocity damping per second. Defaults to none. */
  linearDamping?: number;
}

export class Player {
  readonly mesh: Mesh<CapsuleGeometry, MeshStandardMaterial>;
  readonly body: RigidBody;
  readonly collider: Collider;

  private readonly physics: PhysicsWorld;
  private readonly radiusValue: number;
  private readonly heightValue: number;

  /** Reused every frame so `syncMesh()` allocates nothing. */
  private readonly bodyPosition = new Vector3();

  private disposed = false;

  constructor(options: PlayerOptions) {
    const radius = options.radius ?? PLAYER_RADIUS;
    const height = options.height ?? PLAYER_HEIGHT;

    if (!Number.isFinite(radius) || radius <= 0) {
      throw new RangeError(`[Player] radius must be positive, received ${String(radius)}`);
    }
    if (!Number.isFinite(height) || height <= 2 * radius) {
      throw new RangeError(
        `[Player] height (${String(height)}) must exceed the caps' 2 * radius ` +
          `(${String(2 * radius)}), or the capsule collapses`,
      );
    }

    this.radiusValue = radius;
    this.heightValue = height;
    this.physics = options.physics;

    const halfHeight = (height - 2 * radius) / 2;
    const { body, collider } = this.physics.createCapsuleBody({
      radius,
      halfHeight,
      spawn: options.spawn ?? PLAYER_SPAWN,
      friction: options.friction,
      linearDamping: options.linearDamping,
    });
    this.body = body;
    this.collider = collider;

    // `height` here is the length of the cylindrical middle section, so the
    // geometry's total height is `2 * halfHeight + 2 * radius` - the same
    // capsule Rapier is simulating, centred on the same point.
    const geometry = new CapsuleGeometry(radius, 2 * halfHeight, 8, 16);
    const material = new MeshStandardMaterial({
      color: options.color ?? PLAYER_COLOR,
      roughness: 0.65,
      metalness: 0.05,
    });

    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'player';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    // Place the mesh at the body before the first frame is drawn, so the
    // character is never briefly rendered at the origin.
    this.syncMesh();
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  /** Radius of the capsule, in metres. */
  get radius(): number {
    return this.radiusValue;
  }

  /** Total height of the capsule, in metres. */
  get height(): number {
    return this.heightValue;
  }

  /**
   * World-space centre of the capsule - the physics body's origin, which is the
   * capsule's midpoint, not its feet.
   */
  get position(): Vec3 {
    const p = this.body.translation();
    return { x: p.x, y: p.y, z: p.z };
  }

  /** Current linear velocity, in metres per second. */
  get velocity(): Vec3 {
    const v = this.body.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }

  /** The height of the capsule's lowest point when resting on `y = 0`. */
  get restHeight(): number {
    return this.heightValue / 2;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Copy the simulation's position onto the render mesh.
   *
   * Called once per rendered frame from the render loop, not from the fixed
   * update: the body only moves during fixed steps, so reading it at render
   * time always yields the latest simulation state, and at high refresh rates
   * the mesh simply holds its position between steps rather than tearing.
   *
   * Rotation is deliberately not copied - see the note at the top of the file.
   */
  syncMesh(): void {
    if (this.disposed) return;
    this.body.translation(this.bodyPosition);
    this.mesh.position.copy(this.bodyPosition);
  }

  /* ---------------------------------------------------------------------- */
  /* Scene graph                                                            */
  /* ---------------------------------------------------------------------- */

  addTo(parent: Object3D): void {
    parent.add(this.mesh);
  }

  removeFrom(parent: Object3D): void {
    parent.remove(this.mesh);
  }

  /**
   * Release the mesh's GPU resources and remove the body from the simulation.
   *
   * Removing the rigid body also removes its colliders, so there is no
   * double-free to worry about. The physics world itself is *not* disposed
   * here: it was passed in, so whoever created it owns it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.physics.world.removeRigidBody(this.body);
  }
}
