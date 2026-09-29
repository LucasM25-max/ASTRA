/**
 * CharacterGenerator.ts - ASTRA procedural player
 * =============================================================================
 * Builds the player character from primitives and a bone hierarchy, replacing
 * the Step 1.3 placeholder capsule.
 *
 * The shape
 * ---------
 * Everything is assembled from `CylinderGeometry` and `BoxGeometry` - no
 * imported model, no mesh data. The plan asks for exactly that, and it has a
 * second benefit: every part's dimensions are known analytically, which is what
 * lets the chain mail's ring density be expressed in rings per *metre* rather
 * than rings per UV unit. See the note on UV scale in CharacterMaterials.ts.
 *
 * Rigid parts on a bone hierarchy, not a skinned mesh
 * --------------------------------------------------
 * Each part is parented to the bone that drives it rather than being skinned
 * with weights. For a stylised character whose limbs are discrete cylinders this
 * is the honest choice: skinning would need per-vertex weights on geometry that
 * has no soft anything, would cost more to build than the character does, and
 * would produce exactly the rubbery elbow the style guide's "no cartoon
 * exaggeration" rule is trying to avoid. `AnimationMixer` animates the bones
 * either way, so nothing about the animation is limited by this.
 *
 * Proportions
 * -----------
 * Seven and a half heads tall - the academic canon, and the number the plan
 * names. The whole figure is derived from one input, the total height, so the
 * proportions cannot drift out of canon when the height changes. The test
 * asserts the head count rather than a list of numbers that would silently rot.
 *
 *   crown 1.80 - chin 1.56 - shoulder 1.48 - hip 0.96 - knee 0.50
 *         - ankle 0.08 - sole 0.00
 *
 * The sword
 * ---------
 * An elongated box blade with a crossguard, a grip and a pommel, sheathed on
 * the back. `drawSword()` and `sheatheSword()` reparent it between the back and
 * the right hand's grip bone, which is the whole mechanism - there is no second
 * sword and no state to keep in sync. Both transforms are derived from a
 * direction vector rather than from hand-tuned Euler angles, so what the sword
 * is *doing* is visible in the code and assertable in a test.
 *
 * Why the root is a Group
 * -----------------------
 * `MovementController` owns the character's yaw and writes it to `player.mesh`
 * (see Player.ts). The animator must never fight that, so it animates the bones
 * and leaves the root's rotation alone. The root is therefore a plain Group that
 * something else may rotate freely.
 * =============================================================================
 */

import {
  Bone,
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Object3D,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import {
  createChainMailMaterial,
  createCharacterMaterials,
  type ChainMailMaterialOptions,
  type CharacterMaterials,
} from '../procedural/CharacterMaterials';

/** Total height of the character, in metres. Matches the collider. */
export const CHARACTER_HEIGHT = 1.8;

/**
 * How many heads tall the figure is. The academic canon; the plan names it.
 * Changing this changes the head size and therefore every proportion below.
 */
export const HEADS_TALL = 7.5;

/** Shoulder width. Wider than the hips, deliberately - see Rule C below. */
export const SHOULDER_WIDTH = 0.48;

/** Hip width. */
export const HIP_WIDTH = 0.3;

/** Radius of an upper arm, in metres. */
export const ARM_RADIUS = 0.055;

/** Radius of a thigh, in metres. */
export const THIGH_RADIUS = 0.088;

/** Radius of a shin, in metres. */
export const SHIN_RADIUS = 0.062;

/**
 * How much larger the chain mail sits off the body it covers, as a fraction of
 * the limb radius. The plan asks for "slightly larger torso/limb cylinders";
 * without a gap the mail z-fights with the limb underneath it, and with a large
 * one the limbs read as balloons.
 */
export const MAIL_STANDOFF = 0.14;

export interface CharacterProportions {
  /** Total height, metres. */
  height: number;
  /** Height of the head alone, metres. `height / HEADS_TALL`. */
  head: number;
  /** Y of the ankle joint. */
  ankle: number;
  /** Y of the knee joint. */
  knee: number;
  /** Y of the hip joint. */
  hip: number;
  /** Y of the shoulder joint. */
  shoulder: number;
  /** Y of the base of the neck / bottom of the chin. */
  chin: number;
  /** Length of the neck. */
  neck: number;
  /** Length of the torso, hip to shoulder. */
  torso: number;
  /** Length of the spine section, hip to mid-back. */
  spine: number;
  /** Length of the chest section, mid-back to shoulder. */
  chest: number;
  /** Length of an upper arm. */
  upperArm: number;
  /** Length of a forearm. */
  lowerArm: number;
  /** Length of a hand. */
  hand: number;
  /** Length of a thigh. */
  thigh: number;
  /** Length of a shin. */
  shin: number;
  /** Half the shoulder width. */
  shoulderHalf: number;
  /** Half the hip width. */
  hipHalf: number;
}

/**
 * Derive every measurement from the total height.
 *
 * The vertical chain is built downwards from the crown so the total is exact by
 * construction rather than by tuning: whatever the fractions come to, they sum
 * to `height`. That is why there is no fudge term.
 */
export function characterProportions(height = CHARACTER_HEIGHT): CharacterProportions {
  const head = height / HEADS_TALL;
  const neck = head * 0.33;
  const torso = head * 2.17;
  const thigh = head * 1.92;
  const shin = head * 1.75;
  const foot = head * 0.33;
  const upperArm = head * 1.25;
  const lowerArm = head * 1.08;
  const hand = head * 0.71;

  const ankle = foot;
  const knee = ankle + shin;
  const hip = knee + thigh;
  const shoulder = hip + torso;
  const chin = shoulder + neck;

  return {
    height,
    head,
    ankle,
    knee,
    hip,
    shoulder,
    chin,
    neck,
    torso,
    // The torso is split into two bones so the chest can breathe and twist
    // independently of the hips. 40/60 is close to where the ribcage actually
    // ends, and the exact split is invisible.
    spine: torso * 0.4,
    chest: torso * 0.6,
    upperArm,
    lowerArm,
    hand,
    thigh,
    shin,
    shoulderHalf: SHOULDER_WIDTH / 2,
    hipHalf: HIP_WIDTH / 2,
  };
}

/** Names of the bones, in hierarchy order. Used by the animator and the tests. */
export const BONE_NAMES = [
  'root',
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulder.L',
  'upperArm.L',
  'lowerArm.L',
  'hand.L',
  'shoulder.R',
  'upperArm.R',
  'lowerArm.R',
  'hand.R',
  'thigh.L',
  'shin.L',
  'foot.L',
  'thigh.R',
  'shin.R',
  'foot.R',
  'swordGrip',
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

/** A named bone, found by `rig.bone(name)`. */
export interface NamedBone extends Bone {
  name: BoneName;
}

export interface CharacterRig {
  /** The character's origin. Feet at y = 0. Rotate this, not the bones. */
  readonly root: Group;
  /** The named bones, in hierarchy order. */
  readonly bones: readonly NamedBone[];
  /** Every mesh in the rig, for shadow flags and disposal. */
  readonly parts: readonly Mesh[];
  /** The greatsword, wherever it currently is. */
  readonly sword: Group;
  /** The proportions the rig was built to. */
  readonly proportions: CharacterProportions;
  /** Look a bone up by name. Throws if absent, which is a wiring bug. */
  bone(name: BoneName): NamedBone;
  /** True while the sword is in the right hand. */
  readonly swordDrawn: boolean;
  /** Move the sword to the right hand. Idempotent. */
  drawSword(): void;
  /** Move the sword back to the sheath on the back. Idempotent. */
  sheatheSword(): void;
  /** Release every geometry and material. Safe to call twice. */
  dispose(): void;
}

export interface CharacterGeneratorOptions {
  /** Total height in metres. Defaults to `CHARACTER_HEIGHT`. */
  height?: number;
  /** Override any of the four materials. Omitted ones are created. */
  materials?: Partial<CharacterMaterials>;
  /** Rings per metre of chain mail. Defaults to the material's own. */
  mailDensity?: number;
}

/** One geometry-plus-material pair, so dispose can find them all. */
interface Part {
  mesh: Mesh;
  geometry: BufferGeometry;
  material: CharacterMaterials[keyof CharacterMaterials];
}

export class CharacterGenerator {
  private readonly options: CharacterGeneratorOptions;
  private readonly materials: CharacterMaterials;
  private readonly ownsMaterials: boolean;
  private readonly parts: Part[] = [];
  private disposed = false;

  constructor(options: CharacterGeneratorOptions = {}) {
    this.options = options;
    const created = createCharacterMaterials(
      {},
      options.mailDensity === undefined ? {} : { density: options.mailDensity },
    );
    this.materials = {
      skin: options.materials?.skin ?? created.skin,
      chainMail: options.materials?.chainMail ?? created.chainMail,
      leather: options.materials?.leather ?? created.leather,
      steel: options.materials?.steel ?? created.steel,
    };
    // Only dispose what this generator actually created. If the caller passed
    // materials in, they own them.
    this.ownsMaterials =
      !options.materials?.skin &&
      !options.materials?.chainMail &&
      !options.materials?.leather &&
      !options.materials?.steel;
  }

  /** Build the whole rig. */
  generate(): CharacterRig {
    const p = characterProportions(this.options.height ?? CHARACTER_HEIGHT);
    const root = new Group();
    root.name = 'character';

    const bones: NamedBone[] = [];
    const addBone = (name: BoneName, parent: Object3D, x: number, y: number, z: number): NamedBone => {
      const b = new Bone();
      b.name = name;
      b.position.set(x, y, z);
      parent.add(b);
      bones.push(b as NamedBone);
      return b as NamedBone;
    };

    /* ---- the spine ------------------------------------------------------- */
    const rootBone = addBone('root', root, 0, 0, 0);
    const hips = addBone('hips', rootBone, 0, p.hip, 0);
    const spine = addBone('spine', hips, 0, p.spine, 0);
    const chest = addBone('chest', spine, 0, p.chest, 0);
    const neck = addBone('neck', chest, 0, p.neck, 0);
    // The head's pivot sits at the base of the skull, so the skull mesh hangs
    // above it and the nod rotates about the neck rather than about the crown.
    const head = addBone('head', neck, 0, p.head * 0.55, 0);

    /* ---- the torso ------------------------------------------------------- */
    // Pelvis. A box, wider at the hips than at the waist, so the silhouette
    // narrows upwards the way a torso does.
    this.addBox(hips, p.hipHalf * 2.0, p.spine * 1.05, p.torso * 0.42, this.materials.leather, 0, p.spine * 0.52, 0);
    // Abdomen, under the mail.
    this.addCylinder(spine, p.shoulderHalf * 0.6, p.shoulderHalf * 0.52, p.spine * 1.1, this.materials.skin, 0, p.spine * 0.55, 0);
    // Ribcage.
    this.addBox(chest, p.shoulderHalf * 2.0, p.chest * 1.05, p.torso * 0.46, this.materials.skin, 0, p.chest * 0.52, 0);
    // Neck.
    this.addCylinder(neck, p.head * 0.22, p.head * 0.24, p.neck, this.materials.skin, 0, p.neck * 0.5, 0);
    // Head. A box, narrower front to back than side to side: a sphere reads as a
    // toy at this scale, and a box with the right proportions reads as a jaw.
    this.addBox(head, p.head * 0.72, p.head, p.head * 0.8, this.materials.skin, 0, p.head * 0.5, 0);

    /* ---- limbs ----------------------------------------------------------- */
    for (const side of ['L', 'R'] as const) {
      const sign = side === 'L' ? -1 : 1;

      const shoulder = addBone(`shoulder.${side}`, chest, sign * p.shoulderHalf, 0.04, 0);
      const upperArm = addBone(`upperArm.${side}`, shoulder, 0, -0.02, 0);
      const lowerArm = addBone(`lowerArm.${side}`, upperArm, 0, -p.upperArm, 0);
      addBone(`hand.${side}`, lowerArm, 0, -p.lowerArm, 0);

      const thigh = addBone(`thigh.${side}`, hips, sign * p.hipHalf, -0.04, 0);
      const shin = addBone(`shin.${side}`, thigh, 0, -p.thigh, 0);
      const foot = addBone(`foot.${side}`, shin, 0, -p.shin, 0);

      // Pauldron: chain mail over a slightly larger cylinder, as the plan asks.
      this.addMailCylinder(shoulder, ARM_RADIUS * 2.0, ARM_RADIUS * 1.8, p.upperArm * 0.36, 0, -p.upperArm * 0.18, 0);

      // Arm. The skin cylinder is the limb; the mail cylinder stands off it.
      this.addCylinder(upperArm, ARM_RADIUS, ARM_RADIUS * 0.86, p.upperArm, this.materials.skin, 0, -p.upperArm * 0.5, 0);
      this.addMailCylinder(upperArm, ARM_RADIUS * (1 + MAIL_STANDOFF), ARM_RADIUS * (1 + MAIL_STANDOFF) * 0.86, p.upperArm, 0, -p.upperArm * 0.5, 0);

      this.addCylinder(lowerArm, ARM_RADIUS * 0.82, ARM_RADIUS * 0.66, p.lowerArm, this.materials.skin, 0, -p.lowerArm * 0.5, 0);
      // A leather bracer over the forearm. The plan asks for leather somewhere,
      // and a bracer is where it belongs.
      this.addCylinder(lowerArm, ARM_RADIUS * 1.02, ARM_RADIUS * 0.9, p.lowerArm * 0.45, this.materials.leather, 0, -p.lowerArm * 0.3, 0);
      this.addBox(lowerArm, p.hand * 0.42, p.hand * 0.9, p.hand * 0.62, this.materials.leather, 0, -p.lowerArm - p.hand * 0.45, 0);

      // Leg.
      this.addCylinder(thigh, THIGH_RADIUS, THIGH_RADIUS * 0.72, p.thigh, this.materials.skin, 0, -p.thigh * 0.5, 0);
      this.addMailCylinder(thigh, THIGH_RADIUS * (1 + MAIL_STANDOFF), THIGH_RADIUS * (1 + MAIL_STANDOFF) * 0.72, p.thigh, 0, -p.thigh * 0.5, 0);

      this.addCylinder(shin, SHIN_RADIUS, SHIN_RADIUS * 0.6, p.shin, this.materials.skin, 0, -p.shin * 0.5, 0);
      this.addMailCylinder(shin, SHIN_RADIUS * (1 + MAIL_STANDOFF), SHIN_RADIUS * (1 + MAIL_STANDOFF) * 0.6, p.shin, 0, -p.shin * 0.5, 0);

      // Boot. A box whose top sits at the ankle, so the sole lands on y = 0.
      this.addBox(foot, p.head * 0.3, p.ankle, p.head * 0.74, this.materials.leather, 0, -p.ankle * 0.5, p.head * 0.14);
    }

    /* ---- the sword, sheathed on the back --------------------------------- */
    const sword = this.buildSword(p);
    const swordGrip = addBone('swordGrip', bones.find((b) => b.name === 'hand.R')!, 0, -p.hand * 0.9, 0.02);

    // The rig's methods close over the generator, not over the rig: a shorthand
    // method in the object literal below would see `this` as the literal, which
    // is exactly the bug where dispose silently does nothing.
    const generator = this;

    const rig: CharacterRig = {
      root,
      bones,
      parts: this.parts.map((part) => part.mesh),
      sword,
      proportions: p,
      bone(name) {
        const found = bones.find((b) => b.name === name);
        if (!found) throw new Error(`[CharacterGenerator] no bone named ${String(name)}`);
        return found;
      },
      get swordDrawn() {
        return sword.parent === swordGrip;
      },
      drawSword() {
        if (sword.parent === swordGrip) return;
        swordGrip.add(sword);
        // In the hand the blade runs along the forearm, so it points forward and
        // slightly down - the way a greatsword is actually held, not straight up.
        sword.position.set(0, 0, 0.04);
        sword.quaternion.copy(orientYTo(new Vector3(0, 0, 1)));
      },
      sheatheSword() {
        if (sword.parent === chest) return;
        chest.add(sword);
        // Across the back, grip at the right shoulder, tip down at the left hip.
        sword.position.set(0.1, p.shoulder * 0.92, -p.torso * 0.36);
        sword.quaternion.copy(orientYTo(new Vector3(-0.45, -0.89, -0.06)));
      },
      dispose() {
        generator.disposeRig(root);
      },
    };

    // Start sheathed, as the plan asks.
    rig.sheatheSword();
    return rig;
  }

  /**
   * Release everything a generated rig holds.
   *
   * Idempotent, and separate from the rig's own `dispose` so that two rigs built
   * by one generator do not double-free each other's materials.
   */
  disposeRig(root: Group): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const part of this.parts) part.geometry.dispose();
    if (this.ownsMaterials) {
      for (const material of Object.values(this.materials)) material.dispose();
    }
    this.parts.length = 0;
    root.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Part builders                                                          */
  /* ---------------------------------------------------------------------- */

  private addCylinder(
    parent: Object3D,
    rTop: number,
    rBottom: number,
    length: number,
    material: CharacterMaterials[keyof CharacterMaterials],
    x: number,
    y: number,
    z: number,
  ): Mesh {
    const geometry = new CylinderGeometry(rTop, rBottom, length, 12, 1);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.parts.push({ mesh, geometry, material });
    return mesh;
  }

  /**
   * A chain mail cylinder.
   *
   * Each one gets its own material instance rather than sharing one, because the
   * shader needs the part's real circumference and height to make "rings per
   * metre" mean anything. They all share a compiled program - the cache key is
   * fixed per material kind - so this costs uniform values, not shaders.
   */
  private addMailCylinder(
    parent: Object3D,
    rTop: number,
    rBottom: number,
    length: number,
    x: number,
    y: number,
    z: number,
  ): Mesh {
    const circumference = 2 * Math.PI * Math.max(rTop, rBottom);
    const mailOptions: ChainMailMaterialOptions =
      this.options.mailDensity === undefined ? {} : { density: this.options.mailDensity };
    const material = createChainMailMaterial({ ...mailOptions, size: [circumference, length] });
    const geometry = new CylinderGeometry(rTop, rBottom, length, 16, 1);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.parts.push({ mesh, geometry, material });
    return mesh;
  }

  private addBox(
    parent: Object3D,
    width: number,
    height: number,
    depth: number,
    material: CharacterMaterials[keyof CharacterMaterials],
    x: number,
    y: number,
    z: number,
  ): Mesh {
    const geometry = new BoxGeometry(width, height, depth);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.parts.push({ mesh, geometry, material });
    return mesh;
  }

  /* ---------------------------------------------------------------------- */
  /* The greatsword                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * An elongated box blade with a crossguard, a grip and a pommel.
   *
   * The group's origin is the grip, and the blade runs along +Y. Both the
   * sheathed and the drawn transform orient that +Y at a direction chosen for
   * what it should read as, which is why neither is a set of magic Euler angles.
   *
   * The proportions matter more than the detail: a greatsword is roughly as long
   * as its owner is tall, which is what makes the silhouette read at distance
   * (style guide Rule C) and what gives the scale contrast against the trees.
   */
  private buildSword(p: CharacterProportions): Group {
    const sword = new Group();
    sword.name = 'greatsword';

    const bladeLength = p.height * 0.95;
    const bladeWidth = 0.055;
    const bladeDepth = 0.018;
    const guardWidth = 0.26;
    const gripLength = 0.2;

    const blade = this.addBox(sword, bladeWidth, bladeLength, bladeDepth, this.materials.steel, 0, gripLength + bladeLength * 0.5, 0);
    blade.name = 'greatsword-blade';
    // The guard.
    this.addBox(sword, guardWidth, 0.03, 0.045, this.materials.steel, 0, gripLength, 0);
    // The grip.
    this.addCylinder(sword, 0.017, 0.02, gripLength, this.materials.leather, 0, gripLength * 0.5, 0);
    // The pommel.
    this.addCylinder(sword, 0.026, 0.026, 0.032, this.materials.steel, 0, 0.014, 0);

    return sword;
  }
}

/**
 * A quaternion that rotates local +Y onto `direction`.
 *
 * Used for the sword so that "the blade points down the back" and "the blade
 * points forward" are written as directions in the code and can be asserted as
 * directions in a test, instead of being buried in three Euler angles that
 * nobody can read.
 */
export function orientYTo(direction: Vector3): Quaternion {
  const target = direction.clone();
  if (target.lengthSq() < 1e-12) return new Quaternion();
  target.normalize();
  // setFromUnitVectors picks the short arc, which for +Y -> -Y is a 180 degree
  // rotation about an arbitrary perpendicular - undefined, so it is pinned here.
  const from = new Vector3(0, 1, 0);
  if (from.dot(target) < -0.999999) {
    return new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
  }
  return new Quaternion().setFromUnitVectors(from, target);
}
