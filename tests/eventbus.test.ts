import { describe, expect, it, vi } from 'vitest';
import { EventBus, eventBus, type AstraEvents } from '../src/core/EventBus';

describe('EventBus', () => {
  it('delivers a payload to every registered handler, in registration order', () => {
    const bus = new EventBus();
    const calls: string[] = [];

    bus.on('scene:changed', () => calls.push('first'));
    bus.on('scene:changed', () => calls.push('second'));
    bus.emit('scene:changed', { previous: null, current: 'GAMEPLAY' });

    expect(calls).toEqual(['first', 'second']);
  });

  it('passes the exact payload object through', () => {
    const bus = new EventBus();
    const payload: AstraEvents['engine:resize'] = { width: 1920, height: 1080, pixelRatio: 2 };
    let received: AstraEvents['engine:resize'] | undefined;

    bus.on('engine:resize', (value) => {
      received = value;
    });
    bus.emit('engine:resize', payload);

    expect(received).toBe(payload);
  });

  it('stops delivering once a handler is removed with off()', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('time:paused', handler);
    bus.emit('time:paused', { previousSpeed: 1 });
    bus.off('time:paused', handler);
    bus.emit('time:paused', { previousSpeed: 1 });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns a working unsubscribe function from on()', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsubscribe = bus.on('time:resumed', handler);
    unsubscribe();
    unsubscribe(); // idempotent
    bus.emit('time:resumed', { speed: 0.25 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('fires a once() handler exactly one time', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.once('engine:started', handler);
    bus.emit('engine:started', { frame: 0 });
    bus.emit('engine:started', { frame: 1 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ frame: 0 });
  });

  it('ignores duplicate registrations of the same handler', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('engine:stopped', handler);
    bus.on('engine:stopped', handler);
    expect(bus.listenerCount('engine:stopped')).toBe(1);

    bus.emit('engine:stopped', { frame: 3 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when an event has no listeners', () => {
    const bus = new EventBus();
    expect(() => bus.emit('input:key-down', {
      code: 'KeyW',
      key: 'w',
      repeat: false,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
    })).not.toThrow();
  });

  it('isolates a throwing handler and keeps dispatching to the rest', () => {
    const bus = new EventBus();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const survivor = vi.fn();

    bus.on('scene:changed', () => {
      throw new Error('boom');
    });
    bus.on('scene:changed', survivor);

    expect(() => bus.emit('scene:changed', { previous: null, current: 'PAUSED' })).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('lets a handler unsubscribe another handler during dispatch', () => {
    const bus = new EventBus();
    const removed = vi.fn();
    const remover = vi.fn(() => {
      bus.off('scene:changed', removed);
    });

    bus.on('scene:changed', removed);
    bus.on('scene:changed', remover);
    bus.emit('scene:changed', { previous: null, current: 'CINEMATIC' });
    bus.emit('scene:changed', { previous: 'CINEMATIC', current: 'GAMEPLAY' });

    // Both ran on the first emit (the set was snapshotted), but the removed
    // handler must not run again on the second.
    expect(removed).toHaveBeenCalledTimes(1);
    expect(remover).toHaveBeenCalledTimes(2);
  });

  it('tracks listener counts and clears them', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('engine:started', handler);
    bus.on('engine:stopped', handler);
    expect(bus.listenerCount()).toBe(2);
    expect(bus.hasListeners('engine:started')).toBe(true);

    bus.clear('engine:started');
    expect(bus.listenerCount('engine:started')).toBe(0);
    expect(bus.listenerCount()).toBe(1);

    bus.clear();
    expect(bus.listenerCount()).toBe(0);
    expect(bus.hasListeners('engine:stopped')).toBe(false);
  });

  it('exposes a shared application-wide instance', () => {
    expect(eventBus).toBeInstanceOf(EventBus);
    expect(eventBus.listenerCount()).toBe(0);
  });
});
