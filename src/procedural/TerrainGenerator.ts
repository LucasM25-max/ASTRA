/**
 * TerrainGenerator.ts - ASTRA procedural world
 * =============================================================================
 * Turns noise into ground: a heightmap, the mesh drawn from it, and the
 * collision surface that must match it.
 *
 * The one rule that shapes this whole file
 * ----------------------------------------
 * **There is one height array, and everything reads it.** The visual mesh
 * displaces `PlaneGeometry` vertices from it; the Rapier collision trimesh is
 * built from those same vertices; `heightAt` and `normalAt` sample it. Nothing
 * resamples, nothing approximates, nothing keeps a second copy. The plan's
 * requirement that "collision mesh matches visual terrain" is satisfied by
 * construction rather than by tuning two things until they look the same.
 *
 * Height composition
 * ------------------
 * Three terms, added in this order:
 *
 *   1. Rolling hills - layered fbm, 5 octaves, gentle amplitude. This is the
 *      dominant term and the reason the ground reads as hills rather than as
 *      noise.
 *   2. Rim ramp - the same kind of noise but ridged, and multiplied by a
 *      smoothstep of the distance from the centre. The playable 200m stays
 *      gentle; the outer ring gets rougher and higher, so the terrain reads as
 *      a basin you sit in and discourages wandering off without any invisible
 *      geometry. Boundary walls are Step 2.9's job and are deliberately absent
 *      here.
 *   3. Valley carve - a Gaussian subtracted along the stream spline. This is
 *      the one term that has to agree with another system, which is why the
 *      spline is a shared module (`StreamSpline`) rather than a private curve.
 *
 * Biome weights
 * -------------
 * Four weights per vertex - grass, dirt, rock, mud - from height, slope and
 * distance to the stream, then perturbed by Voronoi noise so the boundaries
 * are organic rather than banded. They are written as a `vec4` attribute the
 * terrain shader blends with, and also folded into a `color` attribute so the
 * terrain still reads correctly through any material that only understands
 * vertex colours.
 * =============================================================================
 */

import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Matrix4, PlaneGeometry } from 'three';
import { PerlinNoise2D, SimplexNoise2D, fbm2D, ridged2D, voronoiF1Normalized } from './NoiseLibrary';
import { StreamSpline } from './StreamSpline';
import { BANK_MARGIN, BANK_PLATEAU, BANK_RISE, StreamProfile } from './StreamGenerator';

/** Side length of the terrain, in metres. From the plan: 500m x 500m. */
export const TERRAIN_SIZE = 500;

/**
 * Grid resolution: vertices per side.
 *
 * 384 gives ~1.3m cells and 293,378 triangles. Chosen against the 500k
 * visible-triangle budget in `DebugHud.PERFORMANCE_BUDGET` - a 512 grid would
 * spend the entire budget on the ground before a single tree exists.
 */
export const TERRAIN_RESOLUTION = 384;

/** Octaves of fbm for the base hills. The plan asks for 4-6. */
export const DEFAULT_OCTAVES = 5;

/** Peak-to-trough height of the rolling hills in the playable area, in metres. */
export const DEFAULT_HILL_AMPLITUDE = 5.5;

/** Horizontal scale of the base hills. Larger is broader, gentler swells. */
export const DEFAULT_HILL_FREQUENCY = 0.0125;

/**
 * Normalised radius at which the rim ramp begins. 0.4 of the half-size is
 * 100m from the centre, which is the edge of the ~200m playable area.
 */
export const DEFAULT_RIM_START = 0.4;

/** Extra roughness contributed by the rim at the terrain's outer edge. */
export const DEFAULT_RIM_AMPLITUDE = 9;

/** Gentle overall rise toward the rim, so the playable area sits in a basin. */
export const DEFAULT_RIM_LIFT = 7;

/** Depth of the carved valley at its centre, in metres. */
export const DEFAULT_VALLEY_DEPTH = 4.5;

/** Width of the valley's Gaussian falloff, in metres. */
export const DEFAULT_VALLEY_WIDTH = 26;

/** Distance from the stream beyond which the ground is no longer "bank". */
export const DEFAULT_BANK_WIDTH = 18;

/**
 * Depth of the narrow channel cut into the valley floor for the stream.
 *
 * The valley carve is 4.5 m deep but 26 m wide - a valley, not a channel.
 * Measured on the default terrain, the ground rises only 0.076 m between the
 * spline and 1.5 m either side of it, so a 1-3 m wide ribbon of water has
 * nothing to nestle against: without this carve its edges float above the
 * ground, and the water depth is whatever offset the ribbon was given rather
 * than a real channel.
 *
 * 1.1 m with a width that tracks the stream's own half-width leaves the ribbon
 * edges buried across the whole 1-3 m range. The margin has to cover the
 * terrain's own small-scale roughness as well as the channel's shape: measured
 * on the default terrain the uncarved ground drops up to 0.3 m between the
 * spline and the ribbon's edge, and at 0.8 m of carve that was enough to leave
 * spots only 9 mm deep - a stream that nearly vanishes. 1.1 m keeps the
 * shallowest point above 0.3 m.
 */
export const DEFAULT_CHANNEL_DEPTH = 1.1;

/** Channel half-width as a multiple of the stream's half-width at that point. */
export const DEFAULT_CHANNEL_WIDTH_FACTOR = 1.0;

/** Extra rise of the bank above the water surface, in metres. */
/**
 * How far below the lowest ground in the band the top of the bank sits, in
 * metres. Small on purpose: this is what decides how incised the stream looks.
 * `drop` has to exceed `depth + BANK_MARGIN` for the carve to stay a lowering,
 * and this is the slack on top of that.
 */
const CHANNEL_BANK = 0.12;

/**
 * How far past the ribbon's own edge the carve continues, in metres.
 *
 * It has to reach at least one grid cell beyond, because the ribbon's edge
 * vertex is read back through the grid's bilinear interpolation and its stencil
 * spans half a cell either side of it. Stopping the carve at the edge leaves
 * that stencil on uncarved ground, and on a hillside that drops away the water's
 * edge then floats by whatever the hill dropped - measured at 0.85 m on the
 * default terrain before this was added.
 */
const CHANNEL_CARVE_MARGIN = 2;

/**
 * Spacing of the channel's cross-sections along the stream, in metres.
 *
 * Finer than the terrain grid on purpose. The ribbon walks the spline in its
 * own even steps and reads the bed back through `heightAt`, so the two
 * parameterizations have to agree to within the bed's slope times the spacing.
 * At the terrain's own 1.3 m step and a bed that climbs 0.35 m per step near
 * the map's rim, that error was 0.09 m - more than the 0.06 m the bank margin
 * provides, and the water's edge floated. A quarter-metre spacing puts the
 * error at 0.02 m.
 */
const CHANNEL_CROSS_STEP = 0.25;

/** Width of the moving average that smooths the bed along the flow, in metres. */
const CHANNEL_BED_SMOOTHING = 4;

/** Samples taken across the flow when measuring and carving the channel. */
const CHANNEL_SAMPLES = 17;

/** The four biomes the terrain blends between. */
export const BIOME_GRASS = 0;
export const BIOME_DIRT = 1;
export const BIOME_ROCK = 2;
export const BIOME_MUD = 3;
export const BIOME_COUNT = 4;

/**
 * Biome colours, in sRGB hex.
 *
 * Restrained and earthy per style guide rule 7: the greens and browns sit
 * close together so the terrain reads as one continuous surface, and rock is
 * the only cool tone - it is what makes exposed stone legible against the
 * grass without needing a texture.
 */
export const BIOME_COLORS: readonly number[] = [
  0x5f7d43, // grass - dominant, earthy green
  0x6d5638, // dirt - paths and riverbanks, brown
  0x6f7276, // rock - exposed stone, grey
  0x3f4a2c, // mud - dark brown-green
];

export interface TerrainGeneratorOptions {
  /** Side length in metres. Defaults to `TERRAIN_SIZE`. */
  size?: number;
  /** Vertices per side. Defaults to `TERRAIN_RESOLUTION`. */
  resolution?: number;
  /** World seed. Same seed, same world. */
  seed?: number;
  /** The stream the valley is carved along. */
  spline?: StreamSpline;
  /** Octaves of fbm for the rolling hills. */
  octaves?: number;
  /** Hill amplitude in metres. */
  hillAmplitude?: number;
  /** Hill frequency. */
  hillFrequency?: number;
  /** Normalised radius where the rim ramp starts. */
  rimStart?: number;
  /** Rim roughness amplitude. */
  rimAmplitude?: number;
  /** Rim lift. */
  rimLift?: number;
  /** Valley depth in metres. */
  valleyDepth?: number;
  /** Valley width in metres. */
  valleyWidth?: number;
  /** How far from the stream still counts as bank. */
  bankWidth?: number;
  /**
   * Depth of the stream channel cut into the valley floor. 0 disables it.
   *
   * Defaults to `DEFAULT_CHANNEL_DEPTH`. The width of the carve tracks the
   * stream's own half-width, so the channel and the water in it always agree.
   */
  channelDepth?: number;
  /** Channel half-width as a multiple of the stream's half-width. */
  channelWidthFactor?: number;
  /** Stream width knobs, forwarded to the profile that sizes the channel. */
  stream?: {
    seed?: number;
    width?: number;
    widthVariation?: number;
  };
}

/** Everything the terrain produced, in one object. */
export interface TerrainData {
  readonly size: number;
  readonly resolution: number;
  readonly seed: number;
  readonly spline: StreamSpline;

  /** Heights, row-major: `heights[i * resolution + j]`, `i` along +z. */
  readonly heights: Float32Array;
  /** The same heights, in the column-major layout a heightfield collider wants. */
  readonly columnMajorHeights: Float32Array;
  /** Distance from each vertex to the stream, row-major, metres. */
  readonly distanceToStream: Float32Array;

  /** Biome weights per vertex, row-major, 4 floats per vertex. */
  readonly biomeWeights: Float32Array;

  readonly minHeight: number;
  readonly maxHeight: number;

  /** Height of the ground at a world position, bilinearly interpolated. */
  heightAt(x: number, z: number): number;
  /** Unit surface normal at a world position, from the height gradient. */
  normalAt(x: number, z: number): { x: number; y: number; z: number };
  /** 0 = flat, 1 = vertical. */
  slopeAt(x: number, z: number): number;
}

/** Smooth Hermite step from 0 to 1. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Clamp to [0, 1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Blur the stream bed across the direction of flow.
 *
 * A level water surface can only sit in a bed that is itself level-ish. The
 * hills carry five octaves and the top two have wavelengths/**
 * Replace the ground in a narrow band around the spline with a designed
 * channel cross-section.
 *
 * Why not a Gaussian dimple
 * -------------------------
 * The obvious carve - subtract a Gaussian centred on the spline - cannot work,
 * and the reason is measurable. On the default terrain the stream runs across a
 * hillside near u = 0.9, where the ground drops 0.83 m between the spline and
 * 1.5 m to one side of it. A level water surface has to be above the bed in the
 * middle and below the ground at the ribbon's edge; with a Gaussian carve the
 * edge is lower than the middle by more than the carve provides, so no height
 * satisfies both and the water either floats at the edge or vanishes in the
 * middle. Deepening the Gaussian to fix it takes a 2 m gouge.
 *
 * Averages do not help either: blurring the bed across the flow removes
 * curvature but preserves a linear slope, which is exactly the problem here.
 *
 * What does work
 * --------------
 * Give the channel a designed cross-section. The bed is flat across the flow
 * and follows the lowest ground in the band, so it still runs downhill; from
 * the edge of the bed it climbs to a little above the water surface, stays
 * flat there across the ribbon's edge, and only then blends back to the hills.
 * Every point of the designed profile sits at or below the lowest original
 * ground in the band, so the carve can only ever lower the terrain - it never
 * raises a ridge, and the water's edge is always buried.
 *
 * Two widths in that profile exist only because of the grid. The climb has to
 * span more than a cell (`BANK_RISE`), or there is no vertex on the flat bed and
 * the water's surface reads back too high; and the flat top has to span a cell
 * (`BANK_PLATEAU`), or the ribbon's edge lands on a slope the grid can only
 * approximate. Both were measured, not guessed: with a 1.3 m rise the edge
 * floated 6 cm, and widening the rise to 2.2 m plus a 1.3 m shelf took the
 * worst burial from 3 cm to 17 cm across ten seeds.
 *
 * `StreamProfile.surfaceHeightAt` reads this shape back as "the lowest ground
 * under the ribbon, plus the depth", so the water and the channel agree without
 * either module holding state the other can drift from.
 */
function carveStreamChannel(
  heights: Float32Array,
  resolution: number,
  step: number,
  half: number,
  spline: StreamSpline,
  profile: StreamProfile,
): void {
  /** Bilinear sample of `heights`, with the grid edges clamped. */
  const sample = (x: number, z: number): number => {
    const fx = (x + half) / step;
    const fz = (z + half) / step;
    const j = Math.min(resolution - 2, Math.max(0, Math.floor(fx)));
    const i = Math.min(resolution - 2, Math.max(0, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - j));
    const tz = Math.min(1, Math.max(0, fz - i));
    const k00 = i * resolution + j;
    const k10 = k00 + 1;
    const k01 = k00 + resolution;
    const k11 = k01 + 1;
    const a = heights[k00] + (heights[k10] - heights[k00]) * tx;
    const b = heights[k01] + (heights[k11] - heights[k01]) * tx;
    return a + (b - a) * tz;
  };

  /** Unit left-hand normal of the spline at an arc position, in the XZ plane. */
  const normalAt = (a: number): { x: number; z: number } => {
    const t = spline.tangentAtDistance(a);
    const len = Math.hypot(t.x, t.z);
    if (len < 1e-9) return { x: 1, z: 0 };
    return { x: -t.z / len, z: t.x / len };
  };

  const length = spline.length;
  if (!(length > 0)) return;

  // How far below the lowest ground in the band the bed sits. Chosen so the
  // designed profile at the outer edge of the bank lands just under that lowest
  // ground, which is what keeps the whole carve a lowering.
  const drop = profile.depth + BANK_MARGIN + CHANNEL_BANK + 0.05;

  // 1. Bed level at each cross-section. Read before anything is written, so a
  //    later cross-section can never measure an already-carved one.
  const crossCount = Math.max(2, Math.ceil(length / CHANNEL_CROSS_STEP) + 1);
  const crossArc = new Float32Array(crossCount);
  const raw = new Float32Array(crossCount);

  for (let c = 0; c < crossCount; c++) {
    const a = Math.min(length, c * CHANNEL_CROSS_STEP);
    crossArc[c] = a;

    const p = spline.pointAtDistance(a);
    const n = normalAt(a);
    const reach = profile.ribbonHalfWidthAtDistance(a) + CHANNEL_CARVE_MARGIN;

    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < CHANNEL_SAMPLES; i++) {
      const off = -reach + (2 * reach * i) / (CHANNEL_SAMPLES - 1);
      const h = sample(p.x + n.x * off, p.z + n.z * off);
      if (h < lowest) lowest = h;
    }
    raw[c] = Number.isFinite(lowest) ? lowest : 0;
  }

  // Smooth the bed along the flow with a sliding mean, then clamp it back under
  // the local minimum. The mean is what stops the bed following every bump in
  // the hills; the clamp is what stops the smoothing from lifting the bed above
  // ground it was measured below, which would turn the carve into a fill.
  const radius = Math.max(1, Math.round(CHANNEL_BED_SMOOTHING / CHANNEL_CROSS_STEP));
  const smoothed = new Float32Array(crossCount);
  let running = 0;
  for (let c = 0; c <= Math.min(radius, crossCount - 1); c++) running += raw[c];
  for (let c = 0; c < crossCount; c++) {
    const lo = Math.max(0, c - radius);
    const hi = Math.min(crossCount - 1, c + radius);
    // Recompute rather than slide: clamping the window at the ends makes a
    // running sum drift, and the ends are exactly where the spline runs into
    // the rim ramp.
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += raw[k];
    smoothed[c] = sum / (hi - lo + 1);
  }
  for (let c = 0; c < crossCount; c++) {
    smoothed[c] = Math.min(smoothed[c], raw[c]) - drop;
  }

  // 2. Replace the ground inside the footprint, walking the same cross-sections
  //    the ribbon walks.
  //
  //    This is the part that has to match exactly. An earlier version keyed the
  //    carve off each grid vertex's *nearest* point on the spline, while the
  //    ribbon places its vertices by offsetting perpendicular from a
  //    cross-section's own arc position. On a curve those are different
  //    parameterizations - the nearest point to a vertex beside cross-section
  //    `a` is generally not `a` - so the channel came out lopsided and the
  //    water's edge floated by up to 0.85 m. Walking the cross-sections on both
  //    sides removes the disagreement.
  //
  //    The bands overlap, because consecutive cross-sections are 0.25 m apart
  //    and each band is several metres wide. Taking the lowest designed value
  //    across the overlap - the obvious rule, and the first one tried - drags
  //    every bank down to the level of the cross-section upstream of it, which
  //    on a bed that climbs is the lowest one. Each vertex is therefore assigned
  //    to the single cross-section it is nearest to along the flow.
  const carved = new Map<number, { along: number; value: number }>();

  for (let c = 0; c < crossCount; c++) {
    const a = crossArc[c];
    const p = spline.pointAtDistance(a);
    const n = normalAt(a);
    const tangent = spline.tangentAtDistance(a);
    // Flat bed out to here, then a climb that crosses the water surface at the
    // stream's nominal half-width, clears it at the ribbon's edge, and blends
    // back to the hills a little way beyond that.
    const flatTo = profile.bedHalfWidthAtDistance(a);
    const bankTop = flatTo + BANK_RISE;
    const plateauEnd = bankTop + BANK_PLATEAU;
    const reach = plateauEnd + CHANNEL_CARVE_MARGIN;
    const level = smoothed[c];
    const climb = profile.depth + BANK_MARGIN;

    // Bounding box of the band, in grid indices.
    const ex = n.x * reach;
    const ez = n.z * reach;
    const j0 = Math.max(0, Math.ceil((Math.min(p.x - ex, p.x + ex) + half) / step));
    const j1 = Math.min(resolution - 1, Math.floor((Math.max(p.x - ex, p.x + ex) + half) / step));
    const i0 = Math.max(0, Math.ceil((Math.min(p.z - ez, p.z + ez) + half) / step));
    const i1 = Math.min(resolution - 1, Math.floor((Math.max(p.z - ez, p.z + ez) + half) / step));

    for (let i = i0; i <= i1; i++) {
      const z = -half + i * step;
      const rowBase = i * resolution;
      for (let j = j0; j <= j1; j++) {
        const x = -half + j * step;
        const dx = x - p.x;
        const dz = z - p.z;
        const across = dx * n.x + dz * n.z;
        const d = Math.abs(across);
        if (d >= reach) continue;

        const k = rowBase + j;
        // Distance along the flow from this cross-section, used to decide which
        // cross-section owns the vertex when the bands overlap.
        const along = dx * tangent.x + dz * tangent.z;

        const previous = carved.get(k);
        if (previous !== undefined && Math.abs(previous.along) <= Math.abs(along)) continue;

        // Flat bed under the water, then a rise that clears the surface by the
        // bank margin, then a flat shelf out to the ribbon's edge. The bed is
        // flat so the water's surface height reads back exactly - a sloped bed
        // would put a gradient under the ribbon for the terrain grid's bilinear
        // interpolation to get wrong, and that error is what left the water
        // floating at its edge.
        const top = level + climb;
        let value = level + climb * smoothstep(flatTo, bankTop, d);

        // Past the top of the rise the bank is flat out to the ribbon's edge and
        // only then blends back toward the hills. It never drops below the top
        // of the rise: the ribbon's edge vertex is read through the grid's
        // interpolation, its stencil reaches this far, and ground below the
        // waterline there would show as a gap. The flat shelf is what makes
        // that guarantee survive the grid - a climb that is still rising where
        // the ribbon ends leaves the edge on a slope the grid can only
        // approximate, and a 1.3 m cell approximates it badly.
        if (d >= bankTop) {
          const fade = smoothstep(plateauEnd, reach, d);
          const original = heights[k];
          const blended = top + (original - top) * fade;
          value = Math.max(blended, top);
        }

        carved.set(k, { along, value });
      }
    }
  }

  for (const [k, entry] of carved) heights[k] = entry.value;

}

export function generateTerrain(options: TerrainGeneratorOptions = {}): TerrainData {
  const size = options.size ?? TERRAIN_SIZE;
  const resolution = Math.max(2, Math.floor(options.resolution ?? TERRAIN_RESOLUTION));
  const seed = options.seed ?? 0;
  const spline = options.spline ?? new StreamSpline();

  if (!(size > 0)) {
    throw new RangeError(`[TerrainGenerator] size must be positive, received ${String(size)}`);
  }

  const octaves = Math.max(1, Math.floor(options.octaves ?? DEFAULT_OCTAVES));
  const hillAmplitude = options.hillAmplitude ?? DEFAULT_HILL_AMPLITUDE;
  const hillFrequency = options.hillFrequency ?? DEFAULT_HILL_FREQUENCY;
  const rimStart = options.rimStart ?? DEFAULT_RIM_START;
  const rimAmplitude = options.rimAmplitude ?? DEFAULT_RIM_AMPLITUDE;
  const rimLift = options.rimLift ?? DEFAULT_RIM_LIFT;
  const valleyDepth = options.valleyDepth ?? DEFAULT_VALLEY_DEPTH;
  const valleyWidth = options.valleyWidth ?? DEFAULT_VALLEY_WIDTH;
  const bankWidth = options.bankWidth ?? DEFAULT_BANK_WIDTH;
  const channelDepth = options.channelDepth ?? DEFAULT_CHANNEL_DEPTH;
  const channelWidthFactor = options.channelWidthFactor ?? DEFAULT_CHANNEL_WIDTH_FACTOR;

  if (!(channelDepth >= 0)) {
    throw new RangeError(
      `[TerrainGenerator] channelDepth must be non-negative, received ${String(channelDepth)}`,
    );
  }
  if (!(channelWidthFactor > 0)) {
    throw new RangeError(
      `[TerrainGenerator] channelWidthFactor must be positive, received ${String(channelWidthFactor)}`,
    );
  }

  // Three independent noise fields, each with its own seed offset so that
  // changing the world seed changes all of them coherently rather than
  // shifting one and leaving the others identical.
  const hills = new PerlinNoise2D(seed);
  const rim = new PerlinNoise2D(seed + 0x5eed);
  const detail = new SimplexNoise2D(seed + 0xd06);
  const patches = new SimplexNoise2D(seed + 0x9a7c);

  const heights = new Float32Array(resolution * resolution);

  // One pass for both fields: the arc length is only valid where it belongs to
  // the nearest point, so the two have to be stamped together. See
  // `StreamSpline.nearestField`.
  const distanceToStream = spline.nearestField(size, resolution).distance;

  // Sizes the channel so it always matches the water that will sit in it.
  const streamProfile =
    channelDepth > 0
      ? new StreamProfile(spline, {
          seed: options.stream?.seed ?? seed,
          width: options.stream?.width,
          widthVariation: options.stream?.widthVariation,
        })
      : null;

  const half = size / 2;
  const step = size / (resolution - 1);

  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < resolution; i++) {
    const z = -half + i * step;
    const rowBase = i * resolution;
    for (let j = 0; j < resolution; j++) {
      const x = -half + j * step;
      const k = rowBase + j;

      // Radial coordinate, 0 at the centre and 1 at the middle of an edge.
      const r = Math.min(1, Math.hypot(x, z) / half);
      const ramp = smoothstep(rimStart, 1, r);

      // 1. Rolling hills.
      const rolling = fbm2D(hills, x, z, {
        octaves,
        frequency: hillFrequency,
        amplitude: 1,
        gain: 0.5,
      });

      // 2. Rim ramp: ridged noise, faded in with distance from the centre,
      //    plus a gentle overall rise so the playable area sits in a basin.
      const rimNoise = ridged2D(rim, x, z, {
        octaves: Math.max(3, octaves - 1),
        frequency: hillFrequency * 1.6,
        amplitude: 1,
        gain: 0.55,
      });
      const rimTerm = (rimNoise * rimAmplitude + rimLift * 0.5) * ramp;

      let h = rolling * hillAmplitude * (1 - ramp * 0.55) + rimTerm;

      // 3. Valley carve. Subtracted last so the stream always runs low,
      //    whatever the hills do underneath it.
      const d = distanceToStream[k];
      const carve = valleyDepth * Math.exp(-((d / valleyWidth) * (d / valleyWidth)));
      h -= carve;

      heights[k] = h;
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  // The stream needs a channel with a designed cross-section, not a Gaussian
  // dimple. See the function for why the obvious approach fails.
  if (streamProfile !== null) {
    carveStreamChannel(heights, resolution, step, half, spline, streamProfile);
  }

  // Column-major copy, for a heightfield collider. Kept even though the
  // current Rapier build cannot create one - see `PhysicsWorld.createTerrain
  // Collider` for why - because it is the layout the API documents and the
  // moment that bug is fixed the collider becomes a two-line change.
  const columnMajorHeights = new Float32Array(resolution * resolution);
  for (let i = 0; i < resolution; i++) {
    for (let j = 0; j < resolution; j++) {
      columnMajorHeights[j * resolution + i] = heights[i * resolution + j];
    }
  }

  const biomeWeights = new Float32Array(resolution * resolution * BIOME_COUNT);
  buildBiomeWeights(
    biomeWeights,
    heights,
    distanceToStream,
    resolution,
    step,
    half,
    { bankWidth, detail, patches },
  );

  return {
    size,
    resolution,
    seed,
    spline,
    heights,
    columnMajorHeights,
    distanceToStream,
    biomeWeights,
    minHeight,
    maxHeight,
    heightAt: (x, z) => sampleHeight(heights, resolution, size, x, z),
    normalAt: (x, z) => sampleNormal(heights, resolution, size, x, z),
    slopeAt: (x, z) => 1 - sampleNormal(heights, resolution, size, x, z).y,
  };
}

/* -------------------------------------------------------------------------- */
/* Biome weights                                                              */
/* -------------------------------------------------------------------------- */

interface BiomeContext {
  readonly bankWidth: number;
  readonly detail: SimplexNoise2D;
  readonly patches: SimplexNoise2D;
}

/**
 * Fill `out` with four normalized weights per vertex.
 *
 * The base rules are the ones the plan asks for - height, slope and proximity
 * to the stream - expressed as:
 *
 *   rock  steep ground, and ground right at the water's edge
 *   mud   the wet bank, where it is flat enough to hold water
 *   dirt  the band just outside the bank: the path the water leaves behind
 *   grass everything else, dominant by design
 *
 * Each rule is then multiplied by a Voronoi/Simplex factor before
 * normalization. Without that, four smooth rules produce four smooth bands
 * and the terrain looks printed. With it, the boundaries wander and break up,
 * which is style guide rule 5 - natural imperfection - applied to colour
 * rather than to geometry.
 *
 * Every factor that scales a weight is applied *before* the normalization,
 * never after. Scaling afterwards breaks the invariant that the four weights
 * sum to one, and every consumer - the shader's renormalization, any future
 * code that reads a weight directly - then has to defend against a value it
 * was promised could not happen.
 */
function buildBiomeWeights(
  out: Float32Array,
  heights: Float32Array,
  distanceToStream: Float32Array,
  resolution: number,
  step: number,
  half: number,
  ctx: BiomeContext,
): void {
  const { bankWidth, detail, patches } = ctx;

  for (let i = 0; i < resolution; i++) {
    const z = -half + i * step;
    const rowBase = i * resolution;
    for (let j = 0; j < resolution; j++) {
      const x = -half + j * step;
      const k = rowBase + j;

      // Slope in radians, from central differences. The border ring falls back
      // to one-sided differences, because sampling outside the grid would read
      // garbage rather than the terrain's edge.
      //
      // `i` and `j` are row and column; `i * resolution + j` is the array
      // offset. The distance between adjacent rows is `step`, not
      // `resolution * step` - conflating the two scales the gradient by the
      // whole grid width.
      const jm = j > 0 ? j - 1 : j;
      const jp = j < resolution - 1 ? j + 1 : j;
      const im = i > 0 ? i - 1 : i;
      const ip = i < resolution - 1 ? i + 1 : i;
      const dx = (jp - jm) * step;
      const dz = (ip - im) * step;
      const dhdx = dx > 0 ? (heights[k + (jp - j)] - heights[k + (jm - j)]) / dx : 0;
      const dhdz =
        dz > 0 ? (heights[ip * resolution + j] - heights[im * resolution + j]) / dz : 0;
      const slope = Math.atan(Math.hypot(dhdx, dhdz));

      const steep = smoothstep(0.1, 0.38, slope);
      const bank = 1 - smoothstep(0, bankWidth, distanceToStream[k]);

      // Organic variation, at scales chosen to match what the vertex spacing
      // can actually show: Voronoi for hard-edged patching, simplex for fine
      // grain, and a very slow broad mottle so the field never reads as
      // uniformly green at distance.
      const patch = 0.65 + 0.35 * voronoiF1Normalized(x * 0.045, z * 0.045, 0x51ce);
      const fine = 0.8 + 0.2 * detail.noiseNormalized(x * 0.09, z * 0.09);
      const broad = 0.92 + 0.08 * patches.noiseNormalized(x * 0.02, z * 0.02);

      // Dirt peaks in a band a few metres out from the bank, not at the water.
      const dirtBand =
        smoothstep(0, bankWidth * 0.3, distanceToStream[k]) *
        (1 - smoothstep(bankWidth * 0.5, bankWidth, distanceToStream[k]));

      // A little extra rock on high ground, so height matters as the plan asks
      // and not only as a proxy for slope.
      const high = smoothstep(2.5, 9, heights[k]);

      const grass = (1 - steep) * (1 - bank) * fine * broad * (1 - high * 0.3);
      const dirt = dirtBand * (1 - steep * 0.7) * patch;
      const rock = steep * 0.9 + bank * 0.45 + high * 0.22;
      const mud = bank * (1 - steep) * 0.75 * patch;

      const total = grass + dirt + rock + mud;
      const inv = total > 1e-6 ? 1 / total : 0.25;
      const o = k * BIOME_COUNT;
      out[o + BIOME_GRASS] = grass * inv;
      out[o + BIOME_DIRT] = dirt * inv;
      out[o + BIOME_ROCK] = rock * inv;
      out[o + BIOME_MUD] = mud * inv;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Sampling                                                                   */
/* -------------------------------------------------------------------------- */

/** Bilinear height lookup. Outside the grid it returns the nearest edge. */
function sampleHeight(
  heights: Float32Array,
  resolution: number,
  size: number,
  x: number,
  z: number,
): number {
  const half = size / 2;
  const step = size / (resolution - 1);
  const fx = (x + half) / step;
  const fz = (z + half) / step;
  const j = Math.min(resolution - 2, Math.max(0, Math.floor(fx)));
  const i = Math.min(resolution - 2, Math.max(0, Math.floor(fz)));
  const tx = clamp01(fx - j);
  const tz = clamp01(fz - i);

  const k00 = i * resolution + j;
  const k10 = k00 + 1;
  const k01 = k00 + resolution;
  const k11 = k01 + 1;

  const a = heights[k00] + (heights[k10] - heights[k00]) * tx;
  const b = heights[k01] + (heights[k11] - heights[k01]) * tx;
  return a + (b - a) * tz;
}

/**
 * Surface normal from the height gradient.
 *
 * Central differences, with one-sided fallback at the border. The gradient is
 * negated because the normal points *up* out of the surface: for
 * `y = h(x, z)`, `n = normalize(-dh/dx, 1, -dh/dz)`.
 *
 * The `i`/`j` versus linear-index distinction is the trap in this function.
 * `i` and `j` are row and column; `i * resolution + j` is the array offset.
 * Mixing them compiles fine and produces a gradient that is wrong by a factor
 * of `resolution` - which looks like a slightly wrong normal rather than like
 * a bug, which is exactly why it is worth being explicit about.
 */
function sampleNormal(
  heights: Float32Array,
  resolution: number,
  size: number,
  x: number,
  z: number,
): { x: number; y: number; z: number } {
  const half = size / 2;
  const step = size / (resolution - 1);
  const j = Math.min(resolution - 1, Math.max(0, Math.round((x + half) / step)));
  const i = Math.min(resolution - 1, Math.max(0, Math.round((z + half) / step)));

  const jm = j > 0 ? j - 1 : j;
  const jp = j < resolution - 1 ? j + 1 : j;
  const im = i > 0 ? i - 1 : i;
  const ip = i < resolution - 1 ? i + 1 : i;

  const dx = (jp - jm) * step;
  const dz = (ip - im) * step;

  const dhdx = dx > 0 ? (heights[i * resolution + jp] - heights[i * resolution + jm]) / dx : 0;
  const dhdz = dz > 0 ? (heights[ip * resolution + j] - heights[im * resolution + j]) / dz : 0;

  const nx = -dhdx;
  const ny = 1;
  const nz = -dhdz;
  const len = Math.hypot(nx, ny, nz);
  return { x: nx / len, y: ny / len, z: nz / len };
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the terrain mesh geometry from generated data.
 *
 * Starts from `PlaneGeometry`, as the plan asks, and then displaces it. The
 * trick worth knowing: `PlaneGeometry` lays its vertices out in local XY with
 * row `iy` running from `+y` downward, which is *exactly* the layout
 * `(x, -z, height)` needs. So only the third component - the displacement -
 * has to be written, and a single -90 degree rotation about X then lands every
 * vertex on `(x, height, z)` in world space with its normal along `+Y`.
 *
 * That rotation is baked into the geometry rather than left on the mesh, and
 * that is a deliberate choice: it means the `position` attribute is already in
 * world coordinates, so the collision trimesh can be built from those exact
 * numbers with no transform of its own to keep in sync. A mesh that carries
 * the rotation instead is one extra place for the visual and the collider to
 * drift apart.
 *
 * Normals come from `computeVertexNormals()`, not from the height gradient:
 * they must describe the mesh's actual triangles, and those are the same
 * triangles the collider uses.
 */
export function buildTerrainGeometry(data: TerrainData): BufferGeometry {
  const { resolution, size } = data;
  const geometry = new PlaneGeometry(size, size, resolution - 1, resolution - 1);

  const position = geometry.getAttribute('position') as BufferAttribute;
  const array = position.array as Float32Array;
  const vertexCount = resolution * resolution;
  if (array.length !== vertexCount * 3) {
    throw new Error(
      `[TerrainGenerator] PlaneGeometry produced ${array.length / 3} vertices, expected ${vertexCount}`,
    );
  }

  const colors = new Float32Array(vertexCount * 3);
  const biome = new Float32Array(vertexCount * 4);

  // Linear-space biome colours. `Color.setHex` converts from sRGB, and the
  // `color` attribute is read as linear by Three's standard material, so this
  // is the round trip that keeps the terrain the colour it was authored as.
  const biomeRgb = BIOME_COLORS.map((hex) => {
    const r = ((hex >> 16) & 0xff) / 255;
    const g = ((hex >> 8) & 0xff) / 255;
    const b = (hex & 0xff) / 255;
    // sRGB -> linear.
    return [
      r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4),
      g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4),
      b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4),
    ];
  });

  for (let k = 0; k < vertexCount; k++) {
    // Displace along the plane's local +Z, which the rotation below turns
    // into world +Y. Local X and Y are already correct from PlaneGeometry.
    array[k * 3 + 2] = data.heights[k];

    const o = k * BIOME_COUNT;
    const w0 = data.biomeWeights[o + BIOME_GRASS];
    const w1 = data.biomeWeights[o + BIOME_DIRT];
    const w2 = data.biomeWeights[o + BIOME_ROCK];
    const w3 = data.biomeWeights[o + BIOME_MUD];

    colors[k * 3] = w0 * biomeRgb[0][0] + w1 * biomeRgb[1][0] + w2 * biomeRgb[2][0] + w3 * biomeRgb[3][0];
    colors[k * 3 + 1] =
      w0 * biomeRgb[0][1] + w1 * biomeRgb[1][1] + w2 * biomeRgb[2][1] + w3 * biomeRgb[3][1];
    colors[k * 3 + 2] =
      w0 * biomeRgb[0][2] + w1 * biomeRgb[1][2] + w2 * biomeRgb[2][2] + w3 * biomeRgb[3][2];

    biome[o] = w0;
    biome[o + 1] = w1;
    biome[o + 2] = w2;
    biome[o + 3] = w3;
  }

  position.needsUpdate = true;

  // Bake the rotation. PlaneGeometry's own index winding already faces local
  // +Z, which becomes world +Y here - so the index is reused untouched.
  geometry.applyMatrix4(new Matrix4().makeRotationX(-Math.PI / 2));

  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('biome', new Float32BufferAttribute(biome, 4));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return geometry;
}

/**
 * Collision vertices and indices, taken straight from `buildTerrainGeometry`'s
 * output.
 *
 * Returning the mesh's own buffers - not a resampled copy - is what makes the
 * collider and the visual mesh the same surface. The only work here is
 * handing back views the collider API accepts.
 */
export function buildTerrainCollisionData(geometry: BufferGeometry): {
  vertices: Float32Array;
  indices: Uint32Array;
} {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!position || !index) {
    throw new Error('[TerrainGenerator] terrain geometry has no position or index attribute');
  }
  return {
    vertices: position.array as Float32Array,
    indices: index.array as Uint32Array,
  };
}
