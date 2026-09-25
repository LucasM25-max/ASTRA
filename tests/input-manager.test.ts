import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type AstraEvents } from '../src/core/EventBus';
import { InputManager } from '../src/core/InputManager';

/* -------------------------------------------------------------------------- */
/* Minimal fake DOM                                                           */
/* -------------------------------------------------------------------------- */

interface DispatchedEvent {
  type: string;
  preventDefault: () => void;
  [key: string]: unknown;
}

function createFakeTarget() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type: string, listener: EventListener): void {
      let set = listeners.get(type);
      if (set === undefined) {
        set = new Set<EventListener>();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: EventListener): void {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, event: Record<string, unknown> = {}): void {
      const set = listeners.get(type);
      if (set === undefined) return;
      for (const listener of Array.from(set)) {
        (listener as unknown as (dispatched: DispatchedEvent) => void)({
          type,
          preventDefault: () => undefined,
          ...event,
        });
      }
    },
    count(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function createFakeCanvas(rect: { left: number; top: number; width: number; height: number }) {
  return {
    getBoundingClientRect: () => ({ ...rect }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    requestPointerLock: () => undefined,
  } as unknown as HTMLCanvasElement;
}

type FakeTarget = ReturnType<typeof createFakeTarget>;

const VIEWPORT = { left: 0, top: 0, width: 800, height: 600 };

let target: FakeTarget;
let bus: EventBus;

function createInput(options: { emitEvents?: boolean } = {}): InputManager {
  return new InputManager({
    canvas: createFakeCanvas(VIEWPORT),
    target: target as unknown as EventTarget,
    eventBus: bus,
    emitEvents: options.emitEvents ?? true,
  });
}

beforeEach(() => {
  target = createFakeTarget();
  bus = new EventBus();
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('InputManager', () => {
  describe('keyboard polling', () => {
    it('reports held, pressed and released keys', () => {
      const input = createInput();

      expect(input.wasKeyPressed('KeyW')).toBe(false);
      expect(input.isKeyDown('KeyW')).toBe(false);

      target.dispatch('keydown', { code: 'KeyW', key: 'w' });
      input.update();

      expect(input.isKeyDown('KeyW')).toBe(true);
      expect(input.wasKeyPressed('KeyW')).toBe(true);
      expect(input.wasKeyReleased('KeyW')).toBe(false);
      expect(input.getKeysDown()).toEqual(['KeyW']);

      target.dispatch('keyup', { code: 'KeyW', key: 'w' });
      input.update();

      expect(input.isKeyDown('KeyW')).toBe(false);
      expect(input.wasKeyPressed('KeyW')).toBe(false);
      expect(input.wasKeyReleased('KeyW')).toBe(true);
    });

    it('consumes a press after exactly one frame', () => {
      const input = createInput();

      target.dispatch('keydown', { code: 'Space', key: ' ' });
      input.update();
      expect(input.wasKeyPressed('Space')).toBe(true);

      input.update();
      expect(input.wasKeyPressed('Space')).toBe(false);
      expect(input.isKeyDown('Space')).toBe(true);
    });

    it('does not lose a key pressed between two frames', () => {
      // The classic bug: clearing "pressed" at the start of a frame throws away
      // anything that arrived after the previous frame's consumers ran.
      const input = createInput();

      input.update(); // frame 1
      target.dispatch('keydown', { code: 'KeyW', key: 'w' }); // arrives during frame 1
      input.update(); // frame 2

      expect(input.wasKeyPressed('KeyW')).toBe(true);
      expect(input.isKeyDown('KeyW')).toBe(true);
    });

    it('ignores auto-repeat for edge detection but still reports it', () => {
      const input = createInput();
      const seen: AstraEvents['input:key-down'][] = [];
      bus.on('input:key-down', (payload) => seen.push(payload));

      target.dispatch('keydown', { code: 'KeyW', key: 'w' });
      target.dispatch('keydown', { code: 'KeyW', key: 'w', repeat: true });
      input.update();

      expect(input.wasKeyPressed('KeyW')).toBe(true);
      expect(seen.map((payload) => payload.repeat)).toEqual([false, true]);
    });

    it('supports multi-key helpers', () => {
      const input = createInput();

      target.dispatch('keydown', { code: 'ShiftLeft', key: 'Shift' });
      input.update();

      expect(input.isAnyKeyDown('ControlLeft', 'ShiftLeft')).toBe(true);
      expect(input.isAnyKeyDown('ControlLeft', 'AltLeft')).toBe(false);

      target.dispatch('keydown', { code: 'KeyE', key: 'e' });
      input.update();

      expect(input.wasAnyKeyPressed('KeyE', 'KeyQ')).toBe(true);
      expect(input.wasAnyKeyPressed('KeyQ', 'KeyR')).toBe(false);
    });

    it('falls back to the key value when no code is available', () => {
      const input = createInput();
      target.dispatch('keydown', { key: 'x' });
      input.update();
      expect(input.isKeyDown('x')).toBe(true);
    });

    it('suppresses the default action only for captured keys', () => {
      const input = createInput();

      const spaceDefault = vi.fn();
      target.dispatch('keydown', { code: 'Space', key: ' ', preventDefault: spaceDefault });
      expect(spaceDefault).toHaveBeenCalledTimes(1);

      const letterDefault = vi.fn();
      target.dispatch('keydown', { code: 'KeyW', key: 'w', preventDefault: letterDefault });
      expect(letterDefault).not.toHaveBeenCalled();

      expect(input.isAttached).toBe(true);
    });

    it('drops all state when the window loses focus', () => {
      const input = createInput();

      target.dispatch('keydown', { code: 'KeyW', key: 'w' });
      target.dispatch('mousedown', { button: 0, buttons: 1, clientX: 10, clientY: 10 });
      input.update();

      target.dispatch('blur');

      expect(input.isKeyDown('KeyW')).toBe(false);
      expect(input.isMouseDown(0)).toBe(false);
      expect(input.mouseDelta).toEqual({ x: 0, y: 0 });
    });
  });

  describe('mouse polling', () => {
    it('reports position in canvas space and in NDC', () => {
      const input = createInput();

      target.dispatch('mousemove', { clientX: 400, clientY: 300, buttons: 0 });
      input.update();

      expect(input.mousePosition).toEqual({ x: 400, y: 300 });
      expect(input.readMouseNDC()).toEqual({ x: 0, y: 0 });

      target.dispatch('mousemove', { clientX: 800, clientY: 600, buttons: 0 });
      input.update();
      expect(input.readMouseNDC()).toEqual({ x: 1, y: -1 });
    });

    it('offsets the position by the canvas rect', () => {
      const input = new InputManager({
        canvas: createFakeCanvas({ left: 20, top: 40, width: 800, height: 600 }),
        target: target as unknown as EventTarget,
        eventBus: bus,
      });

      target.dispatch('mousemove', { clientX: 420, clientY: 340, buttons: 0 });
      input.update();

      expect(input.mousePosition).toEqual({ x: 400, y: 300 });
      expect(input.readMouseNDC()).toEqual({ x: 0, y: 0 });
    });

    it('does not invent a jump on the first sample', () => {
      const input = createInput();
      target.dispatch('mousemove', { clientX: 500, clientY: 400, buttons: 0 });
      input.update();

      expect(input.mouseDelta).toEqual({ x: 0, y: 0 });

      target.dispatch('mousemove', { clientX: 560, clientY: 430, buttons: 0 });
      input.update();
      expect(input.mouseDelta).toEqual({ x: 60, y: 30 });
    });

    it('reports button presses and releases for exactly one frame', () => {
      const input = createInput();

      target.dispatch('mousedown', { button: 2, buttons: 2, clientX: 10, clientY: 10 });
      input.update();
      expect(input.wasMousePressed(2)).toBe(true);
      expect(input.isMouseDown(2)).toBe(true);
      expect(input.buttons).toBe(2);

      input.update();
      expect(input.wasMousePressed(2)).toBe(false);

      target.dispatch('mouseup', { button: 2, buttons: 0, clientX: 10, clientY: 10 });
      input.update();
      expect(input.wasMouseReleased(2)).toBe(true);
      expect(input.isMouseDown(2)).toBe(false);
      expect(input.buttons).toBe(0);
    });

    it('accumulates wheel movement for one frame', () => {
      const input = createInput();

      target.dispatch('wheel', { deltaX: 0, deltaY: -120 });
      target.dispatch('wheel', { deltaX: 0, deltaY: -120 });
      input.update();
      expect(input.wheelDelta).toEqual({ x: 0, y: -240 });

      input.update();
      expect(input.wheelDelta).toEqual({ x: 0, y: 0 });
    });

    it('suppresses the context menu over the canvas', () => {
      const canvas = createFakeCanvas(VIEWPORT);
      const contextMenu = vi.fn();
      (
        canvas as unknown as {
          addEventListener: (type: string, listener: (event: unknown) => void) => void;
        }
      ).addEventListener = (type, listener) => {
        if (type === 'contextmenu') listener({ preventDefault: contextMenu });
      };

      new InputManager({
        canvas,
        target: target as unknown as EventTarget,
        eventBus: bus,
      });

      expect(contextMenu).toHaveBeenCalledTimes(1);
    });
  });

  describe('events', () => {
    it('publishes key, mouse, wheel and pointer events', () => {
      const input = createInput();
      expect(input.isAttached).toBe(true);

      const seen: string[] = [];
      const types = [
        'input:key-down',
        'input:key-up',
        'input:mouse-down',
        'input:mouse-up',
        'input:mouse-move',
        'input:mouse-wheel',
      ] as const;
      for (const type of types) {
        bus.on(type, () => seen.push(type));
      }

      target.dispatch('keydown', { code: 'KeyW', key: 'w' });
      target.dispatch('keyup', { code: 'KeyW', key: 'w' });
      target.dispatch('mousedown', { button: 0, buttons: 1, clientX: 10, clientY: 10 });
      target.dispatch('mouseup', { button: 0, buttons: 0, clientX: 10, clientY: 10 });
      target.dispatch('mousemove', { clientX: 20, clientY: 20, buttons: 0 });
      target.dispatch('wheel', { deltaX: 3, deltaY: 4 });

      expect(seen).toEqual([...types]);
      expect(input.isAttached).toBe(true);
    });

    it('includes the full payload on key events', () => {
      const input = createInput();
      expect(input.isAttached).toBe(true);

      const seen: AstraEvents['input:key-down'][] = [];
      bus.on('input:key-down', (payload) => seen.push(payload));

      target.dispatch('keydown', {
        code: 'KeyW',
        key: 'w',
        altKey: true,
        ctrlKey: true,
        shiftKey: true,
        metaKey: true,
      });

      expect(seen[0]).toEqual({
        code: 'KeyW',
        key: 'w',
        repeat: false,
        altKey: true,
        ctrlKey: true,
        shiftKey: true,
        metaKey: true,
      });
    });

    it('can publish nothing while still polling', () => {
      const input = createInput({ emitEvents: false });
      const handler = vi.fn();
      bus.on('input:key-down', handler);

      target.dispatch('keydown', { code: 'KeyW', key: 'w' });
      input.update();

      expect(handler).not.toHaveBeenCalled();
      expect(input.isKeyDown('KeyW')).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('detaches every listener it attached', () => {
      const input = createInput();
      expect(target.count('keydown')).toBe(1);
      expect(target.count('mousemove')).toBe(1);

      input.detach();

      expect(target.count('keydown')).toBe(0);
      expect(target.count('mousemove')).toBe(0);
      expect(target.count('resize')).toBe(0);
      expect(input.isAttached).toBe(false);

      target.dispatch('keydown', { code: 'KeyW', key: 'w' });
      expect(input.isKeyDown('KeyW')).toBe(false);
    });

    it('warns instead of throwing when there is no DOM', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const input = new InputManager({ target: null, eventBus: bus });

      expect(input.isAttached).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(input.isKeyDown('KeyW')).toBe(false);
    });
  });
});
