/**
 * Living and built things placed by rule rather than by hand.
 *
 * The world is authored as fields, and everything standing on it is a decision
 * those fields make: no tree where the ground is too wet or too steep, the wood
 * dense where the zone says wood, reeds at the water's edge and nowhere else. Two
 * reasons, both practical. The first is scale: hand-placing four thousand trees
 * across a sector that has to be re-buildable from source is not a thing anybody
 * does twice. The second is the one that matters for photorealism -- a scatter
 * that respects the hydrology cannot lie about it, so the moment the waterline
 * moves, the reeds, the moss line and the tree line all move with it, and the
 * world stays coherent instead of needing a week of art fix-ups.
 *
 * Deterministic: same seed, same authored data, same world, byte for byte. That
 * is what lets tools/check_world.mjs audit placement rather than admire it.
 */

import { makeRandom } from "./noise.js";
import { clamp, ramp, lerp, denseGrid } from "./fields.js";
import {
  ERY, FORK, WORLD, ZONES, FEATURES, CAVE, BRIDGE_S, ROUTE,
} from "./geography.js";
import {
  terrainHeight, waterDepth, waterLevel, slopeDegrees, zoneOf, canopyDensity,
  moisture, fouling, HOLLOW_SOURCES, channelShape,
} from "./relief.js";

/* ============================================================ stand types */

/**
 * A "stand type" is a massing recipe, not a species. Naming Earth trees here
 * would be wrong twice over -- this is the Flanaess, and the brief is a temperate
 * river wood on a world that is not ours -- so what is authored is the structure
 * real woods have: a canopy height, a crown, a bole, a tolerance for wet ground,
 * whether it leans, whether it dies standing. P1 replaces these with scanned
 * species; nothing else in the world has to change.
 *
 * All figures are metres and must survive the scale audit: a "tall" wood at 9 m
 * is a copse, and the player reads the difference even when they cannot say it.
 */
export const STANDS = {
  carrAlder: {
    name: "wet-bank bole wood", height: [14, 23], crown: [5.5, 9.0], bole: [0.42, 0.62],
    lean: 0.10, canopy: "broad", wetTolerance: 1.0, standingDead: 0.10,
    accepts: [4, 1, 9], stride: 7.5,
  },
  riverWillow: {
    name: "bank-side broadleaf", height: [9, 16], crown: [5.0, 8.5], bole: [0.30, 0.50],
    lean: 0.16, canopy: "weeping", wetTolerance: 1.0, standingDead: 0.06,
    accepts: [1, 4, 9, 3], stride: 11,
  },
  woodOak: {
    name: "old canopy tree", height: [21, 34], crown: [11, 19], bole: [0.65, 1.10],
    lean: 0.05, canopy: "broad", wetTolerance: 0.35, standingDead: 0.09,
    accepts: [5, 6, 9, 2], stride: 12,
  },
  woodSlender: {
    name: "understorey and edge", height: [11, 20], crown: [4.0, 7.5], bole: [0.24, 0.44],
    lean: 0.12, canopy: "narrow", wetTolerance: 0.7, standingDead: 0.05,
    accepts: [5, 9, 4, 6], stride: 6.5,
  },
  beech: {
    name: "smooth-barked canopy", height: [22, 33], crown: [8, 14], bole: [0.45, 0.80],
    lean: 0.04, canopy: "columnar", wetTolerance: 0.2, standingDead: 0.07,
    accepts: [6, 7, 5], stride: 10,
  },
  benchScatter: {
    name: "rock-grown stunted", height: [7, 13], crown: [3.5, 6.0], bole: [0.28, 0.52],
    lean: 0.20, canopy: "broad", wetTolerance: 0.25, standingDead: 0.12,
    accepts: [7, 6], stride: 13,
  },
  meadowSolo: {
    name: "isolated pasture tree", height: [13, 21], crown: [9, 15], bole: [0.55, 0.95],
    lean: 0.07, canopy: "broad", wetTolerance: 0.3, standingDead: 0.04,
    accepts: [0, 2], stride: 46,
  },
};

/* ================================================================= rules */

const RULES = {
  /** Nothing stands in moving water, and nothing roots on a scree face. */
  maxWaterDepth: 0.30,
  maxSlope: 34,
  /** The corridor the player walks stays open: a wood may not close over it. */
  routeClear: 3.6,
  routeTrunkClear: 1.5,
  /** Reeds and tussock: shallow water and the wet band only. */
  reedDepth: [0.0, 0.42],
  reedMoisture: 0.58,
};

/** Deterministic jittered lattice: even coverage, no visible grid. */
function* lattice(minX, maxX, minZ, maxZ, stride, seed) {
  const rand = makeRandom(seed);
  const nx = Math.ceil((maxX - minX) / stride), nz = Math.ceil((maxZ - minZ) / stride);
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const jx = (rand() - 0.5) * stride * 0.92, jz = (rand() - 0.5) * stride * 0.92;
      yield {
        x: minX + ix * stride + stride * 0.5 + jx,
        z: minZ + iz * stride + stride * 0.5 + jz,
        r: rand(), ix, iz,
      };
    }
  }
}

/** Distance to the traversable route, by grid lookup rather than by scan. */
function routeGrid() {
  const pts = ROUTE.points.map((p) => ({ x: p[0], z: p[1], r: 0 }));
  return denseGrid(pts, Math.max(4, 12), { getR: () => 0 });
}

const _routeScratch = [];
function nearRoute(grid, x, z, radius) {
  let best = Infinity;
  grid.inRadius(x, z, radius + 12, _routeScratch);
  for (const i of _routeScratch) {
    const d = Math.hypot(ROUTE.points[i][0] - x, ROUTE.points[i][1] - z);
    if (d < best) best = d;
  }
  return best;
}

/* =================================================================== trees */

/**
 * The standing wood: ~4,600 trees, each one a real height, a real bole, a lean
 * that comes from the ground it grew in, and a canopy that respects the same
 * wetness and slope the terrain does.
 */
export function buildTrees() {
  const { minX, maxX, minZ, maxZ } = WORLD.bounds;
  const rand = makeRandom(WORLD.seed ^ 0x7a15);
  const route = routeGrid();
  const out = [];
  const spacing = [];
  const minGap = 2.4;

  for (const stand of Object.values(STANDS)) {
    for (const p of lattice(minX, maxX, minZ, maxZ, stand.stride, WORLD.seed + out.length)) {
      if (out.length > 6000) break;
      const zone = zoneOf(p.x, p.z);
      if (!stand.accepts.includes(zone.id)) continue;
      /* The stand's own density, and the zone's: a wood is not uniform, and the
         patchiness comes from the same canopy field the shadow and the moss use. */
      const density = clamp(zone.canopy * (0.35 + 0.75 * canopyDensity(p.x, p.z)), 0, 1);
      if (rand() > density * 1.05 + 0.05) continue;

      const depth = waterDepth(p.x, p.z);
      if (depth > RULES.maxWaterDepth) continue;
      /* A wet-tolerant wood stands in the carr; an oak that does is dead wood. */
      if (depth > 0.02 && stand.wetTolerance < 0.5 && rand() > stand.wetTolerance) continue;
      if (slopeDegrees(p.x, p.z, 1.2) > RULES.maxSlope) continue;
      if (nearRoute(route, p.x, p.z, RULES.routeClear + 12) < RULES.routeClear) continue;
      if (Math.hypot(p.x - FEATURES.caveMouth.x, p.z - FEATURES.caveMouth.z) < 13) continue;

      /* Minimum gap, so the lattice never shows through as a grid of clusters. */
      let tooClose = false;
      for (let k = spacing.length - 1, n = 0; k >= 0 && n < 40; k--, n++) {
        const s = spacing[k];
        if (Math.abs(s.x - p.x) > 6 || Math.abs(s.z - p.z) > 6) continue;
        if (Math.hypot(s.x - p.x, s.z - p.z) < minGap + s.g) { tooClose = true; break; }
      }
      if (tooClose) continue;

      const height = lerp(stand.height[0], stand.height[1], Math.pow(rand(), 0.8));
      const crown = lerp(stand.crown[0], stand.crown[1], rand()) * (0.75 + 0.5 * height / stand.height[1]);
      const bole = lerp(stand.bole[0], stand.bole[1], rand()) * (height / lerp(...stand.height));
      const dead = rand() < stand.standingDead;
      const y = terrainHeight(p.x, p.z);
      /* The lean follows the slope: a tree on a hillside does grow uphill, and
         one on a riverbank leans over the water. Reference photos show this in
         every wood; a perfectly vertical trunk is the tell of a scatter. */
      const hx = terrainHeight(p.x + 2.2, p.z) - terrainHeight(p.x - 2.2, p.z);
      const hz = terrainHeight(p.x, p.z + 2.2) - terrainHeight(p.x, p.z - 2.2);
      const gs = Math.hypot(hx, hz) / 4.4;
      const lean = Math.atan(gs) * 0.55 + stand.lean * (rand() - 0.5) * 0.9;
      const leanDir = gs > 0.01 ? Math.atan2(hz, hx) : rand() * Math.PI * 2;

      out.push({
        stand: Object.keys(STANDS).find((k) => STANDS[k] === stand),
        x: p.x, z: p.z, y,
        height: dead ? height * lerp(0.35, 0.7, rand()) : height,
        crown, bole, lean, leanDir,
        dead, rot: rand() * Math.PI * 2,
        grey: clamp(0.30 + 0.16 * rand() + 0.10 * (1 - zone.canopy) - 0.06 * moisture(p.x, p.z), 0.14, 0.62),
        canopyLayers: stand.canopy === "broad" ? 3 : stand.canopy === "weeping" ? 4 : 2,
        fouling: fouling(p.x, p.z),
      });
      spacing.push({ x: p.x, z: p.z, g: crown * 0.16 });
    }
  }
  return out;
}

/* ============================================================ boulders, rock */

/**
 * Limestone blocks on the bench and the collapse fan at the cave: real karst
 * debris, sized by the slope it fell down and buried to different degrees, which
 * is what a scatter of rocks needs to stop looking like a handful of spheres.
 */
export function buildBoulders() {
  const { minX, maxX, minZ, maxZ } = WORLD.bounds;
  const rand = makeRandom(WORLD.seed ^ 0xb0a);
  const out = [];
  for (const p of lattice(minX, maxX, minZ, maxZ, 13, WORLD.seed ^ 0xb0b)) {
    const zone = zoneOf(p.x, p.z).id;
    if (zone !== 6 && zone !== 7) continue;
    if (waterDepth(p.x, p.z) > 0.25) continue;
    const nearCave = Math.hypot(p.x - FEATURES.caveMouth.x, p.z - FEATURES.caveMouth.z);
    const prob = zone === 7 ? 0.62 : 0.30;
    if (rand() > prob) continue;
    const slope = slopeDegrees(p.x, p.z, 1.5);
    const size = lerp(0.5, 2.6, Math.pow(rand(), 1.5)) * (zone === 7 ? 1.25 : 1)
      * (1 + 0.35 * ramp(slope, 12, 38));
    if (nearCave < 9) continue;
    out.push({
      x: p.x, z: p.z, y: terrainHeight(p.x, p.z) - size * lerp(0.05, 0.32, rand()),
      size, rot: rand() * Math.PI * 2, pitch: (rand() - 0.5) * 0.5, roll: (rand() - 0.5) * 0.5,
      grey: clamp(0.66 + 0.16 * rand() - 0.12 * moisture(p.x, p.z), 0.35, 0.86),
    });
  }
  /* The fan the mouth pushes out, and the lip the stream drops over: deliberately
     bigger, deliberately clustered, because that is what a collapse entrance has. */
  const cave = CAVE.position;
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const r = lerp(11, 30, rand());
    const x = cave.x - Math.cos(a) * r * 0.8 - cave.frame.tx * r * 0.55;
    const z = cave.z - Math.sin(a) * r * 0.8 - cave.frame.tz * r * 0.55;
    if (waterDepth(x, z) > 0.1) continue;
    const size = lerp(1.2, 4.4, Math.pow(rand(), 1.4));
    out.push({
      x, z, y: terrainHeight(x, z) - size * 0.18, size,
      rot: rand() * 6.28, pitch: (rand() - .5) * .7, roll: (rand() - .5) * .7,
      grey: clamp(0.62 + 0.2 * rand(), 0.35, 0.88), hero: true,
    });
  }
  return out;
}

/* ============================================================== groundcover */

/**
 * Reeds, tussock and brush: the wet band's own silhouette. Placed from depth and
 * moisture alone, which is the whole reason a riverbank reads as a riverbank.
 */
export function buildGroundCover() {
  const { minX, maxX, minZ, maxZ } = WORLD.bounds;
  const out = [];
  const rand = makeRandom(WORLD.seed ^ 0x9e1d);
  for (const p of lattice(minX, maxX, minZ, maxZ, 3.4, WORLD.seed ^ 0x9e1e)) {
    const depth = waterDepth(p.x, p.z);
    const wet = moisture(p.x, p.z);
    const zone = zoneOf(p.x, p.z).id;
    let height = 0, kind = null, density = 0;

    if (depth >= RULES.reedDepth[0] && depth <= RULES.reedDepth[1] && depth > 0.02) {
      kind = "reed"; height = lerp(0.9, 2.1, rand()); density = 1;
    } else if (depth < 0.02 && wet > RULES.reedMoisture && (zone === 4 || zone === 1 || zone === 9)) {
      kind = "tussock"; height = lerp(0.28, 0.62, rand()); density = 1;
    } else if (wet > 0.40 && (zone === 5 || zone === 4 || zone === 9) && rand() < 0.42) {
      kind = "brush"; height = lerp(0.35, 1.15, rand()); density = 1;
    } else if ((zone === 0 || zone === 2) && wet > 0.30 && rand() < 0.16) {
      kind = "grass"; height = lerp(0.30, 0.58, rand()); density = 1;   // a grazed sward, not a jungle
    }
    if (!kind) continue;
    /* The fouled bank is a dead one: the growth right at the water's edge thins
       out, which is how the player reads that something is wrong with the water
       before any of it is explained to them. */
    const foul = fouling(p.x, p.z);
    if (foul > 0.42 && kind !== "reed" && rand() < foul * 0.65) continue;
    out.push({
      kind, x: p.x, z: p.z, y: terrainHeight(p.x, p.z) - 0.03,
      height, width: height * lerp(0.35, 0.62, rand()),
      rot: rand() * 6.28, lean: (rand() - 0.5) * 0.5,
      grey: clamp((kind === "reed" ? 0.36 : kind === "tussock" ? 0.40 : 0.44)
        + 0.12 * (rand() - 0.5) - 0.10 * foul + (kind === "grass" ? 0.18 : 0), 0.12, 0.70),
      density,
    });
  }
  return out;
}

/* ================================================================== props */

/**
 * The hand-made things, authored (not scattered) because every one of them is a
 * decision about scale, wear or the route. Sizes are the REAL table's business:
 * tools/check_world.mjs measures these numbers against the built mesh.
 */
export function buildProps() {
  const props = [];
  const add = (p) => { props.push(p); return p; };

  /* --- the plank footbridge over the First Fork ------------------------- */
  {
    const f = FORK.at(BRIDGE_S);
    const c = channelShape(f.x, f.z, FORK);
    const deckY = Math.max(c.bank, c.ws + 0.55) + 0.06;
    const half = Math.max(c.edge, c.w * 1.25) + 2.4;
    const span = half * 2;
    const width = 1.8, railH = 1.0, plankW = 0.24;
    props.push({
      id: "bridge.deck", kind: "deck",
      x: f.x, z: f.z, yaw: Math.atan2(f.tx, f.tz), y: deckY,
      size: { x: span, y: 0.16, z: width },
      authored: { span, width, deckThickness: 0.16, planks: Math.round(span / plankW) },
    });
    for (let i = 0; i < Math.floor(span / plankW); i++) {
      const along = -half + (i + 0.5) * plankW;
      add({
        id: `bridge.plank.${i}`, kind: "plank",
        x: f.x + f.tx * along, z: f.z + f.tz * along, yaw: Math.atan2(f.tx, f.tz), y: deckY + 0.02,
        size: { x: plankW * 0.94, y: 0.05, z: width * lerp(0.94, 1.0, (i % 3) / 2) },
        grey: 0.30 + (i % 5) * 0.018,
      });
    }
    /* Three pairs of piles; the middle pair stands in the channel. */
    for (const along of [-half + 0.3, 0, half - 0.3]) {
      for (const side of [-1, 1]) {
        const lat = side * (width / 2 + 0.16);
        const x = f.x + f.tx * along + f.nx * lat, z = f.z + f.tz * along + f.nz * lat;
        const baseY = Math.min(terrainHeight(x, z), c.ws - c.depth);
        add({
          id: `bridge.pile.${along.toFixed(1)}.${side}`, kind: "pile",
          x, z, y: (baseY + deckY) / 2, yaw: Math.atan2(f.tx, f.tz),
          size: { x: 0.20, y: deckY - baseY + 0.5, z: 0.20 }, grey: 0.26,
        });
        add({
          id: `bridge.post.${along.toFixed(1)}.${side}`, kind: "post",
          x, z, y: deckY + railH / 2, yaw: Math.atan2(f.tx, f.tz),
          size: { x: 0.11, y: railH, z: 0.11 }, grey: 0.28,
        });
      }
    }
    for (const side of [-1, 1]) {
      const lat = side * (width / 2 + 0.16);
      add({
        id: `bridge.rail.${side}`, kind: "rail",
        x: f.x + f.nx * lat, z: f.z + f.nz * lat, y: deckY + railH * 0.92,
        yaw: Math.atan2(f.tx, f.tz), size: { x: span * 0.99, y: 0.09, z: 0.14 }, grey: 0.29,
      });
    }
    add({
      id: "bridge.approach.n", kind: "approach",
      x: f.x + f.nx * (half + 1.6), z: f.z + f.nz * (half + 1.6), y: terrainHeight(f.x + f.nx * (half + 1.6), f.z + f.nz * (half + 1.6)),
      yaw: Math.atan2(f.tx, f.tz), size: { x: 3.2, y: 0.1, z: width }, grey: 0.4,
    });
  }

  /* --- the log jam across the channel, and its pool --------------------- */
  {
    const s = FORK.obstructions[0].s;
    const f = FORK.at(s);
    const c = channelShape(f.x, f.z, FORK);
    const rand = makeRandom(0xbea1);
    for (let i = 0; i < 11; i++) {
      const lat = lerp(-c.edge * 1.05, c.edge * 1.05, i / 10) + (rand() - 0.5) * 0.5;
      const x = f.x + f.nx * lat, z = f.z + f.nz * lat;
      const y = c.ws - 0.1 + rand() * 0.5;
      add({
        id: `weir.log.${i}`, kind: "log",
        x, z, y, yaw: Math.atan2(f.tx, f.tz) + (rand() - 0.5) * 1.5,
        size: { x: lerp(1.6, 5.2, rand()), y: lerp(0.20, 0.52, rand()), z: lerp(0.20, 0.52, rand()) },
        grey: 0.24 + rand() * 0.1,
      });
    }
    add({
      id: "weir.wedge", kind: "mudwedge",
      x: f.x, z: f.z, y: c.ws - 0.25, yaw: Math.atan2(f.tx, f.tz),
      size: { x: 1.4, y: 0.55, z: c.edge * 2.2 }, grey: 0.34,
    });
  }

  /* --- the landing stage below the village ------------------------------ */
  {
    const s = 205;
    const f = ERY.at(s);
    const lat = -ERY.bankhalf(s) - 3.0;                  // the south side here is the bank
    const x = f.x + f.nx * lat, z = f.z + f.nz * lat;
    const deckY = ERY.ws(s) + 0.42;
    add({
      id: "landing.deck", kind: "deck", x, z, y: deckY, yaw: Math.atan2(f.tx, f.tz),
      size: { x: 5.6, y: 0.14, z: 2.6 }, grey: 0.30,
    });
    for (const along of [-2.4, 0, 2.4]) for (const side of [-1, 1]) {
      const px = x + f.tx * along + f.nx * side * 1.2, pz = z + f.tz * along + f.nz * side * 1.2;
      add({
        id: `landing.pile.${along}.${side}`, kind: "pile", x: px, z: pz,
        y: (terrainHeight(px, pz) + deckY) / 2, yaw: Math.atan2(f.tx, f.tz),
        size: { x: 0.2, y: deckY - terrainHeight(px, pz) + 0.4, z: 0.2 }, grey: 0.25,
      });
    }
    /* A punt, tied up and half sunk in weeds: 4.6 m, per the scale table. */
    add({
      id: "punt", kind: "boat",
      x: x + f.nx * 3.0, z: z + f.nz * 3.0, y: ERY.ws(s) + 0.06,
      yaw: Math.atan2(f.tx, f.tz) + 0.35, size: { x: 4.6, y: 0.46, z: 1.24 }, grey: 0.33,
    });
  }

  /* --- field edge: the stile and the fence the meadow is kept by --------- */
  {
    const f = ERY.at(120);
    const lat = 22;
    const x = f.x + f.nx * lat, z = f.z + f.nz * lat;
    for (let i = -5; i <= 5; i++) {
      const px = x + f.tx * i * 3.2, pz = z + f.tz * i * 3.2;
      add({
        id: `fence.post.${i}`, kind: "post", x: px, z: pz,
        y: terrainHeight(px, pz) + 1.15 / 2, yaw: Math.atan2(f.tx, f.tz),
        size: { x: 0.14, y: 1.15, z: 0.14 }, grey: 0.31,
      });
      if (i < 5) {
        const qx = x + f.tx * (i + 0.5) * 3.2, qz = z + f.tz * (i + 0.5) * 3.2;
        add({
          id: `fence.rail.${i}`, kind: "rail", x: qx, z: qz,
          y: terrainHeight(qx, qz) + 1.02, yaw: Math.atan2(f.tx, f.tz),
          size: { x: 3.2, y: 0.08, z: 0.13 }, grey: 0.30,
        });
      }
    }
    /* The stile: four rises of 0.36 m, which is what a stile is. */
    const sx = x + f.tx * 4.6, sz = z + f.tz * 4.6;
    for (let k = 0; k < 3; k++) {
      add({
        id: `stile.step.${k}`, kind: "step", x: sx, z: sz,
        y: terrainHeight(sx, sz) + 0.36 * (k + 1) - 0.06,
        yaw: Math.atan2(f.nx, f.nz), size: { x: 1.2, y: 0.12, z: 0.34 }, grey: 0.36,
      });
    }
  }

  /* --- the fording place: a paved shallow, wider than the channel ------- */
  {
    const s = 12;
    const f = FORK.at(s);
    const c = channelShape(f.x, f.z, FORK);
    add({
      id: "ford.cobbles", kind: "apron", x: f.x, z: f.z, y: c.ws - 0.16,
      yaw: Math.atan2(f.nx, f.nz), size: { x: 4.0, y: 0.1, z: c.edge * 2.5 }, grey: 0.62,
      flat: true,
    });
  }

  return props;
}

/* ------------------------------------------------------------------- cave */

/**
 * The mouth: a massed rock front with an arch cut through it, a floor that meets
 * the stream, and a short box of interior so the opening reads as a place you
 * could enter rather than a decal. The cave proper is P1's problem; the mouth is
 * the destination of every sightline in the upper half of the sector, so it has to
 * be right now.
 */
export function buildCave() {
  const c = CAVE.position;
  const s = FORK.project(c.x, c.z);
  const ws = FORK.ws(s);
  const bed = FORK.bed(s);
  const halfW = CAVE.width / 2;
  const crown = bed + CAVE.height;
  const yaw = Math.atan2(c.frame.tx, c.frame.tz);
  return {
    yaw,
    bed, ws, crown,
    sill: { x: c.x, z: c.z, y: bed },
    arch: { width: CAVE.width, height: CAVE.height, springing: bed + CAVE.springing },
    /** The rock front: piers either side and a lintel above the arch. */
    front: [
      { id: "cave.pier.w", x: c.x - c.frame.nz * (halfW + 2.2), z: c.z + c.frame.nx * (halfW + 2.2), y: bed + 2.6,
        size: { x: 5.0, y: 7.6, z: 4.4 }, rot: yaw, grey: 0.66 },
      { id: "cave.pier.e", x: c.x + c.frame.nz * (halfW + 2.2), z: c.z - c.frame.nx * (halfW + 2.2), y: bed + 2.6,
        size: { x: 5.0, y: 7.6, z: 4.4 }, rot: yaw, grey: 0.64 },
      { id: "cave.lintel", x: c.x, z: c.z, y: crown + 1.5,
        size: { x: CAVE.width + 9.6, y: 3.2, z: 4.0 }, rot: yaw, grey: 0.68 },
      { id: "cave.roof", x: c.x + c.frame.tx * CAVE.depth * 0.5, z: c.z + c.frame.tz * CAVE.depth * 0.5,
        y: crown + 2.4, size: { x: CAVE.width + 6, y: 2.4, z: CAVE.depth }, rot: yaw, grey: 0.60 },
      { id: "cave.floor", x: c.x + c.frame.tx * CAVE.depth * 0.5, z: c.z + c.frame.tz * CAVE.depth * 0.5,
        y: bed, size: { x: CAVE.width, y: 0.3, z: CAVE.depth }, rot: yaw, grey: 0.42 },
      { id: "cave.wall.n", x: c.x - c.frame.nz * (halfW - 0.35), z: c.z + c.frame.nx * (halfW - 0.35),
        y: bed + CAVE.height * 0.5, size: { x: 0.7, y: CAVE.height + 3, z: CAVE.depth }, rot: yaw, grey: 0.58 },
      { id: "cave.wall.s", x: c.x + c.frame.nz * (halfW - 0.35), z: c.z - c.frame.nx * (halfW - 0.35),
        y: bed + CAVE.height * 0.5, size: { x: 0.7, y: CAVE.height + 3, z: CAVE.depth }, rot: yaw, grey: 0.56 },
      { id: "cave.back", x: c.x + c.frame.tx * (CAVE.depth - 0.4), z: c.z + c.frame.tz * (CAVE.depth - 0.4),
        y: bed + CAVE.height * 0.55, size: { x: CAVE.width + 1.2, y: CAVE.height + 3.4, z: 0.8 }, rot: yaw, grey: 0.5 },
    ],
  };
}

/* ------------------------------------------------------------------ export */

/** Everything that stands up, in one deterministic call. */
export function populate() {
  return { trees: buildTrees(), boulders: buildBoulders(), groundCover: buildGroundCover(), props: buildProps(), cave: buildCave() };
}

void lerp; void clamp; void ZONES;
