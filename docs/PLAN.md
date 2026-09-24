# MASTER PRODUCTION PLAN: THE FOULED STREAM (SECTOR 01)
## AAA Photorealistic 3D Action-Adventure World Architecture

**Project:** The Fouled Stream (Level 1 Adventure)  
**Setting:** World of Greyhawk (Oerth) — Flanaess Borderlands (Upper Ery Watershed)  
**Sector Scope:** Sector 01: *The First Fork* and *Journey Upstream*  
**Engine & Stack:** Three.js (ES Modules, WebGL2 / WebGPU-ready PBR), Node.js Toolchain, Custom AGEO Binary Geometry Container  
**Target Experience:** Photorealistic AAA 3D Action-Adventure RPG Environment  
**Active Milestone:** Phase P0 Completed & Verified; Transitioning to Phase P1  
**Last Updated:** September 2026

---

## 1. Executive Summary & Creative Directives

### 1.1 Core Vision
To construct a photorealistic, immersive, AAA-tier 3D environmental slice for the introductory chapter of the D&D adventure *"The Fouled Stream"*. The environment represents the journey from the idyllic rural waters of the River Ery to the corrupted headwaters entering a dark karst limestone cave.

### 1.2 Non-Negotiable Directives & Boundary Constraints
1. **Zero UI Overlay:** The viewport is completely uncompromised. No health meters, minimaps, compasses, quest pointers, or floating text. All orientation and narrative communication must be 100% diegetic (grounded in the physical world: water discoloration, trampled tracks, audio acoustics, foliage density, light shafts).
2. **Exclusion of Game Mechanics:** This production focuses strictly on world geometry, fluvial geomorphology, physical optics (PBR materials), ecological fidelity, and atmospheric rendering. No dice mechanics, combat systems, inventory management, or stat sheets are implemented.
3. **Exclusion of Later Story Entities:** Neither the Treant nor the magic acorn are present in this sector.
4. **Player Character Decoupling:** The player rig and kinematic locomotion controller exist in the codebase to evaluate scale and traversal, but character authoring is decoupled from world production. The world guarantees continuous collision, step heights $\le 1.13\text{ m}$, dry-foot bank paths, and slopes $\le 20.7^\circ$.
5. **No Earth/British Wildlife or Big Fauna:** The setting is Oerth (the World of Greyhawk). All Earth-specific flora and fauna nomenclature (e.g., British robins, badgers, red deer) are replaced with native Flanaess botanical species and micro-fauna. Large wildlife is entirely omitted to preserve the eerie stillness of an uncorrupted forest succumbing to blight.
6. **Tutorial Calibration (~10 Minutes):** The spatial layout, route length ($1,593.2\text{ m}$), sightlines, and environmental pacing are calibrated specifically for a 10-minute linear/semi-open tutorial experience at natural player walking speeds ($1.13\text{ m/s}$ walk, $2.45\text{ m/s}$ sprint).

---

## 2. World Setting & Narrative Geomorphology (Greyhawk / Oerth)

### 2.1 Regional Lore & Geography
The world is set within the temperate river basin of the Flanaess, in the borderlands between the Kron Hills and the Gnarley Forest / Celene periphery, draining south towards the Sheldomar basin:
* **The Main Stem (River Ery):** A broad, gently flowing second-order lowland river ($19\text{ m}$ to $26\text{ m}$ bankfull width). Its waters are crystalline and tea-tinted from ancient woodland tannins, reflecting the open sky and pastoral meadows.
* **The Contaminated Tributary (The First Fork):** A high-energy, steep-gradient first-order mountain stream ($5.0\text{ m}$ to $7.4\text{ m}$ bankfull width) carving through dense deciduous woodland and karst limestone bluffs.
* **The Karst Sump (The Cave Mouth):** A massive natural archway in a sheared limestone bluff ($8.6\text{ m}$ span $\times 4.1\text{ m}$ vertical clearance) through which the contaminated tributary emerges.
* **The Confluence (The First Fork):** The focal landmark where the clear River Ery meets the fouled tributary, creating a distinct visual shear layer and turbidity plume.

### 2.2 Flanaess Botanical Taxonomy & Ecological Zones
Earth-specific flora is substituted with indigenous Flanaess species exhibiting authentic structural archetypes:

| Flanaess Botanical Type | Real-World Functional Analogue | Ecological Niche | Structural Profile |
| :--- | :--- | :--- | :--- |
| **Flanaess Wet-Alder (*Alnus oerthiensis*)** | Black Alder / Riparian Carr | Channel banks, low flood terraces ($M > 0.8$) | Multi-stemmed, stilt-root buttresses, $14\text{--}23\text{ m}$ tall, high wet tolerance |
| **Gnarley Bronzewood (*Chorisia aenea*)** | Hardwood Oak / Ironwood | High flood terraces, wood interior | Massive sprawling canopy ($11\text{--}19\text{ m}$ crown), deeply fissured bark, $21\text{--}34\text{ m}$ tall |
| **Silver-Bark Beech (*Fagus oerthis*)** | European Beech | Karst limestone bench, well-drained slopes | Smooth grey boles, cathedral canopy, $22\text{--}33\text{ m}$ tall |
| **Weeping River-Willow (*Salix lachryma*)** | Weeping Willow | Stream junctions, silt bars, point bars | Pendulous branches touching water surface, $9\text{--}16\text{ m}$ tall |
| **Shadow-Top Understorey (*Cornus umbra*)** | Dogwood / Hazel coppice | Wood interior edge, clearing boundaries | Slender stems ($0.24\text{--}0.44\text{ m}$ bole), dense foliage screens, $11\text{--}20\text{ m}$ tall |
| **Blight-Spore Fungus & Bracket Mires** | Bracket Polypores & Slime Mold | Sunken hollows, log jams, splash zones | Viscous ochre coatings, necrotic blackened wood, diegetic indicator of fouling |
| **Riparian Star-Reeds & Sedge** | Scirpus / Carex | Water margin ($0.0\text{ m} \le \text{depth} \le 0.42\text{ m}$) | Clustered vertical reeds, stabilization of alluvial banks |

### 2.3 Micro-Fauna & Environmental Audio (Zero Big Fauna)
To maintain the atmosphere of escalating corruption without relying on big animals:
* **Aquatic Micro-Fauna:** Clean waters of the Ery host schools of translucent *Silverfin Minnows* and surface *River-Striders*. Above the confluence on the Fork, fish corpses lie pinned against pebble shoals, and surface striders disappear.
* **Insect Ecology:** Golden dragonflies and sunlit gnats dance over the pristine river meadow; in the carr, cloud swarms of dark midges hover over still water; near the fouled log jam and cave mouth, parasitic beetles and sluggish marsh flies crawl across decaying slime.
* **Diegetic Acoustics:**
  * Zone 0–2: Gentle river ripple ($180\text{ Hz}$ low rumble), wind rustling through broadleaf canopies, distant meadow birdsong.
  * Zone 3 (The Fork): Crisp splashing of shallow rapids meeting the heavy drone of the main river.
  * Zone 4–5: Increasing dampness, hollow dripping from rotting branches, deadened silence where ambient birdcalls abruptly cease.
  * Zone 6–7: Resonant subterranean echo of rushing water inside the limestone karst cavern, low bubbling of viscous foam against rock.

---

## 3. Pacing & Level Design: The ~10-Minute Tutorial Journey

The terrain, sightlines, and path geometry are engineered to guide player exploration naturally without artificial boundaries or UI navigation markers.

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
* **Chainage:** $s = 0\text{ m} \to 180\text{ m}$ (Route Waypoints `w00` – `w03`)
* **Elevation:** $89.0\text{ m} \to 89.8\text{ m}$ (Gentle alluvial slope $< 3^\circ$)
* **Atmosphere:** Warm morning light ($5200\text{ K}$), expansive open meadow, knee-high golden fescue and clover, pristine water ripples.
* **Player Role:** Tutorial orientation — mastering camera orbiting, forward walking ($1.13\text{ m/s}$), sprinting ($2.45\text{ m/s}$), jumping over drainage ditches.

#### Beat 2: River Ery Lowland Towpath (1:30 – 3:15)
* **Chainage:** $s = 180\text{ m} \to 450\text{ m}$ (Route Waypoints `w04` – `w07`)
* **Elevation:** $89.8\text{ m} \to 91.2\text{ m}$
* **Atmosphere:** Canopy closes overhead into high wet-bank bole woods; dappled light shafts; sound of the broad river laps against alluvial gravel shoals; abandoned punt tied to a wooden stake.
* **Player Role:** Linear path following along the natural river levee; visual framing directs the eye eastward upstream.

#### Beat 3: The First Fork & The Turbidity Plume (3:15 – 5:00)
* **Chainage:** $s = 450\text{ m} \to 680\text{ m}$ (Route Waypoints `w08` – `w11`)
* **Elevation:** $91.2\text{ m} \to 92.8\text{ m}$ (Confluence datum $92.15\text{ m}$)
* **Atmosphere:** Landmark encounter. A timber trestle footbridge ($1.8\text{ m}$ deck width) spans the mouth of the tributary. The player observes the meeting of two waters: the crystalline River Ery and the murky, yellow-brown, foam-flecked tributary. The south bank is visibly silted with yellowish particulate.
* **Player Role:** Diegetic call to action — the player crosses the bridge or approaches the shingle spit, discovers the plume, and turns north-east to track the contamination to its source.

#### Beat 4: Ascending the Sylvan Way (5:00 – 6:45)
* **Chainage:** $s = 680\text{ m} \to 1050\text{ m}$ (Route Waypoints `w12` – `w15`)
* **Elevation:** $92.8\text{ m} \to 97.5\text{ m}$ (Climb begins, slopes $8^\circ \to 16^\circ$)
* **Atmosphere:** The valley narrows. The open river sounds are swallowed by dense forest. The path ascends along the western terrace above a natural weir formed by an alder log jam. An upstream backwater pool ($+0.30\text{ m}$ hydrostatic rise) traps brown scum and dead branches.
* **Player Role:** Traversal across rugged ground, navigating roots, climbing natural earthen terraces.

#### Beat 5: The Sunken Hollow & Deadfall (6:45 – 8:30)
* **Chainage:** $s = 1050\text{ m} \to 1350\text{ m}$ (Route Waypoints `w16` – `w19`)
* **Elevation:** $97.5\text{ m} \to 100.8\text{ m}$
* **Atmosphere:** Severe environmental rot. Bankside reeds are wilted, slimy, and discolored. Massive gnarled bronzewood trunks lie fallen across the ravine. Pockets of sulfurous ground-haze settle in depression hollows.
* **Player Role:** Navigating between slippery mudslides, stepping across boulder clusters, maintaining high ground along the bank shoulder.

#### Beat 6: The Limestone Benches & Cave Portal (8:30 – 10:00)
* **Chainage:** $s = 1350\text{ m} \to 1593\text{ m}$ (Route Waypoints `w20` – `w23`)
* **Elevation:** $100.8\text{ m} \to 103.5\text{ m}$ (Karst apron at $103.5\text{ m}$, cliffs rising to $120\text{ m}$)
* **Atmosphere:** Climactic threshold. The soil gives way to bedded karst limestone bluffs. The tributary churns down a steep limestone step cascade. Directly ahead looms the arching Cave Mouth ($8.6\text{ m} \times 4.1\text{ m}$), from which the dark, heavily fouled current rushes out in full force.
* **Player Role:** Final approach to the cavern entrance, setting the stage for Chapter 2 (Underground).

---

## 4. Current State & Phase P0 Completion Audit

Phase P0 (Metric Greybox World & Hydrological Foundation) has been fully built, verified, and committed to git branch `arena/01a0d463-astra`.

```
========================================================================================
SECTOR 01 METRIC AUDIT (Phase P0 Status: 100% COMPLETE & PASSING)
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

### 5.1 Query Resolution: The Hybrid Texturing Pipeline
In response to earlier architectural evaluations, pure procedural texturing and pure unique image texturing both fail AAA RPG criteria when applied naively:
* **Failure of Pure Procedural (Runtime Noise):** Excessive fragment shader math (FBM, voronoi) causes GPU thermal throttling, lacks high-frequency photorealistic micro-details (mineral grain, organic leaf decomposition), and looks synthetic.
* **Failure of Unique Image Texturing (UV Unwrapping):** A $1.6\text{ km} \times 0.6\text{ km}$ terrain mesh cannot be uniquely textured without requiring gigabytes of VRAM or suffering horrific texel density ($< 0.05\text{ px/cm}$).

### 5.2 The Adopted AAA Hybrid Solution
The production pipeline implements a **Field-Driven Triplanar Blending of High-Fidelity Tiling Material Sets**:
1. **Tiling Photogrammetric PBR Libraries (2K / 4K):**
   * *Material A (Flanaess Loam & Forest Litter):* Albedo, Normal, Roughness, Height.
   * *Material B (Alluvial River Gravel & Shingle):* Rounded pebbles, damp silt, sand.
   * *Material C (Karst Bedded Limestone):* Fractured sedimentary strata, sharp calcite fissures.
   * *Material D (Damp Mud & Blighted Sludge):* Viscous, low-roughness ($R < 0.15$), ochre-stained mud.
   * *Material E (Riparian Sedge Turf):* Short dense moss, fibrous roots, organic humus.
2. **Procedural Splatting & Transition Masks (Driven by Mathematical Fields):**
   * Material weights are computed continuously using the exact analytical fields from `src/world/relief.js`:
     $$\text{Weight}_{\text{Rock}} = \text{smoothstep}(18^\circ, 32^\circ, \text{slope})$$
     $$\text{Weight}_{\text{Gravel}} = \text{smoothstep}(0.8\text{ m}, 0.0\text{ m}, d_{\text{water}}) \cdot (1 - \text{smoothstep}(0.15, 0.45, \text{fouling}))$$
     $$\text{Weight}_{\text{BlightSludge}} = \text{smoothstep}(0.2, 0.7, \text{fouling}) \cdot \text{moisture}^{1.5}$$
     $$\text{Weight}_{\text{Loam}} = 1.0 - \sum \text{Weights}$$
3. **Macro-Variation Normal Decal & Height Blending:**
   * Height-map blend transitions prevent muddy linear interpolation. Materials pop cleanly along pebble edges and rock cracks.
   * A low-frequency world-space noise map ($f = 0.005\text{ m}^{-1}$) breaks up tiling repetition across long viewing distances.
4. **Analytic Per-Mesh AO & Curvature:**
   * Non-tiling properties (ambient occlusion in rock hollows, curvature on limestone overhangs) are baked directly into vertex attributes or evaluated procedurally.

```
+-----------------------------------------------------------------------------------------+
|                               AAA HYBRID SHADING ARCHITECTURE                           |
+-----------------------------------------------------------------------------------------+
|                                                                                         |
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
Phase P1: Ground Truth Shading & Image Texture Pipeline  [>> NEXT ACTIVE SPRINT <<]
Phase P2: Photorealistic Foliage & Canopy Architecture   [PLANNED]
Phase P3: Dynamic Hydrology, Flow Fields & Turbidity    [PLANNED]
Phase P4: Greyhawk Atmospheric Fog & Micro-Ecology       [PLANNED]
Phase P5: Diegetic Storytelling, Polish & Optimization   [PLANNED]
==========================================================================================
```

---

### Phase P1: Ground Truth Shading & Image Texture Pipeline
**Objective:** Transform the metric greybox terrain into a photorealistic, physically plausible ground surface using the hybrid PBR material pipeline.

* **Task 1.1: Tiling Material Library Integration**
  * Acquire and author 5 calibrated 2K/4K PBR material texture sets (Flanaess forest loam, river shingle gravel, bedded karst limestone, waterlogged riparian silt, blighted necrotic mire).
  * Format textures with packed channels: RGB Albedo, RG Normal, Red Roughness + Green Height + Blue AO packed (ARM texture maps).
* **Task 1.2: Terrain Splatting & Height-Blend Shader**
  * Develop custom Three.js `ShaderMaterial` implementing triplanar projection on slopes $> 22^\circ$ and planar top-down projection on terraces $< 22^\circ$.
  * Integrate height-blending algorithm ($h_{\text{eff}} = h_i + \text{weight}_i$) with a contrast factor $k = 0.2$ to produce realistic stone-over-mud embedding.
  * Integrate world-space macro variation noise to prevent repetitive pattern recognition along the $1.6\text{ km}$ corridor.
* **Task 1.3: Diegetic Water Margin & Moisture Absorption**
  * Dynamic capillary fringe: Wetness shader logic darkening albedo by $40\%$ and reducing roughness to $0.08$ within $0.35\text{ m}$ elevation above the water surface.
  * Dynamic mud footprint response on moist soils ($M > 0.7$).
* **Task 1.4: Validation & Quality Control**
  * Automated texel density audit: Maintain $\ge 12.0\text{ pixels/cm}$ within a $15\text{ m}$ radius of the player camera.
  * Framerate benchmark on reference WebGL2 profile: $\ge 60\text{ FPS}$ at $1080\text{p}$.

---

### Phase P2: Photorealistic Foliage, Canopy Architecture & Biome Scattering
**Objective:** Replace geometric stand volumes with multi-tier, wind-responsive botanical assets native to the Flanaess.

* **Task 2.1: Flanaess Botanical Asset Production**
  * Author 3D hero tree models for 5 core species:
    1. *Wet-Alder:* Exposed stilt roots, peeling bark, jagged leaves.
    2. *Bronzewood:* Gnarled sprawling limbs, copper-tinted bark, heavy dense foliage.
    3. *Silver-Bark Beech:* Tall columnar trunks, smooth elephantine bark, high canopy.
    4. *Weeping Willow:* Slender drooping branches, fine leaves trailing into the water.
    5. *Deadfall & Rotting Snags:* Hollowed boles, broken limb scars, fungal brackets.
* **Task 2.2: Three-Tier Level of Detail (LOD) & InstancedMesh Pipeline**
  * **LOD 0 ($0\text{--}25\text{ m}$):** Full geometry branch structures ($25\text{k}\text{ tris}$), wind displacement vertex animation, two-sided leaf cards with Subsurface Scattering (SSS) approximation.
  * **LOD 1 ($25\text{--}80\text{ m}$):** Simplified branch cages ($3.5\text{k}\text{ tris}$), static vertex normal maps.
  * **LOD 2 ($80\text{--}300\text{ m}$):** High-resolution octagonal imposter cards or crossed billboards ($16\text{ tris}$) with baked normal and depth maps.
* **Task 2.3: Understorey & Ground Cover Ecosystem**
  * Dense scatter of forest floor assets: ferns, star-reeds, moss pads, decomposing twigs, limestone pebble scree.
  * Distance-culling and chunked spatial partitions matching the existing 216 fine tiles.
* **Task 2.4: Subsurface Scattering (SSS) & Canopy Translucency**
  * Custom leaf foliage shader implementing forward-scattering leaf translucency when the sun is viewed through the canopy (the "green cathedral" effect).

---

### Phase P3: Dynamic Hydrology, Flow Fields & Turbidity Plume
**Objective:** Deliver photorealistic fluvial hydraulics, surface turbulence, foam physics, and the iconic confluence mixing plume.

* **Task 3.1: Precomputed 2D Flow Velocity Vector Field**
  * Generate a high-resolution $2\text{D}$ velocity texture $(u_x, u_z)$ along both stream centrelines:
    $$v(s, d) = v_{\text{max}}(s) \cdot \left(1 - \left(\frac{2d}{W(s)}\right)^2\right)$$
  * Velocity ranges: River Ery ($0.45\text{--}0.85\text{ m/s}$); First Fork rapids ($1.2\text{--}2.4\text{ m/s}$).
* **Task 3.2: Two-Layer Dynamic Water Shader**
  * **Refraction & Depth Absorption:** Beer-Lambert Law light attenuation:
    $$I(z) = I_0 \cdot e^{-\alpha_{\lambda} z}$$
    * Ery Water: Low attenuation $\alpha = (0.08, 0.04, 0.02)$, pristine transparent aqua-green.
    * Fouled Water: High attenuation $\alpha = (0.65, 0.55, 0.20)$, muddy brownish-yellow.
  * **Normal Advection:** Dual-scrolling tangent-space normal maps warped along the local flow velocity vector, resetting phase periodically to prevent texture stretching.
  * **Snell's Window & Screen-Space Reflections (SSR):** Accurate Fresnel equation reflections of bankside willows and sky.
* **Task 3.3: The First Fork Confluence Mixing Layer**
  * Implement the physical Kelvin-Helmholtz shear instability at the confluence:
    * Swirling vortices where the fast, dirty Fork enters the slow, clear Ery.
    * Gradual cross-stream diffusion: Turbidity plume hugging the southern bank of the Ery for $180\text{ m}$ downstream before full lateral mixing.
* **Task 3.4: Dynamic Foam & Aeration Generation**
  * Procedural white-water foam accumulation at:
    * The boulder rapids upstream of the fork.
    * The alder log jam spillway (backwater weir).
    * Edge contact foam line along water-bank intersection using the camera depth buffer.

---

### Phase P4: Greyhawk Environmental Atmosphere, Volumetric Lighting & Micro-Ecology
**Objective:** Establish a moody, cinematic, AAA visual tone that shifts dynamically as the player journeys deeper into the fouled forest.

* **Task 4.1: Dynamic Lighting & Sun Angle Setup**
  * Morning sun angle ($32^\circ$ elevation, azimuth $115^\circ$ ESE) casting long, dramatic tree trunk shadows across the river and walking trail.
  * Directional Cascaded Shadow Maps (CSM) tuned across 4 splits ($0\text{--}8\text{ m}$, $8\text{--}25\text{ m}$, $25\text{--}80\text{ m}$, $80\text{--}250\text{ m}$).
* **Task 4.2: Volumetric God Rays & Atmospheric Fog**
  * Radial light scattering (god rays) filtering through the dense bronzewood and alder canopy.
  * Localized volumetric height fog: Dense ground mist pooling in low-lying hollows and hovering over the cold river surface at dawn.
* **Task 4.3: Diegetic Environmental Color Grading**
  * Gradual LUT color shift along route chainage $s$:
    * $s = 0\text{ m}$ (Meadow): Saturated golden-greens, vibrant sky blue, warm color balance ($5500\text{ K}$).
    * $s = 700\text{ m}$ (Log Jam): Desaturated greens, olive tones, slight greenish-yellow tint in shadowed hollows.
    * $s = 1550\text{ m}$ (Cave Mouth): Oppressive cool slate grey, pale sickly lichen yellow, murky amber highlights on water foam.
* **Task 4.4: Micro-Fauna Particle Systems**
  * GPU compute particles:
    * Swarms of golden sun-gnats over meadow clearings.
    * Sluggish fungal spores floating near the rotting deadfall and cave mouth.
    * Schools of *Silverfin Minnows* dynamically darting away from character footsteps in shallow water.

---

### Phase P5: Diegetic Storytelling, Polish & Traversal Continuity
**Objective:** Finalize environmental dressing, ensure seamless traversal, lock performance to 60 FPS, and prepare for Chapter 2 integration.

* **Task 5.1: Handcrafted Diegetic Story Props**
  * The Abandoned Fisherman's Camp (near waypoint `w06`): Weathered wooden stool, overturned wicker creel, abandoned line caught in submerged willow roots.
  * The Stranded River Punt: Waterlogged flat-bottom boat lodged on the sandbar below the confluence, fouled mud dried along its hull.
  * The Broken Weir: Structural failure on the log jam, displaying claw marks or stress fractures indicating non-natural blockage.
* **Task 5.2: Collision & Traversal Margins**
  * Analytical capsule collision response against tree trunks and karst boulders.
  * Step-up ledge smoothing: Guarantee all elevation changes $< 0.4\text{ m}$ allow smooth foot traversal without clipping or snagging.
* **Task 5.3: Performance & Resource Budgets**
  * Lock solid $60\text{ FPS}$ on baseline hardware (NVIDIA GTX 1660 / Apple M1 or modern equivalent).
  * Draw calls per frame: $\le 85$ (achieved via InstancedMesh and texture atlasing).
  * VRAM consumption: $\le 1.8\text{ GB}$ total for textures, geometry, and framebuffers.
  * Geometry budget per frame: $\le 450\text{k}$ visible triangles.

---

## 7. Verification Framework & Continuous Quality Assurance

To guarantee that photorealism does not come at the cost of stability or scale fidelity, all future phases must adhere to the automated audit suite (`npm run check`):

```bash
# Full repository validation suite
npm run check

# Sub-suite execution
npm run check:world     # Audits scale, hydrology, walkability, viewpoints
npm run check:deploy    # Audits module graph, relative links, assets
```

### Core Invariants Maintained Across All Phases:
1. **Hydrological Monotonicity:** Stream surfaces must rise monotonically upstream with zero inverted gradients ($\frac{dy}{ds} \ge 0$).
2. **Bankfull Containment:** Water elevation during baseflow must not spill out of the primary channel except in authored backwater pools.
3. **Walkable Corridors:** Route slopes must never exceed $21.0^\circ$. No section of the path may be submerged except designated wading shallows.
4. **Eye-Level Visual Quality:** All 23 camera viewpoints must be verified at human eye level ($1.7\text{ m}$) with clear sightlines to focal landmarks (confluence, bridge, weir, cave).
5. **Clean Zero-Build Deployment:** The repository serves directly as static ES modules with relative paths, requiring no compiler or bundler.

---

## 8. Summary Table: Phase Milestones & Deliverables

| Phase | Title | Primary Deliverable | Status |
| :--- | :--- | :--- | :--- |
| **P0** | **Metric Greybox World** | Vector geography, analytical relief, binary geometry, 23 checkpoints, collision engine, automated audit suite. | **100% COMPLETE** |
| **P1** | **Ground Truth Shading** | 5-material PBR library, height-blended triplanar shaders, field splatting, capillary wetness, texel density audit. | **NEXT UP** |
| **P2** | **Photorealistic Foliage** | Oerth botanical models (Alder, Bronzewood, Beech, Willow), 3-tier LOD instancing, wind vertex animation, SSS canopy shaders. | Planned |
| **P3** | **Dynamic Hydrology** | 2D vector flow fields, Snell/Fresnel reflection water shader, Kelvin-Helmholtz mixing plume, procedural foam rapids. | Planned |
| **P4** | **Atmosphere & Ecology** | Volumetric sun shafts, height-fog in hollows, dynamic LUT color grading, micro-fauna GPU particles, 3D spatial audio zones. | Planned |
| **P5** | **Story Dressing & Polish** | Handcrafted diegetic props, capsule collision polish, 60 FPS optimization lock, Chapter 2 cave portal transition. | Planned |
