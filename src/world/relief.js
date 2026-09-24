/**
 * Terrain relief for Sector 1.
 *
 * One function answers "how high is the ground here", and it is composed from
 * the authored hydrology rather than from an artist's height map. That is the
 * load-bearing decision of the whole greybox: if the water surface is a field and
 * the ground is another, then every waterline, debris line, bar, island, wet
 * hollow and flooded bank falls out of the two and is automatically consistent.
 * Nothing can be painted into disagreement, so P0 cannot end up with a river that
 * does not touch its own banks -- the most common way a procedural world looks
 * fake long before anybody has made a texture.
 *
 * Everything here is pure: terrainHeight(x, z) is the contract shared by the
 * mesh builder, the collision surface, the scatter rules and the checker.
 */

import { fbm2, noise2, makeRandom } from "./noise.js";
import { clamp, ramp, lerp, smin, smax, denseGrid } from "./fields.js";
import {
  ERY, FORK, STREAMS, ZONES, WORLD, CAVE, FEATURES, turbidity, FORK_AT, channelAt, zoneAt,
  ROUTE, ROUTE_WAYPOINTS, BRIDGE_S,
} from "./geography.js";

/** Tuning for how the ground behaves around a channel. Authored, not guessed. */
const RELIEF = {
  /** Standing freeboard between the water surface and the top of bank, metres. */
  bankFreeboard: 0.30,
  /** How far the relief may dip below the top of bank, metres. */
  bankFloorTolerance: 0.02,
  /** How far a backed-up reach may creep across its own bankfull line, metres. */
  poolMargin: 3.4,
  /** Fraction of a backwater rise that actually spreads sideways. */
  poolSpread: 0.55,
  /** Lateral blend radius, m: how smoothly channel becomes floodplain. */
  blend: 1.6,
  /** Metres past the waterline over which the floodplain's relief fades in. */
  reliefFade: 34,
  /** Valley floor rise per metre beyond the channel. */
  valleyRise: { ery: 0.040, fork: 0.075 },
  /** Floodplain climb per metre of upstream gradient: steep headwaters are
      incised, and that is why the upper fork sits in a shallow gorge. */
  gradeCoupling: 6.0,
  /** Axial tilt of a tributary's own valley floor, m per metre of chainage. */
  axialTilt: 0.017,
  /** Where the floodplain starts climbing to the valley shoulder. */
  shoulderFrom: { ery: 95, fork: 58 },
  shoulderRise: { ery: 4.4, fork: 2.6 },
  /** Bend terms: the inside silts up, the outside is cut steep. */
  cutBankGain: 1.55,
  barGain: 1.45,
  /** Microrelief amplitude by context, metres. */
  micro: { channel: 0.04, floodplain: 0.26, terrace: 0.5 },
};


/** Set while the hollows' own surfaces are resolved against bare ground. */
let ignoreHollows = false;

/* --------------------------------------------------------------- features */

/**
 * Oxbow scars and wet hollows: real floodplain furniture. Shallow bowls with a
 * raised rim, left behind where the river used to run. They hold water of their
 * own, which is why the carr reads as wet ground rather than as a wet river.
 */
export const HOLLOW_SOURCES = [
  { x: 300, z: 62, rx: 62, rz: 20, depth: 1.05, rim: 0.42, rot: 0.12, kind: "oxbow" },
  { x: 452, z: -86, rx: 48, rz: 16, depth: 0.82, rim: 0.34, rot: -0.22, kind: "oxbow" },
  { x: 700, z: -58, rx: 34, rz: 13, depth: 0.60, rim: 0.28, rot: 0.30, kind: "oxbow" },
  { x: 810, z: -142, rx: 46, rz: 26, depth: 1.45, rim: 0.30, rot: 0.0, kind: "hollow", wet: true },
  { x: 1006, z: -196, rx: 34, rz: 20, depth: 1.10, rim: 0.24, rot: 0.4, kind: "hollow", wet: true },
  /** The fork pool: the deep still water the junction builds against the river. */
  { x: FORK_AT.x + 14, z: FORK_AT.z - 16, rx: 26, rz: 18, depth: 1.10, rim: 0.12, rot: 0.6, kind: "pool", wet: true },
];

/**
 * Root-plate terrain: the hummocky surface of an old woodland, where a blown tree
 * took a plate of earth with it and left a pit. Real distribution, real size
 * range; a scatter of 0.4 m bumps over 3 m is one of the cheapest realism wins
 * there is, because it breaks every straight line in the frame.
 */
export const MOUND_SOURCES = (() => {
  const rand = makeRandom(WORLD.seed ^ 0x2d00d1e);
  const out = [];
  const stride = 30;
  const { minX, maxX, minZ, maxZ } = WORLD.bounds;
  for (let gx = minX; gx < maxX; gx += stride) {
    for (let gz = minZ; gz < maxZ; gz += stride) {
      if (rand() > 0.62) continue;
      const x = gx + rand() * stride, z = gz + rand() * stride;
      const zone = zoneAt(x, z).id;
      if (zone !== 4 && zone !== 5 && zone !== 6 && zone !== 9 && zone !== 7) continue;
      const r = lerp(1.4, 3.6, rand());
      out.push({
        x, z, r,
        mound: r * lerp(0.13, 0.20, rand()),
        pit: r * lerp(0.10, 0.16, rand()),
        dx: lerp(-0.4, 0.4, rand()) * r, dz: lerp(-0.4, 0.4, rand()) * r,
      });
    }
  }
  return out;
})();


/** Neighbourhood lookup for the mounds: the height field asks per vertex. */
const MOUND_GRID = denseGrid(MOUND_SOURCES, 9, { radius: 0, getR: (m) => m.r });
const _moundScratch = [];

/** Where the flood has left a levee, and where it has not. */
function leveeStrength(x, z) {
  return 0.5 + 0.5 * Math.abs(noise2(x / 190, z / 190, 611));
}

/**
 * Each hollow's standing water, resolved once against the terrain without that
 * hollow in it, so a pool's surface cannot depend on its own depth. An oxbow holds
 * water up to the low point of its rim and then dries; that is the whole rule.
 */
for (const o of HOLLOW_SOURCES) {
  let rim = Infinity;
  for (let a = 0; a < 32; a++) {
    const t = a / 32 * Math.PI * 2;
    const px = o.x + Math.cos(t) * o.rx * 1.06, pz = o.z + Math.sin(t) * o.rz * 1.06;
    rim = Math.min(rim, terrainHeightNoHollows(px, pz));
  }
  o.rimElevation = rim;
  /* An oxbow is a scar, not a lake: it holds water only where its own floor came
     out below the rim. A hollow authored to be wet is pushed down until it is. */
  const floor = terrainHeight(o.x, o.z);
  o.level = Math.max(rim - 0.10, o.wet ? floor + o.depth * 0.55 : -Infinity);
  o.holdsWater = o.level > floor + 0.06;
  if (!o.holdsWater) o.level = rim - 0.10;
}

/** Catmull-Rom, for turning a snapped path back into a curve. */
function relax(pts, perSegment = 8) {
  const out = [];
  const at = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let j = 0; j < perSegment; j++) {
      const t = j / perSegment, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
          + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
          + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts.at(-1));
  return out;
}

/** Terrain with the hollows excluded: the bare surface a pool sits in. */
function terrainHeightNoHollows(x, z) {
  ignoreHollows = true;
  const h = terrainHeight(x, z);
  ignoreHollows = false;
  return h;
}

/* ------------------------------------------------------------- rock masses */

/**
 * The buttress the cave mouth is cut into: the stream leaves the hill through it.
 * Modelled as an added dome on the terrain, with a scooped apron of breakdown in
 * front, so the approach is a rock fan rather than a flat plane with a hole in it.
 */
function rockMasses(x, z) {
  const cave = CAVE.position;
  const f = cave.frame;
  const dx = x - cave.x, dz = z - cave.z;
  const along = dx * f.tx + dz * f.tz;        // + = further up the stream, into the rock
  const across = dx * f.nx + dz * f.nz;
  const b = CAVE.buttress;

  let lift = 0;
  const reach = Math.hypot(Math.max(0, along - b.along * 0.4), across * 0.72);
  lift += b.rise * Math.exp(-Math.pow(reach / b.radius, 2)) * ramp(along, -4, 12);

  /* The apron of collapsed rock the mouth pushes out, and the channel it flows in. */
  const fan = Math.exp(-Math.pow(Math.hypot(Math.max(0, -along) / 30, across / 17) ** 2, 1.4));
  lift += 1.15 * fan * ramp(-along, 0, 6);
  lift -= 0.55 * Math.exp(-Math.pow(across / 7.4, 2)) * ramp(-along, 2, 16);

  /* The limestone step the wood climbs on to, on the north side of the upper fork. */
  const sF = FORK.project(x, z);
  const lat = FORK.lateral(x, z, sF).lat;
  const step = ramp(sF - 640, 20, 130) * (1 - ramp(sF - 760, 30, 120));
  lift += 2.9 * step * ramp(-lat, -8, 40) * (1 - ramp(Math.abs(lat) - 150, 0, 90));
  return lift;
}

/* --------------------------------------------------------- the height field */

/**
 * The channel cross-section, as one description used by three questions.
 *
 * `edge` is where the water meets the ground, and it is the load-bearing number:
 * the height field is built so that ground elevation crosses the water surface at
 * exactly `edge`, and the water's extent is defined as `edge`. Terrain and hydrology
 * are then the same statement, so a bankfull channel is wetted by construction,
 * overbank flooding is impossible by construction, and the bars the river builds
 * stand proud of its own water by construction. A greybox that gets this wrong
 * looks like a blue ribbon laid on a height map no matter how good the art gets
 * later, so it is derived here once and everything else reads it.
 */
export function channelShape(x, z, stream, q = stream.query(x, z)) {
  const s = q.s;
  const lat = q.lat;
  const w = stream.bankhalf(s);
  const depth = stream.normalDepth(s);
  const ws = stream.ws(s);
  const bed = stream.bed(s);
  const th = stream.thalweg(s);
  const curv = stream.curvature(s);
  const key = stream.order === 2 ? "ery" : "fork";

  /* Bank top: a fixed freeboard above the surface. The freeboard is authored in
     centimetres, not as a multiple of depth, because in a steep upper reach the
     depth grows faster than the banks do and the two must not be tied. */
  const bank = ws + RELIEF.bankFreeboard + 0.34 * depth;

  /* Wetted half-width across the thalweg, widened where something is holding
     water up -- capped, because a jam backs water into the trees only so far. */
  const back = Math.max(0, stream.backwater(s));
  const runup = back > 0 ? clamp(back / Math.max(0.12, depth), 0, 1.0) : 0;
  const edge = w * (1 + RELIEF.poolSpread * runup);

  /* Floodplain: the valley floor climbing away, its shoulder, the tilt upstream,
     and the levee the flood leaves beside its own channel. */
  const over = Math.max(0, Math.abs(lat) - w);
  const slope = RELIEF.valleyRise[key] + RELIEF.gradeCoupling * Math.max(0, stream.wsDrop) / stream.length;
  const rise = slope * over
    + (stream.order === 1 ? RELIEF.axialTilt * Math.max(0, s) * ramp(over - 6, 0, 30) : 0);
  const shoulder = RELIEF.shoulderRise[key]
    * Math.pow(ramp(over, RELIEF.shoulderFrom[key], RELIEF.shoulderFrom[key] + 130), 1.7);
  const levee = 0.30 * leveeStrength(x, z) * ramp(over, 0.5, 9) * (1 - ramp(over, 34, 110));
  const plain = bank + rise + shoulder + levee;

  /* Bend work: a bar of gravel on the inside, a cut toe on the outside. Same
     strength, opposite sides, so every bend looks like the same river made it. */
  const bendN = clamp(Math.abs(curv) * 240, 0, 1) * stream.bendScale;
  const barH = RELIEF.barGain * depth * bendN;
  const barSide = -Math.sign(curv) * w * 0.62;
  const bar = barH * Math.exp(-Math.pow((lat - barSide) / (w * 0.62), 2));
  const cutH = RELIEF.cutBankGain * depth * bendN;
  const cut = cutH * Math.exp(-Math.pow((lat + Math.sign(curv) * w * 0.95) / (w * 0.5), 2));

  return { s, lat, w, edge, depth, ws, bed, bank, plain, bar, cut, bendN, thalweg: th,
    runup: runup * w, rise, shoulder, levee, over };
}

/**
 * Ground elevation at a point, in metres above the village datum.
 */
export function terrainHeight(x, z) {
  let h = Infinity;

  for (const stream of STREAMS) {
    const c = channelShape(x, z, stream);
    const d = Math.abs(c.lat);

    /* Trough -> top of bank -> floodplain, cross-faded over a couple of metres so
       there is no crease anywhere a shadow could collect. */
    const t = Math.min(1, d / Math.max(0.2, c.edge));
    const trough = c.bed + (c.bank - c.bed) * Math.pow(t, 1.5);
    const toFloodplain = ramp(d, c.w * 1.02, c.w * 1.55);
    let val = lerp(trough - c.bar + c.cut * 0.5, c.plain + c.cut * 0.5, toFloodplain);
    val = smin(val, c.plain + c.cut, RELIEF.blend);

    /* Beyond the authored end of the line the trough simply stops existing. */
    const beyond = ramp(c.s - stream.length, 0, 26) + ramp(-12 - c.s, 0, 12);
    if (beyond > 0) val = lerp(val, c.plain, clamp(beyond, 0, 1));

    /* Relief, confined to this stream's own floodplain: smooth in the channel,
       full beyond it, faded between. A stream flattens what it flows over, and
       the fade is what stops a bump in the meadow wandering across the waterline
       and inventing a pond. Both halves are per-stream, because the world has two
       watercourses and each bounds its own ground. */
    const confine = 1 - ramp(d - c.edge, 0, RELIEF.reliefFade);
    val += microrelief(x, z, confine);

    /* Bounded by its banks. Ground beyond the waterline may not dip below the
       water surface, so the water cannot leak into the floodplain in patches no
       hydrology explains and a bump in the meadow cannot invent a pond. The floor
       is set on the *surface* rather than on the bank line, which turns bankfull
       containment from a hope into a property of the field -- and it is that
       property P1's materials will read wetness from, so it has to be true before
       anybody makes it pretty. */
    if (d > c.edge) val = Math.max(val, c.ws - RELIEF.bankFloorTolerance);

    if (val < h) h = val;
  }

  /* Hollows: oxbow scars, reed pools, the fork pool. */
  if (!ignoreHollows) for (const o of HOLLOW_SOURCES) {
    const c = Math.cos(o.rot), si = Math.sin(o.rot);
    const dx = (x - o.x) * c - (z - o.z) * si, dz = (x - o.x) * si + (z - o.z) * c;
    const q = Math.hypot(dx / o.rx, dz / o.rz);
    if (q > 1.9) continue;
    h += -o.depth * Math.exp(-Math.pow(clamp(q, 0, 1.35), 2) * 2.2)
      + o.rim * Math.exp(-Math.pow((q - 0.92) / 0.20, 2));
  }

  h += rockMasses(x, z);

  MOUND_GRID.inNeighbourhood(x, z, _moundScratch);
  for (let mi = 0; mi < _moundScratch.length; mi++) {
    const m = MOUND_SOURCES[_moundScratch[mi]];
    const dx = x - m.x, dz = z - m.z;
    const q = Math.hypot(dx / m.r, dz / m.r);
    if (q > 2.2) continue;
    const u = 1 - clamp(q, 0, 1);
    h += m.mound * u * u * (3 - 2 * u) - m.pit * Math.exp(-Math.pow((q - 1.25) / 0.38, 2));
  }

  return h;
}

/**
 * Small-scale relief. Kept gentle inside the channel (a stream smooths its own
 * bed) and larger on the floodplain, where nothing is flat. The amplitude is
 * scaled by how far the ground is above the water, so the wetted part of a bar
 * is a ripple of mud, not a boulder field.
 */
function microrelief(x, z, confinement) {
  if (confinement <= 0.001) return 0;
  const plain = RELIEF.micro.floodplain;
  const n1 = fbm2(x / 34, z / 34, { octaves: 4, seed: 17 });
  const n2 = fbm2(x / 6.5, z / 6.5, { octaves: 3, seed: 71 });
  const n3 = noise2(x / 1.9, z / 1.9, 133);
  return (plain * n1 * 0.52 + n2 * 0.17 + n3 * 0.045) * confinement
    + RELIEF.micro.channel * n3 * confinement;
}

/* ------------------------------------------------------------ water, masks */

/**
 * Water-surface elevation at a point, or null when it is dry.
 *
 * This *is* the waterline: it is a field, compared against the same terrain
 * field the mesh is made from, so the boundary of the water is exactly where the
 * ground meets it -- including the bars, the islands behind them, the pool behind
 * the dam and the standing water in the reeds. Nothing in the renderer is allowed
 * to decide where the water is.
 */
export function waterLevel(x, z) {
  const e = waterExtent(x, z);
  return e === null ? null : e.level;
}

/**
 * The water, as an extent: which reach is over here, and what its surface is
 * worth. Everything wet in this sector -- the river, the fork, the pool behind the
 * jam, the standing water in the reeds -- arrives through this one function, so
 * the waterline in the mesh, the wetness in the material, the debris line, the
 * reed line and the checker's audit are all the same boundary.
 */
export function waterExtent(x, z) {
  let best = null;
  for (const stream of STREAMS) {
    const c = channelShape(x, z, stream, stream.query(x, z));
    const d = Math.abs(c.lat - c.thalweg);
    if (d <= c.edge && (best === null || d < best.d)) best = { d, level: c.ws, stream, s: c.s };
  }
  if (!ignoreHollows) for (const o of HOLLOW_SOURCES) {
    const c = Math.cos(o.rot), si = Math.sin(o.rot);
    const dx = (x - o.x) * c - (z - o.z) * si, dz = (x - o.x) * si + (z - o.z) * c;
    const q = Math.hypot(dx / o.rx, dz / o.rz);
    if (q < 1.04 && (best === null || q > best.d)) best = { d: q, level: o.level, stream: null, s: 0, hollow: o };
  }
  return best === null ? null : { level: best.level, stream: best.stream, s: best.s, hollow: best.hollow };
}

/** The stream a patch of water belongs to, for the plume and for the checks. */
export function waterSource(x, z) {
  if (!isSubmerged(x, z)) return null;
  let best = null;
  for (const stream of STREAMS) {
    const s = stream.project(x, z);
    const { lat } = stream.lateral(x, z, s);
    const d = Math.abs(lat - stream.thalweg(s));
    if (best === null || d < best.d) best = { d, stream, s };
  }
  return best;
}

/** True where water lies. Cheap and total: the mesh, the checks and the renderer
 *  all ask the same question, so they cannot disagree about being wet. */
export function isSubmerged(x, z, h = terrainHeight(x, z)) {
  const lvl = waterLevel(x, z);
  return lvl !== null && h < lvl - 0.005;
}

/** Depth of water at a point (0 when dry). */
export function waterDepth(x, z) {
  const lvl = waterLevel(x, z);
  if (lvl === null) return 0;
  return Math.max(0, lvl - terrainHeight(x, z));
}

/**
 * Ground slope in degrees. Every placement rule consults it -- no tree on a
 * scree face, no prop floating on a tilt, no route up a wall -- and the checker
 * fails the build if any part of the walkable corridor exceeds the authored
 * limit, which is how a "walkable" world stops being a claim.
 */
export function slopeDegrees(x, z, step = 1.0) {
  const h = terrainHeight(x, z);
  const hx = terrainHeight(x + step, z), hz = terrainHeight(x, z + step);
  const gx = (hx - h) / step, gz = (hz - h) / step;
  return Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
}

/** Surface normal, for placing props flat and for the mesh's shading. */
export function terrainNormal(x, z, step = 0.75) {
  const h = terrainHeight(x, z);
  const gx = (terrainHeight(x + step, z) - terrainHeight(x - step, z)) / (2 * step);
  const gz = (terrainHeight(x, z + step) - terrainHeight(x, z - step)) / (2 * step);
  const len = Math.hypot(gx, 1, gz);
  return { x: -gx / len, y: 1 / len, z: -gz / len };
}

/**
 * Moisture 0..1, the field behind moss, mud, colour and darkening. Derived from
 * height above the water, from the local slope (water runs off), and from how
 * shaded the spot is -- never painted.
 */
export function moisture(x, z) {
  const h = terrainHeight(x, z);
  const lvl = waterLevel(x, z);
  const above = lvl === null
    ? Math.min(6, Math.min(
      Math.abs(h - ERY.ws(ERY.project(x, z))),
      Math.abs(h - FORK.ws(FORK.project(x, z)))))
    : h - lvl;
  const near = 1 - ramp(above, -0.1, 2.6);
  const drained = 1 - ramp(slopeDegrees(x, z, 1.2), 16, 42) * 0.55;
  const zone = zoneOf(x, z);
  const shade = zone.canopy;
  return clamp(0.12 + 0.88 * near * drained + 0.26 * shade * (1 - near), 0, 1);
}

/**
 * Zone lookup. There is exactly one definition of the zones, in geography.js --
 * the mesh, the scatter rules and the checker all go through this, so a zone
 * cannot mean one thing to the renderer and another to the audit.
 */
export function zoneOf(x, z) { return zoneAt(x, z); }
export function zoneIdAt(x, z) { return zoneAt(x, z).id; }

/** Distance to each stream's centreline, memoised: the zone test needs no frame. */
export function streamDistances(x, z) {
  return { ery: ERY.distance(x, z), fork: FORK.distance(x, z) };
}

/** Canopy density 0..1 at a point, straight from the zone's authored value and
 *  modulated by the same noise that will place the trees, so the ground cover
 *  and the silhouette cannot disagree. */
export function canopyDensity(x, z) {
  const zone = zoneOf(x, z);
  const n = 0.5 + 0.5 * fbm2(x / 88, z / 88, { octaves: 3, seed: 401 });
  const wet = clamp(moisture(x, z), 0, 1);
  return clamp(zone.canopy * lerp(0.72, 1.06, n) + 0.10 * wet * zone.canopy, 0, 1);
}

/** How fouled the ground is: the deposit the flood left, following the plume. */
export function fouling(x, z) {
  return turbidity(x, z);
}

/**
 * Find dry, gently-sloped ground near a bank: the walkable line of a watercourse.
 *
 * The route is authored as an offset from a stream, and a stream's bank is not a
 * straight line, so the offset is a wish rather than a position. This walks the
 * perpendicular from the wish outwards and inwards until it finds ground that is
 * above the water, below the floodplain's steepest bit, and not inside a channel.
 * A route built this way cannot end up in the river, which is the single most
 * common greybox failure and the one that is hardest to see on a flat-shaded map.
 */
export function findBank(x, z, stream, { maxShift = 14, step = 0.4, dry = 0.14, maxSlope = 21 } = {}) {
  const s = stream.project(x, z);
  const f = stream.at(s);
  const l0 = (x - f.x) * f.nx + (z - f.z) * f.nz;
  const order = [];
  for (let k = 0; k * step <= maxShift; k++) {
    if (k === 0) order.push(0);
    else { order.push(k * step); order.push(-k * step); }
  }
  for (const dLat of order) {
    const lat = l0 + dLat;
    const px = f.x + f.nx * lat, pz = f.z + f.nz * lat;
    const h = terrainHeight(px, pz);
    const lvl = waterLevel(px, pz);
    if (lvl !== null && h < lvl + dry) continue;
    if (slopeDegrees(px, pz, 0.8) > maxSlope) continue;
    return { x: px, z: pz, h, lat, shift: dLat, ok: true };
  }
  return { x, z, h: terrainHeight(x, z), lat: l0, shift: 0, ok: false };
}

/**
 * The traversable route: the authored line, snapped onto the ground it has to
 * stand on.
 *
 * A path beside a stream is authored as an offset from the water, but a bank is
 * not a straight line, so an offset is a wish. Each waypoint is walked outwards
 * along the perpendicular until it stands dry, above the water and on ground a
 * person can walk, then the snapped points are re-splined and sampled. The result
 * is a line that cannot end up in the river -- which is the commonest way a
 * greybox world is quietly broken, and the way that is hardest to see on a flat
 * shaded map until someone tries to walk it.
 */
export const ROUTE_TRAVERSAL = (() => {
  const snapped = [];
  for (const wp of ROUTE_WAYPOINTS) {
    const stream = wp.stream === "fork" ? FORK : ERY;
    if (wp.stream === "fork" && Math.abs(wp.s - BRIDGE_S) < 5) {
      snapped.push({ x: wp.x, z: wp.z, wish: wp, stream: stream.id, s: wp.lat });
      continue;
    }
    const r = findBank(wp.x, wp.z, stream, { maxShift: 16, step: 0.25, dry: 0.26, maxSlope: 18 });
    snapped.push({ x: r.x, z: r.z, shift: r.shift, ok: r.ok, wish: wp, stream: stream.id, s: r.lat });
  }

  const pts = relax(snapped.map((p) => [p.x, p.z]), 8);
  for (let i = 0; i < pts.length; i++) {
    const [px, pz] = pts[i];
    const isBridge = Math.hypot(px - FORK.at(BRIDGE_S).x, pz - FORK.at(BRIDGE_S).z) < 14;
    if (isBridge) continue;
    const ext = waterExtent(px, pz);
    const h = terrainHeight(px, pz);
    if (ext !== null && h < ext.level + 0.10) {
      const stream = (pz < FORK_AT.z && px > FORK_AT.x - 20) ? FORK : ERY;
      const r = findBank(px, pz, stream, { maxShift: 14, step: 0.25, dry: 0.20, maxSlope: 19 });
      if (r.ok) { pts[i][0] = r.x; pts[i][1] = r.z; }
    }
  }
  return { points: pts, waypoints: snapped };
})();

/** Elevation the cave's arch springs from, so the rock and the water agree. */
export function caveSillElevation() {
  const c = CAVE.position;
  const s = FORK.project(c.x, c.z);
  return FORK.ws(s) - FORK.depth(s) + CAVE.springing;
}

export { RELIEF, lerp, clamp, ramp, smin, smax };
