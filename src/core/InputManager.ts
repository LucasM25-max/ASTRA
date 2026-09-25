/**
 * InputManager.ts - ASTRA core
 * =============================================================================
 * Keyboard + mouse capture, exposed both as DOM events (on the EventBus) and as
 * pollable per-frame state.
 *
 * Polling is the primary API for gameplay code:
 *
 *   if (input.wasKeyPressed('Space')) player.jump();
 *   if (input.isKeyDown('ShiftLeft')) player.run();
 *
 * `wasKeyPressed` / `wasMousePressed` / `mouseDelta` / `wheelDelta` are only
 * valid for the frame in which they are read. `update()` is what moves the
 * "pressed since the last frame" buffer into the "pressed this frame" buffer,
 * so it must be called exactly once per frame *before* anything reads input.
 *
 * Edge detection is buffer-based rather than "clear at the start of the frame",
 * which is the classic bug: a key pressed between two frames would be discarded
 * before any system ever saw it.
 * =============================================================================
 */

import { EventBus, type AstraEvents } from './EventBus';

/**
 * Keys whose browser default action is suppressed. Without this, Space scrolls
 * or re-triggers a focused button, Tab moves focus, and the arrow keys scroll.
 * Game-specific bindings are added by later steps.
 */
const DEFAULT_PREVENT_DEFAULT_KEYS: readonly string[] = [
  'Space',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
];

export interface InputManagerOptions {
  /** Element used for pointer coordinates, NDC and pointer lock. */
  canvas?: HTMLCanvasElement | null;
  /** Object receiving the DOM events. Defaults to `window`. */
  target?: EventTarget | null;
  eventBus?: EventBus;
  /** Set to false to keep polling but stop publishing events on the bus. */
  emitEvents?: boolean;
  /** Key codes whose default browser action is suppressed. */
  preventDefaultKeys?: readonly string[];
  /** Suppress the browser context menu over the game canvas. Defaults to true. */
  preventContextMenu?: boolean;
}

interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Vec2 {
  x: number;
  y: number;
}

function keyCodeOf(event: KeyboardEvent): string {
  // `code` is physical and layout independent; `key` is the fallback for
  // synthetic/IME events where `code` is empty.
  return event.code || event.key || 'Unknown';
}

/** Collapse -0 to +0; negative zero compares equal but breaks `Object.is`. */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

export class InputManager {
  private readonly canvas: HTMLCanvasElement | null;
  private readonly target: EventTarget | null;
  private readonly bus: EventBus | undefined;
  private readonly emitEvents: boolean;
  private readonly preventDefaultKeys: ReadonlySet<string>;
  private readonly preventContextMenu: boolean;

  private attached = false;
  private viewport: Viewport = { left: 0, top: 0, width: 1, height: 1 };

  /* Keyboard state -------------------------------------------------------- */
  private readonly keysDown = new Set<string>();
  /** Keys pressed during the frame currently being processed. */
  private keysPressedFrame = new Set<string>();
  /** Keys pressed since the last `update()`, waiting to become "this frame". */
  private keysPressedBuffer = new Set<string>();
  private keysReleasedFrame = new Set<string>();
  private keysReleasedBuffer = new Set<string>();

  /* Mouse state ----------------------------------------------------------- */
  private readonly buttonsDown = new Set<number>();
  private buttonsPressedFrame = new Set<number>();
  private buttonsPressedBuffer = new Set<number>();
  private buttonsReleasedFrame = new Set<number>();
  private buttonsReleasedBuffer = new Set<number>();

  private mouseX = 0;
  private mouseY = 0;
  private mouseInitialized = false;
  private prevEventX = 0;
  private prevEventY = 0;
  /** Movement of the most recent mouse event (used by event payloads). */
  private eventDX = 0;
  private eventDY = 0;
  /** Movement accumulated since the last `update()`. */
  private moveDX = 0;
  private moveDY = 0;
  private frameDX = 0;
  private frameDY = 0;
  private wheelDX = 0;
  private wheelDY = 0;
  private frameWheelDX = 0;
  private frameWheelDY = 0;
  private buttonMask = 0;
  private pointerLocked = false;

  constructor(options: InputManagerOptions = {}) {
    this.canvas = options.canvas ?? null;
    this.target = options.target ?? (typeof window !== 'undefined' ? window : null);
    this.bus = options.eventBus;
    this.emitEvents = options.emitEvents ?? true;
    this.preventDefaultKeys = new Set(options.preventDefaultKeys ?? DEFAULT_PREVENT_DEFAULT_KEYS);
    this.preventContextMenu = options.preventContextMenu ?? true;
    this.attach();
  }

  /* ---------------------------------------------------------------------- */
  /* Attach / detach                                                        */
  /* ---------------------------------------------------------------------- */

  get isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    if (this.attached) return;
    const target = this.target;
    if (target === null) {
      console.warn('[InputManager] no event target available (non-DOM environment?) - input disabled');
      return;
    }

    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);

    target.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('mousedown', this.onMouseDown);
    target.addEventListener('mouseup', this.onMouseUp);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    target.addEventListener('pointerlockchange', this.onPointerLockChange);

    target.addEventListener('resize', this.onViewportInvalidated);
    target.addEventListener('scroll', this.onViewportInvalidated, true);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    const canvas = this.canvas;
    if (canvas !== null && this.preventContextMenu) {
      canvas.addEventListener('contextmenu', this.onContextMenu);
    }

    this.attached = true;
    this.refreshViewport();
  }

  detach(): void {
    if (!this.attached) return;
    const target = this.target;

    if (target !== null) {
      target.removeEventListener('keydown', this.onKeyDown);
      target.removeEventListener('keyup', this.onKeyUp);
      target.removeEventListener('blur', this.onBlur);

      target.removeEventListener('mousemove', this.onMouseMove);
      target.removeEventListener('mousedown', this.onMouseDown);
      target.removeEventListener('mouseup', this.onMouseUp);
      target.removeEventListener('wheel', this.onWheel);
      target.removeEventListener('pointerlockchange', this.onPointerLockChange);

      target.removeEventListener('resize', this.onViewportInvalidated);
      target.removeEventListener('scroll', this.onViewportInvalidated, true);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    const canvas = this.canvas;
    if (canvas !== null && this.preventContextMenu) {
      canvas.removeEventListener('contextmenu', this.onContextMenu);
    }

    this.attached = false;
    this.clearState();
  }

  /** Alias of `detach()`. */
  dispose(): void {
    this.detach();
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame update                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Promote everything that happened since the previous call into the "this
   * frame" state. Call once per frame, before reading any input.
   */
  update(): void {
    // Swap rather than clear, so presses that arrived between frames survive.
    const pressed = this.keysPressedBuffer;
    this.keysPressedBuffer = this.keysPressedFrame;
    this.keysPressedFrame = pressed;
    this.keysPressedBuffer.clear();

    const released = this.keysReleasedBuffer;
    this.keysReleasedBuffer = this.keysReleasedFrame;
    this.keysReleasedFrame = released;
    this.keysReleasedBuffer.clear();

    const buttonPressed = this.buttonsPressedBuffer;
    this.buttonsPressedBuffer = this.buttonsPressedFrame;
    this.buttonsPressedFrame = buttonPressed;
    this.buttonsPressedBuffer.clear();

    const buttonReleased = this.buttonsReleasedBuffer;
    this.buttonsReleasedBuffer = this.buttonsReleasedFrame;
    this.buttonsReleasedFrame = buttonReleased;
    this.buttonsReleasedBuffer.clear();

    this.frameDX = this.moveDX;
    this.frameDY = this.moveDY;
    this.moveDX = 0;
    this.moveDY = 0;

    this.frameWheelDX = this.wheelDX;
    this.frameWheelDY = this.wheelDY;
    this.wheelDX = 0;
    this.wheelDY = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Keyboard polling                                                       */
  /* ---------------------------------------------------------------------- */

  isKeyDown(code: string): boolean {
    return this.keysDown.has(code);
  }

  /** True only on the frame the key went down. */
  wasKeyPressed(code: string): boolean {
    return this.keysPressedFrame.has(code);
  }

  /** True only on the frame the key came up. */
  wasKeyReleased(code: string): boolean {
    return this.keysReleasedFrame.has(code);
  }

  /** True when any of `codes` was pressed this frame. */
  wasAnyKeyPressed(...codes: string[]): boolean {
    for (const code of codes) {
      if (this.keysPressedFrame.has(code)) return true;
    }
    return false;
  }

  /** True when any of `codes` is currently held. */
  isAnyKeyDown(...codes: string[]): boolean {
    for (const code of codes) {
      if (this.keysDown.has(code)) return true;
    }
    return false;
  }

  getKeysDown(): readonly string[] {
    return Array.from(this.keysDown);
  }

  /* ---------------------------------------------------------------------- */
  /* Mouse polling                                                          */
  /* ---------------------------------------------------------------------- */

  isMouseDown(button: number): boolean {
    return this.buttonsDown.has(button);
  }

  wasMousePressed(button: number): boolean {
    return this.buttonsPressedFrame.has(button);
  }

  wasMouseReleased(button: number): boolean {
    return this.buttonsReleasedFrame.has(button);
  }

  /** Bitmask of currently held mouse buttons. */
  get buttons(): number {
    return this.buttonMask;
  }

  /** Pointer position in canvas pixels. */
  get mousePosition(): Vec2 {
    return { x: this.mouseX, y: this.mouseY };
  }

  /** Pointer position in normalised device coordinates (-1..1, y up). */
  readMouseNDC(target: Vec2 = { x: 0, y: 0 }): Vec2 {
    const { width, height } = this.viewport;
    if (width <= 0 || height <= 0) {
      target.x = 0;
      target.y = 0;
      return target;
    }
    target.x = normalizeZero((this.mouseX / width) * 2 - 1);
    target.y = normalizeZero(-((this.mouseY / height) * 2 - 1));
    return target;
  }

  /** Pointer movement since the previous frame, in canvas pixels. */
  get mouseDelta(): Vec2 {
    return { x: this.frameDX, y: this.frameDY };
  }

  /** Wheel movement since the previous frame. */
  get wheelDelta(): Vec2 {
    return { x: this.frameWheelDX, y: this.frameWheelDY };
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  requestPointerLock(): void {
    const canvas = this.canvas;
    if (canvas === null || typeof canvas.requestPointerLock !== 'function') return;
    // Chrome resolves a promise here; a rejection (e.g. too soon after exit)
    // must not surface as an unhandled rejection.
    void Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
  }

  exitPointerLock(): void {
    if (typeof document === 'undefined' || typeof document.exitPointerLock !== 'function') return;
    void Promise.resolve(document.exitPointerLock()).catch(() => undefined);
  }

  /** Drop all input state - used on focus loss so keys do not stay "held". */
  clearState(): void {
    this.keysDown.clear();
    this.keysPressedFrame.clear();
    this.keysPressedBuffer.clear();
    this.keysReleasedFrame.clear();
    this.keysReleasedBuffer.clear();

    this.buttonsDown.clear();
    this.buttonsPressedFrame.clear();
    this.buttonsPressedBuffer.clear();
    this.buttonsReleasedFrame.clear();
    this.buttonsReleasedBuffer.clear();

    this.moveDX = 0;
    this.moveDY = 0;
    this.frameDX = 0;
    this.frameDY = 0;
    this.eventDX = 0;
    this.eventDY = 0;
    this.wheelDX = 0;
    this.wheelDY = 0;
    this.frameWheelDX = 0;
    this.frameWheelDY = 0;
    this.buttonMask = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* DOM handlers                                                           */
  /* ---------------------------------------------------------------------- */

  private onKeyDown: EventListener = (rawEvent) => {
    const event = rawEvent as KeyboardEvent;
    const code = keyCodeOf(event);
    if (this.preventDefaultKeys.has(code)) {
      event.preventDefault();
    }

    const repeat = this.keysDown.has(code);
    if (!repeat) {
      this.keysDown.add(code);
      this.keysPressedBuffer.add(code);
    }

    this.publish('input:key-down', {
      code,
      key: event.key,
      repeat,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
  };

  private onKeyUp: EventListener = (rawEvent) => {
    const event = rawEvent as KeyboardEvent;
    const code = keyCodeOf(event);

    if (this.keysDown.delete(code)) {
      this.keysReleasedBuffer.add(code);
    }

    this.publish('input:key-up', {
      code,
      key: event.key,
      repeat: false,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
  };

  private onMouseMove: EventListener = (rawEvent) => {
    const event = rawEvent as MouseEvent;

    if (this.pointerLocked) {
      // Under pointer lock the cursor cannot move, so the browser reports
      // relative motion instead.
      this.eventDX = event.movementX ?? 0;
      this.eventDY = event.movementY ?? 0;
      this.moveDX += this.eventDX;
      this.moveDY += this.eventDY;
    } else {
      const x = event.clientX - this.viewport.left;
      const y = event.clientY - this.viewport.top;

      if (this.mouseInitialized) {
        this.eventDX = x - this.prevEventX;
        this.eventDY = y - this.prevEventY;
        this.moveDX += this.eventDX;
        this.moveDY += this.eventDY;
      } else {
        // First sample: seed the position without inventing a big jump.
        this.mouseInitialized = true;
        this.eventDX = 0;
        this.eventDY = 0;
      }

      this.prevEventX = x;
      this.prevEventY = y;
      this.mouseX = x;
      this.mouseY = y;
    }

    this.buttonMask = event.buttons ?? 0;

    const ndc = this.readMouseNDC();
    this.publish('input:mouse-move', {
      x: this.mouseX,
      y: this.mouseY,
      ndcX: ndc.x,
      ndcY: ndc.y,
      dx: this.eventDX,
      dy: this.eventDY,
      buttons: this.buttonMask,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
  };

  private onMouseDown: EventListener = (rawEvent) => {
    const event = rawEvent as MouseEvent;
    const button = event.button;

    if (!this.buttonsDown.has(button)) {
      this.buttonsDown.add(button);
      this.buttonsPressedBuffer.add(button);
    }
    this.buttonMask = event.buttons ?? 0;

    if (!this.pointerLocked && !this.mouseInitialized) {
      this.mouseInitialized = true;
      this.mouseX = event.clientX - this.viewport.left;
      this.mouseY = event.clientY - this.viewport.top;
      this.prevEventX = this.mouseX;
      this.prevEventY = this.mouseY;
    }

    const ndc = this.readMouseNDC();
    this.publish('input:mouse-down', {
      button,
      x: this.mouseX,
      y: this.mouseY,
      ndcX: ndc.x,
      ndcY: ndc.y,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
  };

  private onMouseUp: EventListener = (rawEvent) => {
    const event = rawEvent as MouseEvent;
    const button = event.button;

    if (this.buttonsDown.delete(button)) {
      this.buttonsReleasedBuffer.add(button);
    }
    this.buttonMask = event.buttons ?? 0;

    const ndc = this.readMouseNDC();
    this.publish('input:mouse-up', {
      button,
      x: this.mouseX,
      y: this.mouseY,
      ndcX: ndc.x,
      ndcY: ndc.y,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
  };

  private onWheel: EventListener = (rawEvent) => {
    const event = rawEvent as WheelEvent;
    this.wheelDX += event.deltaX;
    this.wheelDY += event.deltaY;

    this.publish('input:mouse-wheel', { deltaX: event.deltaX, deltaY: event.deltaY });
  };

  private onPointerLockChange: EventListener = () => {
    const locked =
      typeof document !== 'undefined' &&
      this.canvas !== null &&
      document.pointerLockElement === this.canvas;
    this.pointerLocked = locked;
    if (!locked) {
      this.buttonMask = 0;
      this.buttonsDown.clear();
    }
    this.publish('input:pointer-lock-changed', { locked });
  };

  private onContextMenu: EventListener = (rawEvent) => {
    rawEvent.preventDefault();
  };

  private onBlur: EventListener = () => {
    this.clearState();
  };

  private onVisibilityChange: EventListener = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.clearState();
    }
  };

  private onViewportInvalidated: EventListener = () => {
    this.refreshViewport();
  };

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  /** Re-read the canvas rect; called on resize/scroll, never per frame. */
  refreshViewport(): void {
    const canvas = this.canvas;
    if (canvas === null || typeof canvas.getBoundingClientRect !== 'function') return;
    const rect = canvas.getBoundingClientRect();
    this.viewport = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  private publish<K extends keyof AstraEvents>(type: K, payload: AstraEvents[K]): void {
    if (!this.emitEvents) return;
    this.bus?.emit(type, payload);
  }
}
