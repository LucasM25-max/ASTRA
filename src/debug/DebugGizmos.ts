/**
 * DebugGizmos.ts - ASTRA debug
 * =============================================================================
 * The in-world half of the Step 1.6 debug overlay: a measurement grid lying on
 * the ground and an axis tripod at the origin.
 *
 * Both are ordinary Three.js helpers wrapped in a small owner so they can be
 * added, removed and disposed with the rest of the scene graph, and so their
 * visibility can be driven from outside without anything reaching into Three.
 *
 * Two details that are easy to get wrong and visible immediately:
 *
 *   1. The grid is lifted `GRID_HEIGHT` above the ground. The terrain's top
 *      face sits exactly on y = 0, so a grid drawn at y = 0 is coplanar with
 *      it and z-fights into flickering noise. Two centimetres clears the depth
 *      buffer's precision at gameplay distances and still reads as "on the
 *      ground".
 *
 *   2. Neither gizmo is transparent. Transparent lines have to be depth-sorted
 *      against everything else, which is exactly the kind of ordering bug that
 *      makes a debug tool untrustworthy. Muted colours at full opacity read
 *      clearly without being loud, so there is no reason to take the risk.
 *
 * Neither gizmo touches fog: they are flat line art at the origin, well inside
 * the fog's near plane, so fog has no effect on them anyway.
 * =============================================================================
 */

import { AxesHelper, GridHelper, type Material, type Object3D } from 'three';

/** Side length of the grid, in metres. Matches `TERRAIN_SIZE`. */
export const DEFAULT_GRID_SIZE = 500;

/**
 * Cells across the grid. 250 divisions over 500m is a 2m cell, which is the
 * smallest size that reads as a measurement rather than as texture - a 1m cell
 * turns into moire at any distance.
 *
 * The cell size, not the division count, is the invariant: it was 2m over the
 * old 100m terrain and it is 2m over the 500m one.
 */
export const DEFAULT_GRID_DIVISIONS = 250;

/** Length of the axis lines, in metres. Long enough to point, short enough to stay local. */
export const DEFAULT_AXES_SIZE = 3;

/** Height the grid is lifted to, in metres. See note 1 in the file header. */
export const GRID_HEIGHT = 0.02;

/** Centre line of the grid - the two lines through the origin. */
export const DEFAULT_GRID_CENTER_COLOR = 0xdbe7d8;

/** Every other grid line. */
export const DEFAULT_GRID_LINE_COLOR = 0x8fa38a;

/**
 * Axis colours: X red, Y green, Z blue, toned down from the pure primaries so
 * the tripod does not bleach out the view. The assignment is the universal one
 * and is deliberately not customisable - a debug axis that is not red/green/blue
 * is worse than no axis at all.
 */
export const DEFAULT_AXES_COLORS = { x: 0xe05a4a, y: 0x5ac45a, z: 0x4a86e2 } as const;

/**
 * Dispose a material or an array of them.
 *
 * `AxesHelper` is typed as `LineSegments` with no material generic, so its
 * material is `Material | Material[]` and cannot be disposed without narrowing.
 * Both helpers are built with a single material in practice, but the guard
 * keeps this honest if Three ever changes that.
 */
function disposeMaterial(material: Material | Material[]): void {
  if (Array.isArray(material)) {
    for (const entry of material) entry.dispose();
    return;
  }
  material.dispose();
}

export interface DebugGizmosOptions {
  /** Side length of the grid, in metres. Defaults to `DEFAULT_GRID_SIZE`. */
  gridSize?: number;
  /** Cells across the grid. Defaults to `DEFAULT_GRID_DIVISIONS`. */
  gridDivisions?: number;
  /** Length of the axis lines, in metres. Defaults to `DEFAULT_AXES_SIZE`. */
  axesSize?: number;
  /** Centre line colour. Defaults to `DEFAULT_GRID_CENTER_COLOR`. */
  gridCenterColor?: number;
  /** Grid line colour. Defaults to `DEFAULT_GRID_LINE_COLOR`. */
  gridLineColor?: number;
  /** Axis colours. Defaults to `DEFAULT_AXES_COLORS`. */
  axesColors?: { readonly x?: number; readonly y?: number; readonly z?: number };
}

export class DebugGizmos {
  /** Measurement grid lying flat on the ground, centred on the origin. */
  readonly grid: GridHelper;

  /** X/Y/Z tripod at the origin. */
  readonly axes: AxesHelper;

  /** Parent these gizmos were last added to, or null if detached. */
  private attachedTo: Object3D | null = null;

  /** Size the grid was built with, in metres. Exposed for tests and for the HUD. */
  readonly gridSize: number;

  /** Divisions the grid was built with. */
  readonly gridDivisions: number;

  /** Size the axes were built with, in metres. */
  readonly axesSize: number;

  private disposed = false;

  constructor(options: DebugGizmosOptions = {}) {
    this.gridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
    this.gridDivisions = options.gridDivisions ?? DEFAULT_GRID_DIVISIONS;
    this.axesSize = options.axesSize ?? DEFAULT_AXES_SIZE;

    // GridHelper(size, divisions, centerLineColor, gridColor). It is built in
    // the XZ plane already, so no rotation is needed - only the lift.
    this.grid = new GridHelper(
      this.gridSize,
      this.gridDivisions,
      options.gridCenterColor ?? DEFAULT_GRID_CENTER_COLOR,
      options.gridLineColor ?? DEFAULT_GRID_LINE_COLOR,
    );
    this.grid.name = 'debug-grid';
    this.grid.position.y = GRID_HEIGHT;
    // Invisible until the overlay is shown. Three skips invisible subtrees
    // entirely, so a hidden gizmo costs nothing at render time.
    this.grid.visible = false;
    // A gizmo must never be culled by a bounding sphere that does not know
    // about the lift above, and must never cast or receive shadows.
    this.grid.frustumCulled = false;
    this.grid.castShadow = false;
    this.grid.receiveShadow = false;

    const axesColors = options.axesColors ?? {};
    this.axes = new AxesHelper(this.axesSize);
    this.axes.name = 'debug-axes';
    this.axes.setColors(
      axesColors.x ?? DEFAULT_AXES_COLORS.x,
      axesColors.y ?? DEFAULT_AXES_COLORS.y,
      axesColors.z ?? DEFAULT_AXES_COLORS.z,
    );
    this.axes.visible = false;
    this.axes.frustumCulled = false;
    this.axes.castShadow = false;
    this.axes.receiveShadow = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Visibility                                                             */
  /* ---------------------------------------------------------------------- */

  get isGridVisible(): boolean {
    return this.grid.visible;
  }

  get isAxesVisible(): boolean {
    return this.axes.visible;
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
  }

  setAxesVisible(visible: boolean): void {
    this.axes.visible = visible;
  }

  /* ---------------------------------------------------------------------- */
  /* Scene graph                                                            */
  /* ---------------------------------------------------------------------- */

  /** Attach both gizmos to `parent`. Idempotent. */
  addTo(parent: Object3D): void {
    if (this.attachedTo === parent) return;
    if (this.attachedTo !== null) this.removeFrom(this.attachedTo);
    parent.add(this.grid, this.axes);
    this.attachedTo = parent;
  }

  /** Detach both gizmos from `parent`. Safe to call when already detached. */
  removeFrom(parent: Object3D): void {
    if (this.attachedTo !== parent) return;
    parent.remove(this.grid, this.axes);
    this.attachedTo = null;
  }

  /**
   * Release the GPU resources the two helpers allocated.
   *
   * Idempotent, like every other `dispose()` in the codebase: a double call
   * from a teardown path that has already run must not dispose a geometry
   * twice, which Three would treat as a use-after-free.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.attachedTo !== null) {
      this.removeFrom(this.attachedTo);
    }
    this.grid.geometry.dispose();
    disposeMaterial(this.grid.material);
    this.axes.geometry.dispose();
    disposeMaterial(this.axes.material);
  }
}
