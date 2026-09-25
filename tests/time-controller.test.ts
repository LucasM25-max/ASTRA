import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/EventBus';
import {
  DEFAULT_TRANSITION_DURATION,
  DILATED_SPEED,
  TimeController,
  TimeState,
  lerp,
  stateForSpeed,
} from '../src/core/TimeController';

/** Run the controller forward in `step` second slices. */
function advance(time: TimeController, seconds: number, step = 1 / 60): void {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += step) {
    time.update(step);
  }
}

describe('TimeController', () => {
  describe('defaults', () => {
    it('starts at REALTIME with gameSpeed 1', () => {
      const time = new TimeController();
      expect(time.gameSpeed).toBe(1);
      expect(time.targetSpeed).toBe(1);
      expect(time.state).toBe(TimeState.REALTIME);
      expect(time.isPaused).toBe(false);
      expect(time.isTransitioning).toBe(false);
      expect(time.dilatedSpeed).toBeCloseTo(0.25, 6);
    });

    it('returns a zero delta before the first update', () => {
      const time = new TimeController();
      expect(time.getDelta()).toBe(0);
      expect(time.unscaledDelta).toBe(0);
      expect(time.elapsed).toBe(0);
      expect(time.realElapsed).toBe(0);
    });
  });

  describe('getDelta', () => {
    it('multiplies the engine delta by gameSpeed', () => {
      const time = new TimeController();
      time.update(0.1);
      expect(time.getDelta()).toBeCloseTo(0.1, 6);

      time.setState(TimeState.DILATED, 0);
      time.update(0.1);
      expect(time.getDelta()).toBeCloseTo(0.025, 6);
      expect(time.unscaledDelta).toBeCloseTo(0.1, 6);
    });

    it('accumulates scaled elapsed time but unscaled real time', () => {
      const time = new TimeController();
      time.setState(TimeState.DILATED, 0);
      time.update(1);

      expect(time.elapsed).toBeCloseTo(DILATED_SPEED, 6);
      expect(time.realElapsed).toBeCloseTo(1, 6);
    });

    it('returns zero delta while paused', () => {
      const time = new TimeController();
      time.pause(0);
      time.update(1);
      expect(time.getDelta()).toBe(0);
      expect(time.elapsed).toBe(0);
      expect(time.realElapsed).toBeCloseTo(1, 6);
    });

    it('ignores negative and non-finite deltas', () => {
      const time = new TimeController();
      time.update(-5);
      expect(time.getDelta()).toBe(0);
      time.update(Number.NaN);
      expect(time.getDelta()).toBe(0);
    });
  });

  describe('setSpeed', () => {
    it('applies the change immediately when the duration is zero', () => {
      const time = new TimeController();
      time.setSpeed(0.5, 0);
      expect(time.gameSpeed).toBe(0.5);
      expect(time.isTransitioning).toBe(false);
    });

    it('lerps to the target over the requested duration', () => {
      const time = new TimeController();
      time.setSpeed(0.25, 0.5);

      time.update(0.25);
      expect(time.isTransitioning).toBe(true);
      expect(time.gameSpeed).toBeCloseTo(lerp(1, 0.25, 0.5), 6);

      time.update(0.25);
      expect(time.gameSpeed).toBeCloseTo(0.25, 6);
      expect(time.isTransitioning).toBe(false);
    });

    it('ramps in real time, even while the game is already dilated', () => {
      const time = new TimeController();
      time.setState(TimeState.DILATED); // default 0.5s transition

      time.update(0.25);
      expect(time.gameSpeed).toBeCloseTo(0.625, 6);
      expect(time.getDelta()).toBeCloseTo(0.625 * 0.25, 6);

      time.update(0.25);
      expect(time.gameSpeed).toBeCloseTo(0.25, 6);
    });

    it('re-ramps smoothly from the current speed when interrupted', () => {
      const time = new TimeController();
      time.setSpeed(0.25, 1);
      time.update(0.5); // half way: 0.625
      expect(time.gameSpeed).toBeCloseTo(0.625, 6);

      time.setSpeed(0.5, 1); // interrupted: restart from 0.625
      expect(time.gameSpeed).toBeCloseTo(0.625, 6);

      time.update(0.5);
      expect(time.gameSpeed).toBeCloseTo(lerp(0.625, 0.5, 0.5), 6);
    });

    it('clamps negative speeds to zero', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const time = new TimeController();
      time.setSpeed(-3);
      expect(time.targetSpeed).toBe(0);
      expect(time.state).toBe(TimeState.PAUSED);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects non-finite speeds', () => {
      const time = new TimeController();
      expect(() => time.setSpeed(Number.NaN)).toThrow(RangeError);
      expect(() => time.setSpeed(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });
  });

  describe('states', () => {
    it('maps canonical speeds onto named states', () => {
      expect(stateForSpeed(1)).toBe(TimeState.REALTIME);
      expect(stateForSpeed(0.25)).toBe(TimeState.DILATED);
      expect(stateForSpeed(0)).toBe(TimeState.PAUSED);
      expect(stateForSpeed(0.1)).toBe(TimeState.CUSTOM);
    });

    it('honours a custom dilated speed', () => {
      const time = new TimeController({ dilatedSpeed: 0.5 });
      expect(time.dilatedSpeed).toBeCloseTo(0.5, 6);
      time.setState(TimeState.DILATED, 0);
      expect(time.targetSpeed).toBeCloseTo(0.5, 6);
      expect(time.state).toBe(TimeState.DILATED);
    });

    it('rejects setState(CUSTOM)', () => {
      const time = new TimeController();
      expect(() => time.setState(TimeState.CUSTOM)).toThrow(/setSpeed/);
    });

    it('rejects unknown states', () => {
      const time = new TimeController();
      // @ts-expect-error - deliberately invalid runtime value
      expect(() => time.setState('TURBO')).toThrow();
    });
  });

  describe('pause / resume', () => {
    it('freezes the game and restores the previous speed', () => {
      const time = new TimeController();
      time.setState(TimeState.DILATED, 0);
      expect(time.targetSpeed).toBeCloseTo(0.25, 6);

      time.pause(0);
      expect(time.isPaused).toBe(true);
      expect(time.gameSpeed).toBe(0);
      expect(time.state).toBe(TimeState.PAUSED);

      time.resume(0);
      expect(time.targetSpeed).toBeCloseTo(0.25, 6);
      expect(time.state).toBe(TimeState.DILATED);
    });

    it('remembers the speed across multiple pauses', () => {
      const time = new TimeController();
      time.setState(TimeState.DILATED, 0);
      time.pause(0);
      time.resume(0);
      time.pause(0);
      time.resume(0);
      expect(time.targetSpeed).toBeCloseTo(0.25, 6);
    });

    it('is idempotent', () => {
      const time = new TimeController();
      time.pause(0);
      time.pause(0);
      expect(time.isPaused).toBe(true);

      time.resume(0);
      time.resume(0);
      expect(time.targetSpeed).toBe(1);
      expect(time.state).toBe(TimeState.REALTIME);
    });

    it('restores REALTIME when paused before any speed was ever set', () => {
      const time = new TimeController();
      time.pause(0);
      time.resume(0);
      expect(time.targetSpeed).toBe(1);
    });

    it('toggles', () => {
      const time = new TimeController();
      time.togglePause();
      expect(time.isPaused).toBe(true);
      time.togglePause();
      expect(time.isPaused).toBe(false);
    });

    it('lerps the pause and the resume over the transition duration', () => {
      const time = new TimeController();
      time.pause(DEFAULT_TRANSITION_DURATION);
      advance(time, DEFAULT_TRANSITION_DURATION / 2);
      expect(time.gameSpeed).toBeGreaterThan(0);
      expect(time.gameSpeed).toBeLessThan(1);

      advance(time, DEFAULT_TRANSITION_DURATION / 2);
      expect(time.gameSpeed).toBeCloseTo(0, 6);
    });
  });

  describe('reset', () => {
    it('snaps back to full speed and clears accumulated time', () => {
      const time = new TimeController();
      time.setState(TimeState.DILATED, 0);
      advance(time, 2);
      expect(time.elapsed).toBeGreaterThan(0);

      time.reset();
      expect(time.gameSpeed).toBe(1);
      expect(time.targetSpeed).toBe(1);
      expect(time.state).toBe(TimeState.REALTIME);
      expect(time.elapsed).toBe(0);
      expect(time.realElapsed).toBe(0);
      expect(time.getDelta()).toBe(0);
    });
  });

  describe('events', () => {
    it('publishes speed changes with the old and new state', () => {
      const bus = new EventBus();
      const time = new TimeController({ eventBus: bus });
      const seen: unknown[] = [];
      bus.on('time:speed-changed', (payload) => seen.push(payload));

      time.setState(TimeState.DILATED, 0);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({
        previousSpeed: 1,
        currentSpeed: 0.25,
        previousState: TimeState.REALTIME,
        currentState: TimeState.DILATED,
      });

      // Setting the same speed again is not a change.
      time.setState(TimeState.DILATED, 0);
      expect(seen).toHaveLength(1);
    });

    it('publishes pause and resume with the speed involved', () => {
      const bus = new EventBus();
      const time = new TimeController({ eventBus: bus });
      const pauses: unknown[] = [];
      const resumes: unknown[] = [];
      bus.on('time:paused', (payload) => pauses.push(payload));
      bus.on('time:resumed', (payload) => resumes.push(payload));

      time.pause(0);
      time.resume(0);

      expect(pauses).toEqual([{ previousSpeed: 1 }]);
      expect(resumes).toEqual([{ speed: 1 }]);
    });

    it('does not touch the bus when none was supplied', () => {
      const time = new TimeController();
      expect(() => time.setState(TimeState.PAUSED, 0)).not.toThrow();
    });
  });
});
