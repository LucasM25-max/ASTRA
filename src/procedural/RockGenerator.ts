/**
 * RockGenerator.ts - ASTRA world
 * =============================================================================
 * Large rocks: displaced icosahedrons, placed where a boulder would actually
 * sit and given the collider that makes the player walk around them.
 *
 * Step 2.9's boundary work needs rocks at the world's edge - the plan asks for
 * "dense procedural trees/rocks at edges to make boundaries feel natural" and
 * for "collision on ... large rocks" - so this is the geometry half of that.
 *
 * Why an icosahedron and not a noise-displaced sphere
 * --------------------------------------------------
 * A UV sphere's triangles bunch at the poles, so a rock built from one has a
 * dense cap and a stretched equator and reads as a spinning top whatever the
 * noise does. An icosahedron's faces are all the same size, so displacing them
 * gives a lumpy stone whose facets are evenly spread - which is the look the
 * style guide's "natural imperfection" is after, and it is also why the
 * existing foliage rock uses the same shape. `icosphereData` is imported rather
 * than copied: a second subdivision implementation would be a second place for
 * the midpoint-cache and dropped-corner bugs to live.
 *
 * Three shapes, because one shape repeated is a pattern
 * -----------------------------------------------------
 * A field of identical boulders is the fastest way to make a forest look
 * generated. The three presets differ in more than scale - a boulder is wide
 * and low, a slab is a plate on edge, a standing stone is narrow and tall - so
 * the silhouette changes between them, and the eye reads a scatter of them as
 * geology rather than as a repeated prop.
 *
 * Pure typed arrays, no Three.js import, so the whole module runs under Vitest
 * in Node.
 * =============================================================================
 */

import { SimplexNoise2D, createRng } from './NoiseLibrary';
import { icosphereData, type MeshData } from './TreeGenerator';

/** The three rock silhouettes. */
export type RockShape = 'boulder' | 'slab' | 'standing';

/** Every shape, in the order the field builds its meshes. */
export const ROCK_SHAPES: readonly RockShape[] = ['boulder', 'slab', 'standing'];

export interface RockPreset {
  /** Radius before displacement, in metres. */
  radius: number;
  /**
   * Non-uniform scale, applied after the displacement.
   *
   * Applied to the normals as well as the positions (that is what
   * `icosphereData` does), because a squash that leaves the normals alone
   * lights the rock as though it were still a sphere.
   */
  scale: { x: number; y: number; z: number };
  /** Displacement amplitude, as a fraction of the radius. */
  warp: number;
  /**
   * Icosphere subdivision. 1 is 80 faces, 2 is 320.
   *
   * A rock is a lump: at 320 faces its silhouette is smooth enough to read as
   * weathered stone rather than as a crystal, and 320 triangles is affordable
   * for a few dozen of them. Detail 0 - a bare icosahedron, 20 faces - is
   * deliberately unused: at that resolution the facets are the shape, and the
   * rock stops looking like anything.
   */
  detail: number;
  /** Radius of the capsule collider, in metres. */
  colliderRadius: number;
  /** Half height of the capsule collider's cylindrical section, in metres. */
  colliderHalfHeight: number;
  /** How often this shape appears, relative to the others. */
  weight: number;
  /** Base colour, linear-ish 0..1, shaded per rock by the noise. */
  color: [number, number, number];
}

/**
 * The rock shapes.
 *
 * The collider is a capsule, not the displaced mesh. A capsule is what the
 * forest's trunks already use, it is cheap in the broad phase, and - the part
 * that matters - it is convex and smooth, so the player's capsule slides around
 * it instead of catching on a facet. The trimesh route was rejected for the
 * terrain because of an upstream Rapier panic, and it would be the wrong shape
 * here anyway: a displaced icosphere has concavities the player would snag on.
 *
 * A capsule is a sphere with a cylinder through it, so its height is
 * `2 * (colliderHalfHeight + colliderRadius)` and it can only fit inside a rock
 * whose half-height exceeds `colliderRadius`. That is a real constraint on the
 * shapes, not a detail: a flat enough plate cannot be collided as a capsule at
 * all without the capsule standing proud of the stone and blocking air. The
 * slab's aspect is set by it - flat enough to read as a plate, round enough
 * that the capsule fits inside.
 *
 * Within that, the collider is deliberately a little smaller than the visual
 * rock. A capsule wrapped tightly to a lumpy surface stops the player short of
 * the stone in places and inside it in others, which reads as an invisible wall
 * with rocks drawn through it. Undershooting slightly means the player
 * occasionally clips a corner of a rock they can see, which reads as the rock
 * being rough.
 */
export const ROCK_PRESETS: Record<RockShape, RockPreset> = {
  boulder: {
    radius: 1.5,
    scale: { x: 1.2, y: 0.95, z: 1.05 },
    warp: 0.34,
    detail: 2,
    colliderRadius: 1.15,
    colliderHalfHeight: 0.25,
    weight: 5,
    color: [0.44, 0.45, 0.47],
  },
  slab: {
    radius: 1.7,
    scale: { x: 1.3, y: 0.55, z: 0.95 },
    warp: 0.28,
    detail: 2,
    colliderRadius: 0.8,
    colliderHalfHeight: 0.12,
    weight: 3,
    color: [0.41, 0.42, 0.45],
  },
  standing: {
    radius: 1.1,
    scale: { x: 0.6, y: 1.9, z: 0.65 },
    warp: 0.22,
    detail: 2,
    colliderRadius: 0.5,
    colliderHalfHeight: 1.55,
    weight: 2,
    color: [0.46, 0.46, 0.48],
  },
};

/** How many distinct geometries per shape. */
export const ROCK_VARIANTS = 3;

/**
 * Triangles for one rock.
 *
 * Exact rather than a worst case - `detail` fixes the face count, and an
 * icosphere at detail 2 is always 320 faces - but declared as a budget the way
 * `FUNGUS_TRIANGLES` is, so the field can be costed without building every
 * rock. Forty-four of them is 14,080 triangles, under 3% of the 500K budget,
 * which is why the field carries no far LOD of its own: a second tier would be
 * machinery with nothing to do.
 */
export const ROCK_TRIANGLES: Record<RockShape, number> = {
  boulder: 320,
  slab: 320,
  standing: 320,
};

/**
 * One rock as a standalone mesh.
 *
 * The displacement is simplex noise sampled on the sphere, so the lumps are
 * smooth rather than per-face random: a rock whose faces each jumped by a
 * different amount would read as a crumpled ball of paper. The seed is folded
 * with the variant so the three variants of a shape are three different stones
 * rather than one stone rotated, and the same seed always rebuilds the same
 * rock - which is what lets the field be built once and trusted.
 */
export function generateRock(shape: RockShape, seed: number, variant = 0): MeshData {
  const preset = ROCK_PRESETS[shape];
  const rockSeed = (seed * 6151 + variant * 131071) | 0;
  const rng = createRng(rockSeed);

  const mesh = icosphereData({
    centre: { x: 0, y: 0, z: 0 },
    radius: preset.radius,
    detail: preset.detail,
    warp: preset.warp,
    noise: new SimplexNoise2D(rockSeed ^ 0x77aa),
    color: preset.color,
    colorTip: null,
    scale: preset.scale,
  });

  // Shade the stone by how far out each vertex was pushed, so the lumps catch
  // the light differently from the flats. This is what stops a grey rock from
  // reading as a grey ball: the silhouette has structure, and so does the
  // surface. Done after the build because `icosphereData` returns finished
  // normals with the scale already folded into them.
  //
  // The displacement is radial, so distance from the centre is a direct measure
  // of how far out this vertex ended up.
  const { positions, colors } = mesh;
  // A per-rock tint, so two boulders of the same variant are not the same
  // grey. 18% is enough to break up a field without making any one rock read
  // as a different material from its neighbours.
  const tint = 1 + (rng() - 0.5) * 0.18;
  for (let i = 0; i < colors.length; i += 3) {
    const r = Math.hypot(positions[i], positions[i + 1], positions[i + 2]);
    const pushed = Math.min(1, Math.max(0, (r / preset.radius - 0.72) / 0.5));
    const lift = 0.82 + pushed * 0.34;
    colors[i] *= tint * lift;
    colors[i + 1] *= tint * lift;
    colors[i + 2] *= tint * (0.97 + pushed * 0.06);
  }

  return mesh;
}

/**
 * Pick a shape by weight.
 *
 * `r` is a uniform 0..1 draw. Cumulative weights rather than a normalised
 * array, so adding a shape is a one-line change and the weights can be left as
 * readable integers.
 */
export function pickRockShape(r: number): RockShape {
  const total = ROCK_SHAPES.reduce((sum, shape) => sum + ROCK_PRESETS[shape].weight, 0);
  let acc = 0;
  for (const shape of ROCK_SHAPES) {
    acc += ROCK_PRESETS[shape].weight / total;
    if (r <= acc) return shape;
  }
  return ROCK_SHAPES[ROCK_SHAPES.length - 1];
}
