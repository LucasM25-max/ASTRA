/**
 * FungusGenerator.ts - ASTRA procedural world
 * =============================================================================
 * The corruption's own geometry: mushroom clusters, the fungal shelves that
 * bracket a dying trunk, glowing spore pods, and the dead organic matter the
 * fouled water leaves on its banks.
 *
 * Pure typed-array geometry and pure placement data, with no Three.js import,
 * exactly as `TreeGenerator` and `FoliageGenerator` are - so the whole module
 * runs under Vitest in Node and a broken shape is a failing assertion rather
 * than a black screen.
 *
 * The local frame
 * ---------------
 *   +Y   up the stalk, out from the trunk the shelf grows on
 *   +X   the shelf's reach, and the carrion's flank
 *   y=0  the ground, for anything standing on it
 *
 * The shelf is the one exception: it is rooted at radius zero about +Y, because
 * a bracket's root has to sit *inside* the trunk it grows from and the caller
 * knows that trunk's radius. Placing it at the surface is one matrix, and it
 * means one geometry serves every trunk in the forest.
 *
 * Why these shapes
 * ----------------
 *   mushroom   a cluster of two to five, each a tapered stalk under a
 *              surface of revolution. The cap's profile is one of three
 *              curves - cone, dome, flat - because a forest of identical
 *              cones reads as one asset stamped five hundred times, which is
 *              the "generic asset-store appearance" the style guide exists to
 *              avoid. The underside is a shallow funnel, not a flat disc:
 *              the gills are the part the player sees when they crouch.
 *   shelf      a flattened torus segment. `thickness` is deliberately a
 *              fraction of `reach`, so the bracket reads as a plate rather
 *              than as a donut. Two or three of them stack up a trunk.
 *   pod        a thin stalk and one displaced icosphere. The globe is the
 *              emissive part, and it is small on purpose: the plan asks for
 *              "small glowing spheres", and a pod the size of a fist stops
 *              being spore-like and starts being a lamp.
 *   carrion    a squashed ellipsoid with a tail fin, lying on the bank. The
 *              plan's "dead fish", and the only kind that is not a plant.
 *   rot        a low, wide, heavily displaced blob. Darker than everything
 *              else in the forest, because rot is what is left after the
 *              colour has gone out of a thing.
 *
 * Palette
 * -------
 * Sickly green and bruised purple, per the plan. Both are held in the vertex
 * colours rather than in the material so that one material can serve every
 * kind and a cluster can vary within itself: the material's job is the
 * emissive glow and the gill detail, not the hue.
 *
 * Placement
 * ---------
 * `scatterFungus` rejection-samples a disc against the corruption field. The
 * acceptance probability *is* the corruption, so fungus appears exactly where
 * the corruption is and nowhere else - which is what makes the fouled stream
 * read as a gradient rather than as a ring. Nothing grows in the water itself,
 * and nothing grows on a slope it would slide off.
 * =============================================================================
 */

import { createRng, SimplexNoise2D } from './NoiseLibrary';
import type { MeshData } from './TreeGenerator';
import { icosphereData } from './TreeGenerator';

/**
 * The five kinds of corruption geometry.
 *
 * The first three are the plan's fungus; the last two are the dead organic
 * matter the plan attaches to the same system. They share one module because
 * they share a scatter, a field and a material family, and splitting them
 * would mean two near-identical placement passes over the same patch.
 */
export type FungusKind = 'mushroom' | 'shelf' | 'pod' | 'carrion' | 'rot';

/** Every kind, in the order the corruption system builds its meshes. */
export const FUNGUS_KINDS: readonly FungusKind[] = ['mushroom', 'shelf', 'pod', 'carrion', 'rot'];

/** Radius of the ground a mushroom cluster covers, in metres. */
export const MUSHROOM_CLUSTER_RADIUS = 0.22;

/** How far a shelf reaches out from the trunk, in metres. */
export const SHELF_REACH = 0.34;

/** Thickness of a shelf, in metres. A fraction of the reach, deliberately. */
export const SHELF_THICKNESS = 0.045;

/**
 * How deep a shelf's root sits inside the trunk it grows from, in metres.
 *
 * Not zero, and not for tidiness: a cross-section that reaches radius zero
 * makes the shelf a spindle torus, whose parametrisation collapses where the
 * ellipse touches the axis and whose normal flips through that point. Four
 * centimetres is inside any trunk the forest grows and keeps the surface
 * smooth all the way round.
 */
export const SHELF_ROOT = 0.04;

/** Height of a spore pod's stalk at scale 1, in metres. */
export const POD_HEIGHT = 0.14;

/** Radius of a spore pod's globe at scale 1, in metres. */
export const POD_RADIUS = 0.038;

/** Length of a dead fish at scale 1, in metres. */
export const CARRION_LENGTH = 0.42;

/** Radius of a rot lump at scale 1, in metres. */
export const ROT_RADIUS = 0.2;

/** Rings around a mushroom stalk, including base and top. */
const STALK_RINGS = 3;

/** Radial segments around a mushroom stalk. */
const STALK_RADIAL = 6;

/** Rings along a mushroom cap's profile, pole to rim. */
const CAP_RINGS = 4;

/** Radial segments around a mushroom cap. */
const CAP_RADIAL = 10;

/** Rings around a shelf's cross-section. */
const SHELF_CROSS = 6;

/** Segments along a shelf's arc. */
const SHELF_ARC = 10;

/** A profile of revolution: radius from the axis, and height. */
interface ProfilePoint {
  r: number;
  y: number;
}

/** The three cap silhouettes. */
export type CapShape = 'cone' | 'dome' | 'flat';

/** Every cap shape, so the generator can pick one at random. */
export const CAP_SHAPES: readonly CapShape[] = ['cone', 'dome', 'flat'];

/**
 * Triangles each kind costs per instance, at the WORST case.
 *
 * A cluster holds two to five mushrooms and a trunk carries two or three
 * shelves, so the count genuinely varies with the seed - which is the whole
 * point of the variation, and the reason this is a maximum rather than a
 * single number. The budget built from it therefore never underestimates.
 *
 * Measured, not written down: `fungusTriangleCounts()` reports what the
 * generators actually produced for a given seed, and a test asserts both that
 * every seed in a spread comes in at or under these numbers and that the
 * maximum is actually reached, so the constant cannot silently drift upward.
 * A hand-maintained count drifts the moment a ring is added to a stalk.
 */
export const FUNGUS_TRIANGLES: Record<FungusKind, number> = {
  mushroom: 720,
  shelf: 396,
  pod: 344,
  carrion: 321,
  rot: 640,
};

/**
 * Triangles the generators produce for one seed.
 *
 * Lower than `FUNGUS_TRIANGLES` for most seeds, because a cluster's mushroom
 * count and a trunk's shelf count are drawn from the seed.
 */
export function fungusTriangleCounts(seed = 1): Record<FungusKind, number> {
  const g = generateFungusGeometry(seed);
  return {
    mushroom: g.mushroom.indices.length / 3,
    shelf: g.shelf.indices.length / 3,
    pod: g.pod.indices.length / 3,
    carrion: g.carrion.indices.length / 3,
    rot: g.rot.indices.length / 3,
  };
}

/**
 * Instances of each kind in one patch.
 *
 * The mushrooms and the pods are the two the player actually reads, so they get
 * the bulk of the budget. `carrion` is the rarest thing in the forest on
 * purpose: a bank littered with dead fish stops being eerie and starts being a
 * joke.
 */
export const DEFAULT_FUNGUS_COUNTS: Record<FungusKind, number> = {
  mushroom: 900,
  shelf: 260,
  pod: 340,
  carrion: 70,
  rot: 240,
};

/* -------------------------------------------------------------------------- */
/* geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A cluster of two to five mushrooms.
 *
 * Each mushroom is built independently and appended, so a cluster is a closed
 * shell of closed shells. That matters for the winding and volume tests, and
 * it matters for the material: an open shell lit from inside shows its own
 * back faces through the gap.
 */
export function generateMushroomCluster(seed: number, variant = 0): MeshData {
  const rng = createRng(hash(seed, variant, 0x4d55_5348));
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const count = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i++) {
    // Square-root distributed over the cluster's disc, so the mushrooms are
    // spread through it rather than clumped at its centre.
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * MUSHROOM_CLUSTER_RADIUS;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;

    const stalkHeight = 0.07 + rng() * 0.26;
    const stalkBase = 0.01 + rng() * 0.016;
    const stalkTop = stalkBase * (0.55 + rng() * 0.25);
    const capRadius = stalkBase * (2.6 + rng() * 1.9);
    const capHeight = capRadius * (0.45 + rng() * 0.35);
    const shape = CAP_SHAPES[Math.floor(rng() * CAP_SHAPES.length)];
    // A cluster leans as a whole, not mushroom by mushroom: they grow out of
    // one patch of rot and share its tilt.
    const tilt = (rng() - 0.5) * 0.22;
    const tiltDir = rng() * Math.PI * 2;

    appendMushroom(
      { positions, normals, colors, indices },
      { x, z, stalkHeight, stalkBase, stalkTop, capRadius, capHeight, shape, tilt, tiltDir },
      rng,
    );
  }

  return { positions: f32(positions), normals: f32(normals), colors: f32(colors), indices: u32(indices) };
}

interface MushroomParams {
  x: number;
  z: number;
  stalkHeight: number;
  stalkBase: number;
  stalkTop: number;
  capRadius: number;
  capHeight: number;
  shape: CapShape;
  tilt: number;
  tiltDir: number;
}

/** One mushroom: a tapered stalk under a revolved cap, with a funnel underside. */
function appendMushroom(
  out: Sink,
  p: MushroomParams,
  rng: () => number,
): void {
  const cos = Math.cos(p.tiltDir);
  const sin = Math.sin(p.tiltDir);
  const cosT = Math.cos(p.tilt);
  const sinT = Math.sin(p.tilt);

  // Lean about a horizontal axis through the mushroom's own base, so the
  // whole thing tips rather than shears. Rodrigues' rotation about
  // `axis = (-sin(dir), 0, cos(dir))` by `tilt`, then translated to the base.
  //
  // Written out rather than delegated to a matrix because it runs once per
  // vertex of every mushroom in every cluster, and a 4x4 multiply for a
  // rotation about one known axis is four times the arithmetic it needs.
  const lean = (x: number, y: number, z: number): [number, number, number] => {
    const wv = -sin * x + cos * z; // axis . v
    const k = 1 - cosT;
    return [
      p.x + x * cosT - cos * y * sinT - sin * wv * k,
      y * cosT,
      p.z + z * cosT - sin * y * sinT + cos * wv * k,
    ];
  };

  // The stalk. Buried a little below the ground so no gap shows where it
  // meets the forest floor, and capped at the top so the shell is closed
  // under the cap.
  const stalkProfile: ProfilePoint[] = [];
  for (let i = 0; i < STALK_RINGS; i++) {
    const t = i / (STALK_RINGS - 1);
    stalkProfile.push({
      r: p.stalkBase + (p.stalkTop - p.stalkBase) * t,
      // Starts below y=0 and reaches the cap's underside plane.
      y: -p.stalkBase * 1.5 + (p.stalkHeight + p.stalkBase * 1.5) * t,
    });
  }

  const capBase = p.stalkHeight;
  const gill = p.capHeight * 0.28;

  // The cap's own profile, RIM TO POLE, in the three silhouettes.
  //
  // The traversal order is not cosmetic. `revolve` derives each normal as the
  // profile tangent turned a quarter turn, and that is only the *outward*
  // normal when the whole closed cross-section is walked anticlockwise in the
  // (radius, height) plane - which for a cap means down the outside from the
  // rim to the pole, then back along the underside. Walking it pole-to-rim
  // instead produces a cap whose normals all point into its own interior, and
  // a crown that lights itself from inside.
  const capProfile: ProfilePoint[] = [];
  for (let i = 0; i < CAP_RINGS; i++) {
    const t = 1 - i / (CAP_RINGS - 1);
    let r: number;
    let y: number;
    if (p.shape === 'cone') {
      // A straight cone: widest linear growth, constant slope.
      r = p.capRadius * t;
      y = capBase + p.capHeight * (1 - t);
    } else if (p.shape === 'dome') {
      // A hemisphere, so the slope eases to nothing at the apex.
      r = p.capRadius * Math.sin(t * Math.PI * 0.5);
      y = capBase + p.capHeight * Math.cos(t * Math.PI * 0.5);
    } else {
      // Broad and low: the radius arrives before the height goes.
      r = p.capRadius * Math.sqrt(t);
      y = capBase + p.capHeight * (1 - t * t * t);
    }
    capProfile.push({ r: Math.max(r, 1e-4), y });
  }

  // The underside, from the stalk back out to the rim. Also anticlockwise
  // around the cross-section, which is what makes its normals face down and
  // out rather than up and in - and a funnel that shades like a dome is the
  // single most obvious way to make a mushroom look like a ball on a stick.
  const underProfile: ProfilePoint[] = [];
  for (let i = 0; i < CAP_RINGS; i++) {
    const t = 1 - i / (CAP_RINGS - 1);
    underProfile.push({
      r: p.capRadius + (p.stalkTop - p.capRadius) * Math.pow(t, 0.7),
      y: capBase - gill * Math.sin(t * Math.PI * 0.5),
    });
  }

  // One hue per mushroom, wandering between the sickly green and the bruised
  // purple, so no two clusters in a patch are the same colour.
  const hue = rng();
  const capHigh = mix(COLOR_CAP_HIGH, COLOR_CAP_BRUISED, hue);
  const capLow = mix(COLOR_CAP_LOW, COLOR_CAP_BRUISED_LOW, hue);

  revolve(out, stalkProfile, STALK_RADIAL, (pt) => [
    COLOR_STALK[0] * (0.85 + 0.15 * pt.r / Math.max(p.stalkBase, 1e-6)),
    COLOR_STALK[1] * (0.85 + 0.15 * pt.r / Math.max(p.stalkBase, 1e-6)),
    COLOR_STALK[2] * (0.85 + 0.15 * pt.r / Math.max(p.stalkBase, 1e-6)),
  ], lean);

  revolve(out, capProfile, CAP_RADIAL, (pt) => {
    // Brighter at the apex, darker at the rim, and the rim curls under into
    // shade. A flat ramp across the cap reads as a painted ball.
    const up = clamp01(pt.y - capBase) / Math.max(p.capHeight, 1e-6);
    return mix(capLow, capHigh, smooth01(up * 0.85 + 0.15));
  }, lean);

  revolve(out, underProfile, CAP_RADIAL, (pt) => {
    // The gills: paler and more yellow where the surface faces down and in,
    // darker in the funnel's throat.
    const depth = clamp01((capBase - pt.y) / Math.max(gill, 1e-6));
    return mix(COLOR_GILL, COLOR_GILL_DEEP, depth);
  }, lean);
}

/**
 * A stack of two or three flattened torus segments, rooted at radius zero
 * about +Y.
 *
 * The cross-section is a full ellipse swept through a partial arc, so the
 * bracket is a closed bent tube: half of it is inside the trunk the caller
 * places it against, which is exactly where a bracket's root belongs. The two
 * ends of the arc are capped with flat elliptical discs.
 */
export function generateFungalShelf(seed: number, variant = 0): MeshData {
  const rng = createRng(hash(seed, variant, 0x53_4845));
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const out: Sink = { positions, normals, colors, indices };

  const layers = 2 + Math.floor(rng() * 2);
  const hue = rng();
  const outer = mix(COLOR_SHELF, COLOR_SHELF_BRUISED, hue);
  const inner = mix(COLOR_SHELF_DEEP, COLOR_SHELF_BRUISED_DEEP, hue);

  for (let layer = 0; layer < layers; layer++) {
    // Each shelf sits above the last, and reaches a little further: growth
    // accumulates outward as it climbs.
    const t = layer / Math.max(layers - 1, 1);
    const reach = SHELF_REACH * (0.62 + 0.38 * t);
    const thickness = SHELF_THICKNESS * (0.7 + 0.3 * t);
    const y = t * SHELF_REACH * 0.9;
    const arcStart = rng() * Math.PI * 2;
    const arcSpan = 1.5 + rng() * 1.3;

    appendShelf(out, {
      reach,
      thickness,
      y,
      arcStart,
      arcSpan,
      outer,
      inner,
      rng,
    });
  }

  return { positions: f32(positions), normals: f32(normals), colors: f32(colors), indices: u32(indices) };
}

interface ShelfParams {
  reach: number;
  thickness: number;
  y: number;
  arcStart: number;
  arcSpan: number;
  outer: [number, number, number];
  inner: [number, number, number];
  rng: () => number;
}

/** One flattened torus segment. */
function appendShelf(out: Sink, p: ShelfParams): void {
  // A RING segment, not a spindle. The cross-section is an ellipse centred at
  // `root + reach/2` from the axis, with radial semi-axis `reach/2` and
  // vertical semi-axis `thickness/2`:
  //
  //   r(v) = root + (reach/2)(1 + cos v)
  //   y(v) = y     + (thickness/2) sin v
  //
  // so v=0 is the outer lip, v=PI is the root against the trunk, and v=PI/2
  // and 3PI/2 are the top and the underside. `root` is never allowed to reach
  // zero: a cross-section centred ON the axis is a spindle torus, its
  // parametrisation collapses wherever the ellipse touches the axis, and the
  // surface normal flips through that point - which shows up as half the
  // triangles shading backwards and is invisible in review because the other
  // half looks fine.
  const root = SHELF_ROOT;
  const halfReach = p.reach * 0.5;
  const halfThick = p.thickness * 0.5;
  const base = out.positions.length / 3;

  // d(r)/dv and d(y)/dv, the two numbers the analytic normal is built from.
  const dr = (v: number): number => -halfReach * Math.sin(v);
  const dy = (v: number): number => halfThick * Math.cos(v);

  for (let ring = 0; ring <= SHELF_CROSS; ring++) {
    const v = (ring / SHELF_CROSS) * Math.PI * 2;
    const cv = Math.cos(v);
    const sv = Math.sin(v);
    const radius = root + halfReach * (1 + cv);
    const dRv = dr(v);
    const dYv = dy(v);
    for (let seg = 0; seg <= SHELF_ARC; seg++) {
      const theta = p.arcStart + (seg / SHELF_ARC) * p.arcSpan;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      out.positions.push(radius * ct, p.y + halfThick * sv, radius * st);
      // cross(dP/dv, dP/dtheta), with the positive factor `radius` divided
      // out: the direction is all that is wanted, and the length is restored
      // by the normalisation below.
      const nx = dYv * ct;
      const ny = -dRv;
      const nz = dYv * st;
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-12) {
        out.normals.push(nx / len, ny / len, nz / len);
      } else {
        // Only reachable if both derivatives vanish, which needs reach and
        // thickness to be zero. Falling back to up keeps the vertex lit
        // instead of producing a NaN that spreads through the normal buffer.
        out.normals.push(0, 1, 0);
      }
      // The underside is the shaded part: a shelf seen from below is the
      // common case, and a flat colour there reads as cardboard.
      const under = clamp01(-sv * 0.5 + 0.5);
      out.colors.push(...mix(p.outer, p.inner, under));
    }
  }

  for (let ring = 0; ring < SHELF_CROSS; ring++) {
    for (let seg = 0; seg < SHELF_ARC; seg++) {
      const a0 = base + ring * (SHELF_ARC + 1) + seg;
      const b0 = a0 + 1;
      const c0 = a0 + SHELF_ARC + 1;
      const d0 = c0 + 1;
      pushQuad(out.indices, a0, b0, c0, d0, false);
    }
  }

  // Cap both ends of the arc with flat elliptical discs.
  for (const end of [0, 1]) {
    const theta = p.arcStart + end * p.arcSpan;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    // The start cap faces back along the arc, the end cap faces forward. Both
    // are the same ring of points; only the normal and the winding differ, and
    // getting the normal backwards lights the cap from inside - which on a
    // shelf is the whole visible face.
    //
    // The normal is the arc's TANGENT, not its radial. The disc lies in the
    // plane spanned by radial(theta) and up, so the only direction
    // perpendicular to it is tangent(theta) = (-sin, 0, cos). Pointing it at
    // the radial instead leaves it lying flat in the disc's own plane, which
    // lights the cap edge-on and shows it as a black sliver - and it is
    // exactly the kind of error that survives review, because the tube around
    // it still looks right.
    const facing = end === 0 ? -1 : 1;
    const pole = out.positions.length / 3;
    out.positions.push((root + halfReach) * ct, p.y, (root + halfReach) * st);
    out.normals.push(-st * facing, 0, ct * facing);
    out.colors.push(...p.inner);

    const ringBase = out.positions.length / 3;
    for (let ring = 0; ring <= SHELF_CROSS; ring++) {
      const v = (ring / SHELF_CROSS) * Math.PI * 2;
      const radius = root + halfReach * (1 + Math.cos(v));
      out.positions.push(radius * ct, p.y + halfThick * Math.sin(v), radius * st);
      out.normals.push(-st * facing, 0, ct * facing);
      out.colors.push(...mix(p.outer, p.inner, clamp01(Math.sin(v) * 0.5 + 0.5)));
    }

    for (let ring = 0; ring < SHELF_CROSS; ring++) {
      const i0 = ringBase + ring;
      const i1 = ringBase + ring + 1;
      if (end === 0) out.indices.push(pole, i1, i0);
      else out.indices.push(pole, i0, i1);
    }
  }
}

/**
 * A spore pod: a thin stalk under one displaced icosphere.
 *
 * The globe carries the emissive weight, so its vertex colours are pushed
 * brighter than anything else in the forest and the material adds the glow on
 * top. `warp` is low: a spore pod is smooth, and a lumpy one stops reading as
 * a pod.
 */
export function generateSporePod(seed: number, variant = 0): MeshData {
  // No RNG of its own: a spore pod's shape is one globe and one stalk, and
  // randomising either would make the emissive points in a corrupted grove
  // vary in size for no reason the player could read. The seed still varies
  // the globe's displacement, through the noise field.
  const noise = new SimplexNoise2D(seed * 31 + variant);
  const globe = icosphereData({
    centre: { x: 0, y: POD_HEIGHT, z: 0 },
    radius: POD_RADIUS,
    detail: 2,
    warp: 0.08,
    noise,
    color: COLOR_POD,
    colorTip: COLOR_POD_TIP,
  });

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  appendMesh({ positions, normals, colors, indices }, globe);

  // The stalk. Open at the base, where it is buried, and closed at the top
  // under the globe.
  const profile: ProfilePoint[] = [];
  const baseRadius = POD_RADIUS * 0.22;
  for (let i = 0; i < STALK_RINGS; i++) {
    const t = i / (STALK_RINGS - 1);
    profile.push({
      r: baseRadius * (1 - 0.55 * t),
      y: -baseRadius + POD_HEIGHT * t,
    });
  }
  revolve(
    { positions, normals, colors, indices },
    profile,
    STALK_RADIAL,
    () => [COLOR_POD_STALK[0], COLOR_POD_STALK[1], COLOR_POD_STALK[2]],
  );

  return { positions: f32(positions), normals: f32(normals), colors: f32(colors), indices: u32(indices) };
}

/**
 * A dead fish lying on the bank.
 *
 * A squashed ellipsoid with a tail fin. The squash is applied to the positions
 * *and* the normals, which is what `icosphereData`'s `scale` option does and
 * what a hand-rolled squash would get wrong: leaving the normals alone lights
 * the fish as though it were still a ball.
 */
export function generateCarrion(seed: number, variant = 0): MeshData {
  const rng = createRng(hash(seed, variant, 0x43_4152));
  const noise = new SimplexNoise2D(seed * 57 + variant + 11);
  const body = icosphereData({
    centre: { x: 0, y: 0, z: 0 },
    radius: 1,
    detail: 2,
    warp: 0.22,
    noise,
    color: COLOR_CARRION,
    colorTip: COLOR_CARRION_BELLY,
    scale: { x: 0.075, y: 0.032, z: CARRION_LENGTH * 0.5 },
  });

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  appendMesh({ positions, normals, colors, indices }, body);

  // The tail: two triangles, vertical, at the far end. A single flat card
  // reads as a fin from the side and as nothing from above, which is fine -
  // a fish on a bank is looked at from above.
  const tailZ = CARRION_LENGTH * 0.5;
  const tailBase = positions.length / 3;
  const tail = [
    [0, 0.06, tailZ * 0.94],
    [0, -0.03, tailZ * 0.94],
    [0, 0.01, tailZ * 1.5],
  ] as const;
  for (const [x, y, z] of tail) {
    positions.push(x, y, z);
    normals.push(0, 0, 1);
    colors.push(...COLOR_CARRION);
  }
  indices.push(tailBase, tailBase + 1, tailBase + 2);

  // A slight roll, so the fish is not lying perfectly flat on a bank that is
  // not perfectly flat either.
  const roll = (rng() - 0.5) * 0.5;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    const z = positions[i + 2];
    positions[i + 1] = y * cr - z * sr;
    positions[i + 2] = y * sr + z * cr;
    const ny = normals[i + 1];
    const nz = normals[i + 2];
    normals[i + 1] = ny * cr - nz * sr;
    normals[i + 2] = ny * sr + nz * cr;
  }

  return { positions: f32(positions), normals: f32(normals), colors: f32(colors), indices: u32(indices) };
}

/**
 * A lump of rot: a low, wide, heavily displaced icosphere, darker than
 * anything else on the forest floor.
 */
export function generateRot(seed: number, variant = 0): MeshData {
  const rng = createRng(hash(seed, variant, 0x52_4f54));
  const noise = new SimplexNoise2D(seed * 91 + variant + 3);
  const blob = icosphereData({
    centre: { x: 0, y: 0, z: 0 },
    radius: ROT_RADIUS,
    detail: 2,
    warp: 0.42,
    noise,
    color: COLOR_ROT,
    colorTip: COLOR_ROT_HIGH,
    scale: { x: 1, y: 0.52, z: 1 },
  });

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  appendMesh({ positions, normals, colors, indices }, blob);

  // Two or three smaller lumps beside it, so rot reads as a spreading patch
  // rather than as one stone.
  const extra = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < extra; i++) {
    const a = rng() * Math.PI * 2;
    const d = ROT_RADIUS * (0.4 + rng() * 0.7);
    appendMesh(
      { positions, normals, colors, indices },
      icosphereData({
        centre: { x: Math.cos(a) * d, y: 0, z: Math.sin(a) * d },
        radius: ROT_RADIUS * (0.34 + rng() * 0.4),
        detail: 1,
        warp: 0.4,
        noise,
        color: COLOR_ROT,
        colorTip: COLOR_ROT_HIGH,
        scale: { x: 1, y: 0.5, z: 1 },
      }),
    );
  }

  return { positions: f32(positions), normals: f32(normals), colors: f32(colors), indices: u32(indices) };
}

/** Every geometry the corruption system needs, generated once. */
export interface FungusGeometrySet {
  mushroom: MeshData;
  shelf: MeshData;
  pod: MeshData;
  carrion: MeshData;
  rot: MeshData;
}

/**
 * Build every fungus mesh.
 *
 * Called once at startup, not per frame: the meshes are shared by an
 * `InstancedMesh`, so the per-instance cost is a matrix and nothing else.
 */
export function generateFungusGeometry(seed = 1): FungusGeometrySet {
  return {
    mushroom: generateMushroomCluster(seed),
    shelf: generateFungalShelf(seed),
    pod: generateSporePod(seed),
    carrion: generateCarrion(seed),
    rot: generateRot(seed),
  };
}

/* -------------------------------------------------------------------------- */
/* placement                                                                  */
/* -------------------------------------------------------------------------- */

/** One instance of one kind of corruption geometry. */
export interface FungusInstance {
  kind: FungusKind;
  /** World position of the instance's origin. */
  x: number;
  y: number;
  z: number;
  /** Rotation about the world Y axis, radians. */
  rotationY: number;
  /** Uniform scale. */
  scale: number;
  /** Extra lean away from vertical, radians. */
  tilt: number;
  /** 0..1 colour variation, for the per-instance tint attribute. */
  variation: number;
  /**
   * 0..1 corruption at this instance's position.
   *
   * Carried on the instance rather than re-sampled by the material, so the
   * growth can scale with the corruption it grew in: a stage-3 mushroom is
   * visibly larger and more lurid than a stage-1 one, which is the style
   * guide's "corruption progression: subtle, visible, severe".
   */
  corruption: number;
}

/** What the scatter needs to know about the world. */
export interface FungusField {
  heightAt: (x: number, z: number) => number;
  /** Surface normal, unit length. Optional: without it, no slope rejection. */
  normalAt?: (x: number, z: number) => { x: number; y: number; z: number };
  /** 0..1 corruption intensity. Required: it is the acceptance probability. */
  corruptionAt: (x: number, z: number) => number;
}

export interface FungusScatterOptions {
  seed: number;
  /** Centre of the patch in world XZ. */
  centreX: number;
  centreZ: number;
  /** Radius of the patch, in metres. */
  radius?: number;
  field: FungusField;
  counts?: Partial<Record<FungusKind, number>>;
  /** Height at which cover starts thinning, in metres. */
  hillStart?: number;
  /** Height at which cover is gone entirely, in metres. */
  hillEnd?: number;
  /** Slope (`1 - normal.y`) above which nothing grows. */
  maxSlope?: number;
  /**
   * Corruption below which a candidate is rejected outright.
   *
   * Not zero: the corruption field returns small non-zero values a long way
   * out, and scattering against those directly would put the occasional
   * lonely mushroom on a hillside forty metres from the water, which reads as
   * a bug rather than as spread.
   */
  minCorruption?: number;
}

/** Defaults for the scatter, exported so the system and the tests agree. */
export const DEFAULT_FUNGUS_SCATTER = {
  radius: 60,
  hillStart: 8,
  hillEnd: 18,
  maxSlope: 0.5,
  minCorruption: 0.1,
} as const;

/** Smoothstep, written out rather than imported so the maths is local. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Scatter one patch of corruption.
 *
 * Rejection sampling against the corruption field, plus the same two fades the
 * foliage uses: nothing on a steep face, and thinning with height. The
 * corruption is the acceptance probability, so the growth is densest in the
 * water's shadow and absent everywhere else.
 *
 * Every kind is scattered independently, so a mushroom is not competing with a
 * lump of rot for the same point - which would show up as rot growing out of a
 * mushroom.
 */
export function scatterFungus(options: FungusScatterOptions): FungusInstance[] {
  const { seed, centreX, centreZ, field } = options;
  const radius = options.radius ?? DEFAULT_FUNGUS_SCATTER.radius;
  const hillStart = options.hillStart ?? DEFAULT_FUNGUS_SCATTER.hillStart;
  const hillEnd = options.hillEnd ?? DEFAULT_FUNGUS_SCATTER.hillEnd;
  const maxSlope = options.maxSlope ?? DEFAULT_FUNGUS_SCATTER.maxSlope;
  const minCorruption = options.minCorruption ?? DEFAULT_FUNGUS_SCATTER.minCorruption;
  const counts = { ...DEFAULT_FUNGUS_COUNTS, ...options.counts };

  const out: FungusInstance[] = [];
  for (const kind of FUNGUS_KINDS) {
    const target = counts[kind];
    if (target <= 0) continue;

    // Phase one: how rotten is this patch on average?
    //
    // The acceptance probability below is `corruption^2`, so the expected
    // number of instances placed from `n` candidates is `n` times the mean of
    // `corruption^2` over the patch. That means a fixed target count does NOT
    // give a corruption-driven density - it gives the same number of mushrooms
    // everywhere the field can beat the threshold, and only their positions
    // change. Which is precisely the "ring of blight around the whole stream"
    // this is supposed to avoid.
    //
    // So the target is scaled by the patch's own mean, and the acceptance then
    // only has to distribute that many instances in proportion to the
    // corruption. A coarse lattice is enough: twelve samples across a radius
    // is a five-metre grid, and the corruption field varies over tens of
    // metres.
    const mean = patchMeanCorruption(field, centreX, centreZ, radius, minCorruption);
    // Clean throughout: nothing to scatter, and no reason to spend the tries
    // finding that out one candidate at a time.
    if (mean <= 0) continue;
    const cap = Math.max(1, Math.round(target * mean));

    const rng = createRng(hash(seed, FUNGUS_KINDS.indexOf(kind), 0x5c_47a7));
    // Bounded, not infinite. With acceptance `corruption^2` and a mean of `m`,
    // each try places `m` instances on average, so `cap * 40` tries is a
    // forty-fold margin on a patch whose mean has already been measured. It
    // fails closed rather than hanging.
    const maxTries = cap * 40;

    let placed = 0;
    for (let tries = 0; tries < maxTries && placed < cap; tries++) {
      // Square-root distributed over the disc, so instances are spread through
      // it rather than clumped at its centre.
      const a = rng() * Math.PI * 2;
      const d = Math.sqrt(rng()) * radius;
      const x = centreX + Math.cos(a) * d;
      const z = centreZ + Math.sin(a) * d;

      const corruption = field.corruptionAt(x, z);
      if (corruption < minCorruption) continue;
      // Squared, so a place that is half as rotten holds a quarter as much
      // growth: the falloff should read as the corruption dying out, not as a
      // linear dial.
      if (rng() > corruption * corruption) continue;

      const height = field.heightAt(x, z);
      if (hillEnd > hillStart && height > hillStart) {
        if (rng() > 1 - smoothstep(hillStart, hillEnd, height)) continue;
      }

      const normal = field.normalAt?.(x, z);
      if (normal) {
        const slope = 1 - Math.abs(normal.y);
        if (slope > maxSlope) continue;
      }

      out.push({
        kind,
        x,
        y: height,
        z,
        rotationY: rng() * Math.PI * 2,
        scale: scaleFor(kind, rng, corruption),
        tilt: (rng() - 0.5) * 0.3,
        variation: rng(),
        // Rounded to a hundredth: the tint attribute is a float, but nothing
        // downstream can see past two decimals and a rounded value makes two
        // visits to the same place agree.
        corruption: Math.round(corruption * 100) / 100,
      });
      placed++;
    }
  }

  return out;
}

/** Lattice rings sampled across a patch's radius, to measure its mean. */
const MEAN_SAMPLES = 12;

/**
 * Mean of `corruption^2` over a patch, or 0 if the patch is clean throughout.
 *
 * Sampled on a lattice of equal-area rings rather than by Monte Carlo: twelve
 * rings, the innermost a single point, covers the disc evenly, costs 145 field
 * evaluations, and gives the same answer to within a percent or two whatever
 * the field is doing - which is all the target count is entitled to depend on.
 *
 * The ring radii are `R*sqrt((k+0.5)/n)`, not `R*(k+0.5)/n`. Equal-area rings
 * have boundaries at `R/sqrt(n)` multiples, and bucketing by width instead
 * puts an eighth of the samples into the inner eighth of the area and reads it
 * back as clustering.
 */
function patchMeanCorruption(
  field: FungusField,
  centreX: number,
  centreZ: number,
  radius: number,
  minCorruption: number,
): number {
  let sum = 0;
  let n = 0;
  let any = false;
  for (let i = 0; i < MEAN_SAMPLES; i++) {
    const r = radius * Math.sqrt((i + 0.5) / MEAN_SAMPLES);
    const count = i === 0 ? 1 : MEAN_SAMPLES;
    for (let j = 0; j < count; j++) {
      const a = (j / count) * Math.PI * 2 + i * 0.7;
      const c = field.corruptionAt(centreX + Math.cos(a) * r, centreZ + Math.sin(a) * r);
      if (c >= minCorruption) any = true;
      const clamped = c < minCorruption ? 0 : c;
      sum += clamped * clamped;
      n++;
    }
  }
  if (!any) return 0;
  return sum / Math.max(n, 1);
}

/**
 * Scale for one instance.
 *
 * Every kind grows with the corruption it stands in, which is the style
 * guide's progression made literal: the same mushroom geometry is 0.6 at
 * stage 1 and 1.4 at stage 3. `carrion` does not - a dead fish does not get
 * bigger because the water is filthier.
 */
function scaleFor(kind: FungusKind, rng: () => number, corruption: number): number {
  const base = 0.8 + rng() * 0.4;
  if (kind === 'carrion') return base;
  const growth = 0.6 + corruption * 0.9;
  return base * growth;
}

/** Triangles the given instances cost. */
export function fungusTriangleCost(instances: readonly FungusInstance[]): number {
  let total = 0;
  for (const instance of instances) total += FUNGUS_TRIANGLES[instance.kind];
  return total;
}

/** How many instances of one kind fit a triangle budget. */
export function instancesForBudget(kind: FungusKind, budget: number): number {
  return Math.max(0, Math.floor(budget / FUNGUS_TRIANGLES[kind]));
}

/* -------------------------------------------------------------------------- */
/* palette and helpers                                                         */
/* -------------------------------------------------------------------------- */

/** The sickly yellow-green a cap is at its brightest. */
const COLOR_CAP_HIGH: [number, number, number] = [0.46, 0.54, 0.24];

/** The same cap in shadow, and at its rim. */
const COLOR_CAP_LOW: [number, number, number] = [0.2, 0.25, 0.13];

/** The bruised purple the plan asks for, at cap brightness. */
const COLOR_CAP_BRUISED: [number, number, number] = [0.38, 0.22, 0.4];

/** The bruised purple in shadow. */
const COLOR_CAP_BRUISED_LOW: [number, number, number] = [0.18, 0.11, 0.21];

/** The gills under a cap: paler, more yellow, the part that catches light. */
const COLOR_GILL: [number, number, number] = [0.55, 0.5, 0.33];

/** The gills in the funnel's throat. */
const COLOR_GILL_DEEP: [number, number, number] = [0.24, 0.22, 0.15];

/** A mushroom's stalk: grey-green, and paler than the cap. */
const COLOR_STALK: [number, number, number] = [0.45, 0.45, 0.37];

/** A shelf's face, lit. */
const COLOR_SHELF: [number, number, number] = [0.4, 0.44, 0.26];

/** A shelf's face in shadow, and its underside. */
const COLOR_SHELF_DEEP: [number, number, number] = [0.17, 0.19, 0.12];

/** A shelf's bruised variant, lit. */
const COLOR_SHELF_BRUISED: [number, number, number] = [0.34, 0.21, 0.36];

/** A shelf's bruised variant in shadow. */
const COLOR_SHELF_BRUISED_DEEP: [number, number, number] = [0.15, 0.1, 0.19];

/** A spore pod's globe: the brightest thing in the forest, by design. */
const COLOR_POD: [number, number, number] = [0.62, 0.78, 0.4];

/** The same globe at its tip, where the emissive lift is strongest. */
const COLOR_POD_TIP: [number, number, number] = [0.8, 0.95, 0.55];

/** A spore pod's stalk. */
const COLOR_POD_STALK: [number, number, number] = [0.42, 0.46, 0.34];

/** A dead fish's back. */
const COLOR_CARRION: [number, number, number] = [0.16, 0.15, 0.14];

/** Its belly, which is where the light would have caught it. */
const COLOR_CARRION_BELLY: [number, number, number] = [0.26, 0.25, 0.22];

/** Rot: near-black, because the colour has gone out of it. */
const COLOR_ROT: [number, number, number] = [0.1, 0.09, 0.08];

/** The one place rot still holds a hue, on top where the spores land. */
const COLOR_ROT_HIGH: [number, number, number] = [0.2, 0.22, 0.14];

/** The arrays a generator appends into. */
interface Sink {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

/** Concatenate one mesh into a sink, offsetting its indices. */
function appendMesh(out: Sink, mesh: MeshData): void {
  const base = out.positions.length / 3;
  for (let i = 0; i < mesh.positions.length; i++) out.positions.push(mesh.positions[i]);
  for (let i = 0; i < mesh.normals.length; i++) out.normals.push(mesh.normals[i]);
  for (let i = 0; i < mesh.colors.length; i++) out.colors.push(mesh.colors[i]);
  for (let i = 0; i < mesh.indices.length; i++) out.indices.push(mesh.indices[i] + base);
}

/**
 * Sweep a profile around +Y.
 *
 * The normal is the profile's tangent rotated a quarter turn into the
 * (radial, height) plane, which is exact for a surface of revolution and costs
 * no accumulation pass. Reversing the profile negates both derivatives, so it
 * negates the normal too - which is how the cap's underside gets its winding
 * from the same code path.
 *
 * `lean` is applied last, in world space, so a tilted mushroom leans about its
 * own base rather than about the origin.
 */
function revolve(
  out: Sink,
  profile: ProfilePoint[],
  radial: number,
  colorAt: (pt: ProfilePoint) => readonly [number, number, number],
  lean?: (x: number, y: number, z: number) => [number, number, number],
): void {
  if (profile.length < 2 || radial < 3) return;
  const base = out.positions.length / 3;

  // Per-ring tangent, by central differences with one-sided ends.
  const tangent: Array<[number, number]> = [];
  for (let i = 0; i < profile.length; i++) {
    const prev = profile[Math.max(0, i - 1)];
    const next = profile[Math.min(profile.length - 1, i + 1)];
    const dr = next.r - prev.r;
    const dy = next.y - prev.y;
    const len = Math.hypot(dr, dy);
    // A zero-length tangent means two identical profile points. Falling back
    // to a radial normal keeps the surface lit instead of producing a NaN.
    tangent.push(len > 1e-12 ? [dy / len, -dr / len] : [1, 0]);
  }

  for (let i = 0; i < profile.length; i++) {
    const pt = profile[i];
    const [nr, ny] = tangent[i];
    const color = colorAt(pt);
    for (let s = 0; s <= radial; s++) {
      const theta = (s / radial) * Math.PI * 2;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const x = pt.r * ct;
      const y = pt.y;
      const z = pt.r * st;
      if (lean) {
        const [lx, ly, lz] = lean(x, y, z);
        out.positions.push(lx, ly, lz);
        // The lean is a rotation, so the normal rotates with it. Recomputing
        // it from the leaned position would be wrong: the profile tangent is
        // in the mushroom's own frame.
        const rl = rotateNormal(nr, ny, theta, lean);
        out.normals.push(rl[0], rl[1], rl[2]);
      } else {
        out.positions.push(x, y, z);
        out.normals.push(nr * ct, ny, nr * st);
      }
      out.colors.push(color[0], color[1], color[2]);
    }
  }

  for (let i = 0; i < profile.length - 1; i++) {
    for (let s = 0; s < radial; s++) {
      const a = base + i * (radial + 1) + s;
      const b = a + 1;
      const c = a + radial + 1;
      const d = c + 1;
      pushQuad(out.indices, a, b, c, d, false);
    }
  }
}

/**
 * Rotate a surface-of-revolution normal through the same lean the positions
 * went through.
 *
 * The lean is a rotation about a horizontal axis through the base, so the
 * normal - which lives in the mushroom's own (radial, height) plane - rotates
 * by exactly the same matrix. Written out rather than reusing `lean` on a
 * point, because a normal is a direction and must not be translated.
 */
function rotateNormal(
  nr: number,
  ny: number,
  theta: number,
  lean: (x: number, y: number, z: number) => [number, number, number],
): [number, number, number] {
  // The un-leaned direction.
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const dx = nr * ct;
  const dy = ny;
  const dz = nr * st;
  // Two points on the same direction, differenced through the lean: the
  // difference is the rotation applied to the direction, with the
  // translation cancelled.
  const a = lean(dx, dy, dz);
  const b = lean(0, 0, 0);
  const vx = a[0] - b[0];
  const vy = a[1] - b[1];
  const vz = a[2] - b[2];
  const len = Math.hypot(vx, vy, vz);
  if (len < 1e-12) return [dx, dy, dz];
  return [vx / len, vy / len, vz / len];
}

/**
 * Push one quad as two triangles.
 *
 * `a` is (ring i, segment s), `b` is (i, s+1), `c` is (i+1, s) and `d` is
 * (i+1, s+1). The pair that faces the *same way as the analytic normal* is
 * (a, d, b) and (a, c, d): both take their cross product as
 * `cross(dP/dt, dP/dtheta)`, which is the normal `revolve` computes from the
 * profile tangent. The other two pairings - (a, b, d) and (a, d, c), or
 * (a, b, c) and (b, d, c) - each mix one correct triangle with one that faces
 * backwards, and a mesh with half its triangles inverted lights itself from
 * the inside wherever the two meet.
 *
 * `flip` reverses the pair, for a surface whose outward direction is the
 * other way.
 */
function pushQuad(indices: number[], a: number, b: number, c: number, d: number, flip: boolean): void {
  if (flip) {
    indices.push(a, b, d, a, d, c);
  } else {
    indices.push(a, d, b, a, c, d);
  }
}

/** Linearly interpolate two rgb triples. */
function mix(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smooth01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/**
 * A stable hash of (seed, variant, salt).
 *
 * `Math.random()` is unusable for world generation: it would make every test
 * run produce a different forest, and a bug that only appears on one seed
 * would be unreproducible. Everything here funnels through this.
 */
function hash(seed: number, variant: number, salt: number): number {
  let a = (seed | 0) ^ (variant | 0) ^ salt;
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  return (a ^ (a >>> 16)) | 0;
}

function f32(values: number[]): Float32Array {
  return new Float32Array(values);
}

function u32(values: number[]): Uint32Array {
  return new Uint32Array(values);
}
