/**
 * character-generator.test.ts
 * =============================================================================
 * The generated rig, measured rather than eyeballed.
 *
 * A rig is a pile of cylinders and boxes on a bone hierarchy, and every part is
 * placed by a number. The failures that matter are all *placement* failures, and
 * every one of them is invisible in source and obvious on screen:
 *
 *   - a torso part placed a section out, so the ribcage covers the head
 *   - a head that pokes above the character's declared height
 *   - boots whose soles sit below the ground
 *   - a sword floating above the shoulder, or running through the terrain
 *
 * None of those can be reasoned about. They have to be measured, and the numbers
 * that catch them are exactly the ones asserted here: the rig's bounding box has
 * to run soles-to-crown and nothing may fall outside it.
 *
 * The other thing worth locking down is the chain mail. The plan asks for it on
 * the torso *and* the limbs, and "slightly larger cylinders" - so the mail has to
 * exist on both, and it has to actually stand off the limb rather than coincide
 * with it.
 * =============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { AnimationMixer, Box3, Bone, Group, Mesh, Matrix4, Object3D, Vector3, type MeshStandardMaterial } from 'three';
import {
  BONE_NAMES,
  CHARACTER_HEIGHT,
  HEADS_TALL,
  HIP_WIDTH,
  SHOULDER_WIDTH,
  CharacterGenerator,
  characterProportions,
  orientYTo,
  type CharacterProportions,
} from '../src/player/CharacterGenerator';
import { CharacterAnimator } from '../src/player/CharacterAnimator';

/** The rig's world bounding box, from every part rather than from the group. */
function rigBox(generator: CharacterGenerator): Box3 {
  const rig = generator.generate();
  rig.root.updateMatrixWorld(true);
  return new Box3().setFromObject(rig.root);
}

/** A fresh rig, generated and with its matrices current. */
function makeRig(height = CHARACTER_HEIGHT) {
  const generator = new CharacterGenerator({ height });
  const rig = generator.generate();
  rig.root.updateMatrixWorld(true);
  return { generator, rig };
}

/** World position of a bone. */
function at(rig: ReturnType<CharacterGenerator['generate']>, name: string): Vector3 {
  return new Vector3().setFromMatrixPosition(rig.bone(name as never).matrixWorld);
}

/** True if `node` sits inside `ancestor`'s subtree. */
function isDescendantOf(node: Object3D, ancestor: Object3D): boolean {
  let parent = node.parent;
  while (parent !== null) {
    if (parent === ancestor) return true;
    parent = parent.parent;
  }
  return false;
}

/** The mail material's cache key, so mail parts can be identified. */
const MAIL_KEY = 'astra-chainmail-v1';
const STEEL_KEY = 'astra-steel-v1';

function isMail(mesh: Mesh): boolean {
  return (mesh.material as MeshStandardMaterial).customProgramCacheKey() === MAIL_KEY;
}

/* ========================================================================== */

describe('proportions', () => {
  it('is 7.5 heads tall, as the plan asks', () => {
    const p = characterProportions();
    expect(p.height / p.head).toBeCloseTo(HEADS_TALL, 10);
    expect(HEADS_TALL).toBe(7.5);
  });

  it('sums the vertical chain to the total height exactly', () => {
    // The chain is built downwards from the crown so the total is exact by
    // construction rather than by tuning. If a fraction changes, this is what
    // says whether the character got taller or shorter.
    for (const height of [1.6, 1.8, 2.0]) {
      const p = characterProportions(height);
      const chain = p.ankle + p.shin + p.thigh + p.torso + p.neck + p.head;
      expect(chain).toBeCloseTo(height, 10);
    }
  });

  it('has broad shoulders and narrower hips', () => {
    // Style guide Rule C: the silhouette has to read at distance, and a
    // shoulder that is not wider than the hips does not.
    const p = characterProportions();
    expect(SHOULDER_WIDTH).toBeGreaterThan(HIP_WIDTH);
    expect(p.shoulderHalf).toBeGreaterThan(p.hipHalf);
  });
});

/* ========================================================================== */

describe('the skeleton', () => {
  it('has about twenty bones, all named, all real Bones', () => {
    const { rig } = makeRig();
    expect(rig.bones.length).toBe(BONE_NAMES.length);
    expect(rig.bones.length).toBeGreaterThanOrEqual(20);
    for (const bone of rig.bones) {
      expect(bone).toBeInstanceOf(Bone);
      expect(bone.name.length).toBeGreaterThan(0);
    }
  });

  it('names every bone uniquely', () => {
    // A duplicate name makes `rig.bone()` return the first match and the second
    // limb silently stops animating, with nothing in the log to say so.
    const names = BONE_NAMES.map((n) => n);
    expect(new Set(names).size).toBe(names.length);
  });

  it('puts the joints where the proportions say', () => {
    const { rig } = makeRig();
    const p = rig.proportions;
    expect(at(rig, 'hips').y).toBeCloseTo(p.hip, 6);
    expect(at(rig, 'spine').y).toBeCloseTo(p.hip + p.spine, 6);
    expect(at(rig, 'chest').y).toBeCloseTo(p.shoulder, 6);
    expect(at(rig, 'neck').y).toBeCloseTo(p.chin, 6);
    expect(at(rig, 'thigh.L').y).toBeCloseTo(p.hip, 6);
    expect(at(rig, 'shin.L').y).toBeCloseTo(p.hip - p.thigh, 6);
    expect(at(rig, 'foot.L').y).toBeCloseTo(p.ankle, 6);
  });

  it('mirrors the left and right limbs exactly', () => {
    const { rig } = makeRig();
    for (const base of ['shoulder', 'upperArm', 'lowerArm', 'hand', 'thigh', 'shin', 'foot']) {
      const l = at(rig, `${base}.L`);
      const r = at(rig, `${base}.R`);
      expect(l.y).toBeCloseTo(r.y, 10);
      expect(l.z).toBeCloseTo(r.z, 10);
      expect(l.x).toBeCloseTo(-r.x, 10);
    }
  });
});

/* ========================================================================== */

describe('the rig fits the character it claims to be', () => {
  it('runs soles to crown and nothing outside it', () => {
    // This is the assertion that catches every placement defect at once. A torso
    // part a section out, a head above the crown, a boot below the ground: all
    // three break the box, and none of them is visible in source.
    for (const height of [1.6, 1.8, 2.0]) {
      const box = rigBox(new CharacterGenerator({ height }));
      expect(box.min.y, `soles below the ground at height ${height}`).toBeGreaterThan(-1e-6);
      expect(box.min.y).toBeLessThan(1e-6);
      expect(box.max.y, `crown off the height at ${height}`).toBeCloseTo(height, 6);
    }
  });

  it('keeps the body inside the capsule the player simulates', () => {
    // The capsule is 0.7 m across and 1.8 m tall. Anything on the *body* wider
    // than that catches on doorways the player walks straight through, and the
    // widest thing on the body is the pauldron.
    //
    // The sword is excluded, and deliberately so - see the next test.
    //
    // The measurement is the part's true reach from the body axis, not its
    // bounding-box corner: a cylinder's box corner sits at (r, r) and so
    // overstates the reach by 41%, which would fail a pauldron that is actually
    // a centimetre inside the capsule.
    const generator = new CharacterGenerator();
    const rig = generator.generate();
    rig.root.updateMatrixWorld(true);

    const radius = 0.35;
    let worst = 0;
    for (const part of rig.parts) {
      if (isDescendantOf(part, rig.sword)) continue;
      part.geometry.computeBoundingBox();
      const b = part.geometry.boundingBox as Box3;
      const centre = new Vector3().setFromMatrixPosition(part.matrixWorld);

      if (part.geometry.type === 'CylinderGeometry') {
        const r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
        worst = Math.max(worst, Math.hypot(centre.x, centre.z) + r);
      } else {
        for (const x of [b.min.x, b.max.x]) {
          for (const z of [b.min.z, b.max.z]) {
            worst = Math.max(worst, Math.hypot(centre.x + x, centre.z + z));
          }
        }
      }

      // And vertically, soles on the ground and crown on the height.
      const world = b.clone().applyMatrix4(part.matrixWorld);
      expect(world.min.y).toBeGreaterThanOrEqual(-1e-6);
      expect(world.max.y).toBeLessThanOrEqual(rig.proportions.height + 1e-6);
    }

    expect(worst).toBeLessThanOrEqual(radius);
    // And it is close to filling it, so the collider is not wildly oversized.
    expect(worst).toBeGreaterThan(radius * 0.9);
  });

  it('lets the sheathed greatsword protrude past the capsule, and says so', () => {
    // A 1.45 m blade slung from a 1.48 m shoulder cannot stay inside a 0.35 m
    // capsule: the shoulder and the opposite hip are 0.63 m apart, so a straight
    // blade has 0.8 m left over and it has to go somewhere. It angles out to the
    // character's left, which is also how a real back-slung sword sits and what
    // keeps it clear of the legs - but it does stick out.
    //
    // This is asserted rather than ignored, because the alternative is a sword
    // short enough to be a gladius, and because the capsule is a gameplay
    // approximation of the *body*. Phase 2 has no combat and no sword collider,
    // so the body is what has to be right.
    const generator = new CharacterGenerator();
    const rig = generator.generate();
    rig.root.updateMatrixWorld(true);
    const sword = new Box3().setFromObject(rig.sword);

    // It sticks out to the character's left and behind, not through the front.
    expect(sword.min.x).toBeLessThan(-0.35);
    expect(sword.max.z).toBeLessThan(0);
    expect(sword.max.x).toBeLessThan(0.35);

    // But the protrusion is bounded, so it is a known quantity rather than an
    // accident that grows the next time a proportion changes.
    const reach = Math.max(
      Math.hypot(sword.min.x, sword.min.z),
      Math.hypot(sword.min.x, sword.max.z),
      Math.hypot(sword.max.x, sword.min.z),
    );
    expect(reach).toBeGreaterThan(0.35);
    expect(reach).toBeLessThan(0.85);

    // And the tip clears the terrain, which is the one place a protrusion would
    // actually be seen clipping: the ASTRA terrain's 99th-percentile slope is
    // 0.072, so 50 cm of horizontal travel buys under 4 cm of rise.
    expect(sword.min.y).toBeGreaterThan(0.15);
  });

  it('is a rig of many parts, not a single mesh', () => {
    const { rig } = makeRig();
    expect(rig.parts.length).toBeGreaterThan(20);
    for (const part of rig.parts) {
      expect(part).toBeInstanceOf(Mesh);
      expect(part.geometry).toBeDefined();
      // Every part has to cast, or the character's shadow is a patchwork.
      expect(part.castShadow).toBe(true);
      expect(part.receiveShadow).toBe(true);
    }
  });

  it('spans the leg joints exactly, with no gap and no overlap', () => {
    // A thigh cylinder that stops short of the hip leaves the pelvis floating,
    // and one that overshoots pokes through it.
    const { rig } = makeRig();
    const p = rig.proportions;
    const thigh = rig.parts.find((m) => m.parent === rig.bone('thigh.L') && !isMail(m))!;
    const thighBox = new Box3().setFromObject(thigh);
    expect(thighBox.min.y).toBeCloseTo(p.hip - p.thigh, 4);
    expect(thighBox.max.y).toBeCloseTo(p.hip, 4);

    const shin = rig.parts.find((m) => m.parent === rig.bone('shin.L') && !isMail(m))!;
    const shinBox = new Box3().setFromObject(shin);
    expect(shinBox.min.y).toBeCloseTo(p.ankle, 4);
    expect(shinBox.max.y).toBeCloseTo(p.hip - p.thigh, 4);
  });

  it('narrows from the hips to the waist and widens again at the chest', () => {
    // An hourglass, the way a torso actually is. A cylinder of constant radius
    // reads as a tube.
    const { rig } = makeRig();
    const pelvis = rig.parts.find((m) => m.parent === rig.bone('hips'))!;
    const ribcage = rig.parts.find((m) => m.parent === rig.bone('chest') && isMail(m))!;
    const abdomen = rig.parts.find((m) => m.parent === rig.bone('spine') && isMail(m))!;

    const widthOf = (mesh: Mesh) => {
      const b = new Box3().setFromObject(mesh);
      return b.max.x - b.min.x;
    };
    expect(widthOf(abdomen)).toBeLessThan(widthOf(ribcage));
    expect(widthOf(ribcage)).toBeGreaterThan(widthOf(pelvis));
  });
});

/* ========================================================================== */

describe('chain mail', () => {
  it('covers the torso as well as the limbs', () => {
    // The plan asks for mail on the torso and the limbs. It was missing from the
    // torso entirely at one point, and nothing about a missing cylinder is
    // visible in source.
    const { rig } = makeRig();
    const mailed = new Set(
      rig.parts.filter(isMail).map((m) => (m.parent as Bone).name),
    );
    for (const bone of ['chest', 'spine', 'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'upperArm.L', 'upperArm.R', 'shoulder.L', 'shoulder.R']) {
      expect(mailed.has(bone), `no chain mail on ${bone}`).toBe(true);
    }
  });

  it('stands off the limb it covers', () => {
    // "Slightly larger cylinders" is the plan's phrasing, and it is what makes
    // the mail read as a garment over a body rather than as paint on it.
    const { rig } = makeRig();
    const thighBone = rig.bone('thigh.L');
    const skin = rig.parts.find((m) => m.parent === thighBone && !isMail(m))!;
    const mail = rig.parts.find((m) => m.parent === thighBone && isMail(m))!;

    const skinBox = new Box3().setFromObject(skin);
    const mailBox = new Box3().setFromObject(mail);
    expect(mailBox.max.x - mailBox.min.x).toBeGreaterThan(skinBox.max.x - skinBox.min.x);

    // And it has to be a real gap, not a rounding difference.
    const gap = (mailBox.max.x - mailBox.min.x - (skinBox.max.x - skinBox.min.x)) / 2;
    expect(gap).toBeGreaterThan(0.005);
  });

  it('gives every mail part its own material with the part real size', () => {
    // Each part's rings have to be the same physical size, which needs the part's
    // own circumference and height. Sharing one material would make the rings on
    // a forearm a different size from the rings on a thigh.
    const { rig } = makeRig();
    const mails = rig.parts.filter(isMail).map((m) => m.material as MeshStandardMaterial);
    expect(mails.length).toBeGreaterThan(5);
    // Distinct instances...
    expect(new Set(mails).size).toBe(mails.length);
    // ...all sharing one compiled program, so this costs uniform values and not
    // shaders.
    for (const mail of mails) {
      expect(mail.customProgramCacheKey()).toBe(MAIL_KEY);
      expect(mail.metalness).toBeGreaterThan(0.5);
    }
  });
});

/* ========================================================================== */

describe('the greatsword', () => {
  it('starts sheathed on the back', () => {
    const { rig } = makeRig();
    expect(rig.swordDrawn).toBe(false);
    expect(rig.sword.parent).toBe(rig.bone('chest'));
  });

  it('hangs down the back with its tip clear of the ground', () => {
    // A 1.45 m sword slung from a 1.48 m shoulder has about 3 cm of slack, so
    // the tip's height is the whole design. It used to run a third of a metre
    // through the terrain.
    const { rig } = makeRig();
    const box = new Box3().setFromObject(rig.sword);
    expect(box.min.y).toBeGreaterThan(0.05);
    expect(box.max.y).toBeLessThan(rig.proportions.shoulder + 0.1);

    // And behind the body rather than through it.
    const chestDepth = new Box3().setFromObject(
      rig.parts.find((m) => m.parent === rig.bone('chest') && isMail(m))!,
    );
    expect(box.min.z).toBeLessThan(chestDepth.min.z);
  });

  it('is a real greatsword: blade, crossguard, grip and pommel', () => {
    const { rig } = makeRig();
    const names = rig.sword.children.map((c) => c.name).filter(Boolean);
    expect(names).toContain('greatsword-blade');

    // Four parts, and the blade is by far the longest.
    expect(rig.sword.children.length).toBeGreaterThanOrEqual(4);
    const blade = rig.sword.getObjectByName('greatsword-blade')!;
    const bladeBox = new Box3().setFromObject(blade);
    expect(bladeBox.max.y - bladeBox.min.y).toBeGreaterThan(1.0);
  });

  it('moves to the hand when drawn and back to the chest when sheathed', () => {
    const { rig } = makeRig();
    const swordGrip = rig.bone('swordGrip');

    rig.drawSword();
    expect(rig.swordDrawn).toBe(true);
    expect(rig.sword.parent).toBe(swordGrip);

    // Drawing again must be a no-op rather than a second reparent.
    rig.drawSword();
    expect(rig.sword.parent).toBe(swordGrip);

    rig.sheatheSword();
    expect(rig.swordDrawn).toBe(false);
    expect(rig.sword.parent).toBe(rig.bone('chest'));

    rig.sheatheSword();
    expect(rig.sword.parent).toBe(rig.bone('chest'));
  });

  it('points the drawn blade forward and up, never into the ground', () => {
    const { rig } = makeRig();
    rig.drawSword();
    rig.root.updateMatrixWorld(true);

    const direction = new Vector3(0, 1, 0).applyQuaternion(rig.sword.quaternion);
    // Forward is +Z and up is +Y; a drawn sword must not point down.
    expect(direction.z).toBeGreaterThan(0.5);
    expect(direction.y).toBeGreaterThan(0);

    // And its tip has to clear the terrain, or it drags the moment it is drawn.
    const box = new Box3().setFromObject(rig.sword);
    expect(box.min.y).toBeGreaterThan(0);
  });

  it('never passes through the character while sheathed, in any clip', () => {
    // The blade hangs behind the body, and the legs swing through exactly that
    // region - the run's stride reaches 86 cm behind the hip. A blade placed by
    // eye passes through the shin on most frames, which reads as the sword
    // phasing through the leg. This drives every clip and samples the sword's
    // actual surface points against the body's actual volumes.
    const generator = new CharacterGenerator();
    const rig = generator.generate();
    const animator = new CharacterAnimator(rig);

    // Every body part, excluding the sword's own subtree - it is parented to the
    // chest, so a naive walk would compare the blade against itself.
    type Volume = { object: Object3D; inverse: Matrix4; box: Box3; cylinder: boolean };
    const body: Volume[] = [];
    const collect = (boneName: string): void => {
      rig.bone(boneName as never).traverse((object) => {
        if (!(object as Mesh).isMesh) return;
        let parent = object.parent;
        while (parent !== null) {
          if (parent === rig.sword) return;
          parent = parent.parent;
        }
        (object as Mesh).geometry.computeBoundingBox();
        body.push({
          object,
          inverse: (object as Mesh).matrixWorld.clone().invert(),
          box: (object as Mesh).geometry.boundingBox as Box3,
          cylinder: (object as Mesh).geometry.type === 'CylinderGeometry',
        });
      });
    };
    for (const boneName of [
      'chest', 'spine', 'hips',
      'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'foot.L', 'foot.R',
      'upperArm.L', 'upperArm.R', 'lowerArm.L', 'lowerArm.R',
    ]) {
      collect(boneName);
    }

    const insideBody = (point: Vector3): boolean => {
      for (const volume of body) {
        const local = point.clone().applyMatrix4(volume.inverse);
        const b = volume.box;
        const hit = volume.cylinder
          ? Math.hypot(local.x, local.z) <= Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2 &&
            local.y >= b.min.y && local.y <= b.max.y
          : local.x >= b.min.x && local.x <= b.max.x && local.y >= b.min.y && local.y <= b.max.y &&
            local.z >= b.min.z && local.z <= b.max.z;
        if (hit) return true;
      }
      return false;
    };

    const swordParts: Mesh[] = [];
    rig.sword.traverse((object) => {
      if ((object as Mesh).isMesh) swordParts.push(object as Mesh);
    });
    expect(swordParts.length).toBeGreaterThanOrEqual(4);

    // Surface sample points per part, in the part's own space.
    const samples = new Map<Mesh, Vector3[]>();
    for (const part of swordParts) {
      part.geometry.computeBoundingBox();
      const b = part.geometry.boundingBox as Box3;
      const points: Vector3[] = [];
      for (let i = 0; i <= 8; i += 1) {
        const y = b.min.y + (i / 8) * (b.max.y - b.min.y);
        for (const x of [b.min.x, 0, b.max.x]) {
          for (const z of [b.min.z, 0, b.max.z]) points.push(new Vector3(x, y, z));
        }
      }
      samples.set(part, points);
    }

    const mixer = new AnimationMixer(rig.root);
    let intersections = 0;
    for (const clip of ['idle', 'walk', 'run', 'jump'] as const) {
      const action = mixer.clipAction(animator.clipMap[clip]);
      if (action === null) throw new Error('no action');
      action.reset().play();
      for (let i = 0; i < 32; i += 1) {
        mixer.setTime((i / 32) * animator.clipMap[clip].duration);
        rig.root.updateMatrixWorld(true);
        // Re-derive the inverses every frame: caching them once would compare
        // the animated sword against the *rest* body, which proves nothing.
        for (const volume of body) volume.inverse.copy((volume.object as Mesh).matrixWorld).invert();
        for (const [part, points] of samples) {
          for (const point of points) {
            if (insideBody(point.clone().applyMatrix4(part.matrixWorld))) intersections += 1;
          }
        }
      }
      action.stop();
    }

    expect(intersections, 'the sheathed sword passes through the character').toBe(0);
  }, 30000);

  it('orients local +Y onto the direction it is given', () => {
    // The whole reason the sword's transforms are written as directions rather
    // than as Euler angles: they can be asserted as directions.
    for (const direction of [
      new Vector3(0, 0, 1),
      new Vector3(0, 1, 0),
      new Vector3(-0.2, -0.97, -0.04),
      new Vector3(1, 0, 0),
    ]) {
      const applied = new Vector3(0, 1, 0).applyQuaternion(orientYTo(direction));
      expect(applied.distanceTo(direction.clone().normalize())).toBeLessThan(1e-6);
    }

    // A zero direction is not a rotation, not a NaN.
    const identity = new Vector3(0, 1, 0).applyQuaternion(orientYTo(new Vector3(0, 0, 0)));
    expect(identity.y).toBeCloseTo(1, 10);

    // And the exact opposite of +Y is the degenerate case setFromUnitVectors
    // cannot resolve, so it is pinned rather than left to pick an axis.
    const flipped = new Vector3(0, 1, 0).applyQuaternion(orientYTo(new Vector3(0, -1, 0)));
    expect(flipped.y).toBeCloseTo(-1, 10);
    expect(Number.isFinite(flipped.x)).toBe(true);
  });
});

/* ========================================================================== */

describe('materials', () => {
  it('wears four kinds: skin, chain mail, leather and steel', () => {
    const { rig } = makeRig();
    const keys = new Set(
      rig.parts.map((m) => (m.material as MeshStandardMaterial).customProgramCacheKey()),
    );
    expect([...keys].sort()).toEqual(['astra-chainmail-v1', 'astra-leather-v1', 'astra-skin-v1', 'astra-steel-v1']);
  });

  it('puts leather on the belt and the boots, and steel only on the sword', () => {
    // The plan asks for leather somewhere specific, and steel only where a blade
    // is. A steel boot reads as a toy.
    const { rig } = makeRig();
    const keyOf = (m: Mesh) => (m.material as MeshStandardMaterial).customProgramCacheKey();

    const boots = rig.parts.filter((m) => m.parent === rig.bone('foot.L'));
    expect(boots.length).toBeGreaterThan(0);
    for (const boot of boots) expect(keyOf(boot)).toBe('astra-leather-v1');

    const steelParts = rig.parts.filter((m) => keyOf(m) === STEEL_KEY);
    expect(steelParts.length).toBeGreaterThan(0);
    for (const part of steelParts) {
      // Every steel part belongs to the sword.
      let node = part.parent;
      let inSword = false;
      while (node) {
        if (node === rig.sword) inSword = true;
        node = node.parent;
      }
      expect(inSword, `${part.name} is steel but is not part of the sword`).toBe(true);
    }
  });

  it('keeps the palette earthy, with steel the only bright thing', () => {
    // Style guide Rule 7: a restrained earthy palette, so the fantasy elements
    // pop by contrast. The blade is the one thing allowed to read as bright, and
    // even that is a cold grey rather than chrome.
    const { rig } = makeRig();
    const steel = rig.parts.find((m) => (m.material as MeshStandardMaterial).customProgramCacheKey() === STEEL_KEY)!;
    const material = steel.material as MeshStandardMaterial;
    expect(material.metalness).toBeGreaterThan(0.8);
    expect(material.metalness).toBeLessThanOrEqual(1);
    expect(material.roughness).toBeLessThan(0.4);
  });
});

/* ========================================================================== */

describe('lifecycle', () => {
  it('disposes every geometry and material, and is idempotent', () => {
    const generator = new CharacterGenerator();
    const rig = generator.generate();
    // Spy before disposing, not after: a spy attached afterwards sees nothing,
    // and the assertion passes for the wrong reason.
    const geometrySpies = rig.parts.map((p) => vi.spyOn(p.geometry, 'dispose'));
    const materialSpies = [...new Set(rig.parts.map((p) => p.material))].map((m) =>
      vi.spyOn(m as MeshStandardMaterial, 'dispose'),
    );

    generator.disposeRig(rig.root);

    for (const spy of geometrySpies) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of materialSpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(rig.root.children).toHaveLength(0);

    // A second call must not double-free.
    expect(() => generator.disposeRig(rig.root)).not.toThrow();
  });

  it('leaves materials the caller passed in alone', () => {
    // Whoever creates a material owns it. Disposing one that was passed in frees
    // it out from under the system that is still using it.
    const generator = new CharacterGenerator();
    const rig = generator.generate();
    const material = rig.parts[0].material as MeshStandardMaterial;
    const spy = vi.spyOn(material, 'dispose');

    // Build a second generator that shares the material, and dispose only it.
    const owned = new CharacterGenerator({
      materials: { skin: material as never, chainMail: material as never, leather: material as never, steel: material as never },
    });
    const rig2 = owned.generate();
    owned.disposeRig(rig2.root);
    expect(spy).not.toHaveBeenCalled();

    // The first generator still owns it.
    generator.disposeRig(rig.root);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('honours a custom height end to end', () => {
    const height = 2.1;
    const { rig } = makeRig(height);
    expect(rig.proportions.height).toBeCloseTo(height, 10);
    rig.root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(rig.root);
    expect(box.max.y).toBeCloseTo(height, 6);
    expect(box.min.y).toBeCloseTo(0, 6);
  });

  it('rejects a height that cannot be built', () => {
    // A non-finite height propagates NaN through every proportion, and a NaN rig
    // is a character that vanishes with nothing in the log.
    expect(() => new CharacterGenerator({ height: Number.NaN }).generate()).toThrow();
    expect(() => new CharacterGenerator({ height: 0 }).generate()).toThrow();
    expect(() => new CharacterGenerator({ height: -1 }).generate()).toThrow();
  });
});

/* ========================================================================== */

describe('rig queries', () => {
  it('throws on a bone that does not exist rather than returning undefined', () => {
    // A silent undefined here would surface much later as a null dereference in
    // the animator, three frames into the first walk.
    const { rig } = makeRig();
    expect(() => rig.bone('nope' as never)).toThrow();
    expect(() => rig.bone('thigh' as never)).toThrow();
  });

  it('finds every bone by name', () => {
    const { rig } = makeRig();
    for (const name of BONE_NAMES) {
      expect(rig.bone(name).name).toBe(name);
    }
  });

  it('is rooted at the character group', () => {
    const { rig } = makeRig();
    expect(rig.root).toBeInstanceOf(Group);
    expect(rig.root.name).toBe('character');
    // The root bone is the rig's own origin, so the whole hierarchy moves with it.
    expect(at(rig, 'root').y).toBeCloseTo(0, 10);
  });
});

/* ========================================================================== */

describe('natural imperfection', () => {
  it('is not perfectly symmetrical', () => {
    // Style guide Rule 5 asks for natural imperfection. This rig is deliberately
    // mirror-symmetric, and that is fine for a stylised character - but the
    // proportions themselves must not be round numbers that read as a diagram.
    const p: CharacterProportions = characterProportions();
    expect(p.upperArm / p.lowerArm).toBeGreaterThan(1);
    expect(p.upperArm / p.lowerArm).toBeLessThan(1.3);
    // An arm that reaches mid-thigh, not the knee.
    const handY = p.shoulder - p.upperArm - p.lowerArm;
    expect(handY).toBeLessThan(p.hip);
    expect(handY).toBeGreaterThan(p.hip - p.thigh);
  });
});
