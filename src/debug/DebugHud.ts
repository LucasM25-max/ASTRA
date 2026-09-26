/**
 * DebugHud.ts - ASTRA debug
 * =============================================================================
 * The on-screen half of the Step 1.6 debug overlay: a small panel pinned to the
 * top-left corner showing frame rate, frame time, the TimeController's state and
 * speed, and the renderer's per-frame counters.
 *
 * Why DOM rather than canvas
 * --------------------------
 * The panel is text, it changes a handful of times a second, and it must be
 * readable at any window size. Doing that on the WebGL canvas means a second
 * render pass, a font atlas and a layout system for six lines of text. Doing it
 * in the DOM costs nothing, scales with the browser's own text rendering, and
 * is testable without a GL context - which is the whole reason the jsdom test
 * suite can cover it.
 *
 * The cost contract
 * -----------------
 * This is a debug tool bolted onto a 60fps target, so the important property is
 * that it costs nothing when it is not being looked at:
 *
 *   - hidden: `render()` returns before touching a single DOM node. No writes,
 *     no style recalculation, no layout.
 *   - visible: writes are throttled to `HUD_REFRESH_INTERVAL` of real time
 *     (20Hz). An FPS counter that repaints at 120Hz is unreadable anyway, so
 *     the throttle costs nothing perceptible and removes the work entirely.
 *
 * The throttle is driven by accumulated *real* delta rather than by a wall
 * clock, so it is deterministic under test and immune to a system clock jump.
 *
 * Every value node is created once and mutated in place. Nothing here allocates
 * per frame beyond the string the browser has to store anyway.
 * =============================================================================
 */

import type { TimeState } from '../core/TimeController';

/** How often the panel repaints, in seconds of real time. 20Hz. */
export const HUD_REFRESH_INTERVAL = 0.05;

/** Frame rate the panel treats as "at target". Matches the Phase 1 goal. */
export const TARGET_FPS = 60;

/**
 * The plan's performance budgets, restated so the panel can flag a breach
 * instead of just printing a number nobody reads.
 */
export const PERFORMANCE_BUDGET = {
  /** Draw calls per frame. */
  drawCalls: 200,
  /** Visible triangles per frame. */
  triangles: 500_000,
} as const;

/** DOM id of the panel. Stable so a hot reload can find and reuse it. */
export const HUD_ELEMENT_ID = 'astra-debug-hud';

/**
 * Class marking the injected stylesheet.
 *
 * A class rather than an id on purpose. The panel is deduplicated by id so a
 * hot reload cannot stack two of them, but the stylesheet is deliberately *not*
 * shared: each panel owns its own copy and removes it on dispose, which makes
 * ownership unambiguous and needs no reference counting. Two live panels mean
 * two identical ~2KB stylesheets, which is harmless - CSS is idempotent - and a
 * hot reload leaves at most one stale sheet behind, which the next reload
 * clears.
 */
export const HUD_STYLE_CLASS = 'astra-debug-hud-style';

/** Everything the panel needs to draw one frame. */
export interface DebugSnapshot {
  /** Smoothed frames per second. */
  fps: number;
  /** Wall-clock seconds the frame just took. */
  realDelta: number;
  /** Monotonic frame counter. */
  frame: number;
  /** Fixed simulation steps issued for this frame. */
  fixedSteps: number;
  /** Interpolation alpha for this frame. */
  alpha: number;
  /** Named time state the controller is heading towards. */
  timeState: TimeState;
  /** Current game speed, possibly mid-transition. */
  gameSpeed: number;
  /** Speed being ramped towards. */
  targetSpeed: number;
  /** Current scene state, or null when no SceneManager was supplied. */
  scene: string | null;
  /** Draw calls issued for the last rendered frame. */
  drawCalls: number;
  /** Triangles rendered for the last rendered frame. */
  triangles: number;
  /** Live geometry count in the renderer. */
  geometries: number;
  /** Live texture count in the renderer. */
  textures: number;
  /** Whether the grid gizmo is enabled. */
  grid: boolean;
  /** Whether the axis gizmo is enabled. */
  axes: boolean;
  /** Whether input events are being logged to the console. */
  inputLog: boolean;
}

/** One row of the panel: a label and the node its value is written into. */
interface Row {
  readonly label: string;
  readonly node: HTMLElement;
  /** Set when the row's value is expected to breach a budget. */
  warn?: boolean;
}

const PANEL_STYLES = `
#${HUD_ELEMENT_ID} {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 8px;
  padding: 7px 9px 8px;
  min-width: 172px;
  font: 11px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  color: #cfe3cf;
  background: rgba(6, 10, 8, 0.78);
  border: 1px solid rgba(150, 190, 150, 0.26);
  border-radius: 3px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}

#${HUD_ELEMENT_ID}[hidden] {
  display: none;
}

.astra-debug__head {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-bottom: 4px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(150, 190, 150, 0.18);
}

.astra-debug__fps {
  font-size: 21px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.astra-debug__fps[data-warn="true"] {
  color: #ffb9a6;
}

.astra-debug__fps-unit {
  font-size: 10px;
  opacity: 0.55;
}

.astra-debug__ms {
  margin-left: auto;
  font-size: 10px;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

.astra-debug__row {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  white-space: nowrap;
}

.astra-debug__k {
  opacity: 0.58;
}

.astra-debug__v {
  font-variant-numeric: tabular-nums;
}

.astra-debug__v[data-warn="true"] {
  color: #ffb9a6;
}

.astra-debug__v[data-on="false"] {
  opacity: 0.45;
}
`;

export interface DebugHudOptions {
  /** Element the panel is appended to. Defaults to `document.body`. */
  parent?: HTMLElement | null;
  /** Start visible. Defaults to false - a debug tool must not ship on screen. */
  visible?: boolean;
}

/** Format a speed as a percentage of real time, e.g. `25%`. */
function formatPercent(speed: number): string {
  return `${Math.round(speed * 100)}%`;
}

/** Format a triangle count compactly: 1.2k, 480k, 1.4M. */
function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Format a boolean as an on/off word rather than true/false. */
function formatToggle(on: boolean): string {
  return on ? 'on' : 'off';
}

export class DebugHud {
  private readonly parent: HTMLElement | null;
  private readonly root: HTMLElement;
  private readonly style: HTMLStyleElement | null;
  private readonly rows = new Map<string, Row>();

  private readonly fpsNode: HTMLElement;
  private readonly msNode: HTMLElement;

  private visible: boolean;
  /** Real seconds accumulated towards the next repaint. */
  private refreshClock = 0;
  private disposed = false;

  constructor(options: DebugHudOptions = {}) {
    this.parent = options.parent ?? (typeof document !== 'undefined' ? document.body : null);
    this.visible = options.visible ?? false;

    this.root = document.createElement('div');
    this.root.id = HUD_ELEMENT_ID;
    this.root.className = 'astra-debug';
    // `hidden` rather than display:none in JS: it is one attribute the browser
    // can act on directly, and the stylesheet's `[hidden]` rule wins on
    // specificity over the panel's own `display: flex`.
    this.root.hidden = !this.visible;
    this.root.setAttribute('aria-hidden', 'true');

    const head = document.createElement('div');
    head.className = 'astra-debug__head';

    this.fpsNode = document.createElement('span');
    this.fpsNode.className = 'astra-debug__fps';
    this.fpsNode.textContent = '0';
    this.fpsNode.dataset.warn = 'false';

    const fpsUnit = document.createElement('span');
    fpsUnit.className = 'astra-debug__fps-unit';
    fpsUnit.textContent = 'fps';

    this.msNode = document.createElement('span');
    this.msNode.className = 'astra-debug__ms';
    this.msNode.textContent = '- ms';

    head.append(this.fpsNode, fpsUnit, this.msNode);
    this.root.append(head);

    this.style = DebugHud.injectStyles();

    // Reuse a panel left behind by a hot reload instead of stacking a second
    // one on top of it.
    const existing =
      this.parent !== null ? this.parent.querySelector<HTMLElement>(`#${HUD_ELEMENT_ID}`) : null;
    if (existing !== null) {
      existing.remove();
    }

    // Declare every row up front so `render()` only ever mutates live nodes.
    // Grouped in the order they are read: loop, then game time, then renderer,
    // then the toggles this panel is the only visible record of.
    this.addRow('frame', 'frame');
    this.addRow('steps', 'steps');
    this.addRow('alpha', 'alpha');
    this.addRow('time', 'time');
    this.addRow('speed', 'speed');
    this.addRow('target', 'target');
    this.addRow('scene', 'scene');
    this.addRow('calls', 'draws', true);
    this.addRow('tris', 'tris', true);
    this.addRow('geo', 'geo');
    this.addRow('tex', 'tex');
    this.addRow('grid', 'grid');
    this.addRow('axes', 'axes');
    this.addRow('log', 'log');

    this.parent?.append(this.root);
  }

  /* ---------------------------------------------------------------------- */
  /* State                                                                  */
  /* ---------------------------------------------------------------------- */

  get element(): HTMLElement {
    return this.root;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.root.hidden = !visible;
    // Force a repaint on the next render() even if the throttle would have
    // swallowed it, so a freshly shown panel is never blank for 50ms.
    this.refreshClock = HUD_REFRESH_INTERVAL;
  }

  /* ---------------------------------------------------------------------- */
  /* Rows                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Declare a row. Called once at construction; keeping the nodes alive is what
   * makes `render()` allocation-free.
   */
  private addRow(key: string, label: string, warn = false): void {
    const row = document.createElement('div');
    row.className = 'astra-debug__row';

    const labelNode = document.createElement('span');
    labelNode.className = 'astra-debug__k';
    labelNode.textContent = label;

    const valueNode = document.createElement('span');
    valueNode.className = 'astra-debug__v';
    valueNode.textContent = '-';
    if (warn) valueNode.dataset.warn = 'false';

    row.append(labelNode, valueNode);
    this.root.append(row);
    this.rows.set(key, { label, node: valueNode, warn });
  }

  /** Write a value into a row's node, only when it actually changed. */
  private write(key: string, value: string, warn?: boolean): void {
    const row = this.rows.get(key);
    if (row === undefined) return;
    if (row.node.textContent !== value) {
      row.node.textContent = value;
    }
    if (warn !== undefined && row.node.dataset.warn !== String(warn)) {
      row.node.dataset.warn = String(warn);
    }
  }

  /** Write an on/off toggle row. */
  private writeToggle(key: string, on: boolean): void {
    const row = this.rows.get(key);
    if (row === undefined) return;
    if (row.node.textContent !== formatToggle(on)) {
      row.node.textContent = formatToggle(on);
    }
    if (row.node.dataset.on !== String(on)) {
      row.node.dataset.on = String(on);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Push one frame of state into the panel.
   *
   * Returns true when the DOM was actually written, which is how the tests
   * prove the hidden and throttled paths cost nothing.
   */
  render(snapshot: DebugSnapshot): boolean {
    if (this.disposed) return false;
    if (!this.visible) return false;

    // Throttle on real time, not frame count: at 144fps this still repaints
    // 20 times a second, and a 30fps machine is not punished for it.
    this.refreshClock += snapshot.realDelta;
    if (this.refreshClock < HUD_REFRESH_INTERVAL) return false;
    this.refreshClock = 0;

    const fps = Math.round(snapshot.fps);
    if (this.fpsNode.textContent !== String(fps)) {
      this.fpsNode.textContent = String(fps);
    }
    const fpsWarn = fps > 0 && fps < TARGET_FPS;
    if (this.fpsNode.dataset.warn !== String(fpsWarn)) {
      this.fpsNode.dataset.warn = String(fpsWarn);
    }

    const ms = `${(snapshot.realDelta * 1000).toFixed(2)} ms`;
    if (this.msNode.textContent !== ms) {
      this.msNode.textContent = ms;
    }

    this.write('frame', String(snapshot.frame));
    this.write('steps', String(snapshot.fixedSteps));
    this.write('alpha', snapshot.alpha.toFixed(2));
    this.write('time', snapshot.timeState);
    this.write('speed', formatPercent(snapshot.gameSpeed));
    this.write('target', formatPercent(snapshot.targetSpeed));
    this.write('scene', snapshot.scene ?? '-');
    this.write('calls', String(snapshot.drawCalls), snapshot.drawCalls > PERFORMANCE_BUDGET.drawCalls);
    this.write('tris', formatCount(snapshot.triangles), snapshot.triangles > PERFORMANCE_BUDGET.triangles);
    this.write('geo', String(snapshot.geometries));
    this.write('tex', String(snapshot.textures));
    this.writeToggle('grid', snapshot.grid);
    this.writeToggle('axes', snapshot.axes);
    this.writeToggle('log', snapshot.inputLog);

    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Teardown                                                               */
  /* ---------------------------------------------------------------------- */

  /** Detach the panel and drop the injected stylesheet. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.remove();
    this.rows.clear();
    this.style?.remove();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Append this panel's own stylesheet.
   *
   * Injected rather than shipped in `index.html` so the panel is entirely
   * self-contained: it works in the jsdom test suite, under a hot reload, and
   * dropped into any host page without that page having to know about it.
   */
  private static injectStyles(): HTMLStyleElement | null {
    if (typeof document === 'undefined') return null;

    const style = document.createElement('style');
    style.className = HUD_STYLE_CLASS;
    style.textContent = PANEL_STYLES;
    document.head.append(style);
    return style;
  }
}
