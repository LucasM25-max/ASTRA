/**
 * Player.ts - ASTRA player
 * =============================================================================
 * The player character: a procedural humanoid rig standing on a dynamic capsule
 * collider.
 *
 * Step 1.3 shipped a capsule with no rig and no animation, and this is the swap
 * the plan's Phase 4 note anticipated: the mesh is now the procedurally
 * generated character from `CharacterGenerator`, animated by
 * `CharacterAnimator`, wearing the materials from `CharacterMaterials`.
 * Everything above this class - the movement controller, the camera, the
 * encounter system - was written against the *body* and the *transform*, not
 * against the mesh, which is why this stayed a change in one file.
 *
 * Three objects, one transform
 * ----------------------------
 * The physics body, the render root and the skeleton are deliberately kept
 * separate, and are only ever reconciled in `syncMesh()`, which the render loop
 * calls once per frame. The simulation owns *position*; visual rotation is owned
 * by whoever is animating the character (`MovementController` turns the root to
 * face its direction of travel, and `CharacterAnimator` writes the bones but
 * never the root). That split matters because the collider's rotation is locked
 * - see `PhysicsWorld.createCapsuleBody` - so letting physics drive the root's
 * rotation would freeze the character facing one way forever.
 *
 * The offset that is easy to get wrong
 * ------------------------------------
 * The capsule's origin is its *midpoint*, at half the character's height. The
 * rig's origin is its *feet*, on the ground. Those differ by exactly
 * `height / 2`, and every frame has to bridge them: the root is placed at
 * `body.translation - height / 2`. Get it wrong in either direction and the
 * character either floats half a body above the terrain or sinks through it,
 * both of which look like a physics bug rather than like an offset mistake.
 *
 * The capsule is still the collider, deliberately. The rig is a dozen cylinders
 * and boxes on a bone hierarchy; wrapping that in convex hulls or a trimesh
 * would cost far more per step and would catch on the terrain's own facets. The
 * plan asks for a procedural character, not for a procedural collider, and the
 * capsule remains the cheapest shape that is the right height and width.
 * =============================================================================
 */

import { Group, Vector3, type Object3D } from 'three';
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import type { PhysicsWorld, Vec3 } from '../physics/PhysicsWorld';
import { CharacterAnimator } from './CharacterAnimator';
import { CharacterGenerator, type CharacterRig } from './CharacterGenerator';

/** Radius of the capsule, in metres. */
export const PLAYER_RADIUS = 0.35;

/** Total height of the capsule, in metres. Matches the character rig's height. */
export const PLAYER_HEIGHT = 1.8;

/**
 * Half-height of the capsule's cylindrical section: the total height minus the
 * two hemispherical caps, halved.
 */
export const PLAYER_HALF_HEIGHT = (PLAYER_HEIGHT - 2 * PLAYER_RADIUS) / 2;

/** Where the player appears when the world loads, per the Step 1.3 spec. */
export const PLAYER_SPAWN = { x: 0, y: 1, z: 0 } as const;

/**
 * Half the character's height: the distance from the capsule's centre to the
 * soles of the boots, and therefore the offset that has to be subtracted from
 * the body's translation to place the rig's feet on the ground.
 */
export const PLAYER_FOOT_OFFSET = PLAYER_HEIGHT / 2;

export interface PlayerOptions {
  /** An initialised physics world to create the body in. */
  physics: PhysicsWorld;
  /** Initial position of the capsule's centre. Defaults to `PLAYER_SPAWN`. */
  spawn?: Vec3;
  /** Capsule radius in metres. Defaults to `PLAYER_RADIUS`. */
  radius?: number;
  /** Total capsule height in metres. Defaults to `PLAYER_HEIGHT`. */
  height?: number;
  /** Collider friction. Defaults to Rapier's own 0.5. */
  friction?: number;
  /** Linear velocity damping per second. Defaults to none. */
  linearDamping?: number;
}

export class Player {
  /**
   * The render root: the character rig's `Group`.
   *
   * Still called `mesh` because that is what every caller above this class
   * already reads - `addTo`, `removeFrom` and `MovementController`'s
   * `player.mesh.rotation.y` all work unchanged on a `Group`, and renaming it
   * would spread this step's change into four other files for no benefit.
   */
  readonly mesh: Group;
  readonly body: RigidBody;
  readonly collider: Collider;
  /** The generated character: bones, parts, proportions and the greatsword. */
  readonly character: CharacterRig;
  /** Drives the character's clips. Advanced from `syncMesh`. */
  readonly animator: CharacterAnimator;

  private readonly physics: PhysicsWorld;
  private readonly radiusValue: number;
  private readonly heightValue: number;
  private readonly generator: CharacterGenerator;

  /** Reused every frame so `syncMesh()` allocates nothing. */
  private readonly bodyPosition = new Vector3();
  /** The body's linear velocity, read into it once per frame. */
  private readonly bodyVelocity = new Vector3();

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

    // Build the character at the *capsule's* height. The generator defaults to
    // its own 1.8 m proportions, and a rig that disagreed with the collider by
    // even a few centimetres would either float or sink - the same class of bug
    // the old mesh/collider dimension check guarded against, so it is still
    // checked below rather than assumed.
    this.generator = new CharacterGenerator({ height });
    this.character = this.generator.generate();
    this.animator = new CharacterAnimator(this.character);

    this.mesh = this.character.root;
    this.mesh.name = 'player';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    // The rig's feet sit on its own origin, so the root has to be lifted by the
    // body's half-height to line the soles up with the capsule's bottom cap.
    // Without this the character stands half a body inside the terrain.
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
   * Reconcile the render root with the simulation, and advance the animation.
   *
   * Called once per rendered frame from the render loop, not from the fixed
   * update: the body only moves during fixed steps, so reading it at render
   * time always yields the latest simulation state, and at high refresh rates
   * the mesh simply holds its position between steps rather than tearing.
   *
   * Rotation is deliberately not copied from the body - see the note at the top
   * of the file.
   *
   * `delta` is *game* time, the same scaled delta the world is advanced with,
   * so the character slows and freezes with everything else during time
   * dilation. It defaults to zero, which advances nothing: a caller that only
   * wants the transform reconciled can omit it, and a caller that forgets it
   * gets a still character rather than one racing ahead on an undefined delta.
   *
   * The animation's speed comes from the body's own horizontal velocity rather
   * than from the input, and that is the point: what the player *asks* for and
   * what the body *does* disagree the moment the character is shoved, slides
   * down a slope, or is stopped against a wall, and a character that keeps
   * striding while pinned against a tree is worse than one that stands still.
   */
  syncMesh(delta = 0): void {
    if (this.disposed) return;

    this.body.translation(this.bodyPosition);
    // Feet, not centre: the rig's origin is the ground.
    this.mesh.position.set(
      this.bodyPosition.x,
      this.bodyPosition.y - this.heightValue / 2,
      this.bodyPosition.z,
    );

    if (delta > 0) {
      this.body.linvel(this.bodyVelocity);
      const groundSpeed = Math.hypot(this.bodyVelocity.x, this.bodyVelocity.z);
      this.animator.setSpeed(groundSpeed);
      this.animator.update(delta);
    }
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
   * Draw the greatsword, or sheathe it again.
   *
   * Both are safe to call every frame - the rig's own methods are no-ops when
   * the sword is already in the requested state, so a caller does not have to
   * track which one it is in.
   */
  drawSword(): void {
    if (this.disposed) return;
    this.character.drawSword();
  }

  sheatheSword(): void {
    if (this.disposed) return;
    this.character.sheatheSword();
  }

  /** True while the greatsword is in the character's hand. */
  get swordDrawn(): boolean {
    return this.character.swordDrawn;
  }

  /**
   * Release the character's GPU resources and remove the body from the
   * simulation.
   *
   * Removing the rigid body also removes its colliders, so there is no
   * double-free to worry about. The physics world itself is *not* disposed
   * here: it was passed in, so whoever created it owns it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.animator.dispose();
    this.generator.disposeRig(this.character.root);
    this.physics.world.removeRigidBody(this.body);
  }
}
