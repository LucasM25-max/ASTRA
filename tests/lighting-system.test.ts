import { describe, expect, it, vi } from 'vitest';
import {
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  PointLight,
  Scene,
} from 'three';
import {
  DEFAULT_AMBIENT_COLOR,
  DEFAULT_AMBIENT_INTENSITY,
  DEFAULT_GLOW_COLOR,
  DEFAULT_GLOW_DISTANCE,
  DEFAULT_HEMI_GROUND_COLOR,
  DEFAULT_HEMI_INTENSITY,
  DEFAULT_HEMI_SKY_COLOR,
  DEFAULT_SHADOW_EXTENT,
  DEFAULT_SHADOW_MAP_SIZE,
  DEFAULT_SHADOW_NORMAL_BIAS,
  DEFAULT_SHADOW_RADIUS,
  DEFAULT_SUN_COLOR,
  DEFAULT_SUN_INTENSITY,
  DEFAULT_SUN_POSITION,
  LightingSystem,
  SHADOW_CASCADE_NOTE,
} from '../src/renderer/LightingSystem';

describe('LightingSystem', () => {
  it('creates exactly a directional sun and an ambient fill', () => {
    const lighting = new LightingSystem();

    expect(lighting.sun).toBeInstanceOf(DirectionalLight);
    expect(lighting.ambient).toBeInstanceOf(AmbientLight);

    expect(lighting.sun.type).toBe('DirectionalLight');
    expect(lighting.ambient.type).toBe('AmbientLight');
    expect(lighting.group.children).toHaveLength(4); // sun, sun target, ambient, hemi
    // The hemisphere light is what makes a shaded bank read as a shaded bank
    // rather than as a darker bank, and it must be in the group so it is added
    // and removed with the rest of the rig.
    expect(lighting.hemi).toBeInstanceOf(HemisphereLight);
    expect(lighting.group.children).toContain(lighting.hemi);
  });

  it('separates sky from ground with the hemisphere light', () => {
    const lighting = new LightingSystem();

    expect(lighting.hemi.color.getHex()).toBe(DEFAULT_HEMI_SKY_COLOR);
    expect(lighting.hemi.groundColor.getHex()).toBe(DEFAULT_HEMI_GROUND_COLOR);
    expect(lighting.hemi.intensity).toBe(DEFAULT_HEMI_INTENSITY);

    // Style-guide rule 6 again, on the hemisphere: sky above must be cooler and
    // brighter than the earth below. An inverted hemisphere light - warm ground,
    // cold sky - makes every shadow look like it is lit from below.
    const sky = lighting.hemi.color;
    const ground = lighting.hemi.groundColor;
    expect(sky.b).toBeGreaterThan(sky.r);
    expect(ground.r).toBeGreaterThan(ground.b);
    // And the sky must out-light the ground, or the fill is upside down.
    expect(sky.r + sky.g + sky.b).toBeGreaterThan(ground.r + ground.g + ground.b);

    // It must be weaker than the sun. A hemisphere light that rivals the
    // directional one flattens the picture back out again.
    expect(lighting.hemi.intensity).toBeLessThan(lighting.sun.intensity);
  });

  it('makes the sun a shadow caster with a box sized for the tree tiers', () => {
    const lighting = new LightingSystem();

    expect(lighting.sun.castShadow).toBe(true);
    const camera = lighting.sun.shadow.camera;
    expect(camera.left).toBe(-DEFAULT_SHADOW_EXTENT);
    expect(camera.right).toBe(DEFAULT_SHADOW_EXTENT);
    expect(camera.top).toBe(DEFAULT_SHADOW_EXTENT);
    expect(camera.bottom).toBe(-DEFAULT_SHADOW_EXTENT);

    // A 24-bit depth buffer spread over four orders of magnitude is where acne
    // comes from, so the near and far planes are pushed tight around the slab.
    expect(camera.near).toBeGreaterThan(0.5);
    expect(camera.far).toBeLessThan(2000);
    expect(camera.far).toBeGreaterThan(camera.near);

    expect(lighting.sun.shadow.mapSize.x).toBe(DEFAULT_SHADOW_MAP_SIZE);
    expect(lighting.sun.shadow.mapSize.y).toBe(DEFAULT_SHADOW_MAP_SIZE);
  });

  it('biases the shadow along the normal rather than the depth', () => {
    const lighting = new LightingSystem();

    // The acne cure for noise-displaced, leaning geometry. A depth bias of the
    // same magnitude would clear the surfaces and detach every shadow from its
    // caster - peter-panning, which on a tree reads as a shadow floating a metre
    // off the ground.
    expect(lighting.sun.shadow.normalBias).toBe(DEFAULT_SHADOW_NORMAL_BIAS);
    expect(lighting.sun.shadow.normalBias).toBeGreaterThan(0);
    expect(lighting.sun.shadow.bias).toBe(0);
    // Soft edges, not mush.
    expect(lighting.sun.shadow.radius).toBe(DEFAULT_SHADOW_RADIUS);
    expect(lighting.sun.shadow.radius).toBeGreaterThan(0);
    expect(lighting.sun.shadow.radius).toBeLessThan(5);
  });

  it('can be built without shadows', () => {
    const lighting = new LightingSystem({ shadows: false });
    expect(lighting.sun.castShadow).toBe(false);
  });

  it('keeps the shadow box over the player without moving the light direction', () => {
    const lighting = new LightingSystem();
    const before = lighting.sun.position.clone().sub(lighting.sun.target.position);

    lighting.followShadowFocus(300, -140, 12);

    expect(lighting.sun.target.position.toArray()).toEqual([300, 12, -140]);
    // Same offset from the target means the same direction, so every shadow in
    // the world keeps pointing the same way while the box slides under the
    // player. A directional light whose direction drifts as you walk is one of
    // those bugs that takes an afternoon to find.
    expect(lighting.sun.position.clone().sub(lighting.sun.target.position).distanceTo(before))
      .toBeLessThan(1e-9);
  });

  it('ignores a non-finite shadow focus', () => {
    const lighting = new LightingSystem();
    lighting.followShadowFocus(10, 10, 0);
    lighting.followShadowFocus(Number.NaN, 10, 0);
    lighting.followShadowFocus(10, Number.POSITIVE_INFINITY, 0);
    expect(lighting.sun.target.position.toArray()).toEqual([10, 0, 10]);
  });

  it('uses a warm sun and a cool ambient fill', () => {
    const lighting = new LightingSystem();

    expect(lighting.sun.color.getHex()).toBe(DEFAULT_SUN_COLOR);
    expect(lighting.sun.intensity).toBe(DEFAULT_SUN_INTENSITY);
    expect(lighting.ambient.color.getHex()).toBe(DEFAULT_AMBIENT_COLOR);
    expect(lighting.ambient.intensity).toBe(DEFAULT_AMBIENT_INTENSITY);

    // Rule 6 of the style guide: warm sun, cool shadows. The sun must be warmer
    // (more red than blue) and the ambient fill cooler (more blue than red).
    const sun = lighting.sun.color;
    expect(sun.r).toBeGreaterThan(sun.b);

    const ambient = lighting.ambient.color;
    expect(ambient.b).toBeGreaterThan(ambient.r);
  });

  it('places the sun high and off to one side, aimed at the origin', () => {
    const lighting = new LightingSystem();

    expect(lighting.sun.position.toArray()).toEqual([
      DEFAULT_SUN_POSITION.x,
      DEFAULT_SUN_POSITION.y,
      DEFAULT_SUN_POSITION.z,
    ]);
    // Angled rather than straight overhead, so the light rakes across the plane.
    expect(lighting.sun.position.y).toBeGreaterThan(Math.abs(lighting.sun.position.x));
    expect(lighting.sun.target.position.toArray()).toEqual([0, 0, 0]);
  });

  it('accepts overrides', () => {
    const lighting = new LightingSystem({
      sunColor: 0xffffff,
      sunIntensity: 1,
      sunPosition: { x: 1, y: 2, z: 3 },
      ambientColor: 0x000000,
      ambientIntensity: 0,
    });

    expect(lighting.sun.color.getHex()).toBe(0xffffff);
    expect(lighting.sun.intensity).toBe(1);
    expect(lighting.sun.position.toArray()).toEqual([1, 2, 3]);
    expect(lighting.ambient.intensity).toBe(0);
  });

  it('flickers a registered glow smoothly and never below zero', () => {
    const lighting = new LightingSystem();
    const glow = new PointLight(DEFAULT_GLOW_COLOR, 4, DEFAULT_GLOW_DISTANCE, 2);
    const release = lighting.flicker(glow, { depth: 0.5, rate: 2, secondary: 6, phase: 0 });

    expect(lighting.flickerCount).toBe(1);

    const seen: number[] = [];
    for (let i = 0; i < 400; i++) {
      lighting.update(1 / 60);
      seen.push(glow.intensity);
    }
    // Never negative, and never above the baseline - a glow that brightens past
    // its own intensity is a glow that pulses the wrong way round.
    for (const value of seen) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(4 + 1e-9);
    }
    // And it actually moves. A flicker that never changes is not a flicker.
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.5);
    // Smooth: no frame-to-frame jump big enough to read as a stutter. Two sines
    // at 2 and 6 rad/s over a 1/60 s step move by well under 10% of the range.
    let biggest = 0;
    for (let i = 1; i < seen.length; i++) {
      biggest = Math.max(biggest, Math.abs(seen[i] - seen[i - 1]));
    }
    expect(biggest).toBeLessThan(0.15);

    release();
    expect(lighting.flickerCount).toBe(0);
    // Releasing is idempotent: the corruption system releases on dispose and a
    // double release must not splice the wrong entry out of the list.
    release();
    expect(lighting.flickerCount).toBe(0);
  });

  it('reads a live baseline so a glow can flicker and still fade', () => {
    // The corruption's glow scales with the rot underfoot. If the flicker
    // captured the intensity once at registration, the glow would flicker
    // around whatever it happened to be when the world was built and then never
    // fade again.
    const lighting = new LightingSystem();
    const glow = new PointLight(DEFAULT_GLOW_COLOR, 0, DEFAULT_GLOW_DISTANCE, 2);
    let baseline = 0;
    lighting.flicker(glow, { baseline: () => baseline, depth: 0.5, phase: 0 });

    baseline = 8;
    lighting.update(1 / 60);
    expect(glow.intensity).toBeGreaterThan(0);
    expect(glow.intensity).toBeLessThanOrEqual(8 + 1e-9);

    baseline = 0;
    lighting.update(1 / 60);
    expect(glow.intensity).toBe(0);
  });

  it('does not advance on a zero or negative delta', () => {
    const lighting = new LightingSystem();
    const glow = new PointLight(DEFAULT_GLOW_COLOR, 4, DEFAULT_GLOW_DISTANCE, 2);
    lighting.flicker(glow, { depth: 1, rate: 9, phase: 0 });
    lighting.update(1 / 60);
    const after = glow.intensity;
    lighting.update(0);
    lighting.update(-1);
    lighting.update(Number.NaN);
    expect(glow.intensity).toBe(after);
  });

  it('documents why there is one shadow cascade and not two', () => {
    // The plan asks for at least two. This is the deviation, written down where
    // the next person will find it rather than buried in a commit message.
    expect(SHADOW_CASCADE_NOTE).toMatch(/onBeforeCompile/);
    expect(SHADOW_CASCADE_NOTE.length).toBeGreaterThan(40);
  });

  it('can re-point the sun at runtime', () => {
    const lighting = new LightingSystem();
    lighting.setSunPosition(10, 20, 30);
    expect(lighting.sun.position.toArray()).toEqual([10, 20, 30]);
  });

  it('attaches to and detaches from a scene as one unit', () => {
    const scene = new Scene();
    const lighting = new LightingSystem();

    lighting.addTo(scene);
    expect(scene.children).toContain(lighting.group);
    expect(scene.getObjectByName('sun')).toBe(lighting.sun);
    expect(scene.getObjectByName('ambient')).toBe(lighting.ambient);
    expect(lighting.group).toBeInstanceOf(Group);

    lighting.removeFrom(scene);
    expect(scene.children).not.toContain(lighting.group);
  });

  it('disposes every light and drops every flicker', () => {
    const lighting = new LightingSystem();
    const disposeSun = vi.spyOn(lighting.sun, 'dispose');
    const disposeAmbient = vi.spyOn(lighting.ambient, 'dispose');
    const disposeHemi = vi.spyOn(lighting.hemi, 'dispose');
    const glow = new PointLight(DEFAULT_GLOW_COLOR, 4);
    lighting.flicker(glow);

    lighting.dispose();

    expect(disposeSun).toHaveBeenCalledTimes(1);
    expect(disposeAmbient).toHaveBeenCalledTimes(1);
    expect(disposeHemi).toHaveBeenCalledTimes(1);
    // A flicker that outlives its light writes to a disposed PointLight forever.
    expect(lighting.flickerCount).toBe(0);
  });
});
