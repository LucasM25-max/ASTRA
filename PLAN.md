# MASTER PRODUCTION PLAN: THE FOULED STREAM (SECTOR 01)
## AAA Photorealistic 3D Action-Adventure World Architecture

**Project:** The Fouled Stream (Level 1 Adventure)
**Setting:** World of Greyhawk (Oerth) — Flanaess Borderlands (Upper Ery Watershed)
**Sector Scope:** Sector 01: *The First Fork* and *Journey Upstream*
**Engine & Stack:** Three.js (ES Modules, WebGL2), Node.js Toolchain, Custom AGEO Binary Geometry Container
**Art Style:** Photorealistic PBR — tileable scanned-quality texture sets (albedo, normal, roughness/height/AO), triplanar projection, height-blended material splatting, volumetric atmosphere, physically-based water optics
**Target Experience:** Photorealistic AAA 3D Action-Adventure RPG Environment
**Active Milestone:** Phase P1 Completed & Verified; Transitioning to Phase P2
**Last Updated:** September 2026

---

## 1. Executive Summary & Creative Directives

### 1.1 Core Vision
To construct a photorealistic, immersive, AAA-tier 3D environmental slice for the introductory chapter of the D&D adventure *"The Fouled Stream"*. The environment represents the journey from the idyllic rural waters of the River Ery to the corrupted headwaters entering a dark karst limestone cave.

### 1.2 Non-Negotiable Directives & Boundary Constraints
1. **Zero UI Overlay:** The viewport is completely uncompromised. No health meters, minimaps, compasses, quest pointers, or floating text. All orientation and narrative communication must be 100% diegetic (grounded in the physical world: water discolouration, trampled tracks, audio acoustics, foliage density, light shafts).
2. **Exclusion of Game Mechanics:** This production focuses strictly on world geometry, fluvial geomorphology, physical optics (PBR materials), ecological fidelity, and atmospheric rendering. No dice mechanics, combat systems, inventory management, or stat sheets are implemented.
3. **Exclusion of Later Story Entities:** Neither the Treant nor the magic acorn are present in this sector.
4. **Player Character Decoupled:** The player rig and kinematic locomotion controller exist in the codebase to evaluate scale and traversal, but character authoring is decoupled from world production. The world guarantees continuous collision, step heights ≤ 1.13 m, dry-foot bank paths, and slopes ≤ 20.7°.
5. **No Earth/British Wildlife or Big Fauna:** The setting is Oerth (the World of Greyhawk). All Earth-specific flora and fauna nomenclature (e.g., British robins, badgers, red deer) are replaced with native Flanaess botanical species and micro-fauna. Large wildlife is entirely omitted to preserve the eerie stillness of an uncorrupted forest succumbing to blight.
6. **Tutorial Calibration (~10 Minutes):** The spatial layout, route length (1,593.2 m), sightlines, and environmental pacing are calibrated specifically for a 10-minute linear/semi-open tutorial experience at natural player walking speeds (1.13 m/s walk, 2.45 m/s sprint).

---

## 2. World Setting & Narrative Geomorphology (Greyhawk / Oerth)

### 2.1 Regional Lore & Geography
The world is set within the temperate river basin of the Flanaess, in the borderlands between the Kron Hills and the Gnarley Forest / Celene periphery, draining south towards the Sheldomar basin:
* **The Main Stem (River Ery):** A broad, gently flowing second-order lowland river (19 m to 26 m bankfull width). Its waters are crystalline and tea-tinted from ancient woodland tannins, reflecting the open sky and pastoral meadows.
* **The Contaminated Tributary (The First Fork):** A high-energy, steep-gradient first-order mountain stream (5.0 m to 7.4 m bankfull width) carving through dense deciduous woodland and karst limestone bluffs.
* **The Karst Sump (The Cave Mouth):** A massive natural archway in a sheared limestone bluff (8.6 m span × 4.1 m vertical clearance) through which the contaminated tributary emerges.
* **The Confluence (The First Fork):** The focal landmark where the clear River Ery meets the fouled tributary, creating a distinct visual shear layer and turbidity plume.

### 2.2 Flanaess Botanical Taxonomy & Ecological Zones

| Flanaess Botanical Type | Real-World Functional Analogue | Ecological Niche | Structural Profile |
|---|---|---|---|
| **Flanaess Wet-Alder (*Alnus oerthiensis*)** | Black Alder / Riparian Carr | Channel banks, low flood terraces (M > 0.8) | Multi-stemmed, stilt-root buttresses, 14–23 m tall, high wet tolerance |
| **Gnarley Bronzewood (*Chorisia aenea*)** | Hardwood Oak / Ironwood | High flood terraces, wood interior | Massive sprawling canopy (11–19 m crown), deeply fissured bark, 21–34 m tall |
| **Silver-Bark Beech (*Fagus oerthis*)** | European Beech | Karst limestone bench, well-drained slopes | Smooth grey boles, cathedral canopy, 22–33 m tall |
| **Weeping River-Willow (*Salix lachryma*)** | Weeping Willow | Stream junctions, silt bars, point bars | Pendulous branches touching water surface, 9–16 m tall |
| **Shadow-Top Understorey (*Cornus umbra*)** | Dogwood / Hazel coppice | Wood interior edge, clearing boundaries | Slender stems (0.24–0.44 m bole), dense foliage screens, 11–20 m tall |
| **Blight-Spore Fungus & Bracket Mires** | Bracket Polypores & Slime Mold | Sunken hollows, log jams, splash zones | Viscous ochre coatings, necrotic blackened wood, diegetic indicator of fouling |
| **Riparian Star-Reeds & Sedge** | Scirpus / Carex | Water margin (0.0 m ≤ depth ≤ 0.42 m) | Clustered vertical reeds, stabilization of alluvial banks |

### 2.3 Micro-Fauna & Environmental Audio (Zero Big Fauna)
* **Aquatic Micro-Fauna:** Clean waters of the Ery host schools of translucent *Silverfin Minnows* and surface *River-Striders*. Above the confluence on the Fork, fish corpses lie pinned against pebble shoals, and surface striders disappear.
* **Insect Ecology:** Golden dragonflies and sunlit gnats dance over the pristine river meadow; in the carr, cloud swarms of dark midges hover over still water; near the fouled log jam and cave mouth, parasitic beetles and sluggish marsh flies crawl across decaying slime.
* **Diegetic Acoustics:**
  * Zone 0–2: Gentle river ripple (180 Hz low rumble), wind rustling through broadleaf canopies, distant meadow birdsong.
  * Zone 3 (The Fork): Crisp splashing of shallow rapids meeting the heavy drone of the main river.
  * Zone 4–5: Increasing dampness, hollow dripping from rotting branches, deadened silence where ambient birdcalls abruptly cease.
  * Zone 6–7: Resonant subterranean echo of rushing water inside the limestone karst cavern, low bubbling of viscous foam against rock.

---

## 3. Pacing & Level Design: The ~10-Minute Tutorial Journey

```
[0:00 - 1:30]               [1:30 - 3:15]               [3:15 - 5:00]
VILLAGE MEADOW ----------> RIVER ERY TOWPATH ---------> THE FIRST FORK (CONFLUENCE)
- Open sunlit vista         - Shaded willow corridor     - Hero vista: Wooden Trestle Bridge
- Calibrate locomotion      - River Ery broad flow       - Discover the Turbidity Plume
- Elevation: 89.0 m         - Elevation: 89.5 - 91.0 m   - Confluence water datum: 92.15 m
                                                                  |
                                                                  v
[8:30 - 10:00]              [6:45 - 8:30]               [5:00 - 6:45]
CAVE MOUTH (THE SUMP) <--- THE SUNKEN HOLLOW <--------- ASCENDING SYLVAN TRACK
- Karst limestone crags     - Gnarled deadfall           - Alder log jam & backwater pool
- Cascading foul rapids     - Rotten humus & foam        - Gradient steepens (14° to 20°)
- Cavern portal (8.6x4.1m)  - Dying bankside flora       - Sound of Ery fades
- Elevation: 103.5 m        - Elevation: 98.0 - 100.5 m  - Elevation: 92.5 - 97.0 m
```

### Detailed Environmental Beat Breakdown

#### Beat 1: The Sylvan Water Meadow (0:00 – 1:30)
* **Chainage:** s = 0 m → 180 m (Route Waypoints w00 – w03)
* **Elevation:** 89.0 m → 89.8 m (Gentle alluvial slope < 3°)
* **Atmosphere:** Warm morning light (5200 K), expansive open meadow, knee-high golden fescue and clover, pristine water ripples.
* **Player Role:** Tutorial orientation — mastering camera orbiting, forward walking (1.13 m/s), sprinting (2.45 m/s), jumping over drainage ditches.

#### Beat 2: River Ery Lowland Towpath (1:30 – 3:15)
* **Chainage:** s = 180 m → 450 m (Route Waypoints w04 – w07)
* **Elevation:** 89.8 m → 91.2 m
* **Atmosphere:** Canopy closes overhead into high wet-bank bole woods; dappled light shafts; sound of the broad river laps against alluvial gravel shoals; abandoned punt tied to a wooden stake.

#### Beat 3: The First Fork & The Turbidity Plume (3:15 – 5:00)
* **Chainage:** s = 450 m → 680 m (Route Waypoints w08 – w11)
* **Elevation:** 91.2 m → 92.8 m (Confluence datum 92.15 m)
* **Atmosphere:** Landmark encounter. A timber trestle footbridge (1.8 m deck width) spans the mouth of the tributary. The player observes the meeting of two waters: the crystalline River Ery and the murky, yellow-brown, foam-flecked tributary.

#### Beat 4: Ascending the Sylvan Way (5:00 – 6:45)
* **Chainage:** s = 680 m → 1050 m (Route Waypoints w12 – w15)
* **Elevation:** 92.8 m → 97.5 m (Climb begins, slopes 8° → 16°)
* **Atmosphere:** The valley narrows. Open river sounds are swallowed by dense forest. The path ascends along the western terrace above a natural weir formed by an alder log jam.

#### Beat 5: The Sunken Hollow & Deadfall (6:45 – 8:30)
* **Chainage:** s = 1050 m → 1350 m (Route Waypoints w16 – w19)
* **Elevation:** 97.5 m → 100.8 m
* **Atmosphere:** Severe environmental rot. Bankside reeds are wilted, slimy, and discoloured. Massive gnarled bronzewood trunks lie fallen across the ravine. Pockets of sulfurous ground-haze settle in depression hollows.

#### Beat 6: The Limestone Benches & Cave Portal (8:30 – 10:00)
* **Chainage:** s = 1350 m → 1593 m (Route Waypoints w20 – w23)
* **Elevation:** 100.8 m → 103.5 m (Karst apron at 103.5 m, cliffs rising to 120 m)
* **Atmosphere:** Climactic threshold. The soil gives way to bedded karst limestone bluffs. The tributary churns down a steep limestone step cascade. Directly ahead looms the arching Cave Mouth (8.6 m × 4.1 m).

---

## 4. Current State & Phase Completion Audit

Phase P0 (Metric Greybox World & Hydrological Foundation) and Phase P1 (Ground Truth Shading & Image Texture Pipeline) have been fully built, verified, and committed.

```
========================================================================================
SECTOR 01 METRIC AUDIT
========================================================================================
[Hydrology & Dimensions]
• River Ery Bankfull Width:       19.0 m to 26.0 m (Authored)
• Tributary Fork Bankfull Width:  5.0 m to 7.4 m (Authored)
• Confluence Water Surface Match: Δy = 1.9 cm (92.150 m Ery vs 92.169 m Fork)
• Flow Monotonicity:              Strictly verified; 0 backflow reversals
• Maximum Froude Numbers:         Fork Fr = 0.53, Ery Fr = 0.42 (Subcritical < 0.8)
• Log Jam Hydraulic Rise:         +0.30 m upstream pool containment
• Cave Mouth Portal Dimensions:   8.6 m arch span × 4.1 m crown clearance

[Route & Traversal Physics]
• Total Corridor Length:          1,593.2 m (Target: 1,560 m ± 5%)
• Distance (Village -> Fork):     808.1 m (Target: 800 m)
• Total Elevation Gain:           14.41 m (89.10 m datum -> 103.51 m cave apron)
• Walkable Surface Slopes:        Maximum 20.7° (Threshold: ≤ 21.0°)
• Submerged Route Waypoints:      0 of 129 samples (100% dry-foot path)
• Maximum Traversal Step:         1.13 m (Threshold: < 1.50 m)

[Compiled Geometry & Binary Assets]
• Total Triangles:                595,392 tris
  - Ground Mesh (ground.geo):     204,828 tris (216 fine tiles @ 14m chunk) [23.4 MB]
  - Water Mesh (water.geo):        95,988 tris (Dynamic river rib surface)     [3.8 MB]
  - Standing Scatter (standing.geo): 292,740 tris (Trees, boulders, reeds)    [31.6 MB]
  - Handcrafted Props (props.geo):  1,836 tris (Bridge, weir, punt, fence)   [198 KB]
• Populated Entities:
  - Standing Trees:               6,001 individual instances firmly rooted
  - Karst Boulders:               207 instances on benches and cave apron
  - Tufts & Marginal Reeds:       16,722 instances along water margins
  - Floating/Misaligned Boles:    0 (Strict terrain heightfield snapping)

[Verification & Camera Checkpoints]
• Automated Test Suites:          npm run check -> 100% PASS (check_app, check_deploy, check_world)
• Verification Shots:             23 calibrated camera checkpoints at eye level (1.7 m)
========================================================================================
```

---

## 5. Architectural Deep-Dive: Procedural vs Image Textures

### 5.1 The Hybrid Texturing Pipeline
Pure procedural texturing (runtime noise) and pure unique image texturing (UV unwrapping the whole terrain) both fail AAA RPG criteria:
* **Failure of Pure Procedural:** Excessive fragment shader math, lacks high-frequency photorealistic micro-detail (mineral grain, organic leaf decomposition), looks synthetic.
* **Failure of Unique Image Texturing:** A 1.6 km × 0.6 km terrain mesh cannot be uniquely textured without gigabytes of VRAM.

### 5.2 The Adopted AAA Hybrid Solution
The production pipeline implements **Field-Driven Triplanar Blending of High-Fidelity Tiling Material Sets**:

1. **Tiling Photogrammetric PBR Libraries (2K / 4K):** Five material sets, each with Albedo, Normal, and packed Roughness/Height/AO maps (see Section 8 for complete texture list and generation prompts).
2. **Procedural Splatting & Transition Masks:** Material weights computed from analytical fields (slope, moisture, elevation, fouling) defined in `splat.js`.
3. **Macro-Variation Normal Decal & Height Blending:** Height-map blend transitions prevent muddy linear interpolation. World-space noise breaks tiling repetition.
4. **Analytic Per-Mesh AO & Curvature:** Non-tiling properties baked into vertex attributes or evaluated procedurally.

```
+-----------------------------------------------------------------------------------------+
|                               AAA HYBRID SHADING ARCHITECTURE                           |
+-----------------------------------------------------------------------------------------+
|   +-----------------------+     +-------------------------+     +-------------------+   |
|   | 2K PBR Material Lib   |     | Field Splatting Maps    |     | Mesh Geometry     |   |
|   | - Flanaess Loam       |     | - Slope Field           |     | - Vertex Position |   |
|   | - Karst Limestone     | --> | - Moisture Field        | --> | - Vertex Normal   |   |
|   | - Alluvial Gravel     |     | - Fouling Field         |     | - Curvature / AO  |   |
|   | - Blighted Sludge     |     | - Elevation Zonation    |     +-------------------+   |
|   +-----------------------+     +-------------------------+               |             |
|                \                            /                             |             |
|                 v                          v                              |             |
|       +-----------------------------------------------+                   |             |
|       | Custom Height-Blended Triplanar TerrainShader | <-----------------+             |
|       | - Macro-Noise De-tiling                       |                                 |
|       | - Normal Map Blending (Reoriented Normal Map) |                                 |
|       | - Wetness Darkening & Specular Modifiers      |                                 |
|       +-----------------------------------------------+                                 |
|                                |                                                        |
|                                v                                                        |
|                   +-------------------------+                                           |
|                   | High-End AAA Photoreal  |                                           |
|                   | Viewport Rendering      |                                           |
|                   +-------------------------+                                           |
+-----------------------------------------------------------------------------------------+
```

---

## 6. Phased Implementation Roadmap

```
2026 ROADMAP OVERVIEW
==========================================================================================
Phase P0: Metric Greybox & Hydrological Foundation       [### COMPLETED & VERIFIED ###]
Phase P1: Ground Truth Shading & Image Texture Pipeline  [### COMPLETED & VERIFIED ###]
Phase P2: Photorealistic Foliage & Canopy Architecture   [>> NEXT ACTIVE SPRINT <<]
Phase P3: Dynamic Hydrology, Flow Fields & Turbidity    [PLANNED]
Phase P4: Greyhawk Atmospheric Fog & Micro-Ecology       [PLANNED]
Phase P5: Diegetic Storytelling, Polish & Optimization   [PLANNED]
==========================================================================================
```

---

### Phase P1: Ground Truth Shading & Image Texture Pipeline
**Objective:** Transform the metric greybox terrain into a photorealistic, physically plausible ground surface using the hybrid PBR material pipeline.
**Status: COMPLETE & VERIFIED** — all four tasks delivered and held to account by `tools/check_p1.mjs` (40 checks, part of `npm run check`):
* Task 1.1 delivered as a deterministic procedural PBR library (`src/world/textures.js`): 5 materials × (albedo + normal + packed roughness/height/AO) at 512 px, seamless-tiled and byte-stable across runs, plus a 512 px micro-detail tile.
* Task 1.2 delivered via `MeshStandardMaterial.onBeforeCompile` injection (`src/world/terrainMaterial.js`): height-blended (k = 0.2) triplanar on slopes > 22°, planar on terraces, world-space macro variation, 47 texture fetches.
* Task 1.3 delivered as the capillary fringe (40% albedo darkening, roughness → 0.08 within 0.35 m above water) plus a 256 px wet-mud footprint tile.
* Task 1.4 delivered as the `check_p1.mjs` suite: determinism + seamless-tiling hashes, splat partition-of-unity, biome-ownership probes, ≥ 12 px/cm micro-detail density, VRAM ≤ 1.8 GB.

**Texture Upgrade Path:** The current P1 textures are procedural noise (512 px). Section 8 provides AI-generated photogrammetric-quality replacement prompts for each material. When generated, these replace the procedural `DataTexture`s via `TextureLoader` — no shader changes required, as the material system already accepts external texture maps.

---

### Phase P2: Photorealistic Foliage, Canopy Architecture & Biome Scattering
**Objective:** Replace geometric stand volumes with multi-tier, wind-responsive botanical assets native to the Flanaess.

* **Task 2.1: Flanaess Botanical Asset Production** — Author 3D hero tree models for 5 core species (see Section 8 for complete model and texture prompts).
* **Task 2.2: Three-Tier Level of Detail (LOD) & InstancedMesh Pipeline**
  * **LOD 0 (0–25 m):** Full geometry branch structures (25k tris), wind displacement vertex animation, two-sided leaf cards with Subsurface Scattering (SSS) approximation.
  * **LOD 1 (25–80 m):** Simplified branch cages (3.5k tris), static vertex normal maps.
  * **LOD 2 (80–300 m):** High-resolution octagonal imposter cards or crossed billboards (16 tris) with baked normal and depth maps.
* **Task 2.3: Understorey & Ground Cover Ecosystem** — Dense scatter of forest floor assets (see Section 8).
* **Task 2.4: Subsurface Scattering (SSS) & Canopy Translucency** — Custom leaf foliage shader implementing forward-scattering leaf translucency.

---

### Phase P3: Dynamic Hydrology, Flow Fields & Turbidity Plume
**Objective:** Deliver photorealistic fluvial hydraulics, surface turbulence, foam physics, and the iconic confluence mixing plume.

* **Task 3.1: Precomputed 2D Flow Velocity Vector Field**
* **Task 3.2: Two-Layer Dynamic Water Shader** — Refraction, depth absorption (Beer-Lambert), normal advection, Snell's window & SSR.
* **Task 3.3: The First Fork Confluence Mixing Layer** — Kelvin-Helmholtz shear instability, cross-stream turbidity diffusion.
* **Task 3.4: Dynamic Foam & Aeration Generation** — Procedural white-water foam at rapids, log jam spillway, bank edges.

---

### Phase P4: Greyhawk Environmental Atmosphere, Volumetric Lighting & Micro-Ecology
**Objective:** Establish moody, cinematic visual tone shifting dynamically along the journey.

* **Task 4.1: Dynamic Lighting & Sun Angle Setup** — Morning sun (32° elevation, 115° ESE), 4-split CSM.
* **Task 4.2: Volumetric God Rays & Atmospheric Fog** — Radial light scattering through canopy, localized height fog in hollows.
* **Task 4.3: Diegetic Environmental Color Grading** — Gradual LUT shift from warm golden meadow to cool grey cave mouth.
* **Task 4.4: Micro-Fauna Particle Systems** — Golden sun-gnats, fungal spores, Silverfin Minnows.

---

### Phase P5: Diegetic Storytelling, Polish & Traversal Continuity
**Objective:** Finalize environmental dressing, ensure seamless traversal, lock performance to 60 FPS.

* **Task 5.1: Handcrafted Diegetic Story Props** — See Section 8 for model and texture prompts.
* **Task 5.2: Collision & Traversal Margins**
* **Task 5.3: Performance & Resource Budgets** — ≤ 60 FPS on GTX 1660 / M1, ≤ 85 draw calls, ≤ 1.8 GB VRAM, ≤ 450k visible tris.

---

## 7. Verification Framework & Continuous Quality Assurance

```bash
npm run check           # Full repository validation suite
npm run check:world     # Audits scale, hydrology, walkability, viewpoints
npm run check:deploy    # Audits module graph, relative links, assets
npm run check:p1        # PBR ground shading suite
```

### Core Invariants Maintained Across All Phases:
1. **Hydrological Monotonicity:** Stream surfaces must rise monotonically upstream (dy/ds ≥ 0).
2. **Bankfull Containment:** Water elevation during baseflow must not spill out of the primary channel except in authored backwater pools.
3. **Walkable Corridors:** Route slopes must never exceed 21.0°. No section of the path may be submerged except designated wading shallows.
4. **Eye-Level Visual Quality:** All 23 camera viewpoints must be verified at human eye level (1.7 m) with clear sightlines to focal landmarks.
5. **Clean Zero-Build Deployment:** The repository serves directly as static ES modules with relative paths.

---

## 8. Complete Asset List: Textures, Models & Generation Prompts

Every asset below includes a ready-to-use generation prompt. Textures are tileable PNG images (albedo in sRGB, normal in linear, packed ARM in linear). Models are `.glb` files with UV-unwrapped geometry and PBR materials.

---

### 8.1 TERRAIN PBR MATERIAL SETS (5 materials × 3 maps each = 15 textures)

The existing `splat.js` defines five materials with these tile sizes and IDs. Each needs three texture maps: **Albedo** (RGB, sRGB colour), **Normal** (RG tangent-space), and **Packed ARM** (Red = Roughness, Green = Height, Blue = Ambient Occlusion).

---

#### M1. Flanaess Loam & Forest Litter (`loam`, tile = 4.0 m)

**M1a. Albedo — `terrain_loam_albedo.png` (1024×1024)**

> Seamless tileable photorealistic forest floor soil texture. Rich dark brown loam earth with decomposing autumn leaf litter, small twigs, scattered pebbles, and patches of green moss. Temperate deciduous woodland floor in a fantasy setting. Soft dappled light impression. Muted, natural colour palette: dark chocolate brown soil (#3A2E1E), golden-brown decomposing leaves (#8B7040), occasional grey pebble (#7A7A70), green moss patches (#4A6A30). Photogrammetric quality, seamless in both axes. No man-made objects, no footprints.

**M1b. Normal — `terrain_loam_normal.png` (1024×1024)**

> Matching tangent-space normal map for the forest floor loam texture above. Emphasise the leaf litter relief, small twig impressions, pebble bumps, and moss pad depressions. Moderate normal strength — visible surface detail without extreme bumpiness. Standard OpenGL convention (Y+ up). Seamless tile.

**M1c. Packed ARM — `terrain_loam_arm.png` (1024×1024)**

> Matching packed ARM texture for the forest floor loam. Red channel = roughness (0.85–0.95, slightly rougher on moss, smoother on wet soil). Green channel = height (leaf litter raised, soil recessed, pebbles prominent). Blue channel = ambient occlusion (dark in crevices between leaves and twigs, lighter on exposed surfaces). Seamless tile.

---

#### M2. Alluvial River Gravel & Shingle (`gravel`, tile = 3.0 m)

**M2a. Albedo — `terrain_gravel_albedo.png` (1024×1024)**

> Seamless tileable photorealistic riverbed gravel texture. Rounded river-worn pebbles and coarse sand in a natural stream bed. Mix of warm grey, brown, tan, and occasional ochre-coloured stones. Wet patches darker than dry areas. Some fine sand between larger pebbles. Photogrammetric quality. Colours: medium grey pebbles (#8A8580), warm brown cobbles (#7A6A50), tan sand (#B0A090), damp dark patches (#4A4A40). Seamless in both axes. Fantasy river setting.

**M2b. Normal — `terrain_gravel_normal.png` (1024×1024)**

> Matching tangent-space normal map for the riverbed gravel. Strong relief between individual rounded pebbles — each pebble should read as a distinct smooth dome with crevice channels between them. Higher normal strength than the loam (gravel has more pronounced relief). OpenGL Y+ convention. Seamless tile.

**M2c. Packed ARM — `terrain_gravel_arm.png` (1024×1024)**

> Matching packed ARM for riverbed gravel. Red = roughness (wet pebbles 0.3–0.5, dry sand 0.9+). Green = height (pebble tops raised, sand channels recessed). Blue = AO (deep in inter-pebble crevices). Seamless tile.

---

#### M3. Karst Bedded Limestone (`limestone`, tile = 6.0 m)

**M3a. Albedo — `terrain_limestone_albedo.png` (1024×1024)**

> Seamless tileable photorealistic karst limestone cliff texture. Bedded sedimentary rock with horizontal strata lines, fractured calcite veins, sharp angular cracks, and weathered surface pitting. Pale grey-white stone with darker grey banding. Occasional green lichen patches in deeper cracks. Ancient geological formation suitable for a fantasy cave entrance. Colours: pale limestone (#B0A890), darker strata bands (#808070), calcite veins (#C8C0B0), lichen in cracks (#6A7A50), iron oxide staining (#9A7A60). Seamless tile.

**M3b. Normal — `terrain_limestone_normal.png` (1024×1024)**

> Matching tangent-space normal map for the karst limestone. Emphasise the horizontal bedding planes, vertical fracture joints, calcite vein ridges, and surface pitting/erosion detail. Strong directional normals following the strata. High normal strength (limestone has sharp relief). OpenGL Y+ convention. Seamless tile.

**M3c. Packed ARM — `terrain_limestone_arm.png` (1024×1024)**

> Matching packed ARM for karst limestone. Red = roughness (weathered surface 0.7–0.9, fresh fracture faces 0.4–0.6, wet limestone 0.3). Green = height (strata ridges raised, erosion pits recessed, calcite veins slightly raised). Blue = AO (deep in fracture joints and erosion pits). Seamless tile.

---

#### M4. Blighted Necrotic Mire (`sludge`, tile = 4.0 m)

**M4a. Albedo — `terrain_sludge_albedo.png` (1024×1024)**

> Seamless tileable photorealistic corrupted/blighted mud texture. Viscous, waterlogged dark mud with a sickly yellowish-brown tint indicating magical contamination or pollution. Patches of dark standing water, slimy surface texture, decomposing organic matter, and faint oily sheen. Unhealthy, fouled appearance. Colours: dark muddy brown (#4A3A20), sickly yellow-ochre contamination (#A08030), oily dark patches (#2A2010), faint greenish corruption tinge (#6A7A40), slimy highlights (#8A7A50). Seamless tile. Fantasy blight/pollution aesthetic.

**M4b. Normal — `terrain_sludge_normal.png` (1024×1024)**

> Matching tangent-space normal map for the blighted mud. Gentle, undulating relief — viscous mud with shallow ripple impressions, organic matter lumps, and slimy surface texture. Low-to-moderate normal strength (mud is soft). OpenGL Y+ convention. Seamless tile.

**M4c. Packed ARM — `terrain_sludge_arm.png` (1024×1024)**

> Matching packed ARM for blighted mud. Red = roughness (very low 0.08–0.20 for wet slimy mud, higher 0.6+ for dried crust patches). Green = height (organic lumps raised, puddles recessed). Blue = AO (minimal, mud is fairly flat). Seamless tile.

---

#### M5. Riparian Sedge Turf (`turf`, tile = 3.0 m)

**M5a. Albedo — `terrain_turf_albedo.png` (1024×1024)**

> Seamless tileable photorealistic water-margin grass and sedge turf texture. Dense short grass and sedge growing along a riverbank — fibrous root structure at the base transitioning to green grass blades above. Slightly damp appearance. Natural temperate grassland. Colours: rich green grass (#4A7A35), damp brown soil base (#5A4A30), yellow-green grass tips (#8AA040), occasional small wildflower (#B0A040), darker wet patches. Seamless tile. Fantasy riparian setting.

**M5b. Normal — `terrain_turf_normal.png` (1024×1024)**

> Matching tangent-space normal map for the sedge turf. Fine grass blade impressions creating a directional fibrous normal pattern. Moderate strength — enough to give the grass surface visible directionality when lit. OpenGL Y+ convention. Seamless tile.

**M5c. Packed ARM — `terrain_turf_arm.png` (1024×1024)**

> Matching packed ARM for sedge turf. Red = roughness (0.80–0.95, grass is rough). Green = height (grass blades slightly raised, soil base recessed). Blue = AO (subtle darkening at grass root base). Seamless tile.

---

#### M6. Near-Field Micro-Detail (tile = 0.4 m)

**M6a. Albedo — `terrain_detail_albedo.png` (512×512)**

> Seamless tileable photorealistic forest floor close-up detail texture. Dense leaf litter, decomposing twigs, tiny mushroom caps, moss patches, small insects, dark humus soil, and individual grass blades. Extreme close-up ground detail for near-camera rendering. Natural colours: dark earth (#3A3020), brown leaves (#6A5A3A), green moss (#4A6A30), tiny mushroom caps (#C0A050), individual grass blades (#5A7A30). Seamless tile.

**M6b. Normal — `terrain_detail_normal.png` (512×512)**

> Matching tangent-space normal map for the micro-detail. Very fine relief: individual leaf edges, twig profiles, mushroom cap curves, grass blade ridges. High-frequency detail. OpenGL Y+ convention. Seamless tile.

**M6c. Packed ARM — `terrain_detail_arm.png` (512×512)**

> Matching packed ARM for the micro-detail. Red = roughness (wet leaves 0.3, dry twigs 0.8, moss 0.9). Green = height (twigs and mushrooms raised, soil recessed). Blue = AO (dense between individual leaves and twigs). Seamless tile.

---

### 8.2 WATER TEXTURES (Phase P3)

---

#### W1. Clean River Ery Water Normal Map

**`water_ery_normal.png` (512×512)**

> Seamless tileable photorealistic clean river water surface normal map. Gentle ripple pattern with concentric and directional wave forms. Crystal-clear mountain river surface — subtle, not stormy. Low-amplitude, high-frequency detail mixed with broader swells. Tangent-space normal map, OpenGL Y+ convention. Seamless tile.

---

#### W2. Fouled Tributary Water Normal Map

**`water_fork_normal.png` (512×512)**

> Seamless tileable photorealistic turbid/polluted river water surface normal map. More agitated, chaotic ripple pattern than clean water — faster flow, rougher surface. Murky, contaminated mountain stream. Irregular wave forms suggesting suspended sediment. Tangent-space normal map, OpenGL Y+ convention. Seamless tile.

---

#### W3. Foam & Aeration Texture

**`water_foam.png` (512×512)**

> Seamless tileable photorealistic white-water foam texture. Aerated river foam — white bubbles, swirling patterns, translucent edges where foam meets clear water. For rapids, waterfall bases, and bank-edge foam accumulation. White (#E8E8E0) to translucent. RGBA with alpha channel for foam density. Seamless tile.

---

#### W4. Water Caustics Pattern

**`water_caustics.png` (512×512)**

> Seamless tileable photorealistic underwater caustic light pattern. Bright refracted light patterns dancing on a riverbed — the sunlight pattern seen through shallow, clear moving water. Soft, organic, overlapping bright lines on a darker base. For projecting onto the riverbed beneath clear Ery water. White-bright (#FFFFFF) on medium grey (#808080). Seamless tile, animated via UV scrolling in shader.

---

### 8.3 TREE BARK TEXTURES (5 species, each with Albedo + Normal + ARM = 15 textures)

---

#### TB1. Wet-Alder Bark (14–23 m multi-stemmed riparian tree)

**TB1a. Albedo — `bark_alder_albedo.png` (1024×1024)**

> Seamless tileable photorealistic wet alder tree bark texture. Dark olive-brown bark with deep vertical fissures, peeling papery bark layers, and patches of green moss and damp darkening. Multi-stemmed riparian tree — the bark should look constantly damp. Colours: dark olive-brown (#3B4A2A), deep fissure shadow (#1A2A10), green moss patches (#4A6A30), papery peeling bark (#6A6A50), damp dark streaks (#2A3A20). Seamless tile for cylinder UV wrapping.

**TB1b. Normal — `bark_alder_normal.png` (1024×1024)**

> Matching tangent-space normal map for wet alder bark. Deep vertical fissure channels, peeling bark layer edges, moss pad bumps, papery bark curl relief. Strong normal strength for dramatic bark detail. OpenGL Y+ convention. Seamless tile.

**TB1c. Packed ARM — `bark_alder_arm.png` (1024×1024)**

> Matching packed ARM for wet alder bark. Red = roughness (wet bark 0.4, dry papery bark 0.8, moss 0.95). Green = height (fissure ridges raised, channels recessed, peeling bark slightly raised). Blue = AO (deep in fissures, moderate under peeling bark). Seamless tile.

---

#### TB2. Gnarley Bronzewood Bark (21–34 m massive ancient hardwood)

**TB2a. Albedo — `bark_bronzewood_albedo.png` (1024×1024)**

> Seamless tileable photorealistic massive ancient hardwood tree bark texture. Deeply fissured, gnarled bark with a distinctive warm copper-bronze tint suggesting the "bronzewood" name. Thick ridges, deep vertical cracks, and ancient weathered texture. Scale should feel imposing — this is the largest tree in the forest. Colours: warm copper-brown (#5C4033), bronze highlights (#7A5A40), deep shadow in fissures (#2A1A10), weathered grey patches (#6A6A60), lichen spots (#6A7A50). Seamless tile.

**TB2b. Normal — `bark_bronzewood_normal.png` (1024×1024)**

> Matching tangent-space normal map for bronzewood bark. Very deep fissures, thick ridged bark plates, ancient weathering texture. High normal strength — this bark has dramatic relief. OpenGL Y+ convention. Seamless tile.

**TB2c. Packed ARM — `bark_bronzewood_arm.png` (1024×1024)**

> Matching packed ARM for bronzewood bark. Red = roughness (0.75–0.95, very rough ancient bark). Green = height (thick ridges raised, deep fissures recessed). Blue = AO (very dark in deep fissures, moderate under overhangs). Seamless tile.

---

#### TB3. Silver-Bark Beech Bark (22–33 m smooth-barked cathedral tree)

**TB3a. Albedo — `bark_beech_albedo.png` (1024×1024)**

> Seamless tileable photorealistic European beech tree bark texture. Characteristically smooth, elephantine bark with horizontal lenticel marks and subtle grey-silver colour. Occasional dark moss patches at the base and shallow wound marks. Elegant, cathedral-tree quality. Colours: smooth pale grey (#8A8A7A), silver highlights (#A0A090), dark horizontal lenticel lines (#6A6A60), slight green moss at base (#6A7A50), occasional dark wound scar (#4A3A30). Seamless tile.

**TB3b. Normal — `bark_beech_normal.png` (1024×1024)**

> Matching tangent-space normal map for beech bark. Subtle relief — smooth bark with fine horizontal lenticel texture, shallow wound marks, gentle moss pad bumps. Low-to-moderate normal strength (beech bark is famously smooth). OpenGL Y+ convention. Seamless tile.

**TB3c. Packed ARM — `bark_beech_arm.png` (1024×1024)**

> Matching packed ARM for beech bark. Red = roughness (smooth bark 0.5–0.6, moss 0.9, wound areas 0.7). Green = height (very subtle — lenticels barely raised, wounds slightly recessed). Blue = AO (minimal, smooth bark has little self-shadowing). Seamless tile.

---

#### TB4. Weeping River-Willow Bark (9–16 m riverside tree)

**TB4a. Albedo — `bark_willow_albedo.png` (1024×1024)**

> Seamless tileable photorealistic weeping willow tree bark texture. Smooth pale golden-tan bark with fine vertical grooves and subtle horizontal cracking. Younger, more flexible bark than oak — slightly fibrous texture. Often damp near the base from river proximity. Colours: warm tan (#7A6B50), golden highlights (#9A8A60), fine dark grooves (#5A4A30), damp darkening at base (#4A3A20). Seamless tile.

**TB4b. Normal — `bark_willow_normal.png` (1024×1024)**

> Matching tangent-space normal map for willow bark. Fine vertical groove texture, subtle fibre relief, gentle horizontal cracking. Moderate normal strength. OpenGL Y+ convention. Seamless tile.

**TB4c. Packed ARM — `bark_willow_arm.png` (1024×1024)**

> Matching packed ARM for willow bark. Red = roughness (0.6–0.8, moderate). Green = height (grooves slightly recessed, fibre ridges raised). Blue = AO (subtle in grooves). Seamless tile.

---

#### TB5. Dead/Snag Bark (6–12 m deadfall trees)

**TB5a. Albedo — `bark_dead_albedo.png` (1024×1024)**

> Seamless tileable photorealistic dead/rotting tree bark texture. Grey-brown dead wood with deep cracks, peeling flakes, fungal bracket growths, and necrotic blackened patches. The bark of a tree killed by environmental blight. Colours: grey-brown dead wood (#4A3A2A), necrotic black (#1A1A10), ochre-yellow fungus spots (#C4A035), peeling grey flakes (#6A6A50), greenish-black rot (#2A3010). Seamless tile.

**TB5b. Normal — `bark_dead_normal.png` (1024×1024)**

> Matching tangent-space normal map for dead bark. Deep cracks, peeling flake edges, fungal bracket dome shapes, rotting pitting texture. Strong normal strength (dead bark has dramatic relief). OpenGL Y+ convention. Seamless tile.

**TB5c. Packed ARM — `bark_dead_arm.png` (1024×1024)**

> Matching packed ARM for dead bark. Red = roughness (0.8–0.95, very rough dead wood, fungus smoother at 0.5). Green = height (flake edges raised, rot pits recessed, fungus brackets raised). Blue = AO (very deep in cracks and rot cavities). Seamless tile.

---

### 8.4 TREE FOLIAGE / LEAF CARD TEXTURES (5 species, Albedo + Alpha each = 5 textures)

These textures are applied to canopy geometry as transparent leaf cards — the standard technique for photorealistic foliage in games.

---

#### TF1. Wet-Alder Foliage

**`foliage_alder.png` (1024×1024, RGBA)**

> Photorealistic alder branch with leaves on a transparent (alpha) background. A dense cluster of dark olive-green alder leaves — small, oval, serrated-edge leaves on visible branch stems. Mix of mature dark green leaves and younger yellow-green leaves. Some leaves slightly translucent where backlit. Natural, not symmetrical — organic scatter of leaves and thin branches. The alpha channel should mask out everything except the leaves and branches. For use as a foliage card applied to canopy geometry in a 3D forest scene. Slight autumn tinge on a few leaves (golden-brown).

---

#### TF2. Gnarley Bronzewood Foliage

**`foliage_bronzewood.png` (1024×1024, RGBA)**

> Photorealistic dense broadleaf oak-like canopy foliage on a transparent background. Rich deep emerald-green leaves — large, broad, slightly lobed leaves characteristic of an ancient hardwood. Dense overlapping cluster creating deep shadow in the interior and bright green at the edges. Visible branch structure at the base. Some leaves catching sunlight (bright green) while interior leaves are in shadow (very dark green). Natural organic scatter. Alpha masks non-leaf areas. For ancient forest canopy.

---

#### TF3. Silver-Bark Beech Foliage

**`foliage_beech.png` (1024×1024, RGBA)**

> Photorealistic beech tree foliage on a transparent background. Bright spring-green beech leaves — small, elliptical, wavy-edged leaves with visible parallel veins. Lighter and more translucent than oak foliage. The canopy should feel luminous and airy — beech cathedral canopies are famous for their filtered green light. Some leaves are backlit and appear bright yellow-green. Delicate branch structure visible. Alpha masks non-leaf areas.

---

#### TF4. Weeping River-Willow Foliage

**`foliage_willow.png` (1024×1024, RGBA)**

> Photorealistic weeping willow leaf strand on a transparent background. Long, narrow, lance-shaped leaves arranged on drooping pendulous branches — the characteristic cascading curtain of a weeping willow. Pale yellow-green leaves, slightly translucent. The texture should be tall and narrow (suitable for a vertical hanging strip rather than a broad canopy card). Graceful, flowing, trailing. Alpha masks non-leaf areas.

---

#### TF5. Dead/Snag Foliage (Sparse Dead Leaves)

**`foliage_dead.png` (1024×1024, RGBA)**

> Photorealistic dead tree canopy remnant on a transparent background. Sparse, skeletal broken branches with a few remaining brown, curled, dead leaves. Mostly transparent — the branches and leaves should cover only 20–30% of the texture area. Some fungal bracket shapes on the branches. Grey-brown branches, dark brown curled dead leaves, ochre fungus spots. For deadfall and rotting snag canopy geometry. Alpha should be mostly transparent.

---

### 8.5 VEGETATION & GROUND COVER TEXTURES (8 textures)

---

#### VG1. Reed & Sedge Card

**`veg_reeds.png` (512×1024, RGBA)**

> Photorealistic riparian reed and sedge plant cluster on a transparent background. Tall vertical reed blades (3–5 distinct blades) with seed heads at the top. Yellow-green stems (#8AA040) transitioning to brown seed heads (#6A5A30). For water-margin vegetation placed along riverbanks. Natural slight lean and curvature. Alpha masks background. Suitable for vertical billboard/strip geometry.

---

#### VG2. Fern Frond

**`veg_fern.png` (512×512, RGBA)**

> Photorealistic single fern frond on a transparent background. Lush deep green fern with curled fiddle-head tip and alternating pinnae (leaflets). Forest floor detail vegetation. Colours: deep green (#3A6A30) with lighter green tips (#5A8A40), brown stem (#4A3A20). Natural curvature. Alpha masks background. For scattered ground cover in forest areas.

---

#### VG3. Meadow Grass Tuft

**`veg_grass.png` (256×512, RGBA)**

> Photorealistic grass tuft on a transparent background. A small cluster of tall grass blades — golden-green, slightly dry meadow grass suitable for an open sunlit field. Colours: golden-green (#8A9A40) with yellow tips (#B0A040). For meadow areas. 5–8 blades with natural curvature. Alpha masks background. For billboard grass scattered across the village meadow.

---

#### VG4. Forest Floor Moss Patch

**`veg_moss.png` (512×512, RGBA)**

> Photorealistic moss pad texture on a transparent background. Dense, low-growing moss with tiny fronds and sporophytes. Rich deep green (#3A5A28) to brighter green edges (#5A7A38). For placement on rocks, logs, and tree bases in damp forest areas. Flat, ground-hugging form. Alpha masks background.

---

#### VG5. Blight Fungus Patch

**`veg_fungus.png` (512×512, RGBA)**

> Photorealistic fungal growth cluster on a transparent background. 2–4 bracket fungus caps and slime mold patches — viscid, unhealthy-looking. Vivid ochre-yellow centres (#C4A035) with dark necrotic edges (#2A1A0A) and slight greenish slime (#6A7A40). For placement on dead trees and rotting logs near the fouled stream. Should look damp and slightly glistening. Alpha masks background.

---

#### VG6. Wildflower Cluster (Meadow)

**`veg_wildflower.png` (256×256, RGBA)**

> Photorealistic small wildflower cluster on a transparent background. 3–5 small fantasy wildflowers — white clover-like blooms, small golden buttercup-type flowers, and purple self-heal spikes. Natural meadow flowers for the sunlit village meadow. For scattered ground detail among the grass. Alpha masks background.

---

#### VG7. Fallen Leaf Litter Overlay

**`veg_leaf_litter.png` (512×512, RGBA)**

> Photorealistic scattered fallen leaf overlay on a transparent background. Individual fallen leaves — brown, golden, and olive-coloured deciduous leaves lying on the ground. For adding detail to the forest floor on top of the loam terrain texture. Natural scatter pattern, not dense — just a few individual leaves visible. Alpha masks background.

---

#### VG8. Ivy / Climbing Vine

**`veg_ivy.png` (512×1024, RGBA)**

> Photorealistic climbing ivy vine texture on a transparent background. Dense ivy leaves climbing along a vertical surface — mix of mature dark green leaves and younger lighter leaves, with visible stems and tendrils. For applying to tree trunks and cliff faces to add ecological detail. Dark green (#2A5A20) to medium green (#4A7A30). Alpha masks background.

---

### 8.6 SKY & ATMOSPHERE TEXTURES (3 textures)

---

#### SK1. Sky Gradient Dome

**`sky_gradient.png` (2048×1024)**

> Photorealistic panoramic sky gradient for a temperate fantasy river valley on a clear morning. Horizontal equirectangular projection. Warm peach-gold horizon (#E8B87A) transitioning through soft blue (#7BABC4) to deep sky blue (#4A7AA0) at the zenith. Subtle wispy cirrus clouds near the horizon. No heavy cloud cover — mostly clear with atmospheric haze. Fantasy RPG quality — slightly more saturated and dramatic than a real photograph. No sun disc (the directional light handles that).

---

#### SK2. God Ray / Light Shaft Texture

**`godray.png` (256×512)**

> Soft volumetric light shaft texture for forest god rays. A single shaft of warm golden-white light filtering through a gap in a forest canopy. Bright warm centre (#FFF8E0) fading through soft gold (#E0C080) to transparent edges. Soft, diffused, ethereal quality. For use as an additive-blended billboard quad positioned in canopy gaps. RGBA with alpha for falloff.

---

#### SK3. Fog / Haze Sprite

**`fog_sprite.png` (256×256)**

> Soft atmospheric fog/haze sprite texture. A gentle, diffused cloud of pale grey-white mist. Soft radial falloff from slightly opaque centre to fully transparent edges. For use as a billboard sprite scattered in low-lying hollows and over the river surface. RGBA, very subtle opacity. Cool blue-grey tint (#C0CCD4).

---

### 8.7 PROPELLING & STRUCTURE TEXTURES (8 textures)

---

#### PR1. Weathered Wood (Bridge, Punt, Fence)

**`prop_wood_albedo.png` (1024×1024)**

> Seamless tileable photorealistic weathered outdoor wood plank texture. Grey-brown weathered timber with visible grain, knot holes, moss patches, and rain staining. For wooden structures (footbridge, punt, fence) in a damp riverside fantasy setting. Colours: grey-brown weathered surface (#6A5A40), darker grain lines (#4A3A28), green moss patches (#4A6A30), rain drip staining (#3A3020), exposed lighter wood where surface has worn (#8A7A60). Seamless tile.

**`prop_wood_normal.png` (1024×1024)**

> Matching tangent-space normal map for weathered wood. Wood grain ridges, knot holes, plank seam edges, moss bump detail. Moderate normal strength. OpenGL Y+ convention. Seamless tile.

**`prop_wood_arm.png` (1024×1024)**

> Matching packed ARM for weathered wood. Red = roughness (weathered surface 0.8, wet areas 0.3, worn areas 0.6). Green = height (grain ridges raised, knot holes recessed). Blue = AO (in grain grooves and knot holes). Seamless tile.

---

#### PR2. Wicker / Basket Weave (Creel)

**`prop_wicker_albedo.png` (512×512)**

> Seamless tileable photorealistic wicker basket weave texture. Traditional woven willow or reed basket material — interlocking natural fibre strands. Tan-brown colour (#8A7A40) with darker shadows between weave gaps (#5A4A30). For the abandoned fisherman's creel basket. Natural, handcrafted appearance. Seamless tile.

---

#### PR3. Rope / Fishing Line

**`prop_rope_albedo.png` (256×256)**

> Seamless tileable photorealistic twisted natural fibre rope texture. Thin, weathered hemp or flax fishing line — slightly frayed, damp, grey-brown. For the abandoned fishing line draped over willow roots. Colours: grey-tan (#7A7060) with darker twist shadows (#4A4030). Seamless tile.

---

#### PR4. Limestone Block (Cave Mouth, Cairn)

**`prop_limestone_block_albedo.png` (1024×1024)**

> Seamless tileable photorealistic rough-cut limestone block texture. More uniform than the terrain limestone — this is for shaped/dressed stone (cairn waymarkers, cave mouth portal framing). Pale grey (#B0A890) with subtle strata banding, tool marks, and lichen patches. Clean enough to read as "placed stone" vs natural cliff. Seamless tile.

---

#### PR5. Dried Mud / Campfire Ground

**`prop_dried_mud_albedo.png` (512×512)**

> Seamless tileable photorealistic dried mud and ash ground texture. A small campsite ground — cracked dry mud, scattered ash, charcoal fragments, and trampled earth. For the abandoned fisherman's camp area. Colours: dry grey-brown mud (#7A6A50), dark ash/charcoal (#2A2A20), cracked lighter mud (#A09080). Seamless tile.

---

#### PR6. River Sand Bar

**`prop_sand_albedo.png` (512×512)**

> Seamless tileable photorealistic fine river sand texture. Smooth, damp river sand with subtle ripple marks from water retreat. Pale tan (#C0B090) with darker damp patches (#A09070). For sandbars and point bars along the River Ery. Clean, fine-grained. Seamless tile.

---

#### PR7. Iron-Stained Stone (Weir, Stake)

**`prop_stained_stone_albedo.png` (512×512)**

> Seamless tileable photorealistic iron-oxide stained stone texture. Grey stone with heavy reddish-brown iron staining from mineral-rich water contact. For the wooden weir structure and river stonework. Colours: grey base (#7A7A70), reddish-brown iron stain (#8A4A20), dark wet patches (#3A3A30). Seamless tile.

---

#### PR8. Carved/Rough-Hewn Wood (Fence Posts, Stakes)

**`prop_hewn_wood_albedo.png` (512×512)**

> Seamless tileable photorealistic rough-hewn/chopped wood texture. Axe-cut timber with visible tool marks, splinters, and raw exposed wood grain. Darker and rougher than the weathered plank wood — this is freshly split structural timber. Colours: raw wood (#8A7A50), dark bark edges (#3A2A18), axe-mark ridges (#6A5A38), exposed fresh wood (#A09070). Seamless tile.

---

### 8.8 3D MODELS — TREES (5 species × 3 LODs = 15 models)

---

#### T1. Flanaess Wet-Alder (*Alnus oerthiensis*) — Multi-stemmed riparian carr tree, 14–23 m

**T1-LOD0 (`tree_alder_lod0.glb`, ~15,000–25,000 tris)**

> Photorealistic 3D model of a multi-stemmed wet alder tree, 18 m tall (scale: 1 unit = 1 m). 3–4 slightly tilted cylinder trunks (12-sided, smooth) emerging from a shared root flare with exposed stilt-root buttresses — characteristic of alders growing in waterlogged riverbank soil. Trunk diameter 0.42–0.62 m. Irregular broad canopy of 3–5 foliage masses formed by branch structure ending in leaf-card planes. UV-unwrapped: trunks UV-mapped to the wet-alder bark texture set (TB1), canopy leaf-card planes UV-mapped to the alder foliage texture (TF1). Branch architecture should be visible through the canopy — not a solid green blob. Export as .glb with PBR materials (MeshStandardMaterial compatible).

**T1-LOD1 (`tree_alder_lod1.glb`, ~3,000–5,000 tris)**

> Simplified wet alder: 2 cylinder trunks (8-sided) with reduced branch structure and 2–3 canopy foliage masses. Same UV mapping to bark and canopy textures. Visible branch structure still reads at medium distance. Export as .glb.

**T1-LOD2 (`tree_alder_lod2.glb`, ~16 tris)**

> Billboard impostor: two crossed quads (16 tris) with a pre-rendered alder tree silhouette baked into the texture. Should capture the multi-stemmed, broad-canopy alder shape. RGBA texture with alpha cutout. Export as .glb.

---

#### T2. Gnarley Bronzewood (*Chorisia aenea*) — Massive ancient hardwood, 21–34 m

**T2-LOD0 (`tree_bronzewood_lod0.glb`, ~20,000–30,000 tris)**

> Photorealistic 3D model of a massive ancient bronzewood tree, 28 m tall. Single thick trunk (16-sided, smooth) with deeply fissured bark — the bark geometry itself should have pronounced ridges and channels. Trunk diameter 0.65–1.10 m. Wide sprawling canopy: 5–7 large branch limbs extending outward to form a broad dome crown (11–19 m spread). The largest, most imposing tree in the scene. UV-unwrapped: trunk mapped to bronzewood bark textures (TB2), canopy leaf-cards mapped to bronzewood foliage (TF2). Multiple layers of foliage at different depths. Export as .glb.

**T2-LOD1 (`tree_bronzewood_lod1.glb`, ~4,000–6,000 tris)**

> Simplified bronzewood: thick trunk (10-sided) with 3–4 major branch stubs and 2–3 canopy masses. Same UV mapping. Still reads as a massive tree. Export as .glb.

**T2-LOD2 (`tree_bronzewood_lod2.glb`, ~16 tris)**

> Billboard impostor: broad dome silhouette. Wider than tall. Rich green canopy, brown trunk base. Export as .glb.

---

#### T3. Silver-Bark Beech (*Fagus oerthis*) — Tall columnar cathedral tree, 22–33 m

**T3-LOD0 (`tree_beech_lod0.glb`, ~18,000–25,000 tris)**

> Photorealistic 3D model of a tall columnar beech tree, 30 m tall. Smooth thin trunk (12-sided) — characteristically straight and elephantine. Trunk diameter 0.45–0.80 m. High-set canopy (crown begins at ~15 m) with the trunk fully visible below — the "cathedral" effect. Canopy is 3–4 merged foliage masses forming a broad dome above the trunk line. UV-unwrapped: trunk to beech bark textures (TB3), canopy to beech foliage (TF3). Branch structure visible through translucent leaf cards. Export as .glb.

**T3-LOD1 (`tree_beech_lod1.glb`, ~3,000–5,000 tris)**

> Simplified beech: thin straight trunk (8-sided), single high canopy mass. Same UV mapping. Export as .glb.

**T3-LOD2 (`tree_beech_lod2.glb`, ~16 tris)**

> Billboard impostor: tall, thin trunk with high dome canopy. Distinctive beech silhouette. Export as .glb.

---

#### T4. Weeping River-Willow (*Salix lachryma*) — Drooping riverside tree, 9–16 m

**T4-LOD0 (`tree_willow_lod0.glb`, ~12,000–20,000 tris)**

> Photorealistic 3D model of a weeping willow tree, 13 m tall. Short thick trunk (10-sided) branching early into long, flexible, drooping branches that hang down to ground or water level. Canopy geometry should be a teardrop/inverted dome shape created by layered curtain-like branch structures. UV-unwrapped: trunk to willow bark textures (TB4), hanging foliage strips to willow foliage (TF4). The key feature is the cascading curtain of leaves — should read as "weeping" at any distance. For stream junctions and silt bars. Export as .glb.

**T4-LOD1 (`tree_willow_lod1.glb`, ~2,000–4,000 tris)**

> Simplified willow: trunk + 4–6 drooping branch strips with foliage cards. Same UV mapping. Still reads as weeping. Export as .glb.

**T4-LOD2 (`tree_willow_lod2.glb`, ~16 tris)**

> Billboard impostor: distinctive drooping teardrop silhouette. Export as .glb.

---

#### T5. Deadfall & Rotting Snag — Blight-killed standing dead tree, 6–12 m

**T5-LOD0 (`tree_dead_lod0.glb`, ~5,000–10,000 tris)**

> Photorealistic 3D model of a dead/broken tree, 9 m tall. Irregular trunk with a jagged broken top (angled, not smooth — the tree died and broke, not pruned). 2–3 broken branch stubs protruding at angles. Bark partially peeled and fallen. Optional: flat disc bracket-fungus shapes on the trunk side, small shelf mushrooms. UV-unwrapped: trunk to dead bark textures (TB5), sparse canopy remnants to dead foliage (TF5). Should look forlorn, corrupted by the fouled stream's blight. Export as .glb.

**T5-LOD1 (`tree_dead_lod1.glb`, ~800–1,500 tris)**

> Simplified dead tree: trunk cylinder (6-sided) with broken top and 1–2 branch stubs. Same UV mapping. Export as .glb.

**T5-LOD2 (`tree_dead_lod2.glb`, ~8 tris)**

> Simple crossed quads: thin dead silhouette. Mostly transparent. Export as .glb.

---

### 8.9 3D MODELS — ROCKS & BOULDERS (3 models)

---

#### R1. Karst Limestone Boulder (1–3 m, 207 instances on benches and cave apron)

**`rock_boulder.glb` (~500–1,500 tris)**

> Photorealistic 3D model of a karst limestone boulder, 2 m average diameter. Irregular angular fractured shape — use a subdivided icosahedron (3 subdivisions) with vertex displacement to create natural limestone fracture planes. Sharp angular edges where rock has fractured along bedding planes. Flat-ish top surface with slight weathering and lichen. UV-unwrapped to the karst limestone terrain texture (M3) — the boulder should share the same material as the cliff faces for visual consistency. Subtle strata banding visible. Export as .glb with PBR material.

---

#### R2. River Cobble Cluster (0.2–0.8 m per stone, scattered along shingle banks)

**`rock_cobbles.glb` (~200–600 tris)**

> Photorealistic 3D model of a cluster of 5–7 rounded river cobbles. Each stone is a smooth, water-worn ellipsoid (low-poly sphere, 8–12 faces, squashed vertically). Mix of sizes (0.2–0.8 m). UV-unwrapped to the river gravel terrain texture (M2). Should look like a natural scatter of streambed pebbles. For shingle banks and the riverbed. Export as .glb.

---

#### R3. Karst Cliff Face Block (4–8 m, used for cave mouth framing and limestone benches)

**`rock_cliff.glb` (~1,000–3,000 tris)**

> Photorealistic 3D model of a karst limestone cliff section, 6 m tall × 4 m wide × 2 m deep. Rectangular block with fractured angular faces, vertical joint planes, and horizontal bedding planes. The front face should show natural limestone fracture with strata visible. UV-unwrapped to the karst limestone terrain texture (M3). For the cave mouth portal framing and limestone bench edges. The cliff should look like a piece of natural geological formation, not a cut block. Export as .glb.

---

### 8.10 3D MODELS — PROPS & STRUCTURES (5 models)

---

#### P1. Timber Trestle Footbridge (over the First Fork, 1.8 m deck width)

**`prop_bridge.glb` (~800–2,000 tris)**

> Photorealistic 3D model of a rustic timber trestle footbridge spanning 6 m. Simple medieval/fantasy construction: two pairs of vertical timber posts (0.15 m square cross-section) set into the streambed, supporting horizontal bearer beams, topped by a plank deck (1.8 m wide). Single rail on each side (single horizontal timber on short uprights). All timber is rough-hewn, weathered grey-brown. UV-unwrapped to the weathered wood textures (PR1). Moss and damp staining on the lower posts where they meet the waterline. For a fantasy rural setting — functional, not decorative. No nails or metal hardware visible (wooden peg joints). Export as .glb with PBR material.

---

#### P2. Stranded River Punt (flat-bottomed boat on sandbar)

**`prop_punt.glb` (~300–800 tris)**

> Photorealistic 3D model of a small flat-bottomed river punt/boat, 3.5 m long × 1.2 m wide. Simple construction: flat bottom plank, slightly flared sides rising 0.3 m, squared-off stern, gently tapered bow. Single wooden bench seat (thwart) across the middle. A wooden punt pole (2.5 m long, 0.04 m diameter) rests across the gunwales. The boat appears long-abandoned: dried fouled mud along the waterline, slight warping, one plank slightly sprung. UV-unwrapped to weathered wood texture (PR1) with additional mud/dirt vertex colour or overlay. For the sandbar below the confluence. Export as .glb.

---

#### P3. Broken Log Jam Weir (natural dam across the tributary)

**`prop_weir.glb` (~1,000–2,500 tris)**

> Photorealistic 3D model of a log jam/weir structure, 5 m wide × 2 m tall × 2 m deep. A natural accumulation of 5–8 fallen logs (0.3–0.6 m diameter, 4–6 m long, 10-sided cylinders) stacked and wedged across the stream channel. One log visibly cracked/split with exposed wood interior. Gaps between logs where water would pour through. Mud, moss, and debris packed between the logs. UV-unwrapped to dead bark texture (TB5) for the logs, weathered wood (PR1) for any cut surfaces. Should look like a natural blockage that has partially failed. For the upstream backwater pool area. Export as .glb.

---

#### P4. Abandoned Fisherman's Campsite (3 prop pieces as one .glb)

**`prop_campsite.glb` (~400–1,000 tris total)**

> Photorealistic 3D model set of an abandoned riverside campsite, containing three objects as separate mesh groups within one .glb file:
>
> **(a) Wooden Stool** (~60 tris): Simple three-legged stool, 0.45 m seat height, 0.3 m square seat. Rough-hewn legs and plank seat. Weathered grey-brown. UV to weathered wood (PR1).
>
> **(b) Overturned Wicker Creel** (~120 tris): A fishing basket, 0.4 m diameter, 0.3 m tall. Traditional woven wicker construction, overturned on its side. Contents spilled: a few small stones, a tangled line. UV to wicker texture (PR2). Colours: tan-brown natural fibre.
>
> **(c) Fishing Line on Willow Root** (~30 tris): A thin fishing line (0.005 m diameter, 2 m long) draped over a submerged willow root, trailing into the water. UV to rope texture (PR3). Grey-brown, frayed.
>
> For waypoint w06 on the riverbank. Should feel long-abandoned — months, not days. Export as .glb.

---

#### P5. Stone Cairn Waymarker (along the path)

**`prop_cairn.glb` (~100–300 tris)**

> Photorealistic 3D model of a stone cairn waymarker, 0.8 m tall. A stack of 4–5 flat irregular limestone slabs (each 0.15–0.25 m thick, 0.3–0.5 m across) decreasing in size from base to top. Slightly weathered, with green moss on north-facing surfaces and lichen patches. UV-unwrapped to limestone block texture (PR4) with moss overlay. For marking the path through the forest. Should look hand-placed but aged — centuries old. Export as .glb.

---

### 8.11 3D MODELS — VEGETATION SCATTER (6 models)

---

#### V1. Reed & Sedge Cluster (water margin, 16,722 instances)

**`veg_reeds_cluster.glb` (~100–300 tris)**

> Photorealistic 3D model of a cluster of 8–12 riparian reed blades. Each blade is a thin vertical quad or pair of triangles (2–4 tris each), 0.5–1.2 m tall. UV-unwrapped to the reed/sedge texture (VG1). Slight random lean and twist per blade. The cluster should look natural — not evenly spaced. For water-margin vegetation along both rivers. Will be instanced 16,722 times. Wind sway applied via vertex shader (not embedded in geometry). Export as .glb.

---

#### V2. Fern Frond Cluster (forest floor)

**`veg_fern_cluster.glb` (~80–200 tris)**

> Photorealistic 3D model of a cluster of 4–6 fern fronds. Each frond is a flat tapered shape (8–12 tris) radiating from a central point, angled upward and outward at 30–60°. UV-unwrapped to fern texture (VG2). 0.3–0.6 m total height. For forest floor detail in shaded areas. Export as .glb.

---

#### V3. Moss Pad (on rocks and logs)

**`veg_moss_pad.glb` (~20–50 tris)**

> Photorealistic 3D model of a moss pad: a slightly domed disc, 0.2–0.5 m diameter, 0.05 m thick. UV-unwrapped to moss texture (VG3). For placement on boulders, log surfaces, and tree bases. Conforms to the underlying surface shape. Export as .glb.

---

#### V4. Meadow Grass Tuft (open meadow)

**`veg_grass_tuft.glb` (~30–80 tris)**

> Photorealistic 3D model of a grass tuft: 6–10 thin vertical blade quads arranged in a cluster, 0.2–0.4 m tall. UV-unwrapped to grass texture (VG3). For the open sunlit village meadow (Beat 1). Billboard-style blades that face the camera. Export as .glb.

---

#### V5. Blight Fungus Patch (on deadfall and rotting wood)

**`veg_fungus_patch.glb` (~40–100 tris)**

> Photorealistic 3D model of a fungal growth cluster: 3–5 bracket fungus caps and slime mold patches. Each bracket is a half-disc or shelf shape (8–12 tris). UV-unwrapped to fungus texture (VG5). 0.1–0.3 m across. For placement on deadfall trees and rotting logs near the fouled stream. Should look viscid, damp, and unhealthy. Export as .glb.

---

#### V6. Fallen Log (forest floor clutter)

**`prop_fallen_log.glb` (~100–300 tris)**

> Photorealistic 3D model of a fallen dead log, 3 m long × 0.3 m diameter. Simple tapered cylinder (10-sided) with one broken/splintered end. Optional: 1–2 broken branch stubs, moss patches on the upper surface. UV-unwrapped to dead bark texture (TB5) with moss overlay (VG3). For forest floor scatter. Export as .glb.

---

### 8.12 3D MODELS — MICRO-FAUNA (3 models)

---

#### F1. Golden Dragonfly (animated, meadow insect)

**`fauna_dragonfly.glb` (~50–100 tris)**

> Photorealistic 3D model of a golden dragonfly, 0.06 m wingspan. Elongated slender body (2-sided quad, 0.03 m long), 4 translucent wing planes (each a thin quad, angled outward). UV-unwrapped for hand-painted golden body texture and translucent iridescent wing texture. Colours: golden-green body (#A0B040), translucent wing membranes with faint iridescence. Include a 2-frame wing flap animation clip named "flap" (wings rotate ±20° around body axis, 30 Hz cycle). For swarming over the meadow in Beat 1. Export as .glb with embedded animation.

---

#### F2. Silverfin Minnow (template, school fish)

**`fauna_minnow.glb` (~20–50 tris)**

> Photorealistic 3D model of a small Silverfin Minnow, 0.05 m body length. Elongated fusiform body (diamond/wedge shape, 4–8 tris for the body, small triangle tail fin). UV-unwrapped for a photorealistic silver fish texture — bright silver flanks (#B0B8C0) with pale belly (#D0D0C8), faint lateral line. For instancing in darting schools (20–50 instances per school) in the clean Ery water. No animation embedded — movement will be driven procedurally. Export as .glb.

---

#### F3. Fish Corpse (pinned against pebble shoal above confluence)

**`fauna_fish_corpse.glb` (~30–60 tris)**

> Photorealistic 3D model of a dead fish, 0.06 m body length. Same basic body shape as the minnow but slightly splayed — mouth open, fins splayed, body slightly bloated. UV-unwrapped for a dull grey-brown death colouration texture (#6A6050 body, #A0A090 pale belly, slightly cloudy eye). Static, no animation. For placing pinned against pebble shoals in the fouled Fork water above the confluence — a diegetic indicator of contamination. Export as .glb.

---

### 8.13 3D MODELS — PARTICLE SYSTEM TEMPLATES (2 models)

---

#### PS1. Gnat/Insect Swarm Particle

**`particle_gnat.glb` (~4 tris)**

> Tiny crossed-quad billboard (4 tris), UV-mapped to a bright golden-yellow soft dot on transparent background. For instancing as swarming gnat particles over meadow clearings. Very small (0.01 m). RGBA texture with soft glow falloff. Export as .glb.

---

#### PS2. Fungal Spore Particle

**`particle_spore.glb` (~4 tris)**

> Tiny crossed-quad billboard (4 tris), UV-mapped to a dark ochre-amber soft dot on transparent background. For instancing as drifting spore particles near deadfall and the cave mouth. Very small (0.005 m). RGBA texture with soft falloff. Export as .glb.

---

## 9. Asset Count Summary

| Category | Textures | Models | Triangle Budget (LOD 0, all instances) |
|---|---|---|---|
| Terrain PBR (5 materials × 3 maps) | 15 | — | — |
| Terrain Micro-Detail (1 × 3 maps) | 3 | — | — |
| Water Textures | 4 | — | — |
| Tree Bark (5 species × 3 maps) | 15 | — | — |
| Tree Foliage (5 species × 1 RGBA) | 5 | — | — |
| Vegetation Textures | 8 | — | — |
| Sky & Atmosphere Textures | 3 | — | — |
| Prop Textures | 8 | — | — |
| **Total Textures** | **61** | — | — |
| Trees (5 species × 3 LODs) | — | 15 | ~3.6M tris (6001 trees × avg 600) |
| Rocks & Boulders | — | 3 | ~50K tris (207 instances) |
| Props & Structures | — | 5 | ~3K tris |
| Vegetation Scatter | — | 6 | ~170K tris (16,722+ instances) |
| Micro-Fauna | — | 3 | ~2K tris (instances) |
| Particle Templates | — | 2 | ~200 tris (instances) |
| **Total Models** | — | **34** | **~3.8M tris (LOD0), ~900K mixed LOD** |

---

## 10. Summary Table: Phase Milestones & Deliverables

| Phase | Title | Primary Deliverable | Status |
|---|---|---|---|
| **P0** | **Metric Greybox World** | Vector geography, analytical relief, binary geometry, 23 checkpoints, collision engine, automated audit suite. | **100% COMPLETE** |
| **P1** | **Ground Truth Shading** | 5-material PBR library (procedural), height-blended triplanar shaders, field splatting, capillary wetness, texel density audit. | **100% COMPLETE** |
| **P1U** | **Texture Upgrade** | Replace 5 procedural PBR sets + micro-detail with 6 AI-generated photogrammetric-quality texture sets (18 textures). No shader changes — drop-in replacement of `DataTexture` with `TextureLoader`. | **PLANNED** |
| **P2** | **Photorealistic Foliage** | 5 species Oerth botanical models (15 LOD assets), bark + foliage textures (20 textures), wind vertex animation, SSS canopy shaders, understorey scatter (6 assets). | **PLANNED** |
| **P3** | **Dynamic Hydrology** | 2D vector flow fields, Snell/Fresnel water shader, confluence mixing plume, foam textures, caustics. | **PLANNED** |
| **P4** | **Atmosphere & Ecology** | Volumetric sun shafts, height-fog, dynamic LUT colour grading, sky dome texture, micro-fauna particles (3 fauna + 2 particle assets). | **PLANNED** |
| **P5** | **Story Dressing & Polish** | 5 diegetic prop models + 8 prop textures, capsule collision polish, 60 FPS lock, cave portal transition. | **PLANNED** |