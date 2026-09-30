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
  private readonly parts: Part[] = [];
  /** Materials the caller supplied, and therefore still owns. */
  private readonly passedIn: Set<CharacterMaterials[keyof CharacterMaterials]>;
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
    // Which of the four the caller supplied. Whoever creates a material owns it,
    // so disposing one that was passed in frees it out from under the system
    // that is still using it.
    this.passedIn = new Set(
      [
        options.materials?.skin,
        options.materials?.chainMail,
        options.materials?.leather,
        options.materials?.steel,
      ].filter((m): m is CharacterMaterials[keyof CharacterMaterials] => m !== undefined),
    );
  }

  /** Build the whole rig. */
  generate(): CharacterRig {
    const height = this.options.height ?? CHARACTER_HEIGHT;
    // Validated here rather than in the constructor, because a non-finite height
    // does not fail loudly: it propagates NaN through every proportion, every
    // bone position and every matrix, and the character simply vanishes with
    // nothing in the log to say why. Failing at the one point that knows the
    // number is meant to be a height is the cheapest place to catch it.
    if (!Number.isFinite(height) || height <= 0) {
      throw new RangeError(
        `[CharacterGenerator] height must be a positive number, received ${String(height)}`,
      );
    }

    const p = characterProportions(height);
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
    // Every torso part is placed by the absolute height it has to occupy, not by
    // an offset from its bone, and the difference is not cosmetic. The bones sit
    // at the *top* of their section - `chest` is at the shoulder line, `neck` at
    // the chin - so "half a height above the bone" puts the ribcage over the head
    // and the head above the crown, which is exactly what this layout replaces.
    // `spanOf` turns an absolute region into the offset and length the builders
    // want, so the region is what gets read and the arithmetic is done once.
    // The bone heights, accumulated down the chain.
    //
    // These are *not* `bone.position.y`: that is the offset from the bone's
    // parent, so `chest.position.y` is `p.chest` - the length of the chest
    // section - and not the height of the chest. Reading it as a height puts
    // every torso part a whole section out, which is how the neck ended up at
    // y = 3 m. The chain is short enough to write out, and it is the same chain
    // `characterProportions` builds, so the two cannot drift.
    const hipsY = p.hip;
    const spineY = p.hip + p.spine;
    const chestY = p.shoulder;
    const neckY = p.chin;
    const headY = p.chin + p.head * 0.55;

    const spanOf = (boneY: number, bottom: number, top: number) => ({
      y: (bottom + top) / 2 - boneY,
      length: top - bottom,
    });

    // Pelvis: a box, wider at the hips than at the waist, so the silhouette
    // narrows upwards the way a torso does. Leather, because a belt goes here.
    const pelvis = spanOf(hipsY, hipsY, hipsY + p.spine * 0.92);
    this.addBox(hips, p.hipHalf * 2.0, pelvis.length, p.torso * 0.42, this.materials.leather, 0, pelvis.y, 0);

    // Abdomen, under the mail.
    const abdomen = spanOf(spineY, hipsY + p.spine * 0.4, chestY - p.chest * 0.6);
    this.addCylinder(spine, p.shoulderHalf * 0.6, p.hipHalf * 0.95, abdomen.length, this.materials.skin, 0, abdomen.y, 0);
    this.addMailCylinder(
      spine,
      p.shoulderHalf * 0.6 * (1 + MAIL_STANDOFF),
      p.hipHalf * 0.95 * (1 + MAIL_STANDOFF),
      abdomen.length,
      0,
      abdomen.y,
      0,
    );

    // Ribcage, and the chain mail over it. The plan asks for mail on the torso as
    // well as the limbs, and it has to be a cylinder rather than the box this
    // used to be: a box inside a cylinder pokes through at the corners for any
    // radius that fits, so the mail would have to be as wide as the box's
    // diagonal. Rounding the chest is the cheaper of the two, and the pauldrons
    // carry the broad-shoulder silhouette instead.
    const ribcage = spanOf(chestY, chestY - p.chest * 0.95, chestY);
    this.addCylinder(chest, p.shoulderHalf * 0.62, p.shoulderHalf * 0.86, ribcage.length, this.materials.skin, 0, ribcage.y, 0);
    this.addMailCylinder(
      chest,
      p.shoulderHalf * 0.62 * (1 + MAIL_STANDOFF),
      p.shoulderHalf * 0.86 * (1 + MAIL_STANDOFF),
      ribcage.length,
      0,
      ribcage.y,
      0,
    );

    // Neck.
    const neckSpan = spanOf(neckY, chestY, p.chin);
    this.addCylinder(neck, p.head * 0.22, p.head * 0.24, neckSpan.length, this.materials.skin, 0, neckSpan.y, 0);

    // Head. A box, narrower front to back than side to side: a sphere reads as a
    // toy at this scale, and a box with the right proportions reads as a jaw.
    // The span runs chin to crown, so the top of the skull lands exactly on the
    // character's total height.
    const skull = spanOf(headY, p.chin, p.height);
    this.addBox(head, p.head * 0.72, skull.length, p.head * 0.8, this.materials.skin, 0, skull.y, 0);

    /* ---- limbs ----------------------------------------------------------- */
    for (const side of ['L', 'R'] as const) {
      const sign = side === 'L' ? -1 : 1;

      const shoulder = addBone(`shoulder.${side}`, chest, sign * p.shoulderHalf, 0.04, 0);
      const upperArm = addBone(`upperArm.${side}`, shoulder, 0, -0.02, 0);
      const lowerArm = addBone(`lowerArm.${side}`, upperArm, 0, -p.upperArm, 0);
      addBone(`hand.${side}`, lowerArm, 0, -p.lowerArm, 0);

      // No vertical offset here, and that is load-bearing rather than tidy: the
      // proportions are built downwards from the crown so they sum to `height`
      // exactly, and a 4 cm socket offset on the thigh pushes the whole leg chain
      // down by 4 cm - which put the ankle 4 cm short of `p.ankle` and sank the
      // boots' soles below the ground. The chain now lands the ankle exactly on
      // `p.ankle` and the sole exactly on y = 0.
      const thigh = addBone(`thigh.${side}`, hips, sign * p.hipHalf, 0, 0);
      const shin = addBone(`shin.${side}`, thigh, 0, -p.thigh, 0);
      const foot = addBone(`foot.${side}`, shin, 0, -p.shin, 0);

      // Pauldron: chain mail over a slightly larger cylinder, as the plan asks.
      // The radius is held just inside the collider's, so the widest part of the
      // character is the pauldron and it still clears the capsule by a
      // centimetre - a shoulder wider than the body catches on doorways the
      // player walks straight through.
      this.addMailCylinder(shoulder, ARM_RADIUS * 1.8, ARM_RADIUS * 1.62, p.upperArm * 0.36, 0, -p.upperArm * 0.18, 0);

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
        // A little way out to the character's right as well, so the pommel
        // clears the thigh the arm hangs beside.
        sword.position.set(0.09, 0, 0.04);
        // Forward, slightly up, and slightly out to the character's right.
        //
        // The X component is the one that is easy to leave out: with the blade
        // pointing straight forward it runs through the forearm it is held in,
        // because the grip sits on the forearm's axis. Angling it out by about
        // nine degrees clears the arm for the whole length of the blade. The Y
        // component stops the tip dragging through the terrain the moment the
        // sword leaves the back.
        sword.quaternion.copy(orientYTo(new Vector3(0.15, 0.3, 0.94)));
      },
      sheatheSword() {
        if (sword.parent === chest) return;
        chest.add(sword);
        // Across the back, pommel at the right shoulder, tip down past the left
        // hip.
        //
        // The position is *relative to the chest bone*, whose origin is the
        // shoulder line at `p.shoulder`. Writing an absolute height here puts the
        // sword at shoulder + shoulder - it used to float 1.36 m above the
        // shoulder, behind the character's head, pointing down at the ground.
        //
        // The direction is the part that needed measuring. A 1.45 m blade slung
        // from a 1.48 m shoulder cannot reach the hip and stop: the shoulder and
        // the opposite hip are only 0.63 m apart, so a straight blade has ~0.8 m
        // left over and has to go somewhere. Hanging it straight down puts it
        // exactly where the legs swing - the run's stride sweeps 86 cm behind
        // the hip, and the blade passed through the shin on most frames. So it
        // angles out to the character's left as it descends, which is also how a
        // real back-slung sword sits, and the flat of the blade faces the back
        // because the direction's Z component is kept small.
        sword.position.set(0.12, 0.05, -0.28);
        sword.quaternion.copy(orientYTo(new Vector3(-0.42, -0.9, -0.07)));
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

    // Dispose the materials the parts actually wear, not the four templates.
    //
    // Every chain mail part carries its own instance, because the shader needs
    // that part's real circumference and height - so `this.materials.chainMail`
    // is never worn by anything, and disposing the template set leaked every
    // mail material on the character. Both sets have to go: the templates this
    // generator created (one of them is otherwise orphaned with nothing pointing
    // at it), and everything a part wears that was not passed in.
    const toDispose = new Set<CharacterMaterials[keyof CharacterMaterials]>();
    for (const material of Object.values(this.materials)) {
      if (!this.passedIn.has(material)) toDispose.add(material);
    }
    for (const part of this.parts) {
      part.geometry.dispose();
      if (!this.passedIn.has(part.material)) toDispose.add(part.material);
    }
    for (const material of toDispose) material.dispose();

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
   * The proportions matter more than the detail. A greatsword is roughly as long
   * as its owner is tall, which is what makes the silhouette read at distance
   * (style guide Rule C) and what gives the scale contrast against the trees -
   * but that is the *whole* sword. The blade alone is nearer two thirds of the
   * height: at 0.95 the blade was 1.71 m on a 1.8 m character, so slung from the
   * shoulder it ran a third of a metre through the ground. 0.66 with a 0.26 grip
   * gives a 1.45 m sword whose tip clears the terrain with room to spare.
   */
  private buildSword(p: CharacterProportions): Group {
    const sword = new Group();
    sword.name = 'greatsword';

    const bladeLength = p.height * 0.66;
    const bladeWidth = 0.055;
    const bladeDepth = 0.018;
    const guardWidth = 0.26;
    const gripLength = 0.26;

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
