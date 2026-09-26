/**
 * StreamGenerator.ts - the water surface
 * =============================================================================
 * Builds the ribbon of water that follows the stream spline, and answers the
 * questions the rest of the world asks about it: how wide is it here, how deep,
 * is this point in the water.
 *
 * Why the water surface is level across its width
 * -----------------------------------------------
 * Water finds its level. A cross-section of a real stream is horizontal, with
 * the banks rising on either side, so the ribbon's vertices all share the same
 * `y` for a given arc position and only the terrain beneath them varies.
 *
 * Conforming each vertex to the terrain underneath it instead - the obvious
 * implementation, and the one the plan's wording invites - puts every vertex
 * exactly `surfaceOffset` above the ground, which makes the water depth
 * constant and equal to `surfaceOffset`. That is a puddle, not a stream, and it
 * cannot be waded in. Measured on the default terrain, the valley floor rises
 * only 0.076 m between the spline and 1.5 m either side of it, so there is no
 * natural bank for the water to nestle against: the channel has to be cut.
 *
 * The two modules are coupled through `StreamProfile`, and they have to agree
 * exactly or the water floats. That agreement took three attempts to get right,
 * and each failure is recorded below because each one looked correct in review:
 *
 *   a Gaussian carve        cannot bury the edge. At one point on the default
 *                           spline the uncarved ground drops 0.83 m between the
 *                           spline and 1.5 m to one side, so no level surface
 *                           is both above the centre bed and below both edges.
 *   a bed smoothed across
 *   the flow                a dead end. Averaging removes curvature but
 *                           preserves a linear cross-slope, which is exactly
 *                           the failure. Measured worse than doing nothing.
 *   a designed cross-section
 *                           the answer: a flat bed under the water, then a
 *                           climb that crosses the surface at the stream's
 *                           nominal width and clears it beyond.
 *
 * The bed is flat so `surfaceHeightAtDistance` can read the water's height back
 * off the terrain and get it exactly right - a sloped bed would put a gradient
 * under the ribbon for the terrain grid's bilinear interpolation to get wrong,
 * and that error is what left the water floating at its edge.
 *
 * The two modules also have to share one parameterization. `StreamSpline`
 * offers two: `pointAt(u)`, uniform in the Catmull-Rom curve parameter, and
 * `pointAtDistance(d)`, uniform in metres. Mixing them - which is easy to do,
 * because both look right - makes the channel's banks lopsided by 13 cm and the
 * water's edge float. Everything here is arc length, everywhere.
 *
 * Ownership: nothing here touches Three.js scene state or Rapier. It produces
 * plain typed arrays plus a `BufferGeometry`, and is fully testable in Node.
 * =============================================================================
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Uint32BufferAttribute,
} from 'three';
import { PerlinNoise2D } from './NoiseLibrary';
import { StreamSpline, type SplinePoint } from './StreamSpline';

/** Half-width of the stream at its default, in metres (2.8 m across). */
export const DEFAULT_STREAM_HALF_WIDTH = 1.4;

/** How far the noise may push the half-width either side of the default. */
export const DEFAULT_STREAM_WIDTH_VARIATION = 1.1;

/** Narrowest the stream may get: 1 m across, as the plan's low end asks. */
export const MIN_STREAM_HALF_WIDTH = 0.5;

/** Widest the stream may get: 3 m across, as the plan's high end asks. */
export const MAX_STREAM_HALF_WIDTH = 1.5;

/** How far the water surface sits above the channel floor, in metres. */
export const DEFAULT_STREAM_DEPTH = 0.45;

/** Cross-sections sampled along the spline. */
export const DEFAULT_STREAM_SEGMENTS = 384;

/** Vertices across the ribbon, including both edges. */
export const DEFAULT_STREAM_WIDTH_SEGMENTS = 13;

/**
 * Pollution at the three zones the plan names.
 *
 * u = 0 is the cave, where the fungus is; u = 1 is the village of High Ery,
 * downstream. The water cleans up as it flows away from the source.
 */
export const DEFAULT_POLLUTION_UPSTREAM = 0.9;
export const DEFAULT_POLLUTION_MIDSTREAM = 0.6;
export const DEFAULT_POLLUTION_DOWNSTREAM = 0.2;

/** Arc-length position of the mid-stream zone, as a fraction of the spline. */
const MIDSTREAM_U = 0.5;

/**
 * How far above the water surface the channel's bank stands at the outer edge
 * of the ribbon, in metres.
 *
 * This is the burial margin, and it is the only thing standing between the
 * water and an edge that floats above the bank. It has to exceed the worst error
 * the terrain grid can make reading the channel back - which is not zero,
 * because a 384x384 grid over 500 m has 1.3 m cells and cannot represent a
 * cross-section narrower than that exactly. See `BANK_RISE`; measured across
 * seeds, 0.35 m of margin leaves the ribbon's edge 0.17 to 0.19 m under ground
 * at the worst spot.
 */
export const BANK_MARGIN = 0.35;

/**
 * Horizontal distance over which the bank climbs from the flat bed to above the
 * water surface, in metres.
 *
 * Wider than it looks like it needs to be, on purpose. The bed has to stop
 * `t * BANK_RISE` short of the water's edge for the shoreline to land at the
 * stream's nominal half-width, so a narrow rise leaves a bed only a few dozen
 * centimetres across - narrower than one terrain cell. The grid then has no
 * vertex to put on the flat bed, reads the water surface too high, and eats the
 * burial margin. Over a cell and a half the vertices bracketing the centre are
 * always somewhere on the climb, and the read-back error stays under 0.2 m.
 *
 * The cost is a gentler bank: a 0.8 m rise over 2.2 m, about a 36% grade, which
 * is what a stream bank looks like anyway.
 */
export const BANK_RISE = 2.2;

/**
 * Width of the flat shelf at the top of the bank, in metres.
 *
 * The climb reaches its full height `BANK_RISE` metres out from the flat bed,
 * and then has to stay there across the ribbon's edge. That is not a detail:
 * the terrain is a grid, and a grid vertex near the ribbon's edge can sit up to
 * half a cell inside the climb. At 1.3 m cells that is 0.65 m of a 2.2 m wide
 * rise - not enough to matter on its own, but it was enough, combined with the
 * bed read-back error, to leave the water's edge floating 6 cm above the bank.
 *
 * A shelf a cell wide means the vertices bracketing the ribbon's edge are both
 * on it, so the grid represents it exactly and the burial is whatever
 * `BANK_MARGIN` says it is.
 */
export const BANK_PLATEAU = 1.3;

/**
 * Inverse of `smoothstep` on [0, 1].
 *
 * Needed to place the flat bed so that the bank's rise crosses the water
 * surface exactly at the stream's nominal half-width. Solving `3t^2 - 2t^3 = y`
 * in closed form is possible but unreadable; six Newton steps from 0.7 are
 * exact to double precision for every y in [0, 1].
 */
function smoothstepInverse(y: number): number {
  const target = Math.min(1, Math.max(0, y));
  let t = 0.7;
  for (let i = 0; i < 6; i++) {
    const f = 3 * t * t - 2 * t * t * t - target;
    const df = 6 * t - 6 * t * t;
    if (Math.abs(df) < 1e-9) break;
    t = Math.min(1, Math.max(0, t - f / df));
  }
  return t;
}

/** Ground samples taken across the ribbon when placing the surface. */
const SURFACE_SAMPLES = 5;

/** Smooth Hermite step from 0 to 1. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Clamp to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp to [0, 1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A sampler for the ground height, so this module never imports Terrain. */
export type HeightSampler = (x: number, z: number) => number;

export interface StreamProfileOptions {
  /** World seed. Same seed, same stream. */
  seed?: number;
  /** Half-width at the midpoint of the range, in metres. */
  width?: number;
  /** How far noise may push the half-width either side of `width`. */
  widthVariation?: number;
  /** Depth of water above the channel floor, in metres. */
  depth?: number;
  /** Pollution at the cave end (u = 0). */
  pollutionUpstream?: number;
  /** Pollution at the middle of the spline. */
  pollutionMidstream?: number;
  /** Pollution at the village end (u = 1). */
  pollutionDownstream?: number;
}

/** Everything known about the stream at one point along it. */
export interface StreamQuery {
  /** Shortest distance from the query point to the spline, in metres. */
  readonly distance: number;
  /** Arc-length position of the nearest point on the spline, in metres. */
  readonly arcLength: number;
  /** Half-width of the stream at that arc position, in metres. */
  readonly halfWidth: number;
  /** Height of the water surface at that arc position, in metres. */
  readonly surfaceY: number;
  /** Pollution at that arc position, 0 clean to 1 fully polluted. */
  readonly pollution: number;
}

/**
 * The stream's measurable properties, derived from the spline and a seed.
 *
 * One instance owns one noise field, so `halfWidthAt` is cheap enough to call
 * from the terrain generator's inner loop - 147k vertices, one call each.
 * Building a noise object per call instead would allocate a 512-byte
 * permutation table 147k times.
 */
export class StreamProfile {
  readonly spline: StreamSpline;
  readonly seed: number;
  readonly width: number;
  readonly widthVariation: number;
  readonly depth: number;
  readonly pollutionUpstream: number;
  readonly pollutionMidstream: number;
  readonly pollutionDownstream: number;

  private readonly widthNoise: PerlinNoise2D;

  constructor(spline: StreamSpline, options: StreamProfileOptions = {}) {
    this.spline = spline;
    this.seed = options.seed ?? 0;
    this.width = options.width ?? DEFAULT_STREAM_HALF_WIDTH;
    this.widthVariation = options.widthVariation ?? DEFAULT_STREAM_WIDTH_VARIATION;
    this.depth = options.depth ?? DEFAULT_STREAM_DEPTH;
    this.pollutionUpstream = options.pollutionUpstream ?? DEFAULT_POLLUTION_UPSTREAM;
    this.pollutionMidstream = options.pollutionMidstream ?? DEFAULT_POLLUTION_MIDSTREAM;
    this.pollutionDownstream =
      options.pollutionDownstream ?? DEFAULT_POLLUTION_DOWNSTREAM;

    if (!(this.width > 0)) {
      throw new RangeError(`[StreamProfile] width must be positive, received ${String(this.width)}`);
    }
    if (!(this.widthVariation >= 0)) {
      throw new RangeError(
        `[StreamProfile] widthVariation must be non-negative, received ${String(this.widthVariation)}`,
      );
    }
    if (!(this.depth > 0)) {
      throw new RangeError(`[StreamProfile] depth must be positive, received ${String(this.depth)}`);
    }
    for (const [name, value] of [
      ['pollutionUpstream', this.pollutionUpstream],
      ['pollutionMidstream', this.pollutionMidstream],
      ['pollutionDownstream', this.pollutionDownstream],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError(
          `[StreamProfile] ${name} must be within [0, 1], received ${String(value)}`,
        );
      }
    }

    // A private seed offset so the stream's width and the terrain's hills are
    // decorrelated: sharing one field would make the water narrow exactly where
    // the ground is rough.
    this.widthNoise = new PerlinNoise2D(this.seed + 0x57be);
  }

  /**
   * Half-width `distance` metres along the spline.
   *
   * Arc length, not the curve's own parameter. `StreamSpline.pointAt(u)` is
   * uniform in the Catmull-Rom parameter while `pointAtDistance` is uniform in
   * metres, and mixing the two silently disagrees wherever the control points
   * are unevenly spaced - which is what left the channel's banks lopsided by
   * 13 cm and the water's edge floating before this was made consistent.
   *
   * Two octaves at different scales, so the width wanders rather than pulsing
   * at a single frequency.
   */
  halfWidthAtDistance(distance: number): number {
    const s = clamp(distance, 0, this.spline.length);
    const broad = this.widthNoise.noise(s * 0.018, 0.5);
    const fine = this.widthNoise.noise(s * 0.075, 11.5);
    const half = this.width + (broad * 0.7 + fine * 0.3) * this.widthVariation;
    return clamp(half, MIN_STREAM_HALF_WIDTH, MAX_STREAM_HALF_WIDTH);
  }

  /** Half-width at arc position `u` in [0, 1]. */
  halfWidthAt(u: number): number {
    return this.halfWidthAtDistance(clamp01(u) * this.spline.length);
  }

  /**
   * Half-width of the flat bed under the water, `distance` metres along.
   *
   * The bed is flat out to here and climbs beyond, and the point where the
   * climb crosses the water surface is the stream's nominal half-width. So the
   * flat bed stops short of it by however much of the rise band it takes to get
   * from the bed up to the surface - which is `t * BANK_RISE` where `t` inverts
   * the smoothstep at `depth / (depth + BANK_MARGIN)`.
   *
   * A narrow stream can want a negative flat bed, meaning its whole width is
   * the climb. That is fine: the surface height reads the lowest sample, which
   * is still the bed under the spline. It does mean the stream cannot render
   * narrower than `t * BANK_RISE` - about 1.26 m at the defaults, so 2.5 m of
   * water - which is the narrow end of what the grid can show anyway.
   */
  bedHalfWidthAtDistance(distance: number): number {
    const halfWidth = this.halfWidthAtDistance(distance);
    const t = smoothstepInverse(this.depth / (this.depth + BANK_MARGIN));
    return Math.max(0, halfWidth - t * BANK_RISE);
  }

  /**
   * Half-width of the water ribbon, which reaches past the water up the bank.
   *
   * Wider than the bank top by `BANK_PLATEAU`, so the outer edge of the ribbon
   * always lands on ground the terrain grid can represent exactly. See
   * `BANK_PLATEAU`.
   */
  ribbonHalfWidthAtDistance(distance: number): number {
    return this.bedHalfWidthAtDistance(distance) + BANK_RISE + BANK_PLATEAU;
  }

  /**
   * Water depth at an offset across the flow, `distance` metres along the spline.
   *
   * Taken from the designed cross-section rather than by sampling the terrain,
   * which matters: the terrain is a 384x384 grid, so reading it back gives a
   * depth that jitters by a few centimetres from vertex to vertex, and the
   * shader's shoreline fade would flicker with it. The designed profile is
   * smooth by construction and lands the zero crossing exactly where the plan
   * puts the stream's edge.
   *
   * Negative past the bank top, where the ground is `BANK_MARGIN` above the
   * water and there is no water left to fade.
   */
  depthAtAcross(distance: number, across: number): number {
    const flatTo = this.bedHalfWidthAtDistance(distance);
    const reach = flatTo + BANK_RISE;
    const climb = (this.depth + BANK_MARGIN) * smoothstep(flatTo, reach, Math.abs(across));
    return this.depth - climb;
  }

  /**
   * Unit left-hand normal of the spline at an arc position, in the XZ plane.
   *
   * Shared with `TerrainGenerator`'s channel carve through the same arc-length
   * convention, so the ribbon and the channel cannot disagree about which way
   * is "across".
   */
  normalAtDistance(distance: number): { x: number; z: number } {
    const t = this.spline.tangentAtDistance(distance);
    const len = Math.hypot(t.x, t.z);
    if (len < 1e-9) return { x: 1, z: 0 };
    return { x: -t.z / len, z: t.x / len };
  }

  /**
   * Height of the water surface `distance` metres along the spline.
   *
   * The cross-section is level: every vertex in a row shares this height, and
   * only the ground beneath them varies.
   *
   * The height is `depth` above the lowest ground under the ribbon. That is
   * exact rather than approximate because the channel's bed is flat under the
   * ribbon - see `TerrainGenerator.carveStreamChannel` - so the samples below
   * all read the same height and there is no gradient for the grid's bilinear
   * interpolation to get wrong.
   *
   * An earlier version also clamped the surface below the *highest* ground
   * under the ribbon, to stop the water floating where a bank was low. With a
   * flat bed the highest sample equals the lowest, so that clamp subtracted the
   * margin from the surface itself and sank the water by 0.2 m. It is gone; the
   * burial is now guaranteed by the shape of the carve instead.
   */
  surfaceHeightAtDistance(distance: number, heightAt: HeightSampler): number {
    const d = clamp(distance, 0, this.spline.length);
    const p = this.spline.pointAtDistance(d);
    const n = this.normalAtDistance(d);

    const bedHalfWidth = this.bedHalfWidthAtDistance(d);
    let lowest = heightAt(p.x, p.z);
    for (let w = 1; w < SURFACE_SAMPLES; w++) {
      const across = -bedHalfWidth + (2 * bedHalfWidth * w) / (SURFACE_SAMPLES - 1);
      const g = heightAt(p.x + n.x * across, p.z + n.z * across);
      if (g < lowest) lowest = g;
    }

    return lowest + this.depth;
  }

  /** Height of the water surface at arc position `u` in [0, 1]. */
  surfaceHeightAt(u: number, heightAt: HeightSampler): number {
    return this.surfaceHeightAtDistance(clamp01(u) * this.spline.length, heightAt);
  }

  /**
   * Pollution `distance` metres along the spline, 0 clean to 1 fully polluted.
   *
   * Piecewise smoothstep between the three zones the plan names. Smoothstep
   * has zero derivative at both ends, so the segments join without a visible
   * kink - a linear interpolation would put a corner in the middle of the
   * stream where the pollution gradient suddenly changes rate.
   */
  pollutionAtDistance(distance: number): number {
    const length = this.spline.length;
    const t = length > 0 ? clamp01(distance / length) : 0;
    if (t <= MIDSTREAM_U) {
      return (
        this.pollutionUpstream +
        (this.pollutionMidstream - this.pollutionUpstream) *
          smoothstep(0, MIDSTREAM_U, t)
      );
    }
    return (
      this.pollutionMidstream +
      (this.pollutionDownstream - this.pollutionMidstream) *
        smoothstep(MIDSTREAM_U, 1, t)
    );
  }

  /** Pollution at arc position `u` in [0, 1]. */
  pollutionAt(u: number): number {
    return this.pollutionAtDistance(clamp01(u) * this.spline.length);
  }

  /** Everything known about the stream near a world position. */
  query(x: number, z: number, heightAt: HeightSampler): StreamQuery {
    const nearest = this.spline.distanceTo({ x, y: 0, z });
    return {
      distance: nearest.distance,
      arcLength: nearest.arcLength,
      halfWidth: this.halfWidthAtDistance(nearest.arcLength),
      surfaceY: this.surfaceHeightAtDistance(nearest.arcLength, heightAt),
      pollution: this.pollutionAtDistance(nearest.arcLength),
    };
  }
}

export interface StreamGeneratorOptions extends StreamProfileOptions {
  /** The stream path. Defaults to the standard sweep. */
  spline?: StreamSpline;
  /** Ground height sampler. Required: the water has to sit on the terrain. */
  heightAt?: HeightSampler;
  /** Cross-sections sampled along the spline. */
  segments?: number;
  /** Vertices across the ribbon, including both edges. */
  widthSegments?: number;
}

/** The stream, as plain typed arrays plus the derived queries. */
export interface StreamData {
  readonly spline: StreamSpline;
  readonly profile: StreamProfile;
  readonly segments: number;
  readonly widthSegments: number;

  /** Vertex positions, xyz. */
  readonly vertices: Float32Array;
  /** Triangle indices. */
  readonly indices: Uint32Array;
  /** `(arcLength, across)` per vertex, metres. */
  readonly flow: Float32Array;
  /** Local water depth per vertex, metres. */
  readonly depths: Float32Array;
  /** Pollution per vertex, 0 to 1. */
  readonly pollution: Float32Array;

  /** Total arc length of the spline, metres. */
  readonly length: number;

  /**
   * Everything known about the stream near a world position.
   *
   * Takes the ground sampler rather than holding it, so the same generated
   * stream can be queried against any terrain - which is what lets a test build
   * the stream once and check it against a deliberately different ground.
   */
  query(x: number, z: number, heightAt: HeightSampler): StreamQuery;
  /** True when the point is inside the water. */
  isWaterAt(x: number, z: number, heightAt: HeightSampler): boolean;
  /** Half-width of the ribbon, which reaches past the water up the bank. */
  bankReachAt(u: number): number;
  /** How far the water surface is below the point's feet, or 0 if not in water. */
  submersionAt(x: number, z: number, feetY: number, heightAt: HeightSampler): number;
}

/**
 * Build the stream ribbon.
 *
 * The vertex count is `(segments + 1) * widthSegments`, which for the defaults
 * is 385 * 13 = 5005 - small enough that the whole stream costs less than 2% of
 * the terrain's vertex budget.
 */
export function generateStream(options: StreamGeneratorOptions = {}): StreamData {
  const spline = options.spline ?? new StreamSpline();
  const heightAt = options.heightAt;
  if (typeof heightAt !== 'function') {
    throw new TypeError('[StreamGenerator] heightAt sampler is required');
  }

  const profile = new StreamProfile(spline, options);
  const segments = Math.max(1, Math.floor(options.segments ?? DEFAULT_STREAM_SEGMENTS));
  const widthSegments = Math.max(
    2,
    Math.floor(options.widthSegments ?? DEFAULT_STREAM_WIDTH_SEGMENTS),
  );

  const length = spline.length;
  const vertexCount = (segments + 1) * widthSegments;
  const vertices = new Float32Array(vertexCount * 3);
  const flow = new Float32Array(vertexCount * 2);
  const depths = new Float32Array(vertexCount);
  const pollution = new Float32Array(vertexCount);

  let v = 0;
  for (let i = 0; i <= segments; i++) {
    // Walk the spline in arc length, so the cross-sections are evenly spaced in
    // metres. Walking `u` instead would bunch them wherever the control points
    // bunch, and the flow scroll would speed up and slow down along the stream.
    const a = (i / segments) * length;
    const p = spline.pointAtDistance(a);
    const n = profile.normalAtDistance(a);

    // The ribbon runs past the water's own edge and up the bank, so its outer
    // part sits inside ground and the shoreline can fade instead of ending on a
    // hard line. The shader fades it out by depth, which goes to zero exactly
    // where the ground climbs through the surface.
    const bankReach = profile.ribbonHalfWidthAtDistance(a);
    // Level cross-section: every vertex in this row shares one height.
    const surfaceY = profile.surfaceHeightAtDistance(a, heightAt);
    const poll = profile.pollutionAtDistance(a);

    for (let w = 0; w < widthSegments; w++) {
      const t = widthSegments > 1 ? w / (widthSegments - 1) : 0.5;
      const across = -bankReach + 2 * bankReach * t;
      const x = p.x + n.x * across;
      const z = p.z + n.z * across;

      vertices[v * 3] = x;
      vertices[v * 3 + 1] = surfaceY;
      vertices[v * 3 + 2] = z;

      flow[v * 2] = a;
      flow[v * 2 + 1] = across;

      // Local depth, not the nominal one: the ground climbs out of the water
      // toward the banks, so the water there really is shallower, and the shader
      // uses this to fade the bed pattern out and the shoreline in where the
      // water thins. Clamped at zero because past the shoreline the ground is
      // above the surface and there is no water to speak of.
      depths[v] = Math.max(0, profile.depthAtAcross(a, across));
      pollution[v] = poll;

      v++;
    }
  }

  const indices = new Uint32Array(segments * (widthSegments - 1) * 6);
  let k = 0;
  for (let i = 0; i < segments; i++) {
    for (let w = 0; w < widthSegments - 1; w++) {
      const a = i * widthSegments + w;
      const b = a + 1;
      const c = a + widthSegments;
      const d = c + 1;
      // Wound so the face normal points up, matching the terrain mesh.
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  return {
    spline,
    profile,
    segments,
    widthSegments,
    vertices,
    indices,
    flow,
    depths,
    pollution,
    length,
    query(x, z) {
      return profile.query(x, z, heightAt);
    },
    isWaterAt(x, z, heightAt) {
      const q = profile.query(x, z, heightAt);
      return q.distance <= q.halfWidth;
    },
    /** Half-width of the ribbon, which reaches past the water up the bank. */
    bankReachAt(u: number): number {
      return this.profile.ribbonHalfWidthAtDistance(clamp01(u) * this.spline.length);
    },
    submersionAt(x, z, feetY, heightAt) {
      const q = profile.query(x, z, heightAt);
      if (q.distance > q.halfWidth) return 0;
      return Math.max(0, q.surfaceY - feetY);
    },
  };
}

/**
 * The stream's geometry, ready to hand to a `Mesh`.
 *
 * Custom attributes are named `astra*` so they cannot collide with a Three.js
 * built-in, and the normal is computed from the ribbon itself rather than
 * forced to +Y: the surface follows the terrain, and its lighting should too.
 */
export function buildStreamGeometry(data: StreamData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(data.vertices, 3));
  geometry.setAttribute('astraFlow', new Float32BufferAttribute(data.flow, 2));
  geometry.setAttribute('astraDepth', new Float32BufferAttribute(data.depths, 1));
  geometry.setAttribute('astraPollution', new Float32BufferAttribute(data.pollution, 1));
  geometry.setIndex(new Uint32BufferAttribute(data.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The stream's spline point nearest a world position, for tests and gizmos. */
export function nearestSplinePoint(
  spline: StreamSpline,
  x: number,
  z: number,
): SplinePoint {
  return spline.distanceTo({ x, y: 0, z }).point;
}
