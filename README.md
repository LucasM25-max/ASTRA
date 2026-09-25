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
├── renderer/
│   ├── RenderPipeline.ts          WebGLRenderer, scene graph, camera, resizing
│   ├── LightingSystem.ts          Sun + ambient fill
│   └── SkySystem.ts               Gradient sky dome
└── world/
    ├── Terrain.ts                 The ground plane
    └── WorldScene.ts              Composes terrain + sky + lights + fog
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

The camera and the UI are deliberately exempt: they keep running at full speed so
the player can still look around freely during slowed time, which is what makes
Active Encounter combat readable.

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

Temporary key bindings (replaced by the Step 1.6 debug overlay):

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Time state: `REALTIME` / `DILATED` / `PAUSED` |
| `P` | Toggle the `PAUSED` scene state (freezes game time via the event wiring) |

While time is dilated or paused, the sky's slow gradient drift slows and stops
with it — a visible confirmation that the world really is reading its delta from
the `TimeController` and not from the engine.

---

## Notes

- **Rapier** is installed as `@dimforge/rapier3d-compat`: it ships its WASM inline,
  so it works in Vite, in Node and in the test runner with no bundler plugins.
  Physics bodies arrive in Step 1.3.
- Versions are pinned exactly to keep agent-driven builds reproducible.
- `node_modules/` and `dist/` are git-ignored. Note that `node_modules/` is also
  outside the sandbox's persisted snapshot, so run `npm ci` (or `npm install`)
  after any environment reset before building or testing.
- 154 tests across 14 files, including a jsdom integration test that runs the
  real `main.ts` bootstrap end to end.

---

Dungeons & Dragons, D&D, and all related trademarks are the property of Wizards of
the Coast LLC. This project is a non-commercial, code-only homage built for
learning and is not affiliated with or endorsed by Wizards of the Coast.
