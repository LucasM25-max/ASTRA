// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Color, LineBasicMaterial, LineSegments, Scene, type WebGLRenderer } from 'three';
import { Engine, type EngineFrameInfo } from '../src/core/Engine';
import { EventBus } from '../src/core/EventBus';
import { InputManager } from '../src/core/InputManager';
import { SceneManager, SceneState } from '../src/core/SceneManager';
import { TimeController, TimeState } from '../src/core/TimeController';
import {
  DebugOverlay,
  DEFAULT_AXES_KEY,
  DEFAULT_GRID_KEY,
  DEFAULT_INPUT_LOG_KEY,
  DEFAULT_PAUSE_KEY,
  DEFAULT_TOGGLE_KEY,
  INPUT_LOG_INTERVAL,
} from '../src/debug/DebugOverlay';
import {
  DEFAULT_AXES_COLORS,
  DEFAULT_AXES_SIZE,
  DEFAULT_GRID_CENTER_COLOR,
  DEFAULT_GRID_DIVISIONS,
  DEFAULT_GRID_LINE_COLOR,
  DebugGizmos,
  GRID_HEIGHT,
} from '../src/debug/DebugGizmos';
import {
  DebugHud,
  HUD_ELEMENT_ID,
  HUD_REFRESH_INTERVAL,
  HUD_STYLE_CLASS,
  PERFORMANCE_BUDGET,
  TARGET_FPS,
  type DebugSnapshot,
} from '../src/debug/DebugHud';
import { TERRAIN_SIZE } from '../src/world/Terrain';

/**
 * Step 1.6 - Debug & Polish.
 *
 * The overlay is a developer tool, so what is worth testing is not "does it
 * draw" (no GL context in jsdom) but "does it behave, and does it stay out of
 * the way". The second half is the load-bearing half: a debug panel that costs
 * frame time is a bug, and it is tested here as directly as it can be.
 */

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A frame info object with sane defaults; override only what a test cares about. */
function makeFrame(overrides: Partial<EngineFrameInfo> = {}): EngineFrameInfo {
  return {
    frame: 1,
    realDelta: 1 / 60,
    gameDelta: 1 / 60,
    fixedSteps: 1,
    alpha: 0,
    elapsed: 0,
    realElapsed: 0,
    fps: 60,
    gameSpeed: 1,
    ...overrides,
  };
}

/** A snapshot with sane defaults; override only what a test cares about. */
function makeSnapshot(overrides: Partial<DebugSnapshot> = {}): DebugSnapshot {
  return {
    fps: 60,
    realDelta: 1 / 60,
    frame: 1,
    fixedSteps: 1,
    alpha: 0,
    timeState: TimeState.REALTIME,
    gameSpeed: 1,
    targetSpeed: 1,
    scene: SceneState.GAMEPLAY,
    drawCalls: 6,
    triangles: 1200,
    geometries: 4,
    textures: 0,
    grid: true,
    axes: true,
    inputLog: false,
    ...overrides,
  };
}

/** Read a row's displayed text out of a HUD. */
function rowText(hud: DebugHud, label: string): string {
  const rows = Array.from(hud.element.querySelectorAll<HTMLElement>('.astra-debug__row'));
  for (const row of rows) {
    const key = row.querySelector<HTMLElement>('.astra-debug__k');
    if (key?.textContent === label) {
      return row.querySelector<HTMLElement>('.astra-debug__v')?.textContent ?? '';
    }
  }
  throw new Error(`no HUD row labelled "${label}"`);
}

/**
 * Render repeatedly until the HUD's throttle lets a write through.
 *
 * The panel repaints at 20Hz, so a single call with a realistic 1/60 frame
 * delta is deliberately swallowed. Rendering until it writes keeps the "shows
 * X" tests about the values rather than about the throttle, and exercises the
 * accumulation on the way.
 */
function flush(hud: DebugHud, snapshot: DebugSnapshot): void {
  for (let i = 0; i < 64 && !hud.render(snapshot); i += 1) {
    // Rendering again is the point; the loop is bounded so a broken throttle
    // fails the test rather than hanging it.
  }
}

/** Read a row's warn flag. */
function rowWarn(hud: DebugHud, label: string): string {
  const rows = Array.from(hud.element.querySelectorAll<HTMLElement>('.astra-debug__row'));
  for (const row of rows) {
    const key = row.querySelector<HTMLElement>('.astra-debug__k');
    if (key?.textContent === label) {
      return row.querySelector<HTMLElement>('.astra-debug__v')?.dataset.warn ?? '';
    }
  }
  throw new Error(`no HUD row labelled "${label}"`);
}

interface Rig {
  scene: Scene;
  bus: EventBus;
  input: InputManager;
  timeController: TimeController;
  sceneManager: SceneManager;
  overlay: DebugOverlay;
  target: EventTarget;
  /** One engine frame: poll input, then advance the overlay. */
  frame: (overrides?: Partial<EngineFrameInfo>) => void;
  /** Hold a key down (a repeat if it is already down). */
  press: (code: string) => void;
  /** Press and release a key, the way a quick tap looks to the InputManager. */
  tap: (code: string) => void;
  release: (code: string) => void;
  dispose: () => void;
}

function makeRig(options: { renderer?: boolean } = {}): Rig {
  const scene = new Scene();
  const bus = new EventBus();
  const target = new EventTarget();
  const input = new InputManager({ target, canvas: null, eventBus: bus });
  const timeController = new TimeController({ eventBus: bus });
  const sceneManager = new SceneManager({ eventBus: bus, initialState: SceneState.GAMEPLAY });

  // A stand-in for WebGLRenderer. The overlay only reads `info`, and a partial
  // stub is the honest way to test that read without a GL context.
  const renderer =
    options.renderer === false
      ? undefined
      : ({
          info: {
            render: { calls: 7, triangles: 4321, lines: 0, points: 0, frame: 1 },
            memory: { geometries: 5, textures: 2 },
          },
        } as unknown as WebGLRenderer);

  const overlay = new DebugOverlay({
    scene,
    input,
    timeController,
    sceneManager,
    renderer,
    eventBus: bus,
    parent: document.body,
  });

  const press = (code: string): void => {
    target.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
  };

  const release = (code: string): void => {
    target.dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
  };

  // A tap is what actually reaches `wasKeyPressed`: a key held down emits
  // auto-repeats, which the InputManager reports as `repeat` rather than as a
  // fresh press, so a second keydown with no keyup in between is invisible to
  // edge-triggered bindings like these.
  const tap = (code: string): void => {
    press(code);
    release(code);
  };

  const frame = (overrides: Partial<EngineFrameInfo> = {}): void => {
    input.update();
    overlay.update(makeFrame(overrides));
  };

  return {
    scene,
    bus,
    input,
    timeController,
    sceneManager,
    overlay,
    target,
    frame,
    press,
    tap,
    release,
    dispose: () => {
      overlay.dispose();
      input.dispose();
    },
  };
}

beforeEach(() => {
  // Every test starts from a clean document: a panel or stylesheet left behind
  // by a previous test would make the "creates its own DOM" assertions lie.
  clearDocument();
});

afterEach(() => {
  clearDocument();
  vi.unstubAllGlobals();
});

/** Strip anything a previous test may have left in the document. */
function clearDocument(): void {
  document.getElementById(HUD_ELEMENT_ID)?.remove();
  for (const style of Array.from(document.querySelectorAll(`.${HUD_STYLE_CLASS}`))) {
    style.remove();
  }
}

/* -------------------------------------------------------------------------- */
/* DebugGizmos                                                                */
/* -------------------------------------------------------------------------- */

describe('DebugGizmos', () => {
  it('builds a grid that matches the terrain it measures', () => {
    const gizmos = new DebugGizmos();

    expect(gizmos.gridSize).toBe(TERRAIN_SIZE);
    expect(gizmos.gridDivisions).toBe(DEFAULT_GRID_DIVISIONS);
    // 100m over 50 divisions is a 2m cell - the coarsest grid that still reads
    // as a measurement rather than as texture.
    expect(gizmos.gridSize / gizmos.gridDivisions).toBe(2);
    expect(gizmos.grid).toBeInstanceOf(LineSegments);
    gizmos.dispose();
  });

  it('lifts the grid clear of the ground so it cannot z-fight', () => {
    const gizmos = new DebugGizmos();

    // The terrain's top face sits exactly on y = 0. A grid at y = 0 is coplanar
    // with it and flickers; anything from a millimetre to a few centimetres
    // clears the depth buffer without visibly floating.
    expect(gizmos.grid.position.y).toBe(GRID_HEIGHT);
    expect(GRID_HEIGHT).toBeGreaterThan(0);
    expect(GRID_HEIGHT).toBeLessThan(0.05);
    gizmos.dispose();
  });

  it('uses a brighter centre line than the rest of the grid', () => {
    const gizmos = new DebugGizmos();

    // GridHelper's colours live in a vertex-colour buffer, so they are read
    // back through the geometry rather than the material.
    const colors = gizmos.grid.geometry.getAttribute('color');
    expect(colors).toBeDefined();
    expect(colors.count).toBeGreaterThan(0);

    const center = new Color(DEFAULT_GRID_CENTER_COLOR);
    const line = new Color(DEFAULT_GRID_LINE_COLOR);
    expect(center.r + center.g + center.b).toBeGreaterThan(line.r + line.g + line.b);
    gizmos.dispose();
  });

  it('builds an axis tripod coloured X red, Y green, Z blue', () => {
    const gizmos = new DebugGizmos();

    expect(gizmos.axes).toBeInstanceOf(LineSegments);
    expect(gizmos.axesSize).toBe(DEFAULT_AXES_SIZE);

    // Read the colours the same way: out of the geometry's colour attribute.
    // The first three vertices are the X axis, the next three the Y axis.
    const colors = gizmos.axes.geometry.getAttribute('color');
    expect(colors).toBeDefined();
    expect(colors.count).toBeGreaterThanOrEqual(6);

    // Three stores line colours in a float32 buffer, so the values read back
    // differ from a float64 `Color` in the last couple of digits. The test is
    // about which axis is which, so it compares with a tolerance.
    const expected = new Color(DEFAULT_AXES_COLORS.x);
    expect(colors.getX(0)).toBeCloseTo(expected.r, 5);
    expect(colors.getY(0)).toBeCloseTo(expected.g, 5);
    expect(colors.getZ(0)).toBeCloseTo(expected.b, 5);
    // X is the red axis: more red than green or blue.
    expect(colors.getX(0)).toBeGreaterThan(colors.getY(0));
    expect(colors.getX(0)).toBeGreaterThan(colors.getZ(0));
    gizmos.dispose();
  });

  it('keeps both gizmos opaque and shadow-free', () => {
    const gizmos = new DebugGizmos();

    // Neither helper narrows its material to LineBasicMaterial in the type
    // system, so both are read back through `Material` and narrowed by hand.
    const narrowed: LineBasicMaterial[] = [];
    for (const material of [gizmos.grid.material, gizmos.axes.material]) {
      if (!Array.isArray(material) && material instanceof LineBasicMaterial) {
        narrowed.push(material);
      }
    }
    expect(narrowed).toHaveLength(2);

    // Transparent lines have to be depth-sorted against everything else, which
    // is precisely the ordering bug that makes a debug tool untrustworthy.
    for (const material of narrowed) {
      expect(material.transparent).toBe(false);
      expect(material.opacity).toBe(1);
    }
    for (const helper of [gizmos.grid, gizmos.axes]) {
      expect(helper.castShadow).toBe(false);
      expect(helper.receiveShadow).toBe(false);
      // Never culled: the helpers are small and always wanted when shown.
      expect(helper.frustumCulled).toBe(false);
    }
    gizmos.dispose();
  });

  it('starts invisible so a hidden overlay costs nothing', () => {
    const gizmos = new DebugGizmos();

    expect(gizmos.isGridVisible).toBe(false);
    expect(gizmos.isAxesVisible).toBe(false);
    gizmos.dispose();
  });

  it('toggles each gizmo independently', () => {
    const gizmos = new DebugGizmos();

    gizmos.setGridVisible(true);
    expect(gizmos.isGridVisible).toBe(true);
    expect(gizmos.isAxesVisible).toBe(false);

    gizmos.setAxesVisible(true);
    expect(gizmos.isGridVisible).toBe(true);
    expect(gizmos.isAxesVisible).toBe(true);

    gizmos.setGridVisible(false);
    expect(gizmos.isGridVisible).toBe(false);
    expect(gizmos.isAxesVisible).toBe(true);
    gizmos.dispose();
  });

  it('attaches and detaches from the scene graph', () => {
    const scene = new Scene();
    const gizmos = new DebugGizmos();

    gizmos.addTo(scene);
    expect(scene.children).toContain(gizmos.grid);
    expect(scene.children).toContain(gizmos.axes);

    // Adding twice must not duplicate the children.
    gizmos.addTo(scene);
    expect(scene.children.filter((child) => child === gizmos.grid)).toHaveLength(1);

    gizmos.removeFrom(scene);
    expect(scene.children).not.toContain(gizmos.grid);
    expect(scene.children).not.toContain(gizmos.axes);
    gizmos.dispose();
  });

  it('reparents when moved to a different scene', () => {
    const a = new Scene();
    const b = new Scene();
    const gizmos = new DebugGizmos();

    gizmos.addTo(a);
    gizmos.addTo(b);

    expect(a.children).not.toContain(gizmos.grid);
    expect(b.children).toContain(gizmos.grid);
    gizmos.dispose();
  });

  it('releases its GPU resources on dispose', () => {
    const scene = new Scene();
    const gizmos = new DebugGizmos();
    gizmos.addTo(scene);

    const spies = [
      vi.spyOn(gizmos.grid.geometry, 'dispose'),
      vi.spyOn(gizmos.axes.geometry, 'dispose'),
    ];

    gizmos.dispose();

    for (const spy of spies) {
      expect(spy).toHaveBeenCalledOnce();
    }
    expect(scene.children).not.toContain(gizmos.grid);
    expect(scene.children).not.toContain(gizmos.axes);
    // A second dispose must not throw or double-dispose.
    expect(() => gizmos.dispose()).not.toThrow();
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledOnce();
    }
  });

  it('honours custom sizes', () => {
    const gizmos = new DebugGizmos({
      gridSize: 50,
      gridDivisions: 25,
      axesSize: 5,
      gridCenterColor: 0x112233,
      gridLineColor: 0x445566,
    });

    expect(gizmos.gridSize).toBe(50);
    expect(gizmos.gridDivisions).toBe(25);
    expect(gizmos.axesSize).toBe(5);
    gizmos.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* DebugHud                                                                   */
/* -------------------------------------------------------------------------- */

describe('DebugHud', () => {
  it('creates its panel hidden, with a stylesheet', () => {
    const hud = new DebugHud();

    expect(hud.isVisible).toBe(false);
    expect(hud.element.hidden).toBe(true);
    expect(document.getElementById(HUD_ELEMENT_ID)).toBe(hud.element);
    expect(document.querySelectorAll(`.${HUD_STYLE_CLASS}`)).toHaveLength(1);
    hud.dispose();
  });

  it('can be constructed visible', () => {
    const hud = new DebugHud({ visible: true });

    expect(hud.isVisible).toBe(true);
    expect(hud.element.hidden).toBe(false);
    hud.dispose();
  });

  it('appends to the parent it is given', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const hud = new DebugHud({ parent });

    expect(parent.contains(hud.element)).toBe(true);
    hud.dispose();
    expect(parent.contains(hud.element)).toBe(false);
    parent.remove();
  });

  it('replaces a panel left behind by a hot reload instead of stacking', () => {
    const first = new DebugHud();
    const second = new DebugHud();

    expect(document.querySelectorAll(`#${HUD_ELEMENT_ID}`)).toHaveLength(1);
    expect(document.getElementById(HUD_ELEMENT_ID)).toBe(second.element);

    // Each panel owns its own stylesheet, so tearing the first down leaves the
    // second fully styled.
    first.dispose();
    expect(document.querySelectorAll(`.${HUD_STYLE_CLASS}`)).toHaveLength(1);
    expect(second.isDisposed).toBe(false);
    expect(second.element.hidden).toBe(true);

    second.dispose();
    expect(document.querySelectorAll(`.${HUD_STYLE_CLASS}`)).toHaveLength(0);
  });

  it('writes nothing at all while hidden', () => {
    const hud = new DebugHud();
    const before = hud.element.textContent;

    // Ten frames of a fully populated snapshot, and not one node may change.
    for (let i = 0; i < 10; i += 1) {
      expect(hud.render(makeSnapshot({ fps: 30 + i, frame: i + 1 }))).toBe(false);
    }

    expect(hud.element.textContent).toBe(before);
    expect(hud.element.querySelector<HTMLElement>('.astra-debug__fps')?.textContent).toBe('0');
    hud.dispose();
  });

  it('throttles its repaints to the refresh interval', () => {
    const hud = new DebugHud({ visible: true });

    // 0.01s a frame: the fifth frame is the first to reach 0.05s.
    for (let i = 0; i < 4; i += 1) {
      expect(hud.render(makeSnapshot({ realDelta: 0.01 }))).toBe(false);
    }
    expect(hud.render(makeSnapshot({ realDelta: 0.01 }))).toBe(true);
    // And the clock starts again, so the next four are swallowed.
    for (let i = 0; i < 4; i += 1) {
      expect(hud.render(makeSnapshot({ realDelta: 0.01 }))).toBe(false);
    }
    hud.dispose();
  });

  it('repaints immediately when first shown', () => {
    const hud = new DebugHud();
    expect(hud.render(makeSnapshot())).toBe(false);

    hud.setVisible(true);
    // No throttle delay: a freshly shown panel is never blank for 50ms.
    expect(hud.render(makeSnapshot())).toBe(true);
    hud.dispose();
  });

  it('shows the frame rate, frame time and frame count', () => {
    const hud = new DebugHud({ visible: true });

    flush(hud, makeSnapshot({ fps: 59.6, realDelta: 1 / 60, frame: 1234, fixedSteps: 2, alpha: 0.42 }));

    expect(hud.element.querySelector<HTMLElement>('.astra-debug__fps')?.textContent).toBe('60');
    expect(hud.element.querySelector<HTMLElement>('.astra-debug__ms')?.textContent).toBe('16.67 ms');
    expect(rowText(hud, 'frame')).toBe('1234');
    expect(rowText(hud, 'steps')).toBe('2');
    expect(rowText(hud, 'alpha')).toBe('0.42');
    hud.dispose();
  });

  it('shows the TimeController state and speed as a percentage', () => {
    const hud = new DebugHud({ visible: true });

    flush(
      hud,
      makeSnapshot({
        timeState: TimeState.DILATED,
        gameSpeed: 0.25,
        targetSpeed: 0.25,
        scene: SceneState.GAMEPLAY,
      }),
    );

    expect(rowText(hud, 'time')).toBe('DILATED');
    expect(rowText(hud, 'speed')).toBe('25%');
    expect(rowText(hud, 'target')).toBe('25%');
    expect(rowText(hud, 'scene')).toBe('GAMEPLAY');
    hud.dispose();
  });

  it('shows a mid-transition speed that differs from its target', () => {
    const hud = new DebugHud({ visible: true });

    // Halfway through a 1.0 -> 0.25 ramp: the state column has already moved,
    // the speed column has not. That difference is the point of showing both.
    flush(hud, makeSnapshot({ timeState: TimeState.DILATED, gameSpeed: 0.625, targetSpeed: 0.25 }));

    expect(rowText(hud, 'time')).toBe('DILATED');
    expect(rowText(hud, 'speed')).toBe('63%');
    expect(rowText(hud, 'target')).toBe('25%');
    hud.dispose();
  });

  it('shows the renderer counters, compactly', () => {
    const hud = new DebugHud({ visible: true });

    flush(hud, makeSnapshot({ drawCalls: 7, triangles: 4321, geometries: 5, textures: 2 }));
    expect(rowText(hud, 'draws')).toBe('7');
    expect(rowText(hud, 'tris')).toBe('4.3k');
    expect(rowText(hud, 'geo')).toBe('5');
    expect(rowText(hud, 'tex')).toBe('2');

    flush(hud, makeSnapshot({ triangles: 480_000 }));
    expect(rowText(hud, 'tris')).toBe('480.0k');

    flush(hud, makeSnapshot({ triangles: 1_400_000 }));
    expect(rowText(hud, 'tris')).toBe('1.4M');
    hud.dispose();
  });

  it('flags a frame rate below the 60fps target', () => {
    const hud = new DebugHud({ visible: true });

    flush(hud, makeSnapshot({ fps: 60 }));
    expect(hud.element.querySelector<HTMLElement>('.astra-debug__fps')?.dataset.warn).toBe('false');

    flush(hud, makeSnapshot({ fps: 42 }));
    expect(hud.element.querySelector<HTMLElement>('.astra-debug__fps')?.dataset.warn).toBe('true');

    // Zero is "not measured yet", not "too slow" - it must not warn on frame 1.
    flush(hud, makeSnapshot({ fps: 0 }));
    expect(hud.element.querySelector<HTMLElement>('.astra-debug__fps')?.dataset.warn).toBe('false');
    hud.dispose();
  });

  it('flags a breach of the performance budget', () => {
    const hud = new DebugHud({ visible: true });

    flush(hud, makeSnapshot({ drawCalls: 6, triangles: 1200 }));
    expect(rowWarn(hud, 'draws')).toBe('false');
    expect(rowWarn(hud, 'tris')).toBe('false');

    flush(hud, makeSnapshot({ drawCalls: PERFORMANCE_BUDGET.drawCalls + 1 }));
    expect(rowWarn(hud, 'draws')).toBe('true');

    flush(hud, makeSnapshot({ triangles: PERFORMANCE_BUDGET.triangles + 1 }));
    expect(rowWarn(hud, 'tris')).toBe('true');

    // Exactly at budget is not a breach.
    flush(
      hud,
      makeSnapshot({
        drawCalls: PERFORMANCE_BUDGET.drawCalls,
        triangles: PERFORMANCE_BUDGET.triangles,
      }),
    );
    expect(rowWarn(hud, 'draws')).toBe('false');
    expect(rowWarn(hud, 'tris')).toBe('false');
    hud.dispose();
  });

  it('shows the gizmo and logging toggles as on/off', () => {
    const hud = new DebugHud({ visible: true });

    flush(hud, makeSnapshot({ grid: true, axes: false, inputLog: false }));
    expect(rowText(hud, 'grid')).toBe('on');
    expect(rowText(hud, 'axes')).toBe('off');
    expect(rowText(hud, 'log')).toBe('off');

    flush(hud, makeSnapshot({ grid: false, axes: true, inputLog: true }));
    expect(rowText(hud, 'grid')).toBe('off');
    expect(rowText(hud, 'axes')).toBe('on');
    expect(rowText(hud, 'log')).toBe('on');
    hud.dispose();
  });

  it('does not rewrite a node whose value has not changed', () => {
    const hud = new DebugHud({ visible: true });
    flush(hud, makeSnapshot({ frame: 10 }));

    const node = hud.element.querySelector<HTMLElement>('.astra-debug__fps');
    expect(node).not.toBeNull();
    const spy = vi.spyOn(node as HTMLElement, 'textContent', 'set');

    // Both calls carry a delta past the throttle, so the only thing that can
    // suppress the first write is the value being unchanged.
    flush(hud, makeSnapshot({ frame: 10, realDelta: 0.2 }));
    expect(spy).not.toHaveBeenCalled();

    flush(hud, makeSnapshot({ frame: 10, realDelta: 0.2, fps: 12 }));
    expect(spy).toHaveBeenCalled();
    hud.dispose();
  });

  it('removes its panel and stylesheet on dispose', () => {
    const hud = new DebugHud({ visible: true });

    hud.dispose();

    expect(hud.isDisposed).toBe(true);
    expect(document.getElementById(HUD_ELEMENT_ID)).toBeNull();
    expect(document.querySelectorAll(`.${HUD_STYLE_CLASS}`)).toHaveLength(0);
    expect(() => hud.dispose()).not.toThrow();
    // A disposed panel must never write again.
    expect(hud.render(makeSnapshot())).toBe(false);
  });

  it('uses the documented refresh interval and target', () => {
    // Pinned so a future edit to either value has to be a deliberate decision.
    expect(HUD_REFRESH_INTERVAL).toBe(0.05);
    expect(TARGET_FPS).toBe(60);
    expect(PERFORMANCE_BUDGET.drawCalls).toBe(200);
    expect(PERFORMANCE_BUDGET.triangles).toBe(500_000);
  });
});

/* -------------------------------------------------------------------------- */
/* DebugOverlay                                                               */
/* -------------------------------------------------------------------------- */

describe('DebugOverlay: visibility', () => {
  it('starts hidden, with the gizmos in the scene but invisible', () => {
    const rig = makeRig();

    expect(rig.overlay.isVisible).toBe(false);
    expect(rig.overlay.hud.isVisible).toBe(false);
    expect(rig.overlay.gizmos.isGridVisible).toBe(false);
    expect(rig.overlay.gizmos.isAxesVisible).toBe(false);
    // Present in the graph, so showing never has to touch the scene tree.
    expect(rig.scene.children).toContain(rig.overlay.gizmos.grid);
    rig.dispose();
  });

  it('toggles the whole overlay on F3', () => {
    const rig = makeRig();

    rig.frame();
    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.frame();

    expect(rig.overlay.isVisible).toBe(true);
    expect(rig.overlay.hud.isVisible).toBe(true);
    expect(rig.overlay.gizmos.isGridVisible).toBe(true);
    expect(rig.overlay.gizmos.isAxesVisible).toBe(true);

    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.frame();

    expect(rig.overlay.isVisible).toBe(false);
    expect(rig.overlay.gizmos.isGridVisible).toBe(false);
    rig.dispose();
  });

  it('ignores a repeat of the toggle key while it is held', () => {
    const rig = makeRig();
    rig.frame();

    // Holding F3 down: the browser emits keydown repeats, and each one must not
    // flip the overlay back.
    for (let i = 0; i < 5; i += 1) {
      rig.press(DEFAULT_TOGGLE_KEY);
      rig.frame();
    }

    expect(rig.overlay.isVisible).toBe(true);
    rig.dispose();
  });

  it('remembers the gizmo choices across a hide and a show', () => {
    const rig = makeRig();
    rig.frame();

    // F4 turns the grid off. It does not reveal the overlay, because turning
    // something off is not a request to look at it.
    rig.tap(DEFAULT_GRID_KEY);
    rig.frame();
    expect(rig.overlay.isVisible).toBe(false);
    expect(rig.overlay.isGridEnabled).toBe(false);
    expect(rig.overlay.gizmos.isGridVisible).toBe(false);

    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.frame();
    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.frame();
    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.frame();

    // Shown again: the grid is still off, because "enabled" and "visible" are
    // different decisions and only the second one was toggled.
    expect(rig.overlay.isVisible).toBe(true);
    expect(rig.overlay.isGridEnabled).toBe(false);
    expect(rig.overlay.gizmos.isGridVisible).toBe(false);
    expect(rig.overlay.gizmos.isAxesVisible).toBe(true);
    rig.dispose();
  });

  it('reveals the overlay when a gizmo is switched on', () => {
    const rig = makeRig();
    rig.frame();

    // Both gizmos start enabled, so the first F4 turns the grid *off* - and
    // turning something off is not a request to look at it.
    rig.tap(DEFAULT_GRID_KEY);
    rig.frame();
    expect(rig.overlay.isVisible).toBe(false);
    expect(rig.overlay.isGridEnabled).toBe(false);

    // The second F4 switches it back on, and that does reveal the overlay.
    rig.tap(DEFAULT_GRID_KEY);
    rig.frame();
    expect(rig.overlay.isVisible).toBe(true);
    expect(rig.overlay.gizmos.isGridVisible).toBe(true);

    // The same rule holds for the axis tripod.
    rig.tap(DEFAULT_AXES_KEY);
    rig.frame();
    expect(rig.overlay.isAxesEnabled).toBe(false);
    expect(rig.overlay.gizmos.isAxesVisible).toBe(false);

    rig.tap(DEFAULT_AXES_KEY);
    rig.frame();
    expect(rig.overlay.isVisible).toBe(true);
    expect(rig.overlay.gizmos.isAxesVisible).toBe(true);
    rig.dispose();
  });

  it('toggles the axis tripod on its own key', () => {
    const rig = makeRig();
    rig.frame();
    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.frame();

    rig.tap(DEFAULT_AXES_KEY);
    rig.frame();
    expect(rig.overlay.isAxesEnabled).toBe(false);
    expect(rig.overlay.gizmos.isAxesVisible).toBe(false);
    expect(rig.overlay.gizmos.isGridVisible).toBe(true);

    rig.tap(DEFAULT_AXES_KEY);
    rig.frame();
    expect(rig.overlay.isAxesEnabled).toBe(true);
    expect(rig.overlay.gizmos.isAxesVisible).toBe(true);
    rig.dispose();
  });
});

describe('DebugOverlay: time readout and bindings', () => {
  it('drives the TimeController from the 1/2/3 keys', () => {
    const rig = makeRig();
    rig.frame();

    rig.tap('Digit2');
    rig.frame();
    expect(rig.timeController.state).toBe(TimeState.DILATED);
    expect(rig.timeController.targetSpeed).toBeCloseTo(0.25, 6);

    rig.tap('Digit3');
    rig.frame();
    expect(rig.timeController.state).toBe(TimeState.PAUSED);
    expect(rig.timeController.isPaused).toBe(true);

    rig.tap('Digit1');
    rig.frame();
    expect(rig.timeController.state).toBe(TimeState.REALTIME);
    expect(rig.timeController.targetSpeed).toBeCloseTo(1, 6);
    rig.dispose();
  });

  it('toggles pause on P and restores the previous speed', () => {
    const rig = makeRig();
    rig.frame();

    rig.tap(DEFAULT_PAUSE_KEY);
    rig.frame();
    expect(rig.timeController.isPaused).toBe(true);

    rig.tap(DEFAULT_PAUSE_KEY);
    rig.frame();
    expect(rig.timeController.isPaused).toBe(false);
    expect(rig.timeController.targetSpeed).toBeCloseTo(1, 6);
    rig.dispose();
  });

  it('shows the time state and speed in the HUD once visible', () => {
    const rig = makeRig();
    rig.frame();

    rig.tap(DEFAULT_TOGGLE_KEY);
    // Two frames: the first reveals the panel, the second gets past the
    // throttle and actually writes.
    rig.frame({ realDelta: 0.2 });
    rig.frame({ realDelta: 0.2 });

    rig.tap('Digit2');
    rig.frame({ realDelta: 0.2 });

    expect(rowText(rig.overlay.hud, 'time')).toBe('DILATED');
    expect(rowText(rig.overlay.hud, 'target')).toBe('25%');
    rig.dispose();
  });

  it('works without a SceneManager or a renderer', () => {
    const scene = new Scene();
    const bus = new EventBus();
    const target = new EventTarget();
    const input = new InputManager({ target, canvas: null, eventBus: bus });
    const timeController = new TimeController({ eventBus: bus });

    const overlay = new DebugOverlay({ scene, input, timeController, parent: document.body });

    overlay.setVisible(true);
    input.update();
    overlay.update(makeFrame({ realDelta: 0.2 }));

    expect(rowText(overlay.hud, 'scene')).toBe('-');
    expect(rowText(overlay.hud, 'draws')).toBe('0');
    expect(rowText(overlay.hud, 'tris')).toBe('0');
    overlay.dispose();
    input.dispose();
  });
});

describe('DebugOverlay: input logging', () => {
  it('logs nothing until it is switched on', () => {
    const rig = makeRig();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rig.frame();

    rig.press('KeyW');
    rig.target.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1 }));
    rig.target.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
    rig.frame();

    expect(spy).not.toHaveBeenCalled();
    rig.dispose();
  });

  it('logs key presses, releases and modifiers', () => {
    const rig = makeRig();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rig.frame();

    rig.tap(DEFAULT_INPUT_LOG_KEY);
    rig.frame();
    expect(rig.overlay.isLoggingInput).toBe(true);

    rig.press('KeyW');
    rig.frame();
    expect(spy).toHaveBeenCalledWith('[ASTRA:input] key down  KeyW');

    rig.target.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }));
    rig.frame();
    expect(spy).toHaveBeenCalledWith('[ASTRA:input] key up    KeyW');

    rig.target.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', shiftKey: true, ctrlKey: true }),
    );
    rig.frame();
    expect(spy).toHaveBeenCalledWith('[ASTRA:input] key down  KeyW +ctrl+shift');
    rig.dispose();
  });

  it('marks auto-repeat as a repeat', () => {
    const rig = makeRig();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rig.frame();

    rig.tap(DEFAULT_INPUT_LOG_KEY);
    rig.frame();

    // Second press of the same key with it still held: the InputManager reports
    // repeat rather than a fresh press.
    rig.press('Space');
    rig.frame();
    rig.press('Space');
    rig.frame();

    const lines = spy.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('[ASTRA:input] key down  Space');
    expect(lines).toContain('[ASTRA:input] key down  Space (repeat)');
    rig.dispose();
  });

  it('logs mouse buttons and the wheel', () => {
    const rig = makeRig();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rig.frame();

    rig.tap(DEFAULT_INPUT_LOG_KEY);
    rig.frame();

    rig.target.dispatchEvent(new MouseEvent('mousedown', { button: 2, buttons: 2 }));
    rig.frame();
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\[ASTRA:input\] mouse down  button=2/));

    rig.target.dispatchEvent(new MouseEvent('mouseup', { button: 2, buttons: 0 }));
    rig.frame();
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\[ASTRA:input\] mouse up    button=2/));

    rig.target.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: -120 }));
    rig.frame();
    expect(spy).toHaveBeenCalledWith('[ASTRA:input] wheel       dx=0 dy=-120');
    rig.dispose();
  });

  it('coalesces mouse movement into one line per interval', () => {
    const rig = makeRig();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rig.frame();

    rig.tap(DEFAULT_INPUT_LOG_KEY);
    rig.frame();

    // Four moves inside a single frame: at a 120Hz mouse this is the normal
    // case, and logging each one would be unreadable.
    for (let i = 0; i < 4; i += 1) {
      rig.target.dispatchEvent(new MouseEvent('mousemove', { clientX: i * 10, clientY: 0 }));
    }
    rig.frame({ realDelta: 0.2 });

    const moveLines = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('mouse move'));
    expect(moveLines).toHaveLength(1);
    expect(moveLines[0]).toContain('(+3 more)');
    rig.dispose();
  });

  it('holds a move back until the interval has elapsed', () => {
    const rig = makeRig();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rig.frame();

    rig.tap(DEFAULT_INPUT_LOG_KEY);
    rig.frame();

    rig.target.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 0 }));
    // A short frame: not enough real time has passed, so the line waits.
    rig.frame({ realDelta: INPUT_LOG_INTERVAL / 2 });
    expect(spy.mock.calls.filter((call) => String(call[0]).includes('mouse move'))).toHaveLength(0);

    rig.frame({ realDelta: INPUT_LOG_INTERVAL });
    expect(spy.mock.calls.filter((call) => String(call[0]).includes('mouse move'))).toHaveLength(1);
    rig.dispose();
  });

  it('drops buffered movement when logging is switched off', () => {
    const rig = makeRig();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rig.frame();

    rig.tap(DEFAULT_INPUT_LOG_KEY);
    rig.frame();

    rig.target.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 0 }));

    rig.tap(DEFAULT_INPUT_LOG_KEY);
    rig.frame();

    rig.frame({ realDelta: 0.5 });
    expect(spy.mock.calls.filter((call) => String(call[0]).includes('mouse move'))).toHaveLength(0);
    expect(rig.overlay.isLoggingInput).toBe(false);
    rig.dispose();
  });

  it('reports its logging state in the HUD', () => {
    const rig = makeRig();
    rig.frame();
    rig.tap(DEFAULT_TOGGLE_KEY);
    rig.frame({ realDelta: 0.2 });
    expect(rowText(rig.overlay.hud, 'log')).toBe('off');

    rig.tap(DEFAULT_INPUT_LOG_KEY);
    rig.frame({ realDelta: 0.2 });
    expect(rowText(rig.overlay.hud, 'log')).toBe('on');
    rig.dispose();
  });
});

describe('DebugOverlay: cost', () => {
  it('writes no DOM while hidden', () => {
    const rig = makeRig();
    rig.frame();

    const fps = rig.overlay.hud.element.querySelector<HTMLElement>('.astra-debug__fps');
    expect(fps).not.toBeNull();
    const spy = vi.spyOn(fps as HTMLElement, 'textContent', 'set');

    // A thousand hidden frames - a long play session's worth of keyboard and
    // mouse activity - must not touch a single node.
    for (let i = 0; i < 1000; i += 1) {
      rig.tap(i % 3 === 0 ? 'KeyW' : 'KeyA');
      rig.frame({ realDelta: 1 / 60 });
    }

    expect(spy).not.toHaveBeenCalled();
    expect(rig.overlay.hud.isVisible).toBe(false);
    rig.dispose();
  });

  it('writes no DOM while hidden even with input logging on', () => {
    const rig = makeRig();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rig.frame();

    rig.tap(DEFAULT_INPUT_LOG_KEY);
    rig.frame();

    const fps = rig.overlay.hud.element.querySelector<HTMLElement>('.astra-debug__fps');
    const domSpy = vi.spyOn(fps as HTMLElement, 'textContent', 'set');

    for (let i = 0; i < 100; i += 1) {
      rig.tap('KeyW');
      rig.target.dispatchEvent(new MouseEvent('mousemove', { clientX: i, clientY: 0 }));
      rig.frame({ realDelta: 0.2 });
    }

    expect(domSpy).not.toHaveBeenCalled();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    rig.dispose();
  });

  it('never produces a NaN readout, whatever the frame reports', () => {
    const rig = makeRig();
    rig.tap(DEFAULT_TOGGLE_KEY);

    for (const realDelta of [0, 1 / 60, 0.1, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      rig.frame({ realDelta });
    }
    rig.frame({ realDelta: 0.2 });

    for (const label of ['frame', 'steps', 'alpha', 'speed', 'draws', 'tris']) {
      const text = rowText(rig.overlay.hud, label);
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('Infinity');
      expect(text).not.toContain('undefined');
    }
    rig.dispose();
  });

  it('survives a disposed overlay', () => {
    const rig = makeRig();
    rig.dispose();

    expect(rig.overlay.isDisposed).toBe(true);
    expect(() => rig.frame()).not.toThrow();
    expect(() => rig.press(DEFAULT_TOGGLE_KEY)).not.toThrow();
    expect(() => rig.frame()).not.toThrow();
    expect(document.getElementById(HUD_ELEMENT_ID)).toBeNull();
    expect(rig.scene.children).not.toContain(rig.overlay.gizmos.grid);
  });
});

/* -------------------------------------------------------------------------- */
/* Engine wiring                                                              */
/* -------------------------------------------------------------------------- */

describe('DebugOverlay on the engine', () => {
  it('is driven by the render loop and survives dilation and pause', () => {
    const scene = new Scene();
    const bus = new EventBus();
    const target = new EventTarget();
    const input = new InputManager({ target, canvas: null, eventBus: bus });
    const timeController = new TimeController({ eventBus: bus });
    const overlay = new DebugOverlay({ scene, input, timeController, parent: document.body });

    const engine = new Engine({ eventBus: bus, timeController });
    engine.onFrameStart(() => input.update());
    engine.onRender((frame) => overlay.update(frame));
    engine.start();

    // The engine's clock has to be advanced by a fixed amount per step.
    // Recomputing `performance.now() + ms` on every call would advance it by
    // only however much real time the test body took, which is microseconds -
    // and the panel would then repaint a handful of times in total.
    let clock = performance.now();
    const step = (ms: number): void => {
      clock += ms;
      engine.advance(clock);
    };

    // jsdom's rAF needs a warm-up loop before the first real timestamp.
    for (let i = 0; i < 5; i += 1) step(16);

    overlay.setVisible(true);
    for (let i = 0; i < 10; i += 1) step(16);


    expect(overlay.hud.element.hidden).toBe(false);
    expect(Number(rowText(overlay.hud, 'frame'))).toBeGreaterThan(0);

    // Dilate, then pause: the overlay must keep counting frames either way,
    // because it runs on real time like the camera.
    timeController.setState(TimeState.DILATED, 0);
    for (let i = 0; i < 10; i += 1) step(16);
    expect(Number(rowText(overlay.hud, 'frame'))).toBeGreaterThan(10);
    expect(rowText(overlay.hud, 'time')).toBe('DILATED');

    timeController.setState(TimeState.PAUSED, 0);
    for (let i = 0; i < 10; i += 1) step(16);
    expect(Number(rowText(overlay.hud, 'frame'))).toBeGreaterThan(20);
    expect(rowText(overlay.hud, 'time')).toBe('PAUSED');

    engine.stop();
    overlay.dispose();
    input.dispose();
  });
});
