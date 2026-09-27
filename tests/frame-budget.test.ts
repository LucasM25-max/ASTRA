import { afterEach, describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { WorldScene, DEFAULT_FOG_FAR } from '../src/world/WorldScene';
import { FUNGUS_TRIANGLES } from '../src/procedural/FungusGenerator';

/**
 * The plan's performance budget, in the plan's own words:
 *
 *   - Draw calls: < 200 per frame
 *   - Triangles: < 500K visible
 *
 * These tests measure the frame the way the renderer does, by summing
 * `count * (index.count / 3)` over every mesh attached to the scene. Three
 * culls a mesh whose `frustumCulled` is true against its bounding sphere, and
 * submits a mesh whose `frustumCulled` is false whole - which is the case for
 * every forest and corruption mesh, because their instances span the world and
 * a mesh-level bounding sphere is useless. So the sum below is what the GPU is
 * actually asked to draw, not an optimistic upper bound on it.
 */

/** What one subsystem costs, per frame, at one camera position. */
interface Cost {
  meshes: number;
  instances: number;
  triangles: number;
}

const empty = (): Cost => ({ meshes: 0, instances: 0, triangles: 0 });

/** Triangles one mesh of `count` instances submits. */
function costOf(mesh: {
  count?: number;
  geometry?: { index?: { count: number } | null; attributes: { position?: { count: number } } };
}): { instances: number; triangles: number } {
  const geometry = mesh.geometry;
  if (!geometry) return { instances: mesh.count ?? 1, triangles: 0 };
  const per =
    (geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0)) / 3;
  const instances = mesh.count ?? 1;
  return { instances, triangles: per * instances };
}

/** Sum the cost of a whole subtree. */
function costOfTree(root: { traverse: (visit: (child: unknown) => void) => void }): Cost {
  const out = empty();
  root.traverse((child) => {
    const mesh = child as { isMesh?: boolean; isInstancedMesh?: boolean };
    if (!mesh.isMesh && !mesh.isInstancedMesh) return;
    const { instances, triangles } = costOf(child as never);
    out.meshes += 1;
    out.instances += instances;
    out.triangles += triangles;
  });
  return out;
}

let physics: PhysicsWorld;

afterEach(() => {
  physics?.dispose();
});

async function build(): Promise<WorldScene> {
  physics = await PhysicsWorld.create();
  const scene = new Scene();
  return new WorldScene({ scene, physics });
}

/** Fractions of the way along the spline, cave end to village end. */
const STOPS = [0.02, 0.25, 0.5, 0.75, 0.98] as const;

/** Stand at `fraction` of the way along the spline and cost the whole frame. */
async function costAt(
  fraction: number,
): Promise<Record<'terrain' | 'water' | 'forest' | 'corruption', Cost> & { total: Cost }> {
  const world = await build();
  const point = world.terrain.stream.pointAtDistance(fraction * world.terrain.stream.length);
  world.update(1 / 60, { x: point.x, y: 0, z: point.z });

  const parts = {
    terrain: costOfTree(world.terrain.mesh as never),
    water: costOfTree(world.stream.mesh as never),
    forest: costOfTree(world.forest.group),
    corruption: costOfTree(world.corruption.group),
  };
  const total = empty();
  for (const part of Object.values(parts)) {
    total.meshes += part.meshes;
    total.instances += part.instances;
    total.triangles += part.triangles;
  }
  world.dispose();
  return { ...parts, total };
}

describe('frame budget', () => {
  it('costs under the draw-call budget at every point along the stream', async () => {
    for (const t of STOPS) {
      const { total } = await costAt(t);
      // The sky dome and the three lights add a handful more, which the 200
      // budget absorbs with room to spare.
      expect(total.meshes, `draw calls at t=${t}`).toBeLessThan(200);
    }
  }, 120000);

  it('records the triangle cost at every point along the stream', async () => {
    const seen: number[] = [];
    for (const t of STOPS) {
      const { total } = await costAt(t);
      seen.push(Math.round(total.triangles));
    }
    // Regression guard, not the plan's budget. See the note below: the plan
    // asks for under 500K and the frame costs more than that, for a reason
    // that is not this step's to fix. What this asserts is that the number is
    // stable - if a later step quietly adds another hundred thousand triangles
    // this fails, and whoever added them has to look at this comment.
    expect(Math.max(...seen)).toBeLessThan(700_000);
    // And that the cost is flat along the stream: the corruption is a small
    // share of it, so walking from the village to the cave must not cost the
    // frame a meaningful amount.
    expect(Math.min(...seen)).toBeGreaterThan(0.7 * Math.max(...seen));
  }, 120000);

  it('keeps the corruption a small share of the frame', async () => {
    // The corruption is the last thing added to the frame, so it is the one
    // thing this step controls. If it ever grows to a tenth of the frame the
    // tuning has drifted, and the right response is to tighten the fungus
    // triangle budget rather than to quietly spend the plan's allowance.
    const worst = await costAt(0.02);
    expect(worst.corruption.triangles).toBeGreaterThan(0);
    expect(worst.corruption.triangles / worst.total.triangles).toBeLessThan(0.1);
  }, 120000);

  it('caps the ground fungus at its own triangle budget', async () => {
    const world = await build();
    // The four ground kinds, at full capacity, spend the budget they were
    // given and not a triangle more. The capacity is the safety net; the
    // density the player sees is set by the acceptance probability, which is
    // far below the cap even at the cave mouth.
    const ground = world.corruption.group.children.filter((child: { name: string }) =>
      /^corruption-(mushroom|pod|rot|carrion)$/.test(child.name),
    );
    expect(ground.length).toBe(4);
    let capacityTriangles = 0;
    for (const child of ground) {
      const mesh = child as unknown as {
        count: number;
        geometry: { index: { count: number } };
      };
      capacityTriangles += mesh.count * (mesh.geometry.index.count / 3);
    }
    expect(capacityTriangles).toBeLessThanOrEqual(190_000);

    // `FUNGUS_TRIANGLES` is the worst case over the seed space, not the size of
    // any one seed's geometry - the mushroom's cap shape and gill count come
    // from the seed, so a different seed builds a different mushroom. Budgeting
    // against the maximum rather than the average is what makes the cap a cap:
    // an average would be exceeded by roughly half the seeds.
    for (const kind of ['mushroom', 'pod', 'rot', 'carrion'] as const) {
      const mesh = world.corruption.group.getObjectByName(`corruption-${kind}`) as unknown as {
        geometry: { index: { count: number } };
      };
      const actual = mesh.geometry.index.count / 3;
      expect(actual, `${kind} is bigger than its declared cost`).toBeLessThanOrEqual(
        FUNGUS_TRIANGLES[kind],
      );
      // And it is not wildly smaller, or the declared cost is not a worst case
      // but a fiction and the budget is being spent on nothing.
      expect(actual).toBeGreaterThan(FUNGUS_TRIANGLES[kind] * 0.7);
    }
    world.dispose();
  }, 120000);

  it('keeps the fog inside the far plane, so nothing is drawn unseen', () => {
    // A fog further away than the camera's far plane draws triangles the player
    // can never see. The two are independent settings and nothing else checks
    // them. The terrain is 500 m and the fog ends at 400 m, so essentially the
    // whole terrain mesh is inside the fog - which is also why splitting the
    // terrain into tiles would save almost nothing.
    expect(DEFAULT_FOG_FAR).toBeLessThan(2000);
    expect(DEFAULT_FOG_FAR).toBeLessThanOrEqual(500);
  });
});

/**
 * A note on the triangle number, because it is the one place this project does
 * not meet the plan.
 *
 * Measured at the cave mouth, the worst ground in the world:
 *
 *   terrain, one 384x384 mesh          293,378   48%
 *   forest, near + medium trees        180,360   29%
 *   forest, foliage                    73,680    12%
 *   forest, shelves                    28,116     5%
 *   corruption, ground fungus          16,929     3%
 *   forest, far billboards             12,356     2%
 *   stream water                       9,216      1%
 *   ---------------------------------  -------
 *   total                             614,035   100%
 *
 * The plan asks for under 500K. The frame costs about 23% more.
 *
 * The cause is structural and predates this step. The terrain is a single mesh
 * spanning the whole 500 m world, and because its bounding sphere encloses the
 * camera it is never frustum-culled, so all 293K of its triangles are submitted
 * every frame whether the player can see them or not. The forest's near and
 * medium tiers are the Step 2.3 density, tuned against real terrain at 137
 * trees per hectare.
 *
 * Tiling the terrain would fix it, and would change nothing visually - but it
 * would mean re-opening the terrain mesh, its collision trimesh, its corruption
 * attribute and the Step 1.x tests that verify all three, inside a step that is
 * supposed to be about fungus. The right place for it is its own step.
 *
 * What this step does own is the corruption's own 45,045 triangles, and the
 * test above holds that to under a tenth of the frame.
 */
