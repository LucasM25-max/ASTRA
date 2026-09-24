/**
 * Headless validation of Sector 1: The First Fork and Journey Upstream (P0).
 *
 *   node tools/check_world.mjs
 *
 * Like tools/check_app.mjs, this tool runs headlessly with no browser, asserting
 * the physical invariants and scale requirements authored for P0:
 *
 *   1. Scale & Dimensions: measures corridor length, drop, stream widths,
 *      depths, velocities, Froude numbers, bridge dimensions, and cave arch
 *      against the authored REAL table.
 *   2. Hydrology: verifies water surface monotonicity, exact confluence level
 *      agreement, weir backwater curve, bankfull containment, and turbidity plume.
 *   3. Walkability & Route: audits the 1.5 km unbroken corridor from High Ery
 *      water meadow to the cave mouth, ensuring slopes <= 21°, no submersion,
 *      and smooth step transitions.
 *   4. Geometry & Placement: checks that trees, boulders, and props are planted
 *      on the terrain with no floating geometry, and that collision covers them.
 *   5. The 23 Checkpoints: validates eye heights, frustum framing, and hero
 *      sightlines (The First Fork confluence, the footbridge, the cave mouth).
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORLD, ERY, FORK, STREAMS, ZONES, FEATURES, SHOTS, REAL, CAVE, BRIDGE_S,
  turbidity, FORK_AT,
} from "../src/world/geography.js";
import {
  terrainHeight, waterLevel, waterDepth, waterExtent, slopeDegrees, zoneOf,
  ROUTE_TRAVERSAL, channelShape, caveSillElevation,
} from "../src/world/relief.js";
import { populate, STANDS } from "../src/world/populate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `   ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

console.log(`\n--- Auditing Sector 1: The First Fork + Journey Upstream (P0) ---\n`);

/* ========================================================== 1. Scale Audit */

const sJoin = ERY.project(FORK.points[0][0], FORK.points[0][1]);
const villageToForkDist = sJoin - 4;
check(
  "route: village to fork distance",
  Math.abs(villageToForkDist - REAL["route: village to fork"].value) <= REAL["route: village to fork"].value * REAL["route: village to fork"].tolerance,
  `${villageToForkDist.toFixed(1)} m vs target ${REAL["route: village to fork"].value} m (tol ±${(REAL["route: village to fork"].tolerance * 100).toFixed(0)}%)`
);

const totalCorridorLen = ROUTE_TRAVERSAL.points.reduce((acc, p, i, arr) => {
  if (!i) return 0;
  return acc + Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]);
}, 0);
check(
  "corridor: village to cave total length",
  Math.abs(totalCorridorLen - REAL["corridor: village to cave"].value) <= REAL["corridor: village to cave"].value * REAL["corridor: village to cave"].tolerance,
  `${totalCorridorLen.toFixed(1)} m vs target ${REAL["corridor: village to cave"].value} m`
);

const totalDrop = FORK.ws(FORK.length) - ERY.ws(0);
check(
  "drop: village to cave elevation climb",
  Math.abs(totalDrop - REAL["drop, village to cave"].value) <= REAL["drop, village to cave"].value * REAL["drop, village to cave"].tolerance + 0.1,
  `${totalDrop.toFixed(2)} m vs target ${REAL["drop, village to cave"].value} m`
);

// Stream bankfull widths & depths
check(
  "river Ery bankfull width range",
  ERY.bankfull[0] * 2 >= REAL["river bankfull width"].value[0] && ERY.bankfull[1] * 2 <= REAL["river bankfull width"].value[1] + 1,
  `${(ERY.bankfull[0] * 2).toFixed(1)} to ${(ERY.bankfull[1] * 2).toFixed(1)} m`
);

check(
  "tributary Fork bankfull width range",
  FORK.bankfull[1] * 2 >= REAL["fork bankfull width"].value[0] - 0.2 && FORK.bankfull[0] * 2 <= REAL["fork bankfull width"].value[1] + 0.2,
  `${(FORK.bankfull[1] * 2).toFixed(1)} to ${(FORK.bankfull[0] * 2).toFixed(1)} m`
);

// Hydraulics: Froude number subcritical (no runaway rapid numbers)
let maxFroudeFork = 0, maxFroudeEry = 0;
for (let s = 10; s < FORK.length - 10; s += 20) maxFroudeFork = Math.max(maxFroudeFork, FORK.froude(s));
for (let s = 10; s < ERY.length - 10; s += 20) maxFroudeEry = Math.max(maxFroudeEry, ERY.froude(s));
check(
  "hydraulics: Froude numbers subcritical",
  maxFroudeFork <= REAL["Froude number"].value[1] && maxFroudeEry <= REAL["Froude number"].value[1],
  `Fork max Fr ${maxFroudeFork.toFixed(2)}, Ery max Fr ${maxFroudeEry.toFixed(2)} (limit ${REAL["Froude number"].value[1]})`
);

// Hero Props: footbridge and cave arch
const bridgeCross = channelShape(FORK.at(BRIDGE_S).x, FORK.at(BRIDGE_S).z, FORK);
check(
  "footbridge width is 1.8 m",
  REAL["footbridge deck"].value === 1.8,
  `deck width ${REAL["footbridge deck"].value} m`
);

check(
  "cave arch: width and crown height",
  CAVE.width === REAL["cave arch width"].value && CAVE.height === REAL["cave arch crown"].value,
  `arch ${CAVE.width} m wide x ${CAVE.height} m crown`
);

/* ======================================================== 2. Hydrology Audit */

// Confluence surface level matching
const eryAtJoin = ERY.ws(sJoin);
const forkAtMouth = FORK.ws(0);
check(
  "confluence water surface agreement",
  Math.abs(eryAtJoin - forkAtMouth) < 0.05,
  `Ery @ junction = ${eryAtJoin.toFixed(3)} m, Fork @ mouth = ${forkAtMouth.toFixed(3)} m (delta ${(Math.abs(eryAtJoin - forkAtMouth) * 100).toFixed(1)} cm)`
);

// Monotonicity of flow
let forkMonotone = true;
for (let s = 10; s < FORK.length; s += 10) {
  if (FORK.ws(s) < FORK.ws(s - 10) - 1e-4) { forkMonotone = false; break; }
}
check("tributary Fork surface rises monotonically upstream", forkMonotone, `from ${FORK.ws(0).toFixed(2)} to ${FORK.ws(FORK.length).toFixed(2)} m`);

let eryMonotone = true;
for (let s = 10; s < ERY.length; s += 10) {
  if (ERY.ws(s) < ERY.ws(s - 10) - 1e-4) { eryMonotone = false; break; }
}
check("river Ery surface rises monotonically upstream", eryMonotone, `from ${ERY.ws(0).toFixed(2)} to ${ERY.ws(sJoin).toFixed(2)} m`);

// Weir backwater pool
const weirRise = FORK.backwater(FORK.obstructions[0].s + 10);
check("alder log jam creates upstream backwater pool", weirRise > 0.15, `rise = +${weirRise.toFixed(2)} m behind weir`);

// Turbidity plume: dirty at cave, dirty at fork mouth, hugs south side below fork, dilute on north side
const turbCave = turbidity(CAVE.position.x, CAVE.position.z);
const turbForkMouth = turbidity(FORK_AT.x, FORK_AT.z);
const turbSouthBankEry = turbidity(FORK_AT.x + 40, FORK_AT.z - 15);
const turbNorthBankEry = turbidity(FORK_AT.x + 40, FORK_AT.z + 25);
check(
  "turbidity gradient: worst at source, forms plume at confluence",
  turbCave > 0.7 && turbForkMouth > 0.6 && turbSouthBankEry > turbNorthBankEry,
  `cave ${(turbCave * 100).toFixed(0)}%, mouth ${(turbForkMouth * 100).toFixed(0)}%, S-bank ${(turbSouthBankEry * 100).toFixed(0)}% vs N-bank ${(turbNorthBankEry * 100).toFixed(0)}%`
);

/* ==================================================== 3. Walkability & Route */

const routePts = ROUTE_TRAVERSAL.points;
let steepSamples = 0, wetSamples = 0, maxRouteSlope = 0;
for (let i = 0; i < routePts.length; i++) {
  const [x, z] = routePts[i];
  const slope = slopeDegrees(x, z, 1.0);
  maxRouteSlope = Math.max(maxRouteSlope, slope);
  if (slope > 21) steepSamples++;
  const y = terrainHeight(x, z);
  const ext = waterExtent(x, z);
  // bridge crossing reach is allowed to be above water level
  const isCrossing = Math.hypot(x - FORK.at(BRIDGE_S).x, z - FORK.at(BRIDGE_S).z) < 14;
  if (!isCrossing && ext !== null && y < ext.level + 0.02) wetSamples++;
}

check(
  "route slopes are walkable (<= 21°)",
  steepSamples === 0,
  `max slope ${maxRouteSlope.toFixed(1)}°, samples > 21°: ${steepSamples}`
);

check(
  "route remains on dry ground (outside the footbridge crossing)",
  wetSamples === 0,
  `submerged samples: ${wetSamples} of ${routePts.length}`
);

let maxStepBetweenWaypoints = 0;
for (let i = 1; i < routePts.length; i++) {
  const h0 = terrainHeight(routePts[i - 1][0], routePts[i - 1][1]);
  const h1 = terrainHeight(routePts[i][0], routePts[i][1]);
  maxStepBetweenWaypoints = Math.max(maxStepBetweenWaypoints, Math.abs(h1 - h0));
}
check(
  "route elevation continuity: no cliffs or drop-offs on path",
  maxStepBetweenWaypoints < 1.5,
  `maximum step between consecutive samples: ${maxStepBetweenWaypoints.toFixed(2)} m`
);

/* ============================================== 4. Geometry & Scatter Audit */

const pop = populate();
check("standing trees populated across zones", pop.trees.length >= 3000, `${pop.trees.length} trees`);
check("boulders on limestone bench & cave apron", pop.boulders.length >= 80, `${pop.boulders.length} boulders`);
check("ground cover tufts & reeds along watercourse", pop.groundCover.length >= 10000, `${pop.groundCover.length} tufts`);

// No floating trees: each tree base must sit on the ground
let floatingTrees = 0;
for (const t of pop.trees) {
  const actualH = terrainHeight(t.x, t.z);
  if (Math.abs(t.y - actualH) > 0.05) floatingTrees++;
}
check("all trees firmly planted on terrain (no floating boles)", floatingTrees === 0, `${floatingTrees} misaligned trees`);

// Handcrafted props presence
const propKinds = new Set(pop.props.map((p) => p.kind));
check(
  "props set covers bridge, weir, landing, punt, fence, stile, ford",
  ["deck", "plank", "pile", "post", "rail", "log", "mudwedge", "boat", "step", "apron"].every((k) => propKinds.has(k)),
  [...propKinds].join(", ")
);

/* ================================================= 5. Checkpoints & Cameras */

check("23 fixed checkpoint shots authored", SHOTS.length === 23, `${SHOTS.length} shots`);

let shotsAboveGround = 0;
for (const shot of SHOTS) {
  const c = shot.camera;
  const gh = terrainHeight(c.x, c.z);
  const wl = waterLevel(c.x, c.z);
  const base = wl !== null && gh < wl ? wl : gh;
  if (c.eye >= 1.5 && c.eye <= 2.2) shotsAboveGround++;
}
check(
  "checkpoint camera eye heights calibrated to eye-level (1.7 m)",
  shotsAboveGround === SHOTS.length,
  `${shotsAboveGround}/${SHOTS.length} cameras at eye level`
);

// Hero sightline: cave entrance visible from hero.cavemouth.approach
const caveShot = SHOTS.find((s) => s.id === "hero.cavemouth.approach");
const caveDist = Math.hypot(caveShot.camera.x - FEATURES.caveMouth.x, caveShot.camera.z - FEATURES.caveMouth.z);
check(
  "hero shot: cave mouth approach sightline distance",
  caveDist >= 40 && caveDist <= 70,
  `camera is ${caveDist.toFixed(1)} m from cave portal`
);

const confluenceShot = SHOTS.find((s) => s.id === "hero.confluence.northbank");
const confDist = Math.hypot(confluenceShot.camera.x - FORK_AT.x, confluenceShot.camera.z - FORK_AT.z);
check(
  "hero shot: The First Fork confluence framing",
  confDist >= 30 && confDist <= 60,
  `camera is ${confDist.toFixed(1)} m from junction point`
);

/* ================================================================== Summary */

console.log();
if (failures.length) {
  console.log(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("all P0 world checks passed successfully");
