# ASTRA

A 3D action-adventure RPG based on **Dungeons & Dragons 5e (2024)**, built entirely
in code — no game engine, no external art pipeline. Rendering, physics, audio and
all game logic run in the browser through web technologies.

The full build plan lives in [`plan.md`](./plan.md).

---

## Status

**Phase 1 — Player Walking Around in Blank World**

- **Step 1.1 — Project Bootstrap** (complete): Vite + TypeScript, Three.js and
  Rapier, fullscreen canvas, fixed-timestep game loop, `SceneManager`,
  `InputManager`, `TimeController`, `EventBus`.
- **Step 1.2 — Basic 3D Scene** (complete): antialiased WebGL renderer, a flat
  100m x 100m green ground plane, a directional sun plus ambient fill, a
  perspective camera, a blue-to-white gradient skybox and linear fog — all driven
  through `TimeController.getDelta()`.
- **Step 1.3 — Player Character (Capsule Prototype)** (complete): a capsule mesh
  standing on a dynamic Rapier capsule collider, a static ground collider level
  with the visual plane, gravity at -9.81 m/s², and a spawn point of (0, 1, 0).
  Physics runs on the engine's fixed timestep, so it is deterministic and slows
  and freezes with time dilation for free.
- **Step 1.4 — Movement Controller** (complete): WASD relative to the camera
  facing, walk at 3.5 m/s and run at 6 m/s on Shift, acceleration and
  deceleration as bounded rates rather than per-frame lerps, the character mesh
  turning to face its direction of travel at a limited rate, and a jump with a
  downward raycast ground check. Slopes do not slide: the walk target is
  projected into the surface plane so ground speed survives the gradient, and
  gravity is switched off on the player's body while it is grounded so the
  contact solver has nothing to correct. Time dilation needs nothing here — the
  engine issues a quarter of the fixed steps when dilated, and the player slows
  with the world.
- **Step 1.5 — Third-Person Camera** (complete): an orbit camera that follows
  the player at a 4m default distance within a 2m-10m range, aiming 1.5m above
  the capsule's centre. Hold the right mouse button to orbit and scroll to
  zoom; both are exponentially smoothed so they feel the same at any frame
  rate, and the pitch is clamped so the camera cannot flip over the top or dive
  under the floor. A raycast from the focus point pulls the camera in when
  something comes between it and the player, and a second downward ray keeps it
  off the ground. The camera ticks on `Engine.onRender` with the frame's
  *real* delta rather than the scaled game delta, which is what makes it stay
  fully responsive during time dilation — the player can look around freely
  while an Active Encounter plays out at quarter speed.
- **Step 1.6 — Debug & Polish** (complete): a developer overlay, hidden by
  default and togglable with F3, that pins an FPS and frame-time readout to the
  top-left, drops a 2m measurement grid onto the ground and an X/Y/Z tripod at
  the origin, and shows the TimeController's state and gameSpeed. F4, F6 and F7
  toggle the grid, the tripod and a console log of input events independently.
  The 1/2/3 time-state bindings that were temporary developer bindings in
  `main.ts` now live inside it, so every developer binding is in one place. The
  overlay runs on the same render tick as the camera and never touches physics,
  and it is built to a cost contract: invisible gizmos cost nothing, a hidden
  panel writes no DOM at all, and a visible one repaints at 20Hz rather than
  every frame.

**Phase 2 — Living World**

- **Step 2.1 — Procedural Terrain** (complete): a 384×384 heightmap over 500 m
  (~1.3 m cells, ~293k triangles) built from layered Perlin and Voronoi noise —
  hills, a broad valley, a rim ramp that lifts the edges so the world does not
  end at a cliff, and four biomes blended by height and slope. The mesh, its
  per-vertex colours and its collider data all come from one array, so the
  ground you see and the ground you walk on cannot drift apart. The collider is
  a triangle mesh; see the heightfield note below.
- **Step 2.2 — The Fouled Stream** (complete): a Catmull-Rom stream spline with a
  variable 1–3 m width sampled from noise, an extruded water ribbon, and a
  procedural water material that scrolls a flow vector along the spline, fades
  the shoreline by depth, distorts its normals with animated noise and reflects
  a gradient sky analytically — no texture files anywhere. The stream carries a
  pollution value that runs 0.9 at the cave end through 0.6 midstream to 0.2 at
  the village, and the material interpolates between a clean blue-green state
  and a green-brown scummed one. Flowing point sprites drift downstream, and a
  synthesised water loop is spatialised through Howler.js.
  The terrain generator carves a channel for the stream along the same spline,
  with a designed cross-section: a flat bed, a climb that crosses the water
  surface exactly at the stream's nominal half-width, and a flat bank top that
  carries the ribbon's edge under ground. That last part is not decoration —
  the water's surface height is read back off the terrain, so a channel the
  1.3 m grid cannot represent leaves the water's edge floating. Measured across
  seeds, the ribbon's edge sits 0.17–0.19 m under ground at its worst spot and
  the centre depth stays within 0.04 m of the designed 0.45 m.
  Wading is drag, not collision: the player's horizontal velocity and jump are
  scaled down between 0.12 m and 0.45 m of submersion. No changes to
  `MovementController.ts`, and no swimming.
- **Step 2.3 — The Forest** (complete): trees grown by an L-system — 3-4
  iterations of branching, each branch a tapered cylinder of 3 rings by 6
  radial segments with noise-displaced vertices and area-weighted smooth
  normals, capped at the tip and left open at the base where it joins its
  parent. Canopies are clusters of noise-displaced icosahedrons anchored to the
  tree's topmost points rather than multiplied per growing tip, which is what
  keeps one crown shaped like a crown. Four presets — oak (10.1 m tall, 4.9 m
  spread, 2,240 canopy triangles), deciduous (7.5 m), sapling (3.3 m, single
  trunk, small cluster) and dead (5.6 m, grey bark, an 80-triangle canopy of
  bare twigs plus fungal clusters) — each in four variants, because a single
  geometry per type makes every oak in the forest the same tree at a different
  scale. Bark is a Voronoi `f2-f1` ridge in object-space XZ, which gives
  vertical plates that survive stretching, turned into normals through Three's
  own bump-map derivation rather than a hand-derived object-space gradient (the
  fragment shader declares no `modelMatrix`, and for an `InstancedMesh` it would
  be the wrong matrix anyway). Leaves keep their vertex-colour ramp and add a
  view-dependent emissive lift as a subsurface-scattering approximation, with an
  alpha-tested edge mask.
  `ProceduralForest.ts` places trees with Bridson's Poisson disk sampling over a
  density field that doubles near the stream and thins out up the hills: against
  the shipped terrain that is 3,414 trees over 500 m — 137 per hectare, about 8
  oak / 37 deciduous / 70 sapling / 21 dead, inside the plan's ranges. Each tree
  gets a random 0.8-1.2 scale, rotation and a noise-driven lean, and the
  probability of a dead tree climbs toward the polluted end of the stream.
  Three levels of detail: full L-system geometry under 30 m, a simplified trunk
  and one canopy sphere to 80 m, and a billboard cross of two intersecting
  planes beyond that. `FoliageGenerator.ts` adds the ground layer — instanced
  thin-triangle grass, crossed-plane ferns, displaced-sphere bush clusters, plus
  rocks, fallen branches and leaf litter — and `FoliageMaterial.ts` moves it with
  a quadratic-in-height wind phased on world position, so a gust rolls across
  the patch instead of sliding it. The forest is a camera-following 80 m patch
  that rescatters only when its snapped centre changes, and every nearby trunk
  gets a fixed collider — 174 of them at the origin, 8 at the far corner of the
  map — so the player cannot walk through a tree. Measured: 242,906 forest
  triangles in 50 draw calls, on top of the terrain's 293,378.
- **Step 2.4 — The Corruption** (complete): the blight that runs the length of
  the stream, from the village end to the cave that is its source. It is
  entirely visual and atmospheric this phase — nothing about it changes what the
  player can do.
  `CorruptionField.ts` turns the stream's own pollution into a field over the
  world: `intensity = pollution^0.75 * (1 - smoothstep(0, reach, distance))`,
  where `reach` grows with the pollution, so the foul upstream end carries its
  blight roughly twice as far as the clean downstream end. Walking the spline
  from the cave to the village the intensity falls 0.92, 0.90, 0.81, 0.68, 0.50,
  0.30 and the stage falls with it, 3, 3, 3, 2, 2, 1 — which is the plan's three
  zones in order: inner (near the cave) stage 2-3, middle (mid-stream) stage 2,
  outer (downstream) stage 1. About 12% of the world carries corruption at all,
  and 1.8% is at stage 3.
  The field reaches the world in five places. The terrain carries it as one
  float per vertex, mixed into its own colour in the fragment shader. The bark
  shifts toward grey and the canopy droops — quadratic in normalised height, so
  a 10 m oak sinks 1.4 m and a 3.3 m sapling 0.42 m, both 14% of their own
  height — and the crown twists about the tree's own axis with an angle that
  grows up the trunk, so the trunk stays straight where its capsule collider is
  and only the leaves turn. The ground cover desaturates and yellows by the same
  luma weights, except the rocks, which do not die. `FungusGenerator.ts` builds
  five procedural shapes — mushroom clusters, shelf brackets, spore pods,
  carrion and rot — and `CorruptionSystem.ts` scatters them in a camera-following
  patch, with fungal shelves hung off the corrupted trees and drifting spores
  whose density and brightness both rise with the stage. One green point light
  rides the camera and scales with the corruption underfoot, which is what makes
  the pods read as glowing rather than merely bright.
  Measured at the cave mouth, the worst ground in the world: 78 shelves on the
  nearby trees, 36 ground fungi, and 45,045 triangles — 7% of the frame.

---

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Type-check, then produce a production bundle in `dist/` |
| `npm run preview` | Serve the production bundle |
| `npm run typecheck` | `tsc --noEmit` only |
| `npm test` | Run the Vitest suite |

---

## Architecture

```
src/
├── main.ts                        Entry point: builds and wires the core services
├── core/
│   ├── Engine.ts                  Fixed timestep + variable render loop
│   ├── EventBus.ts                Typed publish/subscribe (the event contract)
│   ├── InputManager.ts            Keyboard + mouse capture
│   ├── SceneManager.ts            Macro state machine
│   └── TimeController.ts          Game time, dilation and pause
├── audio/
│   └── WaterAudio.ts              Synthesised flowing-water loop, spatialised
├── debug/
│   ├── DebugGizmos.ts             Terrain-spanning measurement grid + origin axes
│   ├── DebugHud.ts                The DOM panel: FPS, frame time, counters
│   └── DebugOverlay.ts            Orchestrator, key bindings, input logging
├── physics/
│   └── PhysicsWorld.ts            Rapier world, gravity, capsule + terrain + trunk colliders
├── procedural/
│   ├── NoiseLibrary.ts            Perlin, Simplex, Voronoi, FBM — JS and GLSL
│   ├── StreamSpline.ts            Catmull-Rom spline with an arc-length LUT
│   ├── StreamGenerator.ts         Stream profile + extruded water ribbon
│   ├── TerrainGenerator.ts        384×384 heightmap, biomes, channel, collider data
│   ├── MaterialFactory.ts         Triplanar terrain material (no texture files)
│   ├── WaterShader.ts             Procedural water: flow, Fresnel, shoreline, sky
│   ├── TreeGenerator.ts           L-system trees, simplified trees, billboards
│   ├── TreeMaterial.ts            Bark (Voronoi plates, bump normals) + leaf (SSS)
│   ├── FoliageGenerator.ts        Grass, ferns, undergrowth, rocks, branches, litter
│   ├── FoliageMaterial.ts         Wind-vertex and fern-alpha shaders for the above
│   └── ProceduralForest.ts        Poisson placement, density field, LOD tiering
├── player/
│   ├── Player.ts                  Capsule mesh + dynamic body, synced per frame
│   └── MovementController.ts      WASD, walk/run, jump, slopes, camera-relative
├── renderer/
│   ├── RenderPipeline.ts          WebGLRenderer, scene graph, camera, resizing
│   ├── CameraController.ts        Third-person orbit camera (owns no Three objects)
│   ├── LightingSystem.ts          Sun + ambient fill
│   └── SkySystem.ts               Gradient sky dome
└── world/
    ├── Terrain.ts                 Façade over the heightmap + its collider
    ├── Stream.ts                  Water mesh, motes, queries, spatialised audio
    ├── Forest.ts                  Three LOD tiers, trunk colliders, shared wind
    └── WorldScene.ts              Composes terrain + sky + lights + fog + stream + player
```

### The loop

```
each animation frame
  1. clamp the raw delta            (a stalled tab must not fast-forward the world)
  2. TimeController.update(delta)   → scaled game delta, ramps speed transitions
  3. frame-start listeners          (input polling)
  4. fixed update(s)                (0..maxSubSteps at a constant 1/60 s)
  5. render                         (exactly once, with the interpolation alpha)
```

The simulation runs on a fixed timestep so physics and animation stay
deterministic at any frame rate; rendering runs at whatever rate the browser
provides so the camera stays smooth. If the substep cap is hit, the backlog is
dropped — a slow machine degrades into slow motion instead of a death spiral.

### Simulation vs presentation

`WorldScene` splits its update in two, and the split is load-bearing:

```ts
engine.onFixedUpdate((dt) => worldScene.fixedUpdate(dt));  // physics, fixed 1/60
engine.onRender(() => {
  worldScene.update(timeController.getDelta());            // presentation
  renderPipeline.render();
});
```

Physics only ever moves on the fixed path. The render path reconciles meshes with
bodies and advances the sky, and never touches the simulation — a variable frame
delta fed into Rapier would make it inaccurate and non-deterministic.

Time dilation needs no special case anywhere: when `gameSpeed` drops the
accumulator fills more slowly, fixed steps simply happen less often, and the
world slows down. Pause means zero fixed steps, so physics stops dead while the
renderer keeps drawing.

### Time dilation

`TimeController.gameSpeed` is the **only** clock game systems may read, and they
read it through `TimeController.getDelta()`:

```ts
const delta = timeController.getDelta();   // engineDelta * gameSpeed
```

`WorldScene.update()` takes that scaled delta, which is why the whole world
slows and freezes with the `PAUSED` / `DILATED` states while rendering itself
keeps running at full frame rate. Speed transitions are interpolated over
**real** time, never game time — if they were interpolated in game time,
slowing the game would also slow the ramp, and a paused game could never speed
back up.

The camera, the debug overlay and the UI are deliberately exempt: they keep
running at full speed so the player can still look around freely during slowed
time, which is what makes Active Encounter combat readable. In `main.ts` the
camera and the overlay are driven from `Engine.onRender` with `frame.realDelta`
while the world takes `TimeController.getDelta()` - the two deltas sit side by
side in one callback, and the difference between them is the whole point.

### Events

`EventBus` is typed against the `AstraEvents` map in `src/core/EventBus.ts`. Adding
an event there makes TypeScript enforce the payload shape at every call site.
Listeners are isolated, so a throwing handler can never break the game loop.

---

## Manual verification

With `npm run dev` running, open the browser console:

```js
__ASTRA__.sceneManager.current                    // 'MAIN_MENU' after the first frame
__ASTRA__.worldScene.elapsedTime                  // advances every frame
__ASTRA__.worldScene.fog                          // Fog { near: 25, far: 60 }
__ASTRA__.timeController.gameSpeed                // 1
__ASTRA__.timeController.setState('DILATED')      // the world slows to 25%
__ASTRA__.engine.fps
```

Developer key bindings (the Step 1.6 debug overlay):

| Key | Action |
| --- | --- |
| `F3` | Toggle the whole debug overlay: the panel plus both gizmos |
| `F4` | Toggle the ground measurement grid |
| `F6` | Toggle the X/Y/Z tripod at the origin |
| `F7` | Toggle the console log of input events |
| `1` / `2` / `3` | Time state: `REALTIME` / `DILATED` / `PAUSED` |
| `P` | Toggle the `PAUSED` scene state (freezes game time via the event wiring) |

The panel shows FPS, frame time, the frame counter, fixed steps issued, the
`TimeController`'s state, its current and target speed, the current scene, and
the renderer's draw-call, triangle, geometry and texture counts. Function keys
were chosen over letters because the gameplay verbs are WASD, Shift and Space;
`F5` is avoided because every browser binds it to reload.

While time is dilated or paused, the sky's slow gradient drift slows and stops
with it — and so does the player's fall — a visible confirmation that the world
really is reading its delta from the `TimeController` and not from the engine.
The FPS and frame counters keep running through it, which is the same
real-time contract the camera has.

```js
__ASTRA__.worldScene.player.position   // { x, y, z } of the capsule's centre
__ASTRA__.physics.gravity              // { x: 0, y: -9.81, z: 0 }
__ASTRA__.physics.stepCount            // fixed steps taken so far
```

---

## Notes

- **Rapier** is installed as `@dimforge/rapier3d-compat`: it ships its ~3 MB WASM
  inline as base64, so it works in Vite, in Node and in the test runner with no
  bundler plugins. The cost is bundle size — the production bundle is ~5.0 MB
  (~1.84 MB gzipped), almost all of it that base64. Switching to
  `@dimforge/rapier3d` would emit the WASM as a separate, stream-compilable,
  independently cacheable asset (~250 kB of JS plus a 3 MB `.wasm`), at the price
  of wasm-loader configuration and a test-runner setup that no longer works out
  of the box. `vite.config.ts` documents the trade-off where the limit is set.
- Versions are pinned exactly to keep agent-driven builds reproducible.
- `node_modules/` and `dist/` are git-ignored. Note that `node_modules/` is also
  outside the sandbox's persisted snapshot, so run `npm ci` (or `npm install`)
  after any environment reset before building or testing.
- **Boot is async.** Rapier's WASM must be initialised before a `World` can
  exist, so `main.ts` exports a `ready` promise that tests await. `index.html`
  needs no change — the module auto-starts.
- 998 tests across 40 files, including a jsdom integration test that runs the
  real `main.ts` bootstrap end to end and walks, runs, jumps, orbits and dilates
  through it.
- **The terrain collider is a triangle mesh, not a Rapier heightfield.**
  `ColliderDesc.heightfield()` panics with `RuntimeError: unreachable` in
  `rawshape_heightfield` on every published `rapier3d-compat` version (verified
  across 0.11 through 0.22, both `.mjs` and `.cjs`), for raw and normalized
  heights and grids as small as 4×4. The panic is inside Rust, not in the
  argument marshalling. See [rapier.rs#146](https://github.com/dimforge/rapier.rs/issues/146),
  open since 2025-11-17 in a repository that is now archived. The trimesh route
  is permanent; `createTerrainCollider` documents the evidence at the call site.
- **The tree shaders are validated without a GPU.** A GLSL syntax error inside
  an `onBeforeCompile` patch cannot be caught by `tsc` and cannot be seen until a
  browser compiles it, so `tests/tree-material.test.ts` parses the *patched*
  `THREE.ShaderLib.physical` sources with `@shaderfrog/glsl-parser` (a dev
  dependency) and asserts the result is a well-formed program. The same tests
  count ASTRA-injected uniforms per shader — a uniform declared in both the
  vertex and the fragment shader is legal and shares one location — and check
  that no patch declares the same thing twice.

---

Dungeons & Dragons, D&D, and all related trademarks are the property of Wizards of
the Coast LLC. This project is a non-commercial, code-only homage built for
learning and is not affiliated with or endorsed by Wizards of the Coast.
