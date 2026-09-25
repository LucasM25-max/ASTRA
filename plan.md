```markdown
# D&D ASTRA — Complete Build Plan

## Overview

This is the comprehensive build plan for **ASTRA**, a 3D action-adventure RPG based on D&D 5e (2024), built entirely through Arena.ai's agent mode without a traditional game engine. The build is structured in four prioritized phases, each with detailed implementation steps.

**Core design pillars:**

- **Cinematic stylised realism** — believable, grounded fantasy that feels handcrafted
- **Active Encounter combat** — real-time exploration that shifts into time-dilated tactical combat
- **AI Dungeon Master** — a DM Layer that narrates, adapts, and paces the adventure
- **Code-first assets** — procedural geometry and shader-driven materials, no external art pipeline required
- **Session-based structure** — play in discrete sessions like a real D&D table
- **Dice as spectacle** — dice rolls are the most dramatic visual moment in the game

---

## Architecture Decision

Since we're building without a game engine, we'll use **web technologies** as our platform:

- **Three.js** — 3D rendering engine (WebGL)
- **Rapier.js** or **Cannon-es** — Physics engine
- **Howler.js** — Audio
- **Vanilla TypeScript** — Game logic
- **Custom ECS (Entity-Component-System)** — Game architecture
- **GLSL shaders** — Custom visual effects (all materials are procedural)
- **HTML/CSS** — UI/HUD overlays

This gives us full 3D capability, runs in-browser, requires no engine license, and can be built entirely through code generation.

---

## Project Structure

```
astra/
├── index.html
├── src/
│   ├── main.ts                    # Entry point
│   ├── core/
│   │   ├── Engine.ts              # Main game loop
│   │   ├── SceneManager.ts        # Scene state machine
│   │   ├── InputManager.ts        # Keyboard/mouse/gamepad
│   │   ├── AssetLoader.ts         # Models, textures, audio
│   │   ├── EventBus.ts            # Global event system
│   │   ├── TimeController.ts      # Game speed / time dilation
│   │   ├── SaveManager.ts         # LocalStorage save system
│   │   └── SessionManager.ts      # Session start/end/recap
│   ├── ecs/
│   │   ├── World.ts               # ECS world
│   │   ├── Entity.ts              # Entity class
│   │   ├── Component.ts           # Component base
│   │   └── System.ts              # System base
│   ├── renderer/
│   │   ├── RenderPipeline.ts      # Three.js setup + post-processing
│   │   ├── CameraController.ts    # Third-person camera
│   │   ├── LightingSystem.ts      # Dynamic cinematic lighting
│   │   ├── SkySystem.ts           # Day/night + weather
│   │   ├── WaterShader.ts         # Stream/river rendering
│   │   ├── FoliageSystem.ts       # Trees, grass, vegetation
│   │   ├── ParticleSystem.ts      # Spores, magic, dust
│   │   └── PostProcessing.ts      # Bloom, fog, color grading
│   ├── procedural/
│   │   ├── NoiseLibrary.ts        # Perlin, Simplex, Voronoi, FBM
│   │   ├── TerrainGenerator.ts    # Heightmap terrain mesh
│   │   ├── TreeGenerator.ts       # L-system tree meshes
│   │   ├── RockGenerator.ts       # Displaced icosahedrons
│   │   ├── CaveGenerator.ts       # Inverted noise volumes
│   │   ├── FoliageGenerator.ts    # Grass, ferns, undergrowth
│   │   ├── FungusGenerator.ts     # Corruption growths
│   │   ├── CharacterGenerator.ts  # Blocky-but-readable humanoid
│   │   ├── StreamGenerator.ts     # Spline-based stream ribbon
│   │   └── MaterialFactory.ts     # All procedural shader materials
│   ├── player/
│   │   ├── PlayerController.ts    # Movement + animation state
│   │   ├── PlayerCamera.ts        # Orbit camera logic
│   │   ├── CharacterSheet.ts      # D&D stats/abilities
│   │   ├── Inventory.ts           # Equipment + items
│   │   └── PlayerModel.ts         # Character mesh + skeleton
│   ├── world/
│   │   ├── Terrain.ts             # Terrain management
│   │   ├── StreamSystem.ts        # Flowing water along path
│   │   ├── CorruptionSystem.ts    # Visual corruption stages
│   │   ├── ProceduralForest.ts    # Tree placement + variation
│   │   ├── CaveGenerator.ts       # Interior cave geometry
│   │   └── Landmarks.ts           # Key world markers
│   ├── npc/
│   │   ├── NPCManager.ts          # NPC spawning + AI
│   │   ├── DialogueSystem.ts      # Dialogue trees
│   │   ├── Borogrove.ts           # Treant NPC
│   │   └── EnemyAI.ts             # Combat AI basics
│   ├── combat/
│   │   ├── CombatManager.ts       # Initiative + turn order
│   │   ├── DiceSystem.ts          # Dice roll logic + math
│   │   ├── DiceTheatre.ts         # Dice roll visual spectacle
│   │   ├── ActionSystem.ts        # Attack/ability resolution
│   │   ├── DamageSystem.ts        # HP, conditions, death
│   │   └── EncounterManager.ts    # Active Encounter state machine
│   ├── dm/
│   │   ├── DMDirector.ts          # Top-level DM brain
│   │   ├── Narrator.ts            # Descriptive text/voiceover
│   │   ├── DifficultyTuner.ts     # Adjusts encounters on the fly
│   │   ├── PacingMonitor.ts       # Tracks tension/exploration ratio
│   │   └── ImprovEngine.ts        # Handles unexpected player actions
│   ├── quest/
│   │   ├── QuestManager.ts        # Quest state tracking
│   │   ├── QuestMarkers.ts        # Blue pulsing orbs
│   │   └── TutorialQuest.ts       # Fouled Stream quest
│   ├── ui/
│   │   ├── UIManager.ts           # UI state controller
│   │   ├── MainMenu.ts            # Full game menu
│   │   ├── GameModeSelection.ts   # Tutorial/Campaign/Adventure
│   │   ├── HUD.ts                 # In-game HUD
│   │   ├── Minimap.ts             # Bottom-right minimap
│   │   ├── QuestLog.ts            # Top-left quest list
│   │   ├── CharacterSheetUI.ts    # Character sheet panel
│   │   ├── InventoryUI.ts         # Inventory panel
│   │   ├── DialogueUI.ts          # Dialogue box + choices
│   │   ├── DiceUI.ts              # 3D dice display overlay
│   │   ├── CombatLog.ts           # Bottom-left combat log
│   │   ├── ActionBar.ts           # Bottom-center actions
│   │   ├── RadialActionMenu.ts    # In-combat radial menu
│   │   ├── OptionsMenu.ts         # Settings panel
│   │   ├── PauseMenu.ts           # In-game pause overlay
│   │   ├── CreditsScreen.ts       # Credits display
│   │   ├── SessionSummary.ts      # End-of-session recap
│   │   └── LoadingScreen.ts       # Loading with tips
│   ├── audio/
│   │   ├── AudioManager.ts        # Music + SFX manager
│   │   ├── AmbientSystem.ts       # Environmental audio
│   │   └── MusicTrack.ts          # Adaptive music
│   └── data/
│       ├── items.json             # Item definitions
│       ├── spells.json            # Spell definitions
│       ├── quests.json            # Quest definitions
│       ├── dialogue/
│       │   └── borogrove.json     # Borogrove dialogue tree
│       ├── narration/
│       │   └── fouled-stream.json # Pre-written DM narration
│       └── character-presets/
│           └── tutorial-fighter.json  # Tutorial character stats
├── assets/
│   ├── audio/                     # Music + SFX
│   ├── fonts/                     # UI fonts
│   └── shaders/                   # Custom GLSL shader files
├── package.json
├── tsconfig.json
└── vite.config.ts                 # Build tool
```

---

## PHASE 1: Player Walking Around in Blank World

**Goal:** A controllable character moving through a basic 3D space with functional camera, input, physics, and the time-dilation system that will power Active Encounter combat later.

### Step 1.1 — Project Bootstrap

```
Tasks:
- Initialize project with Vite + TypeScript
- Install Three.js, Rapier.js (or Cannon-es)
- Create index.html with fullscreen canvas
- Set up main game loop in Engine.ts (fixed timestep + variable render)
- Implement basic SceneManager with states:
    LOADING, MAIN_MENU, GAME_MODE_SELECT, GAMEPLAY, PAUSED, CINEMATIC
- Create InputManager supporting keyboard + mouse
- Create TimeController.ts:
    - gameSpeed: float (default 1.0)
    - setSpeed(target, duration) — lerps to target over time
    - pause() / resume() — sets to 0.0 / restores previous
    - getDelta() — returns engine delta * gameSpeed
    - All game systems read delta from TimeController, not Engine
    - States: REALTIME (1.0), DILATED (0.25), PAUSED (0.0)
- Create EventBus.ts for decoupled system communication
```

### Step 1.2 — Basic 3D Scene

```
Tasks:
- Initialize Three.js WebGLRenderer with antialiasing
- Create a flat ground plane (100m x 100m) with a basic green material
- Add directional light (sun) + ambient light
- Add perspective camera
- Implement render loop tied to Engine.ts via TimeController.getDelta()
- Add simple skybox (solid gradient blue to white)
- Add fog for depth
```

### Step 1.3 — Player Character (Capsule Prototype)

```
Tasks:
- Create player entity as a capsule mesh (placeholder for character model)
- Implement physics body with Rapier.js (dynamic capsule collider)
- Ground collision with static plane collider
- Gravity at -9.81 m/s²
- Player spawns at (0, 1, 0)
```

### Step 1.4 — Movement Controller

```
Tasks:
- WASD movement relative to camera facing direction
- Movement speed: walk 3.5 m/s, run 6 m/s (hold Shift)
- Smooth acceleration and deceleration (lerped velocity)
- Character rotation faces movement direction (smooth interpolation)
- Jump with Spacebar (ground check via raycast)
- Gravity + landing
- Prevent sliding on slopes
- All movement multiplied by TimeController.gameSpeed so that
  time dilation automatically slows the player during combat
```

### Step 1.5 — Third-Person Camera

```
Tasks:
- Orbit camera locked behind player
- Mouse controls: hold right-click to orbit, scroll to zoom
- Camera distance: 4m default, 2m-10m range
- Camera height offset: +1.5m above player center
- Smooth follow with damping
- Collision detection: raycast from target to camera, pull forward if occluded
- Camera doesn't clip through ground
- Camera movement is NOT affected by TimeController (camera stays
  responsive even when game time is dilated — this is critical for
  the Active Encounter system where the player needs to look around
  freely during slowed time)
```

### Step 1.6 — Debug & Polish

```
Tasks:
- FPS counter (top-left, togglable with F3)
- Grid overlay on ground (togglable)
- Axis helper at origin
- Console logging for input events
- Debug overlay showing TimeController state and gameSpeed value
- Ensure 60fps target on mid-range hardware
```

### Phase 1 Deliverable

A capsule character that walks/runs/jumps around a flat green plane with smooth third-person camera. The time-dilation system exists and is functional but stays at 1.0. Feels responsive and polished.

---

## PHASE 2: Good-Looking 3D World

**Goal:** Transform the blank world into Greyhawk wood — a cinematic, stylised-realistic forest environment with a polluted stream, following the Astra visual style guide. **All geometry is procedurally generated and all materials are shader-driven.** No external 3D models or texture files are required.

### Code-First Asset Strategy

The entire visual world is built from code. This is not a compromise — it is the design. The Astra style guide's emphasis on "simplified but high-quality textures," "strong silhouettes," and "consistency over complexity" favors procedural generation over hand-made assets.

**Three tiers of visual fidelity:**

| Tier | Method | Used For |
|------|--------|----------|
| **Procedural Geometry** | Three.js primitives + noise displacement + L-systems | Terrain, trees, rocks, caves, water, foliage, fungi, character |
| **Shader-Driven Materials** | GLSL shaders with noise functions, no texture files | Bark, leaves, stone, metal, skin, water, corruption, chain mail |
| **AI-Generated Assets** *(future)* | External AI tools for hero models and textures | Upgrades to character, key NPCs, unique landmarks |

All procedural generation lives in `src/procedural/`. The `MaterialFactory.ts` produces every material in the game as a `ShaderMaterial` or `MeshPhysicalMaterial` with procedural maps.

### Step 2.1 — Procedural Terrain

```
Tasks:
- NoiseLibrary.ts: implement Perlin, Simplex, Voronoi, and FBM noise
  functions usable in both JS (for mesh generation) and GLSL (for shaders)
- TerrainGenerator.ts:
  - Generate heightmap using layered FBM noise (4-6 octaves)
  - Terrain size: 500m x 500m (playable area ~200m x 200m)
  - Gentle rolling hills, slight valley carved where stream runs
  - Valley carved by subtracting a Gaussian falloff along the stream spline
  - Output: PlaneGeometry with displaced vertices + computed normals
- Terrain material (via MaterialFactory.ts):
  - Vertex-painted blending between 4 biome colors based on
    height + slope + proximity to stream:
    - Grass (dominant, earthy green)
    - Dirt (paths, riverbanks, brown)
    - Rock (exposed stone near stream, grey)
    - Mud (near polluted areas, dark brown-green)
  - Custom terrain shader with:
    - Triplanar mapping to avoid UV seams
    - Slope-based blending (rock on steep, grass on flat)
    - Subtle normal perturbation from noise for ground detail
    - No texture files — all detail from noise functions
- Collision mesh matches visual terrain (Rapier heightfield collider)
```

### Step 2.2 — Procedural Stream

```
Tasks:
- StreamGenerator.ts:
  - Define stream path as a CatmullRom spline through the terrain valley
  - Generate stream mesh: extruded ribbon following spline with
    variable width (1-3m) sampled from noise
  - Ribbon vertices conform to terrain height + slight offset below
- Custom water shader (WaterShader.ts via MaterialFactory):
  - Animated UV scrolling along spline direction for flow
  - Fresnel-based transparency (opaque at glancing angles, clear head-on)
  - Soft edge blending where water meets terrain (alpha falloff)
  - Subtle reflections via environment map (pre-baked sky, not real-time)
  - Normal map distortion from animated noise for ripples
  - All procedural — no water texture files
- Two visual states controlled by a `pollution` uniform (0.0 to 1.0):
  - CLEAN (0.0): clear blue-green water, visible riverbed noise
  - POLLUTED (1.0): greenish-brown, opaque scum layer, darker,
    subtle particle emission (bubbles/spores)
- Stream pollution value varies along spline:
  - Downstream (near village): 0.2
  - Mid-stream: 0.6
  - Upstream (near cave): 0.9
  - Smooth interpolation between zones
- Flowing particle effect: point sprites moving along spline
- Audio: flowing water sound with spatial positioning (Howler.js)
```

### Step 2.3 — Procedural Forest

```
Tasks:
- TreeGenerator.ts:
  - L-system branching algorithm (3-4 iterations) for trunks
  - Each branch: tapered cylinder with noise-displaced vertices
  - Bark material: Voronoi noise pattern, brown color ramp,
    procedural normal map from height — all in GLSL
  - Canopy: clustered icosahedrons with noise-displaced vertices
  - Leaf material: subsurface scattering approximation,
    green-yellow gradient, alpha-tested edges
  - Tree types generated by varying L-system parameters:
    - Large oaks: wide spread, thick trunk, dense canopy (6-10 per area)
    - Medium deciduous: moderate spread, thinner trunk (30-50)
    - Small saplings: single trunk, small canopy cluster (50-100)
    - Dead/corrupted: reduced canopy, grey bark, fungal clusters
- ProceduralForest.ts (placement):
  - Poisson disk sampling for natural spacing
  - Density varies: thick near stream, thinner on hills
  - Each tree: random scale (0.8-1.2), rotation, slight lean from noise
  - Dead tree probability increases near polluted stream
- LOD system: 3 levels based on camera distance
  - Near (<30m): full L-system geometry
  - Medium (30-80m): simplified trunk + single canopy sphere
  - Far (>80m): billboard cross (two intersecting planes)
- FoliageGenerator.ts:
  - Ground-level grass: instanced thin triangles with wind vertex shader
  - Ferns: instanced crossed planes with alpha noise
  - Undergrowth: small bush clusters from displaced spheres
  - Wind animation: vertex shader displaces tips based on time + position
  - All instanced via Three.js InstancedMesh for performance
- Forest floor: scattered leaf particles, small procedural rocks,
  fallen branch cylinders
```

### Step 2.4 — Corruption Visuals

```
Tasks:
- FungusGenerator.ts:
  - Mushroom clusters: cone + sphere primitives, scaled and grouped
  - Fungal shelf growths on trees: flattened torus segments
  - Spore pods: small glowing spheres on stalks
  - All use procedural materials: sickly green/purple, emissive glow
- CorruptionSystem.ts:
  - Corruption intensity based on proximity to stream center/source
  - Zone definitions (visual only):
    - Outer (downstream): Stage 1 — discolored water, small fungus,
      dying plants, minor abnormalities
    - Middle (mid-stream): Stage 2 — larger fungal growths,
      strange colors, contaminated pools, abnormal vegetation
    - Inner (near cave): Stage 2-3 — enormous fungal structures,
      twisted trees, glowing spores, unnatural lighting
  - Corruption effects applied to nearby procedural assets:
    - Trees nearest stream: bark color shifts to grey, canopy droops
      (vertex displacement), fungal shelf meshes attached
    - Terrain near stream: fungal texture overlay via shader uniform
    - Vegetation: desaturated, yellowed leaf color
  - Particle system: floating spores in corrupted areas
    - Small point sprites, sickly green/purple, gentle drift physics
    - Density increases with corruption stage
  - Dead organic matter: small dark meshes near water (dead fish, rot)
- Corruption is purely visual and atmospheric in this phase.
  It sets mood and tells the story of the polluted stream.
```

### Step 2.5 — Lighting & Atmosphere

```
Tasks:
- LightingSystem.ts:
  - Directional sun: warm golden (slightly angled for long shadows)
  - Ambient light: cool blue-grey (fill shadows)
  - Hemisphere light: sky blue top, earthy green bottom
  - Point lights for magical/fungal glow in corrupted areas
    (sickly green, low intensity, flickering)
- Shadow mapping:
  - Cascaded shadow maps for sun (at least 2 cascades)
  - Soft shadow edges (PCF)
  - Shadow bias tuned to prevent acne on procedural geometry
- Volumetric fog:
  - Ground-level fog in stream valley (denser near water)
  - Height-based fog falloff
  - Slightly greenish tint in corrupted areas
  - Implemented via post-process or custom fog shader
- God rays through tree canopy:
  - Volumetric light scattering post-process
  - Or screen-space approximation for performance
- Post-processing pipeline (PostProcessing.ts):
  - SSAO (screen-space ambient occlusion) for depth in forest
  - Bloom (subtle, mainly on sunlight and magical/fungal glows)
  - Color grading (warm, slightly desaturated cinematic LUT)
  - Vignette (very subtle)
  - Tone mapping (ACES filmic)
  - Anti-aliasing (FXAA or TAA)
  - All via Three.js EffectComposer
```

### Step 2.6 — Sky & Day/Night

```
Tasks:
- SkySystem.ts:
  - Procedural sky using Three.js Sky shader or custom
  - Sun position drives lighting direction
  - Gradient sky colors based on time of day
  - Cloud layer: scrolling noise-based cloud texture (procedural)
  - Start with fixed "late morning" time for tutorial
  - Day/night cycle system implemented but paused for tutorial
- Sky color influences ambient light and fog colors
- Stars/moon for night (future, system ready)
```

### Step 2.7 — Procedural Player Character

```
Tasks:
- CharacterGenerator.ts:
  - Replace capsule with procedural humanoid:
    - Body: box/cylinder primitives assembled into torso, limbs, head
    - Proportions: realistic (7.5 heads tall), not exaggerated
    - Chain mail armor: slightly larger torso/limb cylinders with
      chain mail material (tiling ring pattern via shader)
    - Greatsword: elongated box + crossguard, sheathed on back
  - Character material (MaterialFactory):
    - Skin: simple SSS approximation + noise for variation
    - Chain mail: procedural interlocking ring pattern shader,
      metallic reflectivity
    - Leather: brown noise-based material for boots/belt
    - Steel: high metalness, low roughness for sword
  - Basic skeleton with ~20 bones for animation
  - Strong silhouette: broad shoulders, clear weapon outline,
    readable at distance (per style guide Rule C)
- Animations (minimal set for Phase 2):
  - Idle: breathing, subtle weight shift (procedural sine-based)
  - Walk cycle: procedural IK or keyframed bone rotations
  - Run cycle: faster walk with more bob
  - Jump: launch + fall + land
- Animation blending (walk/run speed-based)
- Smooth animation transitions via AnimationMixer
- Character casts shadow and receives lighting correctly
```

### Step 2.8 — Environmental Audio

```
Tasks:
- AmbientSystem.ts:
  - Forest ambience: bird calls, rustling leaves, distant wildlife
  - Stream: flowing water (spatial audio, louder near stream)
  - Corrupted areas: reduced bird calls, replaced with unsettling
    low hum, occasional organic squelch sounds
  - Wind: gentle gusts synced with tree sway
- Player footstep sounds:
  - Surface detection (grass, dirt, rock, water)
  - Different sound per surface
  - Speed-matched (walk vs run cadence)
- Spatial audio positioning via Web Audio API or Howler.js
```

### Step 2.9 — World Boundaries & Performance

```
Tasks:
- Invisible collision walls at world edges (with soft fog to hide boundary)
- Dense procedural trees/rocks at edges to make boundaries feel natural
- Collision on all trees (cylinder colliders), large rocks
- Player can walk through small foliage (grass, small ferns)
- Performance optimization:
  - Frustum culling (Three.js default)
  - InstancedMesh for all repeated objects (grass, small rocks, fungi)
  - Draw call batching where possible
  - LOD switching for trees
  - Target: 60fps on mid-range laptop GPU
  - Performance budgets:
    - Draw calls: < 200 per frame
    - Triangles: < 500K visible
    - Texture memory: minimal (almost all procedural shaders)
```

### Phase 2 Deliverable

A beautiful Greyhawk forest built entirely from code — procedural terrain, trees, water, corruption, and atmosphere — with a procedurally generated character walking through it. Cinematic lighting, volumetric fog, environmental audio. Feels like a premium fantasy RPG world despite zero external art assets.

---

## PHASE 3: Tutorial Story & Mechanics

**Goal:** Implement the full "Fouled Stream" tutorial adventure with quest tracking, NPC interaction, dialogue, the Active Encounter combat system, the Dice Theatre, the DM Layer, and Session-based play.

### Step 3.1 — Quest System

```
Tasks:
- QuestManager.ts:
  - Quest state machine: NOT_STARTED → ACTIVE → COMPLETED
  - Sub-task tracking with individual completion states
  - Quest data loaded from quests.json
  - Fires events on EventBus for UI and DM Layer updates
- Tutorial quest structure:
  Quest: "Destroy Source of Pollution"
    ├── Task 1: "Follow the polluted stream" (ACTIVE on start)
    ├── Task 2: "Speak with Borogrove" (triggers on proximity)
    ├── Task 3: "Reach the cave entrance"
    ├── Task 4: "Defeat the Twig Blights" (combat)
    ├── Task 5: "Enter the corrupted cave" (future)
    ├── Task 6: "Purify the stream source" (future)
    └── Task 7: "Return to Borogrove" (future)
```

### Step 3.2 — Quest Markers

```
Tasks:
- QuestMarkers.ts:
  - Blue pulsing orbs that mark the path forward
  - Placed along stream path approximately 30m apart
  - Visual: glowing blue sphere with particle trail
    - Soft glow shader (additive blending)
    - Gentle vertical bob animation
    - Particle wisps emanating from orb
    - Subtle pulse (scale + brightness oscillation)
  - Markers disappear when player reaches within 3m
  - Next marker(s) appear/become visible when previous collected
  - Shown on minimap as blue dots
  - When all markers for current task are collected, task updates
```

### Step 3.3 — HUD Implementation

```
Tasks:
- HUD.ts parent controller, child components:

Bottom Right — Minimap:
  - Circular minimap (150px diameter)
  - Top-down orthographic render or canvas-drawn
  - Shows: player arrow (center), terrain, stream (blue line),
    quest markers (blue dots), NPCs (yellow dots), enemies (red dots)
  - Rotating (north-up or player-up, toggle in Options)
  - Below minimap: time display, weather icon

Top Right — Action Buttons:
  - Options gear icon → opens OptionsMenu
  - Character sheet icon → opens CharacterSheetUI
  - Inventory bag icon → opens InventoryUI
  - Styled as subtle medieval-themed icons
  - Hover tooltip

Top Middle — XP Bar:
  - Thin bar showing XP progress to next level
  - "Level 1 Fighter" text
  - In combat: initiative order bar appears below (Active Encounter)

Top Left — Quest Log:
  - Active quest name in header
  - Sub-tasks listed with checkboxes
  - Completed tasks crossed out
  - Collapsible

Bottom Middle — Context Actions:
  - In exploration: available actions (interact, examine, etc.)
  - In dialogue: dialogue window (see DialogueUI)
  - In combat: radial action menu (see RadialActionMenu)

Bottom Left — Combat Log (hidden outside combat):
  - Scrollable text log of combat events
  - Color-coded: damage (red), healing (green), info (white)
  - Populated by DM Narrator for flavorful descriptions

Character Overhead:
  - Floating above player and NPCs:
    - Health bar (red/green)
    - AC in shield icon
    - Name
  - Only visible on enemies when targeted or in combat
```

### Step 3.4 — Character Sheet & Stats

```
Tasks:
- CharacterSheet.ts — Tutorial Fighter data:
  Name: [Player chosen or "Adventurer"]
  Species: Human
  Class: Fighter (Level 1)

  Ability Scores:
    STR: 16 (+3)
    DEX: 12 (+1)
    CON: 14 (+2)
    INT: 10 (+0)
    WIS: 13 (+1)
    CHA: 8 (-1)

  HP: 12 (10 + CON mod)
  AC: 17 (Chain Mail 16 + Defense fighting style 1)
  Initiative: +1 (DEX)
  Speed: 30 ft
  Proficiency Bonus: +2

  Saving Throws: STR +5, CON +4

  Skills (proficient):
    Athletics +5
    Perception +3 (Human bonus)
    Intimidation +1
    Survival +3

  Features:
    - Heroic Inspiration (Human: after Long Rest)
    - Savage Attacker (Origin feat: 1/turn ADV on weapon damage)
    - Defense (+1 AC in armor)
    - Second Wind (Bonus action: 1d10+1 HP, 2 uses)
    - Weapon Mastery: Greatsword (Graze), Flail, Javelin

  Equipment:
    - Chain Mail (AC 16, 55 lbs)
    - Greatsword (2d6 slashing, two-handed, Graze)
    - 75 gp

- CharacterSheetUI.ts:
  - Full-page overlay panel
  - Styled like a D&D character sheet (parchment aesthetic)
  - Sections: abilities, skills, features, equipment
  - Stat values dynamically read from CharacterSheet component
  - Open/close with 'C' key or top-right button
```

### Step 3.5 — Inventory System

```
Tasks:
- Inventory.ts:
  - Item slots: equipment (armor, weapon, accessories) + backpack (grid)
  - Item data structure: name, description, weight, type, properties
  - Starting inventory:
    - Equipped: Chain Mail, Greatsword
    - Backpack: 75 gp
  - Weight tracking (carrying capacity: STR × 15 = 240 lbs)

- InventoryUI.ts:
  - Grid-based inventory panel
  - Equipment slots (paper doll or slot list)
  - Item tooltip on hover (name, description, stats, weight, value)
  - Open/close with 'I' key or top-right button
  - Items show small icon + name
```

### Step 3.6 — DM Layer Foundation

```
Tasks:
- DMDirector.ts:
  - Top-level coordinator for all DM subsystems
  - Listens to EventBus for game events (area entry, combat start,
    quest update, player HP change)
  - Triggers Narrator, DifficultyTuner, PacingMonitor as needed
  - For tutorial: all behavior is pre-scripted, no AI calls

- Narrator.ts:
  - Generates descriptive text displayed as a cinematic text crawl
    at the top of the screen (or bottom, configurable)
  - Text appears with typewriter effect, stays 5-8 seconds, fades
  - For tutorial: pre-written narration from narration/fouled-stream.json
  - Triggered by:
    - Entering a new area ("The stream narrows here, its waters
      thick with a sickly green film...")
    - Combat start ("Six twisted shapes emerge from the undergrowth,
      their twig-like limbs crackling with malice!")
    - Key quest moments ("Borogrove's ancient eyes study you...")
    - Dice roll results (flavor text for nat 20s, nat 1s, close calls)
  - Future: AI-generated narration via API for campaigns

- DifficultyTuner.ts:
  - Monitors player HP and combat performance
  - If player HP drops below 25%: quietly reduce remaining enemy HP
    by 1-2 per creature, narrated as lucky breaks
    ("The blight stumbles on a root!")
  - If player is dominating (all enemies below 50% HP by round 2):
    add a reinforcement enemy emerging from the trees
  - Adjustments are invisible to the player — the dice just seem
    to tell a good story
  - For tutorial: conservative tuning, mainly safety net

- PacingMonitor.ts:
  - Tracks time spent in: combat, exploration, dialogue, idle
  - If combat exceeds 5 rounds: nudge DifficultyTuner to accelerate
  - If exploration exceeds 3 minutes without event: trigger ambient
    DM narration or environmental event (distant shriek, rustling)
  - If idle > 60 seconds: gentle Narrator hint
    ("The stream's corruption grows worse upstream...")
  - Fires events that DMDirector acts on

- ImprovEngine.ts:
  - Stub for tutorial (no unexpected actions expected)
  - Architecture: receives player action intent, generates DC,
    narrates outcome
  - Future: full AI-powered improvisation for open-world play
```

### Step 3.7 — Tutorial Intro Cinematic

```
Tasks:
- TutorialIntro.ts:
  - Black screen → fade in
  - Camera follows a cinematic spline path:
    1. Start: aerial shot pulling through forest canopy
    2. Camera descends to stream level, follows clean water upstream
    3. Water transitions to polluted, fungal growths appear on banks
    4. Camera slows, arrives at player character standing by stream
  - Duration: ~25-30 seconds
  - DM Narrator voiceover (text overlay):
    "The waters of High Ery have run clear for generations.
     But something has changed. A foul corruption creeps
     downstream, poisoning the land. Someone must find the source."
  - Music: gentle orchestral → slightly ominous as corruption appears
  - At end: camera smoothly transitions to gameplay camera position
  - HUD fades in
  - Quest appears: "Destroy Source of Pollution"
  - Player gains control
  - Skip button available (Enter or Escape)
  - SessionManager marks Session 1 as started
```

### Step 3.8 — NPC System & Borogrove

```
Tasks:
- NPCManager.ts:
  - NPC entity with: position, model, dialogue reference, interaction radius
  - Interaction prompt when player is within range ("Press E to speak")

- Borogrove.ts:
  - Treant NPC positioned in forest along stream path
  - Triggers after player passes 2 quest markers
  - Entrance: DM Narrator triggers ("The trees ahead groan and part...")
    then Borogrove steps out from between large trees
  - Visual (procedural):
    - Enormous (4m tall) tree creature
    - Trunk: thick L-system cylinder with heavy bark noise
    - Branches: spreading L-system arms with leaf clusters
    - Face: knothole eyes with warm amber point lights
    - Mossy beard: hanging green particle strips
    - Small creatures on shoulders: tiny sphere clusters
  - Slow, deliberate idle animation (gentle sway, leaf rustle)
  - Interaction triggers dialogue
```

### Step 3.9 — Dialogue System

```
Tasks:
- DialogueSystem.ts:
  - Dialogue tree structure:
    {
      id: "node_1",
      speaker: "Borogrove",
      text: "...",
      responses: [
        { text: "Player option 1", next: "node_2" },
        { text: "Player option 2", next: "node_3" }
      ],
      onEnter: [actions],  // quest updates, item grants, etc.
      onExit: [actions]
    }
  - Typewriter text effect for NPC speech
  - Player responses shown as numbered list
  - Keyboard (1,2,3...) or click to select response
  - TimeController set to DILATED (0.25) during dialogue so the
    world feels alive but slow while reading

- DialogueUI.ts:
  - Bottom-center dialogue panel
  - Speaker portrait/name on left
  - Text area with typewriter animation
  - Player responses below as buttons
  - Semi-transparent dark panel, medieval frame styling
  - Camera stays in free movement (not locked)
  - NPC name plate visible above them

- Borogrove Dialogue Tree:
  Node 1 (Borogrove): "Hold, small one. The forest speaks of your
    approach. You follow the corruption, as I have watched it grow."
    → "What corruption?" → Node 2
    → "Who are you?" → Node 3
    → "I'm here to help." → Node 4

  Node 2 (Borogrove): "An unnatural fungus festers in the cave
    upstream. It poisons the water, and the poison spreads.
    The stream once sang. Now it weeps."
    → "Where is this cave?" → Node 5
    → "Can you stop it?" → Node 6

  Node 3 (Borogrove): "I am Borogrove. I have watched over these
    woods since before your grandparents' grandparents drew breath.
    The trees are my kin, and they are suffering."
    → "What corruption?" → Node 2
    → "I'll help." → Node 4

  Node 4 (Borogrove): "Then the forest is fortunate. The corruption
    is strong, but you carry iron and resolve. Perhaps that is enough."
    → "Where do I go?" → Node 5
    → "What should I know?" → Node 7

  Node 5 (Borogrove): "Follow the stream to its source. The cave
    lies at the head of the valley. But be wary — the corruption
    has spawned creatures. Twisted things of twig and malice."
    → "What should I know?" → Node 7
    → "I'm ready." → Node 8

  Node 6 (Borogrove): "I am old, and my roots run deep. To uproot
    myself for battle would take days. The corruption would spread
    further. This task needs swift feet, not ancient ones."
    → "Then I'll go." → Node 5

  Node 7 (Borogrove): "Take this." [Receives Magic Acorn]
    "An acorn from my crown. Swallow it if you are hurt or
    poisoned, and the forest's strength will mend you."
    [Quest Update: "Borogrove's Acorn" added to inventory]
    → "Thank you. I'll find the source." → Node 8

  Node 8 (Borogrove): "Go well, small one. The trees will watch
    your path."
    [Dialogue ends]
    [TimeController returns to REALTIME]
    [Quest updates: Task 2 complete, Task 3 activates]
    [New markers appear toward cave]
    [DM Narrator: "With the treant's blessing, you press onward..."]
```

### Step 3.10 — Inventory Item: Magic Acorn

```
Tasks:
- Add item to data/items.json:
  {
    id: "magic_acorn",
    name: "Borogrove's Acorn",
    description: "A warm, golden acorn that pulses with natural
      magic. If swallowed, it heals wounds (2d4+2 HP) and
      removes poison. Given by Borogrove the Treant.",
    type: "consumable",
    weight: 0,
    effects: ["heal_2d4+2", "lesser_restoration"],
    unique: true,
    questItem: true
  }
- Visual in inventory: golden glowing acorn icon
- Usable from inventory (for Phase 3, combat use comes later)
```

### Step 3.11 — Active Encounter Combat System

```
Tasks:
- TimeController integration:
  - REALTIME (1.0): normal exploration
  - DILATED (0.25): between combat turns, during dialogue
  - PAUSED (0.0): player's combat turn, menu navigation
  - Transitions are smooth (lerped over 0.5s)

- EncounterManager.ts:
  - State machine: EXPLORATION → ENCOUNTER_TRIGGER → INITIATIVE →
    COMBAT_ROUND → PLAYER_TURN → ENEMY_TURN → ... → COMBAT_END → EXPLORATION
  - Encounter trigger: proximity to enemy group or scripted event
  - Transition to combat:
    1. DM Narrator: "Creatures emerge from the shadows!"
    2. TimeController shifts to DILATED (0.25)
    3. Camera pulls back slightly, DOF shifts
    4. Initiative rolls play out (see DiceTheatre)
    5. Initiative bar populates at top of screen
    6. First turn begins

- CombatManager.ts:
  - Initiative rolling: d20 + DEX mod for all combatants
  - Turn order display in HUD (initiative bar, top middle)
  - On player turn:
    1. TimeController → PAUSED (0.0)
    2. RadialActionMenu appears around character in 3D space
    3. Options: Attack, Second Wind, Item, Dodge, Dash, Disengage
    4. Player selects action
    5. Action resolves with DiceTheatre
    6. TimeController → DILATED (0.25) for result animation
    7. Turn ends, next combatant acts
  - On enemy turn:
    1. TimeController → DILATED (0.25) (not paused — world stays alive)
    2. Enemy moves and acts with brief DiceTheatre for their attack
    3. Camera follows action
    4. Turn ends
  - Reactions (Opportunity Attacks):
    - Trigger automatically when condition met
    - Brief slow-mo flash (TimeController → 0.1 for 1s)
    - DiceTheatre overlay for the reaction roll

- RadialActionMenu.ts:
  - Circular menu in 3D space around player character
  - 6 segments: Attack, Cast (future), Item, Dodge, Dash, Disengage
  - Mouse hover highlights segment, click to select
  - Keyboard shortcuts (1-6) for speed
  - Sub-menus for Attack (weapon selection) and Item (inventory)
  - Styled as glowing arcane circle on the ground
  - Appears/disappears with smooth animation

- Basic attack resolution:
  - d20 + STR mod + proficiency vs target AC
  - Greatsword damage: 2d6 + STR mod
  - Graze (Weapon Mastery): on miss, deal STR mod damage
  - Savage Attacker: roll damage dice twice, take higher (1/turn)
  - Second Wind: bonus action, roll d10+1, heal that much, 2 uses

- Basic enemy: Twig Blight
  - AC 13, HP 4, +3 to hit, 1d4+1 damage
  - 6 Twig Blights at cave entrance
  - Procedural visual: twisted stick figures with glowing red eyes
  - Simple AI: move toward nearest player, attack
```

### Step 3.12 — Dice Theatre

```
Tasks:
- DiceSystem.ts (logic):
  - Dice types: d4, d6, d8, d10, d12, d20
  - Roll function: returns result + breakdown (die + modifier)
  - Advantage/disadvantage: roll twice, take higher/lower
  - All rolls fire events to DiceTheatre for visual presentation

- DiceTheatre.ts (presentation):
  - The most visually dramatic moment in the game
  - Triggered by DiceSystem roll events
  - Sequence for a standard roll:
    1. Camera pulls back slightly, DOF shifts to focus on dice space
    2. Glass table materializes — translucent crystalline surface
       that catches light and reflects the environment
    3. Die drops from above with real physics (Rapier.js)
       - Tumbles, bounces twice, settles
       - Weighty, satisfying sound (resin on wood)
       - Landing face matches predetermined result
    4. Result face glows: gold for success, red for failure
    5. Modifier slams in from the side:
       - "+3" is a glowing rune that drops and embeds with
         particle burst and metallic impact sound
       - "-1" is a cracked, dim rune that falls limply
    6. Total appears with typewriter reveal
    7. HIT/MISS verdict drops from above like a gavel:
       - Screen shake on impact (subtle, 2-3px)
       - Green "HIT" or red "MISS" with slam animation
    8. All visible for 5 seconds or until Continue clicked

  - Dice meshes (procedural):
    - d4: tetrahedron
    - d6: cube
    - d8: octahedron
    - d10: pentagonal trapezohedron
    - d12: dodecahedron
    - d20: icosahedron
    - Number textures on faces (canvas-generated)

  - Special roll moments:

    | Roll | Visual |
    |------|--------|
    | **Natural 20** | Die glows white-hot, cracks of golden light, camera zooms in, slow-mo, triumphant chord, particles explode outward, "CRITICAL HIT" in massive gold text |
    | **Natural 1** | Die cracks, red light bleeds from cracks, camera shakes, dissonant sound, "CRITICAL MISS" in jagged red text, die wobbles and falls over |
    | **Advantage** | Two dice drop simultaneously, the higher one glows gold and the lower one fades to grey and dissolves |
    | **Disadvantage** | Two dice drop, the lower one glows red and the higher one fades |
    | **Death Save** | Die table turns dark, single spotlight on die, heartbeat sound, everything else goes silent |
    | **Savage Attacker** | Two damage dice roll, the lower one shatters, the higher one's result is absorbed into the attack |

- DiceUI.ts:
  - Transparent overlay for dice view
  - Result text animations (slam = scale from 2x to 1x with bounce)
  - Continue button (medieval styled)
  - Dice roll speed option from Options menu:
    - Normal: full 5s sequence
    - Fast: 2s, skip bounce
    - Instant: result only, no animation
```

### Step 3.13 — Session Structure

```
Tasks:
- SessionManager.ts:
  - Session is the fundamental unit of play
  - Session lifecycle:

    SESSION START:
      - "Previously on ASTRA..." recap (DM Narrator, 2-3 sentences)
        For first session: "Your adventure begins..."
      - Character status summary (HP, conditions, resources)
      - Scene loads at last save point
      - Session stats tracking begins

    SESSION PLAY:
      - Normal gameplay
      - Auto-checkpoints at key moments:
        - Entering new area
        - Completing encounter
        - Finishing major dialogue
        - Quest task completion
      - Session stats tracked:
        - Enemies defeated
        - Dice rolled (highest, lowest, total)
        - Damage dealt/taken
        - HP healed
        - Time played
        - Notable moments (nat 20s, nat 1s, close calls)

    SESSION END:
      - Triggered by:
        - Completing a major quest step
        - Long rest
        - Player choosing to end (from Pause Menu)
        - DM PacingMonitor suggesting a natural stopping point
      - SessionSummary screen:
        - XP earned (with breakdown)
        - Notable moments ("Rolled a Natural 20 against the
          Twig Blight leader!")
        - Loot gained
        - Conditions resolved/gained
        - Dice statistics
        - Playtime
      - Level-up flow if applicable (future)
      - Auto-save
      - "Next Session" button or return to Main Menu

  - Long rest = end session + start new session
    - HP restored, abilities reset, Heroic Inspiration granted
    - Mechanically tied to session boundary
```

### Phase 3 Deliverable

Player begins with cinematic intro narrated by the DM Layer, gains control, follows quest markers along polluted stream, encounters Borogrove, has full dialogue interaction, receives magic acorn, quest updates appropriately. Full HUD is functional. Character sheet and inventory are viewable. Combat uses the Active Encounter system with time dilation and radial action menu. Dice Theatre makes every roll a spectacle. Session structure tracks play and provides recaps. DM Layer narrates transitions and tunes difficulty.

---

## PHASE 4: Game Menu

**Goal:** A polished main menu with all specified options, proper navigation, Session-based save/load, and cinematic presentation.

### Step 4.1 — Menu Structure & Navigation

```
Tasks:
- MainMenu.ts:
  - Scene state: MAIN_MENU
  - Full-screen UI overlay
  - Background: 3D rendered scene (slowly rotating/panning camera
    over the procedural forest landscape from Phase 2)
  - Background has subtle depth of field + atmospheric fog

- Layout:
  - ASTRA logo: centered-left, above button list
    - Large stylized text "ASTRA"
    - Subtitle: "A D&D Adventure"
    - Subtle glow/shimmer animation

  - Buttons (left-aligned, vertically stacked):
    1. NEW GAME → GameModeSelection screen
    2. CONTINUE → SaveGameList screen (Session-based)
    3. OPTIONS → OptionsMenu overlay
    4. CREDITS → CreditsScreen

  - Button style:
    - Medieval/fantasy themed
    - Dark semi-transparent background
    - Gold/warm text
    - Hover: subtle glow + slight scale
    - Click: press animation + sound
    - Keyboard navigation (arrow keys + enter)
```

### Step 4.2 — Game Mode Selection

```
Tasks:
- GameModeSelection.ts:
  - Triggered from "New Game"
  - Three mode cards displayed:

  TUTORIAL
    - Icon: crossed swords with scroll
    - Description: "Learn the ways of adventure. Three guided
      quests from the Dungeon Master's Guide. No character
      creation — play as a Level 1 Human Fighter."
    - Sub-list:
      • The Fouled Stream (available)
      • [Quest 2 - locked/coming soon]
      • [Quest 3 - locked/coming soon]
    - Click "The Fouled Stream" → SessionManager starts Session 1
      → LoadingScreen → TutorialIntro cinematic

  CAMPAIGN
    - Icon: book with dragon emblem
    - Description: "Embark on storied adventures across the
      worlds of D&D."
    - Sub-list:
      • Eberron: Forge of the Artificer [Coming Soon]
      • Ravenloft: The Horrors Within [Coming Soon]
      • Arcana Unleashed: Deadfall [Coming Soon]
    - All locked/greyed out with "Coming Soon" badge

  ADVENTURE
    - Icon: compass rose
    - Description: "Open world exploration with quests and
      encounters."
    - Sub-list:
      • Dragon Delves [Coming Soon]
      • Forgotten Realms: Adventures in Faerûn [Coming Soon]
    - All locked/greyed out

  - Back button → Main Menu
```

### Step 4.3 — Continue / Save System

```
Tasks:
- SaveManager.ts:
  - Save data to localStorage (or IndexedDB for larger saves)
  - Save structure:
    {
      id: string,
      name: string,
      timestamp: Date,
      mode: "tutorial" | "campaign" | "adventure",
      quest: string,
      sessionNumber: number,
      playerData: CharacterSheet,
      position: Vector3,
      questState: QuestState,
      sessionStats: SessionStats,
      playtime: number
    }
  - Auto-save at SessionManager checkpoints
  - Manual save from Pause Menu
  - Session end triggers save

- SaveGameList.ts (Continue screen):
  - List of saves sorted by most recent
  - Each entry shows:
    - Character name
    - Mode + quest name
    - Session number ("Session 3")
    - Level
    - Playtime
    - Date/time of save
    - Small screenshot (canvas capture, stored as data URL)
  - Click to load → SessionManager starts with "Previously on ASTRA..."
    recap using sessionStats from save
  - Delete save option
  - Back button → Main Menu
  - If no saves: "No saved games. Start a New Game!"
```

### Step 4.4 — Options Menu

```
Tasks:
- OptionsMenu.ts:
  - Accessible from Main Menu AND in-game (Pause Menu)
  - Tabs:

  GRAPHICS:
    - Resolution scale (0.5x to 2x)
    - Shadow quality (Off, Low, Medium, High)
    - Post-processing (Off, Low, High)
    - Foliage density (Low, Medium, High)
    - Fog quality
    - VSync toggle
    - FPS limit (30, 60, 120, Uncapped)
    - Anti-aliasing (Off, FXAA, TAA)

  AUDIO:
    - Master volume slider
    - Music volume slider
    - SFX volume slider
    - Ambient volume slider
    - Voice volume slider (future)

  CONTROLS:
    - Mouse sensitivity slider
    - Invert Y-axis toggle
    - Key bindings list (rebindable)
    - Camera zoom speed

  GAMEPLAY:
    - Difficulty (for future use)
    - Subtitles toggle
    - HUD scale
    - Minimap rotation style (fixed north / player-relative)
    - Dice Theatre speed (Normal, Fast, Instant)
    - DM Narration toggle (On / Off / Text Only)
    - Tutorial hints toggle
    - Time dilation intensity (Full 25%, Subtle 50%, Off 100%)

  ACCESSIBILITY:
    - Text size
    - High contrast UI
    - Colorblind mode (future)
    - Screen shake toggle

  - Apply / Cancel / Defaults buttons
  - Settings persist to localStorage
```

### Step 4.5 — Credits Screen

```
Tasks:
- CreditsScreen.ts:
  - Scrolling credits or static page:

  ASTRA
  A D&D Digital Adventure

  ---

  Game Director
  Lucas McCormick

  ---

  Built With
  Arena.ai Agent Mode

  ---

  Powered By
  Three.js • TypeScript • WebGL

  ---

  D&D Content
  Based on the Dungeons & Dragons System Reference Document (SRD)
  Dungeons & Dragons, D&D, and all related trademarks are property
  of Wizards of the Coast LLC, a subsidiary of Hasbro, Inc.

  This game is made under the terms of the D&D Systems Reference
  Document 5.1 (Creative Commons Attribution 4.0 International
  License) and/or the Open Gaming License.

  Not affiliated with, endorsed, sponsored, or specifically
  approved by Wizards of the Coast LLC.

  ---

  Special Thanks
  [Your additions here]

  ---

  © 2024 Lucas McCormick. All rights reserved.

  - Back button → Main Menu
  - Background music continues
```

### Step 4.6 — Pause Menu (In-Game)

```
Tasks:
- PauseMenu.ts:
  - Triggered by Escape key during gameplay
  - TimeController → PAUSED (0.0)
  - Overlay with options:
    - Resume (TimeController → previous state)
    - Save Game (triggers SessionManager checkpoint)
    - End Session (triggers SessionSummary → save → Main Menu)
    - Options (same OptionsMenu)
    - Main Menu (confirm dialog: "End current session?")
  - Blurred/darkened game view behind menu
```

### Step 4.7 — Loading Screen & Transitions

```
Tasks:
- LoadingScreen.ts:
  - ASTRA logo centered
  - Loading bar with percentage
  - D&D-style flavor text tips (rotating):
    - "A Natural 20 always hits."
    - "Never split the party."
    - "The DM is always right. Even when they're not."
    - "Check for traps."
  - "The Fouled Stream" title card with brief description
  - Procedural background (slowly rotating dice or forest silhouette)

- Menu transition animations:
  - Fade in/out between screens (0.3s)
  - Slide transitions for sub-menus
  - Background music: ambient orchestral fantasy theme
  - Button hover/click sound effects
  - Custom fantasy cursor (sword or hand pointer)
  - Responsive layout (works at different window sizes)
```

### Phase 4 Deliverable

A polished, navigable game menu with New Game (mode selection), Continue (session-based save list with recaps), Options (full settings including Dice Theatre and DM controls), and Credits. Tutorial can be launched from the menu, loads into the Phase 2+3 world via Loading Screen. Pause menu functional in-game with End Session option. All menus styled consistently with the Astra medieval fantasy aesthetic.

---

## Build Order for Agent Mode

The recommended order for Arena.ai agent mode to build files:

```
SPRINT 1 (Foundation):
  1. package.json + vite.config.ts + tsconfig.json + index.html
  2. src/core/EventBus.ts
  3. src/core/TimeController.ts
  4. src/core/InputManager.ts
  5. src/core/Engine.ts
  6. src/core/SceneManager.ts
  7. src/renderer/RenderPipeline.ts
  8. src/main.ts
  → Result: Empty rendered 3D scene with game loop and time control

SPRINT 2 (Player Movement):
  9. src/player/PlayerController.ts
  10. src/player/PlayerCamera.ts
  11. src/procedural/NoiseLibrary.ts
  12. src/procedural/TerrainGenerator.ts (flat placeholder)
  13. src/procedural/MaterialFactory.ts (basic materials)
  → Result: Capsule walking on flat ground with camera

SPRINT 3 (Procedural World):
  14. src/procedural/TerrainGenerator.ts (heightmap upgrade)
  15. src/procedural/StreamGenerator.ts
  16. src/renderer/WaterShader.ts
  17. src/procedural/TreeGenerator.ts
  18. src/procedural/FoliageGenerator.ts
  19. src/procedural/RockGenerator.ts
  20. src/procedural/FungusGenerator.ts
  21. src/world/CorruptionSystem.ts (visual only)
  22. src/renderer/LightingSystem.ts
  23. src/renderer/SkySystem.ts
  24. src/renderer/PostProcessing.ts
  25. src/renderer/ParticleSystem.ts
  → Result: Beautiful procedural forest environment

SPRINT 4 (Character & Audio):
  26. src/procedural/CharacterGenerator.ts
  27. src/player/PlayerModel.ts
  28. src/audio/AudioManager.ts
  29. src/audio/AmbientSystem.ts
  → Result: Procedural character walking through forest with audio

SPRINT 5 (UI Layer):
  30. src/ui/UIManager.ts
  31. src/ui/HUD.ts
  32. src/ui/Minimap.ts
  33. src/ui/QuestLog.ts
  34. src/ui/ActionBar.ts
  35. src/ui/CharacterSheetUI.ts
  36. src/ui/InventoryUI.ts
  37. src/player/CharacterSheet.ts
  38. src/player/Inventory.ts
  39. src/data/character-presets/tutorial-fighter.json
  40. src/data/items.json
  → Result: Full HUD overlay with character data

SPRINT 6 (DM Layer & Quest):
  41. src/dm/DMDirector.ts
  42. src/dm/Narrator.ts
  43. src/dm/DifficultyTuner.ts
  44. src/dm/PacingMonitor.ts
  45. src/dm/ImprovEngine.ts (stub)
  46. src/data/narration/fouled-stream.json
  47. src/quest/QuestManager.ts
  48. src/quest/QuestMarkers.ts
  49. src/quest/TutorialQuest.ts
  50. src/data/quests.json
  → Result: DM narration triggers, quest tracking works

SPRINT 7 (Tutorial Flow):
  51. Tutorial intro cinematic sequence
  52. src/npc/NPCManager.ts
  53. src/npc/DialogueSystem.ts
  54. src/npc/Borogrove.ts
  55. src/ui/DialogueUI.ts
  56. src/data/dialogue/borogrove.json
  → Result: Playable tutorial opening with DM narration

SPRINT 8 (Combat & Dice):
  57. src/combat/EncounterManager.ts
  58. src/combat/CombatManager.ts
  59. src/combat/DiceSystem.ts
  60. src/combat/DiceTheatre.ts
  61. src/combat/ActionSystem.ts
  62. src/combat/DamageSystem.ts
  63. src/ui/RadialActionMenu.ts
  64. src/ui/DiceUI.ts
  65. src/ui/CombatLog.ts
  → Result: Full Active Encounter combat with Dice Theatre

SPRINT 9 (Session System):
  66. src/core/SessionManager.ts
  67. src/ui/SessionSummary.ts
  68. Integration with SaveManager and QuestManager
  → Result: Session start/play/end/recap cycle works

SPRINT 10 (Main Menu):
  69. src/ui/MainMenu.ts
  70. src/ui/GameModeSelection.ts
  71. src/ui/OptionsMenu.ts
  72. src/ui/CreditsScreen.ts
  73. src/core/SaveManager.ts
  74. src/ui/PauseMenu.ts
  75. src/ui/LoadingScreen.ts
  → Result: Complete menu system with session-based saves

SPRINT 11 (Polish):
  76. Menu transitions & loading screen polish
  77. Audio integration throughout all systems
  78. Dice Theatre special roll moments
  79. DM Narrator combat flavor text
  80. Performance optimization pass
  81. Bug fixes & playtesting
  → Result: Polished deliverable
```

---

## Technical Notes for Agent Mode

### Performance Budgets
- Draw calls: < 200 per frame
- Triangles: < 500K visible
- Texture memory: minimal (almost all procedural shaders, no texture files)
- Target: 60fps at 1080p on integrated GPU

### Key Three.js Features to Use
- `InstancedMesh` for grass, trees, particles, fungi
- `ShaderMaterial` for all materials (water, terrain, bark, stone, metal, skin, corruption)
- `LOD` objects for trees
- `Raycaster` for mouse picking and ground detection
- `AnimationMixer` for character animations
- `EffectComposer` for post-processing
- `PMREMGenerator` for environment lighting

### Time Dilation Architecture
- `TimeController.gameSpeed` is the single source of truth for game time
- All game systems (physics, animation, AI, particles, audio pitch) read delta from `TimeController.getDelta()`
- Camera and UI are exempt — they always run at real-time for responsiveness
- Combat state machine drives speed changes:
  - Exploration: 1.0
  - Combat between turns: 0.25
  - Player turn (menu open): 0.0
  - Dialogue: 0.25
  - Cinematic: 1.0 (or scripted)
- Speed transitions are lerped over 0.5s for smooth feel

### DM Layer Architecture
- DMDirector is a passive listener, not an active controller
- It subscribes to EventBus events and triggers Narrator/DifficultyTuner/PacingMonitor
- For tutorial: all narration is pre-written in JSON, all difficulty tuning is simple conditional logic
- For future campaigns: Narrator can call an AI API, DifficultyTuner can use more sophisticated models, ImprovEngine can handle open-ended player actions
- The layer is designed to be invisible — the player should feel like the game is telling a good story, not that an algorithm is adjusting numbers

### Session Architecture
- SessionManager wraps the entire play experience
- A session is bounded by narrative logic (quest steps, rests) not arbitrary time
- Save points are always narratively justified
- The "Previously on ASTRA..." recap solves the returning-player problem
- Session summaries provide shareable moments and a sense of progression
- Long rests mechanically equal session boundaries

### State Management
- SceneManager handles macro states: MAIN_MENU, GAME_MODE_SELECT, LOADING, GAMEPLAY, PAUSED, CINEMATIC
- Gameplay sub-states (via EncounterManager): EXPLORATION, DIALOGUE, COMBAT
- State transitions disable/enable relevant systems
- EventBus decouples all systems (quest doesn't directly reference UI, DM doesn't directly reference combat)

### Data-Driven Design
- All D&D data (stats, items, spells, quests, dialogue, narration) in JSON
- Game logic reads from data, never hardcodes values
- Makes it easy to add new content without code changes
- Dialogue trees, quest structures, narration triggers all defined in data files

### Procedural Asset Pipeline
- Zero external 3D models required for Phase 1-4
- Zero external texture files required for Phase 1-4
- All geometry generated via Three.js primitives + noise displacement
- All materials generated via GLSL shaders with procedural noise
- This is not a limitation — it ensures visual consistency (Astra Rule D) and avoids the "generic asset-store appearance" trap (Astra Rule 1)
- Future upgrade path: AI-generated hero models and textures can replace procedural versions incrementally

---

## Astra Visual Style Guide (Summary)

The full style guide is maintained as a separate document. Key rules enforced throughout all phases:

1. **Cinematic stylised realism** — believable, not photographic
2. **Realistic proportions** — no cartoon or anime exaggeration
3. **Strong silhouettes** — readable at gameplay distance
4. **Consistency over complexity** — simpler and matching beats detailed and mismatched
5. **Natural imperfection** — worn edges, uneven surfaces, weathering
6. **Cinematic lighting** — warm sun, cool shadows, volumetric fog
7. **Restrained color** — earthy palette, fantasy elements pop by contrast
8. **Material readability** — wood looks like wood, stone looks like stone
9. **Corruption progression** — subtle → visible → severe, gradual not sudden
10. **Scale contrast** — normal human beside enormous tree creates grandeur

All procedural generation and shader materials must pass the **Final Astra Test**: *"Does this look like it belongs in the same world as everything else in Astra?"*

---

## Tutorial Adventure Reference: The Fouled Stream

**Source:** DMG p122, Adventure for Level 1 Characters

**Situation:** An alien fungus in a cave is polluting the stream that flows past the village of High Ery. The fungus has spawned vile creatures in and around the cave.

**Hook:** The folk of High Ery are noticing fungal growths on the riverbanks and a layer of scum on the water.

**Encounters (tutorial covers first two, future sessions cover the rest):**

1. **The First Fork** — A mile upstream, a stream flows into the river from a little wood. Characters can tell this stream is the source of pollution. *(Phase 3: quest markers guide player here)*

2. **Journey Upstream** — Borogrove, a kindly Treant, meets the characters. He knows the source is inside a cave. He gives them a magic acorn (Potion of Healing + Lesser Restoration if swallowed). *(Phase 3: full dialogue tree)*

3. **Twig Blights** — Six Twig Blights outside the cave. *(Phase 3: first Active Encounter combat)*

4. **Corrupted Cave** — Future session. Shrieker Fungus, Bullywug Warriors, Berserk Bear, Psychic Gray Ooze, Stirges, brain fungus.

5. **Journey Home** — Future session. Return to Borogrove for rewards.

**Tutorial Character:** Level 1 Human Fighter with chain mail, greatsword, Defense fighting style, Second Wind, Savage Attacker, Weapon Mastery (Graze). Full stats in `tutorial-fighter.json`.
```
