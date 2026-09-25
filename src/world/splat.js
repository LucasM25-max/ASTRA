/**
 * Phase P1: the material blend math, as one definition shared by the shader
 * and the audit.
 *
 * PLAN section 5.2 specifies the ground as a field-driven blend of five tiling
 * PBR material sets. The weights below are the exact formulas from that
 * section; `splatWeights` is their plain-JS form (used by tools/check_p1.mjs),
 * and `SPLAT_GLSL` is the same computation in GLSL (injected into the terrain
 * material by terrainMaterial.js). Both read the same constants, so the audit
 * cannot pass on math the renderer is not running.
 *
 * Inputs per fragment / sample:
 *   slopeDeg  ground slope in degrees (from the geometric normal)
 *   above     metres above the local water surface (negative when submerged,
 *             +8 where no water is near)
 *   moisture  0..1, the relief field behind moss, mud and darkening
 *   fouling   0..1, the turbidity plume's deposit on the ground
 *   zone      the authored zone id 0..9 (geography.js)
 */

export const P1 = {
  /** Pixels across each tiling material texture. */
  textureSize: 512,
  /** Pixels across the near-field micro-detail texture. */
  detailSize: 512,
  /** World size of one detail tile: 512 px / 40 cm = 12.8 px/cm. */
  detailTile: 0.4,
  /** Height-blend transition width (PLAN: contrast factor k = 0.2). */
  heightBlendK: 0.2,
  /** Triplanar cross-fade around the PLAN threshold of 22 degrees. */
  triplanarStart: 20.0,
  triplanarEnd: 24.0,
  /** Capillary fringe: full wetness at the waterline, dry above this. */
  capillaryHeight: 0.35,
  /** Albedo darkening inside the capillary fringe (PLAN: 40%). */
  capillaryDarken: 0.40,
  /** Roughness inside the capillary fringe (PLAN: 0.08). */
  capillaryRough: 0.08,
  /** Micro-detail fades in from here, full strength from here (metres). */
  detailFar: 15.0,
  detailNear: 6.0,
  /** Soil wetter than this takes footprints. */
  footprintMoisture: 0.7,
  /** Static budget: texture fetches per terrain fragment. */
  maxFetches: 64,
};

/**
 * The five tiling sets. `tile` is the world size of one repeat in metres;
 * `heightScale` weights the set's height channel in the height blend, so a
 * pebble (tall relief) correctly embeds in mud (low relief).
 */
export const MATERIALS = [
  { id: "loam", name: "Flanaess Loam & Forest Litter", tile: 4.0, seed: 0x10a4, heightScale: 0.50, normalStrength: 1.6 },
  { id: "gravel", name: "Alluvial River Gravel & Shingle", tile: 3.0, seed: 0x6a4e, heightScale: 1.00, normalStrength: 2.6 },
  { id: "limestone", name: "Karst Bedded Limestone", tile: 6.0, seed: 0x1e50e, heightScale: 1.00, normalStrength: 2.0 },
  { id: "sludge", name: "Blighted Necrotic Mire", tile: 4.0, seed: 0x51d6e, heightScale: 0.35, normalStrength: 0.9 },
  { id: "turf", name: "Riparian Sedge Turf", tile: 3.0, seed: 0x7e4f, heightScale: 0.60, normalStrength: 1.8 },
];

export const materialById = Object.fromEntries(MATERIALS.map((m) => [m.id, m]));

/** Texel density of a tiling set, in pixels per centimetre. */
export const texelDensityCm = (material) => P1.textureSize / (material.tile * 100);

/** Near-field micro-detail density, in pixels per centimetre. */
export const detailDensityCm = () => P1.detailSize / (P1.detailTile * 100);

const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Blend weights for the five sets at one point. Sums to 1.
 *
 * The four authored terms are PLAN 5.2 verbatim; the zone terms are guard
 * rails, not overrides: limestone may also show on gentler slopes where the
 * authored zone is karst, gravel owns the shingle beach and the channel bed,
 * and turf owns the grazed meadow. Loam is the remainder.
 */
export function splatWeights({ slopeDeg, above, moisture, fouling, zone }) {
  let wRock = sstep(18, 32, slopeDeg);
  if (zone === 6 || zone === 7) wRock = Math.max(wRock, 0.55 * sstep(10, 22, slopeDeg));

  let wGravel = sstep(0.8, 0.0, above) * (1 - sstep(0.15, 0.45, fouling));
  if (zone === 3) wGravel = Math.max(wGravel, 0.55 * sstep(1.6, 0.4, above));
  if (zone === 8) wGravel = Math.max(wGravel, 0.70 * (1 - sstep(0.15, 0.45, fouling)));

  const wSludge = sstep(0.2, 0.7, fouling) * Math.pow(Math.max(0, moisture), 1.5);

  const meadow = zone === 0 || zone === 1 || zone === 2 || zone === 4 || zone === 9;
  let wTurf = sstep(0.30, 0.62, moisture) * (meadow ? 0.85 : 0.30);
  if (zone === 0) wTurf = Math.max(wTurf, 0.8);

  const wLoam = Math.max(0, 1 - (wRock + wGravel + wSludge + wTurf));
  const sum = wRock + wGravel + wSludge + wTurf + wLoam;
  return {
    loam: wLoam / sum,
    gravel: wGravel / sum,
    limestone: wRock / sum,
    sludge: wSludge / sum,
    turf: wTurf / sum,
  };
}

/**
 * The weight computation as GLSL. Reads `slopeDeg`, `moist`, `foul`, `above`,
 * `zone` locals and declares `wLoam`, `wGravel`, `wRock`, `wSludge`, `wTurf`.
 * Kept next to the JS above so the two can be diffed by eye.
 */
export const SPLAT_GLSL = /* glsl */`
  float wRock = smoothstep(18.0, 32.0, slopeDeg);
  if (zone > 5.5 && zone < 7.5) wRock = max(wRock, 0.55 * smoothstep(10.0, 22.0, slopeDeg));
  float wGravel = smoothstep(0.8, 0.0, above) * (1.0 - smoothstep(0.15, 0.45, foul));
  if (zone > 2.5 && zone < 3.5) wGravel = max(wGravel, 0.55 * smoothstep(1.6, 0.4, above));
  if (zone > 7.5 && zone < 8.5) wGravel = max(wGravel, 0.70 * (1.0 - smoothstep(0.15, 0.45, foul)));
  float wSludge = smoothstep(0.2, 0.7, foul) * pow(max(moist, 0.0), 1.5);
  bool meadow = zone < 0.5 || (zone > 0.5 && zone < 2.5) || (zone > 3.5 && zone < 4.5) || zone > 8.5;
  float wTurf = smoothstep(0.30, 0.62, moist) * (meadow ? 0.85 : 0.30);
  if (zone < 0.5) wTurf = max(wTurf, 0.8);
  float wLoam = max(0.0, 1.0 - (wRock + wGravel + wSludge + wTurf));
  float wSum = wRock + wGravel + wSludge + wTurf + wLoam;
  wLoam /= wSum; wGravel /= wSum; wRock /= wSum; wSludge /= wSum; wTurf /= wSum;
`;

/** Texture fetches per terrain fragment, from the shader's own structure. */
export function terrainFetchCount() {
  const perPlane = 3; // albedo + normal + packed (roughness, height, AO)
  const planes = 3;   // triplanar: top + two sides
  return MATERIALS.length * perPlane * planes + 1 /* micro-detail */ + 1; /* footprints */
}
