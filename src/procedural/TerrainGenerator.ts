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

  // Three independent noise fields, each with its own seed offset so that
  // changing the world seed changes all of them coherently rather than
  // shifting one and leaving the others identical.
  const hills = new PerlinNoise2D(seed);
  const rim = new PerlinNoise2D(seed + 0x5eed);
  const detail = new SimplexNoise2D(seed + 0xd06);
  const patches = new SimplexNoise2D(seed + 0x9a7c);

  const heights = new Float32Array(resolution * resolution);
  const distanceToStream = spline.distanceField(size, resolution);

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
