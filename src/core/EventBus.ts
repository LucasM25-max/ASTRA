/**
 * EventBus.ts - ASTRA core
 * =============================================================================
 * A small, strongly typed publish/subscribe hub.
 *
 * Every cross-system message in ASTRA travels through here so systems stay
 * decoupled: the quest system never imports the UI, the DM layer never imports
 * combat, and so on. The message contract lives in `AstraEvents` below - add a
 * new event there and TypeScript enforces the payload shape at every call site.
 *
 * Design notes
 * ------------
 * - `on()` / `once()` return an unsubscribe function, so callers never need to
 *   hold on to the handler just to be able to remove it.
 * - `emit()` snapshots the listener set, so handlers may subscribe or
 *   unsubscribe while an event is being dispatched without breaking iteration.
 * - A throwing handler is logged and isolated: it can never take down the
 *   game loop.
 * - Listeners are stored in `Set`s, so dispatch order is stable (insertion
 *   order) and duplicate registrations of the same handler are ignored.
 * =============================================================================
 */

import type { SceneState } from './SceneManager';
import type { TimeState } from './TimeController';

/* -------------------------------------------------------------------------- */
/* Event payloads                                                            */
/* -------------------------------------------------------------------------- */

/** Emitted by the renderer whenever the drawing buffer size changes. */
export interface ResizePayload {
  width: number;
  height: number;
  pixelRatio: number;
}

/** Emitted by the engine when the main loop starts or stops. */
export interface EngineLifecyclePayload {
  frame: number;
}

/** Emitted by the SceneManager on every successful state change. */
export interface SceneChangePayload {
  previous: SceneState | null;
  current: SceneState;
}

/** Emitted by the TimeController whenever the *target* speed changes. */
export interface TimeChangePayload {
  previousSpeed: number;
  currentSpeed: number;
  previousState: TimeState;
  currentState: TimeState;
}

export interface TimePausePayload {
  previousSpeed: number;
}

export interface TimeResumePayload {
  speed: number;
}

/** Emitted for every key press and release, including auto-repeat. */
export interface KeyEventPayload {
  /** Physical key code, layout independent (`KeyW`, `Space`, `ArrowUp`, ...). */
  code: string;
  /** Logical key value (`w`, ` `, `ArrowUp`, ...). */
  key: string;
  /** True when the event is an auto-repeat rather than a fresh press. */
  repeat: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface MouseButtonPayload {
  /** 0 = left, 1 = middle, 2 = right. */
  button: number;
  x: number;
  y: number;
  ndcX: number;
  ndcY: number;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface MouseMovePayload {
  x: number;
  y: number;
  ndcX: number;
  ndcY: number;
  /** Movement accumulated since the previous frame, in canvas pixels. */
  dx: number;
  dy: number;
  /** Bitmask of the buttons currently held down. */
  buttons: number;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface MouseWheelPayload {
  deltaX: number;
  deltaY: number;
}

export interface PointerLockPayload {
  locked: boolean;
}

/**
 * The complete ASTRA event contract. Every event carries an object payload;
 * there are no payload-less events, which keeps `emit` type-safe and explicit.
 */
export interface AstraEvents {
  'engine:started': EngineLifecyclePayload;
  'engine:stopped': EngineLifecyclePayload;
  'engine:resize': ResizePayload;

  'scene:changed': SceneChangePayload;

  'time:speed-changed': TimeChangePayload;
  'time:paused': TimePausePayload;
  'time:resumed': TimeResumePayload;

  'input:key-down': KeyEventPayload;
  'input:key-up': KeyEventPayload;
  'input:mouse-down': MouseButtonPayload;
  'input:mouse-up': MouseButtonPayload;
  'input:mouse-move': MouseMovePayload;
  'input:mouse-wheel': MouseWheelPayload;
  'input:pointer-lock-changed': PointerLockPayload;
}

/* -------------------------------------------------------------------------- */
/* EventBus                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Constraint for an event map: an object whose property names are event names
 * and whose property types are the payloads.
 *
 * Deliberately *not* `Record<string, unknown>`: a plain interface (no index
 * signature) does not satisfy that constraint, which would reject the typed
 * contract in `AstraEvents` below and silently degrade the whole bus.
 */
export type EventMap = object;

export type EventHandler<Payload> = (payload: Payload) => void;
export type Unsubscribe = () => void;

/**
 * A handler that accepts no usable payload. Storing handlers this way lets the
 * map hold handlers for many different payload types without resorting to
 * `any`: `never` is assignable to every payload type, so any handler fits.
 */
type AnyEventHandler = (payload: never) => void;

export class EventBus<Events extends EventMap = AstraEvents> {
  private readonly listeners = new Map<keyof Events, Set<AnyEventHandler>>();

  /**
   * Subscribe to `type`. Returns a function that removes this subscription.
   * Registering the same handler twice is a no-op (it is stored in a `Set`).
   */
  on<K extends keyof Events>(type: K, handler: EventHandler<Events[K]>): Unsubscribe {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set<AnyEventHandler>();
      this.listeners.set(type, set);
    }
    set.add(handler as AnyEventHandler);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.off(type, handler);
    };
  }

  /** Subscribe to the next occurrence of `type` only. */
  once<K extends keyof Events>(type: K, handler: EventHandler<Events[K]>): Unsubscribe {
    const wrapper = (payload: Events[K]): void => {
      this.off(type, wrapper);
      handler(payload);
    };
    return this.on(type, wrapper);
  }

  /** Remove a previously registered handler. */
  off<K extends keyof Events>(type: K, handler: EventHandler<Events[K]>): void {
    const set = this.listeners.get(type);
    if (set === undefined) return;
    set.delete(handler as AnyEventHandler);
    if (set.size === 0) this.listeners.delete(type);
  }

  /**
   * Publish `payload` to every handler of `type`.
   *
   * The listener set is snapshotted before dispatch so handlers can safely
   * subscribe/unsubscribe, and each handler is isolated in a try/catch so one
   * bad listener cannot abort the rest of the dispatch.
   */
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (set === undefined || set.size === 0) return;

    const snapshot = Array.from(set);
    for (const handler of snapshot) {
      try {
        (handler as EventHandler<Events[K]>)(payload);
      } catch (error) {
        console.error(`[EventBus] listener for "${String(type)}" threw an error`, error);
      }
    }
  }

  /** Remove every listener, or only the listeners of a single event. */
  clear(type?: keyof Events): void {
    if (type === undefined) {
      this.listeners.clear();
      return;
    }
    this.listeners.delete(type);
  }

  listenerCount(type?: keyof Events): number {
    if (type === undefined) {
      let total = 0;
      for (const set of this.listeners.values()) total += set.size;
      return total;
    }
    return this.listeners.get(type)?.size ?? 0;
  }

  hasListeners(type: keyof Events): boolean {
    return this.listenerCount(type) > 0;
  }
}

/**
 * The application-wide bus. ASTRA has exactly one; modules that need it should
 * import this instance (or receive it through their constructor) rather than
 * creating their own.
 */
export const eventBus = new EventBus();
