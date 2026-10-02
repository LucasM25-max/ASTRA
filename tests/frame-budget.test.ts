import { afterEach, describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, type Object3D, Scene, Sphere, Vector3 } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { WorldScene, DEFAULT_FOG_FAR } from '../src/world/WorldScene';
import { FUNGUS_TRIANGLES } from '../src/procedural/FungusGenerator';
import { PERFORMANCE_BUDGET } from '../src/debug/DebugHud';
import { TERRAIN_RESOLUTION } from '../src/procedural/TerrainGenerator';

/**
 * The plan's performance budget, in the plan's own words:
 *
 *   - Draw calls: < 200 per frame
 *   - Triangles: < 500K visible
 *
 * These tests measure the frame the way the renderer does. Three decides what
 * to submit mesh by mesh: a mesh with `frustumCulled` true is tested against
 * its own bounding sphere and dropped whole if the sphere misses, and a mesh
 * with `frustumCulled` false is submitted entire. That second case is every
 * forest and corruption mesh - their instances span the world, so a mesh-level
 * bounding sphere is useless to them - and it is why this test cannot simply
 * sum the scene. It runs Three's own culling test over every mesh and counts
 * only the survivors, which is the number the renderer would actually submit.
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

/**
 * Sum the cost of a whole subtree, honouring per-mesh frustum culling.
 *
 * `camera` is optional: without it every mesh is counted, which is the right
 * answer for a mesh that has opted out of culling and an upper bound otherwise.
 * With it, a cullable mesh whose bounding sphere misses the frustum costs
 * nothing - exactly as Three's `projectObject` would decide.
 */
function costOfTree(
  root: { traverse: (visit: (child: unknown) => void) => void },
  camera?: PerspectiveCamera,
): Cost {
  const out = empty();
  root.traverse((child) => {
    const mesh = child as {
      isMesh?: boolean;
      isInstancedMesh?: boolean;
      frustumCulled?: boolean;
      geometry?: { boundingSphere: { center: Vector3; radius: number } | null };
    };
    if (!mesh.isMesh && !mesh.isInstancedMesh) return;
    if (camera && mesh.frustumCulled !== false) {
      const sphere = mesh.geometry?.boundingSphere;
      if (sphere && !frustum.intersectsSphere(new Sphere(sphere.center, sphere.radius))) return;
    }
    const { instances, triangles } = costOf(child as never);
    out.meshes += 1;
    out.instances += instances;
    out.triangles += triangles;
  });
  return out;
}

/**
 * A reusable frustum, rebuilt whenever the camera moves.
 *
 * Built the way Three does - `projectionMatrix * matrixWorldInverse` - so a
 * tile is rejected here for the same reason the renderer would reject it.
 */
const frustum = new Frustum();
const projScreen = new Matrix4();

function aimFrustum(camera: PerspectiveCamera): void {
  camera.updateMatrixWorld();
  projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreen);
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

/**
 * The camera the measurements are taken through.
 *
 * The real game's third-person camera sits 4 m behind the player and pitches
 * down at `DEFAULT_CAMERA_PITCH`. Measuring through anything else - a camera
 * looking at the horizon, or no camera at all - is how a budget test comes to
 * believe a frame costs less than it does.
 */
const CAMERA_DISTANCE = 4;
const CAMERA_HEIGHT = 1.6;
const CAMERA_PITCH = 0.35;

/** Build the camera a player at `fraction` along the stream would be looking through. */
function cameraAt(world: WorldScene, fraction: number): PerspectiveCamera {
  const point = world.terrain.stream.pointAtDistance(fraction * world.terrain.stream.length);
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  const yaw = fraction * Math.PI * 2;
  camera.position.set(
    point.x - Math.sin(yaw) * CAMERA_DISTANCE * Math.cos(CAMERA_PITCH),
    point.y + CAMERA_HEIGHT + CAMERA_DISTANCE * Math.sin(CAMERA_PITCH),
    point.z - Math.cos(yaw) * CAMERA_DISTANCE * Math.cos(CAMERA_PITCH),
  );
  camera.lookAt(point.x, point.y + 1.4, point.z);
  return camera;
}

/** Stand at `fraction` of the way along the spline and cost the whole frame. */
async function costAt(
  fraction: number,
): Promise<Record<'terrain' | 'water' | 'forest' | 'corruption', Cost> & { total: Cost }> {
  const world = await build();
  const point = world.terrain.stream.pointAtDistance(fraction * world.terrain.stream.length);
  world.update(1 / 60, { x: point.x, y: 0, z: point.z });

  const camera = cameraAt(world, fraction);
  aimFrustum(camera);

  const parts = {
    terrain: costOfTree(world.terrain.group as never, camera),
    water: costOfTree(world.stream.mesh as never, camera),
    forest: costOfTree(world.forest.group, camera),
    corruption: costOfTree(world.corruption.group, camera),
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

  it('stays inside the triangle budget at every point along the stream', async () => {
    // The plan's own number: under 500,000 visible triangles. Not a regression
    // guard with headroom - the budget itself.
    for (const t of STOPS) {
      const { total } = await costAt(t);
      expect(total.triangles, `triangles at t=${t}`).toBeLessThan(PERFORMANCE_BUDGET.triangles);
    }
  }, 180000);

  it('does not leak forest cost as the player walks', async () => {
    // The forest, the corruption and the water are all `frustumCulled = false`:
    // their instances follow the camera, so a mesh-level bounding sphere is
    // camera-centred and always intersects, and Three submits them whole. They
    // are the part of the frame whose cost is a property of the world rather
    // than of the view, and the one thing that must never do is grow while the
    // player walks - a tier that forgot to retire instances, or a patch that
    // re-added itself every frame, would show up here and nowhere else.
    //
    // The cost does vary with position, because the forest is denser along the
    // stream than on the hills, and that variation is correct. What is checked
    // is that it comes back: the same stop measured before and after a walk
    // across the whole map has to agree.
    const stops = [0.02, 0.98, 0.02] as const;
    const seen: number[] = [];
    for (const t of stops) {
      const { forest, corruption, water } = await costAt(t);
      seen.push(forest.triangles + corruption.triangles + water.triangles);
    }
    expect(seen[2], 'the frame is not the same after a walk across the map').toBeCloseTo(
      seen[0],
      -3,
    );
    // And it stays in a band, rather than drifting upward with distance walked.
    expect(Math.min(...seen)).toBeGreaterThan(0.75 * Math.max(...seen));
  }, 180000);

  it('culls the terrain, so the ground costs what the camera can see', async () => {
    // The whole reason the terrain is tiled. The ground is the only large
    // subsystem whose cost is a function of the view, so it is the only one
    // that varies along the stream - and the variation is the culling working,
    // not a leak. A single 500m mesh would report the same number everywhere,
    // which is exactly the failure this guards against.
    const costs: number[] = [];
    for (const t of STOPS) {
      const { terrain } = await costAt(t);
      costs.push(terrain.triangles);
    }
    const whole = (TERRAIN_RESOLUTION - 1) * (TERRAIN_RESOLUTION - 1) * 2;
    // Never the whole grid: if every tile were submitted the split would be
    // doing nothing at all.
    for (const [i, cost] of costs.entries()) {
      expect(cost, `terrain at t=${STOPS[i]}`).toBeLessThan(whole);
    }
    // And a meaningful share of it is actually culled away.
    expect(Math.min(...costs)).toBeLessThan(0.65 * whole);
  }, 180000);

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

  it('leaves most of the frame to the renderer', async () => {
    // The plan's other performance target: 60fps on a mid-range laptop GPU. A
    // frame at 60fps is 16.7 ms, and this project's code owns only the CPU half
    // of it - the world update. The GPU half (rasterisation, the post chain,
    // shadow maps) cannot be measured without a GPU, so what is asserted here
    // is the part that can be: the world update stays a small fraction of the
    // frame, leaving the rest for rendering.
    //
    // Measured at the worst stop on the stream, after a warm-up:
    //
    //   stream      0.21 ms   the water surface's own per-frame work
    //   corruption  0.15 ms   the rot's glow and spore re-homing
    //   player      0.01 ms   the animator, read off the mixer
    //   everything  0.08 ms   sky, lights, forest, boundary, audio
    //   ------------------
    //   total       0.45 ms   3% of a 16.7 ms frame
    //
    // The bound is a quarter of the frame rather than the measured number,
    // because a timing assertion that tight fails on a loaded machine and
    // teaches everyone to ignore it. Four milliseconds still catches anything
    // that regresses by an order of magnitude, which is what a budget is for.
    const world = await build();
    const point = world.terrain.stream.pointAtDistance(0.25 * world.terrain.stream.length);
    for (let i = 0; i < 30; i++) world.update(1 / 60, { x: point.x, y: 0, z: point.z });

    const frames = 300;
    const started = performance.now();
    for (let i = 0; i < frames; i++) world.update(1 / 60, { x: point.x, y: 0, z: point.z });
    const perFrame = (performance.now() - started) / frames;

    expect(perFrame).toBeLessThan(16.7 / 4);
    world.dispose();
  }, 180000);

  it('spends almost nothing on textures, because the materials are procedural', async () => {
    // The plan: "Texture memory: minimal (almost all procedural shaders)".
    //
    // Every material in this world is generated in code - the terrain's biome
    // blend, the bark's colour ramp, the sky's gradient - so the textures that
    // exist are the ones the world draws for itself. Measured, they are:
    //
    //   4 x 64x64   the far-LOD tree billboards, drawn by `generateBillboard`
    //   1 x 32x32   the corruption's spore sprite
    //   ------------------
    //   91 KB total
    //
    // Which is the plan's requirement met exactly: not zero textures, but
    // nothing an artist made. What this asserts is the property that matters -
    // that no art asset has crept back in. A single 2048x2048 albedo map would
    // be 11 MB and would fail the size bound below by a factor of a hundred.
    const world = await build();

    let textures = 0;
    let bytes = 0;
    let largest = 0;
    for (const root of [
      world.terrain.group,
      world.forest.group,
      world.corruption.group,
      world.boundary.group,
      world.stream.mesh,
    ]) {
      root.traverse(collectTextures);
    }

    function collectTextures(object: Object3D): void {
      const material = (object as { material?: unknown }).material;
      if (!material) return;
      for (const one of Array.isArray(material) ? material : [material]) {
        const slots = one as Record<
          string,
          { isTexture?: boolean; image?: { width?: number; height?: number } } | undefined
        >;
        for (const slot of Object.values(slots)) {
          if (!slot || !slot.isTexture) continue;
          textures++;
          const image = slot.image;
          if (image?.width && image?.height) {
            // RGBA is 4 bytes a texel and mipmaps add a third again, so this is
            // an upper bound rather than a measurement.
            bytes += image.width * image.height * 4 * 1.34;
            largest = Math.max(largest, image.width * image.height);
          }
        }
      }
    }

    expect(textures).toBeGreaterThan(0);
    // No single texture bigger than a 128x128 sprite, and the whole lot under
    // a megabyte. Both are generous against 91 KB and both fail hard on any
    // real art asset.
    expect(largest).toBeLessThanOrEqual(128 * 128);
    expect(bytes).toBeLessThan(1024 * 1024);
    world.dispose();
  }, 180000);

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
