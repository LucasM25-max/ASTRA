// @vitest-environment jsdom
/**
 * The real WebGL failure path. jsdom provides no WebGL context, so this asserts
 * that RenderPipeline fails loudly (rather than silently producing a blank
 * canvas) - `main.ts` catches exactly this and shows the boot-error panel.
 */
import { describe, expect, it } from 'vitest';
import { RenderPipeline } from '../src/renderer/RenderPipeline';

describe('RenderPipeline without WebGL', () => {
  it('throws a descriptive error when no context can be created', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);

    expect(() => new RenderPipeline(canvas)).toThrow(/WebGL context/i);
  });

  it('reports that a headless canvas has no WebGL support at all', () => {
    const canvas = document.createElement('canvas');
    // jsdom's canvas has no getContext implementation that returns a context.
    expect(canvas.getContext('webgl2')).toBeNull();
  });
});
