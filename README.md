<div align="center">

# 🧭 POLARIS-X

**Predictive Iceberg Intelligence & Adaptive Route Planning for Antarctic**

Hybrid global + polar maritime routing and ice-hazard auditing, running entirely in the browser.

Smart India Hackathon 2026 · Problem Statement **SIH26059** · Theme: Transportation & Logistics · Category: Software · Team **Deadline_Driven**

![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646cff?logo=vite&logoColor=white)
![CesiumJS](https://img.shields.io/badge/CesiumJS-3D%20globe-6cadde)
![SIH](https://img.shields.io/badge/SIH-2026-orange)

</div>

<!-- VERIFY: the badge versions match frontend/package.json (React ^18.3, TypeScript ^5.6, Vite ^5.4 per CODEBASE_MANUAL). -->

---

## What is POLARIS-X?

POLARIS-X is a browser-based decision-support tool for planning ship routes **anywhere on Earth, including the Southern Ocean and the Antarctic coast**, where standard commercial routing data stops.

You pick a departure and a destination. POLARIS-X then:

1. stitches a global shipping-lane network to a purpose-built polar water graph,
2. smooths the result into a route a real vessel could sail,
3. validates every segment against real coastlines and ice shelves (an invalid route is never drawn),
4. audits the route against three independent iceberg datasets and grades each hazard by distance,
5. shows everything on a 3D globe and a 2D tactical radar view, with a mission schedule (ETA, headings, speeds).

> **Decision support, not a navigation aid.** POLARIS-X is a hackathon prototype. It is not certified for real-world navigation and must not replace ECDIS, ice charts, or the master's judgement.

**Live prototype:** <https://antartic-nav-backend.onrender.com/> <!-- VERIFY: link is taken from the SIH submission deck; confirm it is still live and what it serves. -->

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [Key features](#key-features)
- [Implementation status vs. the SIH proposal](#implementation-status-vs-the-sih-proposal)
- [How it works](#how-it-works)
- [Ice hazard risk tiers](#ice-hazard-risk-tiers)
- [Performance](#performance)
- [Verified corridors](#verified-corridors)
- [Tech stack](#tech-stack)
- [Datasets](#datasets)
- [Repository structure](#repository-structure)
- [Getting started](#getting-started)
- [Using the app](#using-the-app)
- [Testing and verification](#testing-and-verification)
- [Regenerating the datasets](#regenerating-the-datasets)
- [Known limitations and roadmap](#known-limitations-and-roadmap)
- [Documentation index](#documentation-index)
- [Team](#team)
- [Data credits and license](#data-credits-and-license)

---

## Why this exists

Commercial maritime routing data (for example Eurostat's MARNET network) has no edges south of roughly −55°S, so there is simply no routing graph for the Southern Ocean or the Antarctic coastline. Near the pole, three more problems appear:

- **Great-circle shortcuts cut through land.** The shortest path between two southern points often bows south through peninsulas, capes or permanent ice shelves.
- **Docked ships look "grounded".** High-resolution coastline polygons enclose wharves and jetties, so a naive point-in-polygon test rejects legitimate berths.
- **Ice hazard data is fragmented.** Tracked giant icebergs, radar-detected grounded icebergs and historical drift trajectories come from different sources in different formats.

POLARIS-X bridges the global network to a custom polar graph, validates every route against real land geometry, and layers independent ice-hazard auditing on top.

---

## Key features

- 🌐 **Dual-core hybrid routing.** Global shipping lanes (`searoute-ts`, Eurostat MARNET 20 km) stitched to a custom polar water graph through 13 verified transition gateways.
- 🧊 **Zero-tolerance land and ice-shelf validation.** Every segment is checked against Natural Earth 10 m coastlines and SCAR ice-shelf boundaries. A route that fails is wiped, not just flagged.
- ⚓ **Adaptive harbor approach.** 16-bearing radial raycasting finds real open-water clearance for each port instead of a fixed buffer.
- 🪢 **Route smoothing.** Geodesic string-pulling, great-circle densification and lateral detour repair so the path is navigable, not a jagged waypoint chain.
- ⚠️ **Multi-source ice-hazard audit.** Three iceberg datasets are checked against the route with geodesic point-to-segment distance and graded into four risk tiers. The audit never moves the route.
- 🚢 **Kinematic mission schedule.** Per-segment speed, heading, ETA and course changes for a Polar Class 4 (PC4) research vessel.
- 🖥️ **Two synchronised views.** A CesiumJS 3D globe and a 2D south-polar-stereographic tactical radar.
- ⚡ **Off-thread computation.** All routing runs in a Web Worker, so the UI stays at 60 FPS and a route request can be cancelled instantly.

---

## Implementation status vs. the SIH proposal

The SIH idea submission describes the full POLARIS-X vision. This repository implements the routing, validation, hazard-audit and visualisation core. The table shows where each proposal item stands today.

| Proposal item | Status in this repo |
| --- | --- |
| Integrated platform: routing + risk + 3D visualisation | ✅ Implemented |
| Interactive 3D Earth with vessels, icebergs, hazards and routes | ✅ Implemented (CesiumJS + 2D tactical view) |
| Iceberg registry with position, size and drift history | ✅ Implemented via three datasets (USNIC, Sentinel-1 SAR, BYU drift) |
| Safest, efficient route (distance, time, risk) | 🟡 Partial. Routes are shortest-path on a land-validated graph; ice hazards are audited after routing and are not yet part of the path cost |
| Time and fuel estimates | 🟡 Partial. PC4 kinematic model with illustrative fuel figures |
| Cached datasets, offline operation | ✅ Implemented (static JSON/GeoJSON, no backend) |
| Sea-ice concentration forecasting from SAR, ocean and weather data | ⬜ Not implemented (planned: AMSR2 / NSIDC ingestion) |
| Iceberg detection from SAR imagery | ⬜ Not implemented. The app uses a published Sentinel-1 detection dataset |
| Physics + ML iceberg drift and melt prediction | ⬜ Not implemented. Drift data is historical, not projected |
| Live risk-cost grid and automatic mid-voyage replanning (D\* Lite) | ⬜ Not implemented. Routes are recomputed when the user changes ports |
| FastAPI backend, Copernicus Marine / ERA5 ingestion | ⬜ Not in this repo. The app is fully client-side |

Legend: ✅ implemented · 🟡 partly implemented · ⬜ planned / not in this repo

---

## How it works

```
User selects Departure + Destination
              │
              ▼
   Terminal Harbor Approach Engine ──► finds clear open water at both ports
              │
              ▼
     Topology Classifier ──► picks 1 of 6 routing cases
              │
   ┌──────────┴──────────┐
   ▼                     ▼
Global Graph        Polar Water Graph
(searoute-ts /      (custom A* solver)
 MARNET 20 km)
   └──────────┬──────────┘
              ▼
   Stitched at Transition Gateway(s)
              │
              ▼
   Route Quality Engine ──► string-pulling, densification, detour repair
              │
              ▼
   Zero-Tolerance Validation Gate ──► wipes any route that clips land or ice shelves
              │
              ▼
   Kinematics and Scheduling ──► per-segment speed, heading, ETA
              │
              ▼
   Ice Hazard Auditor ──► proximity check against 3 iceberg datasets
              │
              ▼
   3D Globe (CesiumJS)  +  2D Tactical Radar
```

All heavy computation above runs in a dedicated Web Worker (`frontend/src/workers/routing.worker.ts`). The main thread only dispatches the request and renders the result.

### The six routing topology cases

| Case | Name | Example | Strategy |
| --- | --- | --- | --- |
| 1 | `POLAR_TO_POLAR` | McMurdo → Palmer Station | Pure polar-graph shortest path |
| 2 | `GLOBAL_TO_GLOBAL` | Cape Town → Mumbai | Pure global network (MARNET) |
| 3 | `GLOBAL_TO_POLAR` | Hobart → McMurdo | Global leg → best transition gateway → polar leg |
| 4 | `POLAR_TO_GLOBAL` | McMurdo → Hobart | Reverse of Case 3 |
| 5 | `POLAR_TO_POLAR_GLOBAL_TRANSIT` | McMurdo → Neumayer III | Polar → global → polar, when going around the coast is slower than cutting north |
| 6 | `ISOLATED_FJORD_REJECTION` | Puerto Natales | Clean refusal (`HYBRID_UNAVAILABLE`) instead of drawing a route across land |

<!-- VERIFY: classification rule. CODEBASE_MANUAL describes a −55°S latitude threshold; the Phase 8 report describes a connectivity check against the polar graph. Update this line to match the current classifyRoutingTopology. -->

### Safety invariants

These hold for every route the app displays:

1. The route starts and ends within 1 m of the requested port coordinates.
2. No segment intersects land or an ice shelf outside the harbor-clearance window.
3. If any check fails, the route coordinates are cleared, so an unsafe polyline cannot reach the screen.
4. The hazard auditor is **non-mutating**. It reports threats and never nudges a validated route, because a diversion could push the ship into shallow water or toward land.

---

## Ice hazard risk tiers

Icebergs within a 50 km corridor of the route are classified by geodesic distance from the track:

| Tier | Distance | Meaning |
| --- | --- | --- |
| 🔴 Critical | < 5 km | Immediate collision hazard. Mandatory diversion or dead-slow speed |
| 🟠 Severe | 5–15 km | Close proximity. Searchlights and ice-strengthened hull protocols |
| 🟡 Warning | 15–30 km | Monitor drift against wind and tidal forecasts |
| 🔵 Advisory | 30–50 km | Logged for situational awareness |

---

## Performance

Figures from the Phase 8 performance-engineering pass (full details in the [implementation report](PHASE_8_ROUTING_PERFORMANCE_IMPLEMENTATION_REPORT.md)).

| Metric | Before | After |
| --- | --- | --- |
| Main-thread blocking on Darwin → McMurdo | 67,880 ms | **0 ms** (Web Worker) |
| UI frame rate while routing | 0 FPS (frozen) | **60 FPS** |
| Polar graph query (Dijkstra → A\*) | 9.17 ms | **2.19 ms** (4.18× faster, 0.000000 km path error over 100 random node pairs) |
| Redundant terminal-approach scans per hybrid route | 9–10 | **1** (hoisted and memoised) |
| Cancelling an in-flight route | not possible | **< 1 ms** (`worker.terminate()`) |

Typical warm route times measured in that pass:

| Route | Distance | Time |
| --- | --- | --- |
| Vernadsky → Palmer Station | 19 km | 59 ms |
| Ushuaia → Ellefsen Harbor | 1,571 km | 339 ms |
| Christchurch → McMurdo | 4,823 km | 973 ms |
| Cape Town → McMurdo | 10,405 km | 2.4 s |
| Hobart → McMurdo (hybrid, Case 3) | 4,197 km | ≈ 7.2 s |
| Melbourne → Casey Station (hybrid, Case 3) | 3,920 km | ≈ 6.4 s |

Hybrid routes are still the slowest. They now run off the main thread, so the interface stays responsive while they resolve.

---

## Verified corridors

`scripts/verify_production_routing.mjs` checks six authoritative corridors. Four must produce a valid route with zero land crossings. Two must be **correctly rejected**.

| Corridor | Result |
| --- | --- |
| Darwin → McMurdo Station | ✅ 9,800.9 km, 649 waypoints, 0 land crossings |
| Hobart → McMurdo Station | ✅ 4,196.6 km, 416 waypoints, 0 land crossings |
| Ushuaia → Ellefsen Harbor | ✅ 1,571.4 km, 197 waypoints, 0 land crossings |
| Cape Town → McMurdo Station | ✅ 10,405.2 km, 948 waypoints, 0 land crossings |
| Rotterdam → Keppel Singapore | ⛔ Rejected as expected. The global network's Suez Canal path crosses the land polygon, so strict validation refuses it (see limitations) |
| Puerto Natales → McMurdo Station | ⛔ `HYBRID_UNAVAILABLE` as expected. The port sits in an isolated Patagonian fjord |

<!-- VERIFY: CODEBASE_MANUAL says the verify script covers 10 corridors; the Phase 8 report says 6. Confirm the current count in scripts/verify_production_routing.mjs. -->

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Lucide React |
| 3D globe | CesiumJS via `vite-plugin-cesium` |
| 2D tactical view | HTML5 Canvas with a custom south-polar-stereographic projection |
| Global routing | `searoute-ts` (Eurostat MARNET 20 km network) |
| Polar routing | Custom A\* solver (Haversine heuristic) over a hand-built water graph, using `tinyqueue` |
| Concurrency | Web Worker (`routing.worker.ts`) with a Promise-based bridge |
| Offline data pipeline | Python 3.10/3.11 (GeoPandas, Shapely, NumPy) and Node.js scripts |

There is **no backend or API service**. The app is fully client-side and loads pre-processed JSON/GeoJSON from `frontend/public/data/` at runtime. The `scripts/` and `data/` folders are offline tooling that *produces* those static files.

---

## Datasets

| Dataset | Source | Volume | Used for |
| --- | --- | --- | --- |
| World Port Index + Antarctic stations | US NGA Publication 150, plus COMNAP station registries | 3,825 ports (3,808 commercial + 17 Antarctic stations) | Port lookup, harbor approach |
| Coastlines and ice shelves | Natural Earth v5.1.1 (10 m) + SCAR Antarctic Digital Database | n/a | Land and ice-shelf collision validation |
| Polar water graph | Custom-built and scrubbed against the coastlines above | ≈ 17.7k nodes / 575.8k directed edges | Polar-leg pathfinding |
| Transition gateways | Auto-discovered between MARNET's southern edge and the polar graph | 13 gateways | Stitching global and polar legs |
| USNIC tracked icebergs | US National Ice Center | 33 giant tabular icebergs (for example A-23A, A-68, B-15) | Ice-hazard audit |
| Sentinel-1 SAR grounded icebergs | ESA Sentinel-1 C-band radar | 39,619 detections | Ice-hazard audit |
| Drifting iceberg trajectories | BYU / USNIC scatterometer record (QuikSCAT, ASCAT, ERS-1/2) | 624 trajectories, 1992–2020 | Historical drift-corridor audit |

<!-- VERIFY: graph size. README/CODEBASE_MANUAL say 7,388 nodes / 13,228 edges; the Phase 8 reports (polarWaterGraph.indexed.json, 11.17 MB) say 17,688 nodes / 575,842 directed edges. The Phase 8 figures are used above because they were measured on the running code. Confirm against the graph file shipped in frontend/public/data/. -->

See [`data/README.md`](data/README.md) for folder layout and provenance.

---

## Repository structure

```
├── data/                    # Offline GIS repository: raw + processed spatial datasets
├── frontend/                # The application (Vite + React + TypeScript)
│   ├── public/data/         # Final JSON/GeoJSON assets fetched by the app at runtime
│   └── src/
│       ├── components/      # globe/, tactical/, mission/, annotations/
│       ├── services/        # Routing, validation, hazard audit, data loading
│       ├── workers/         # routing.worker.ts (off-thread routing)
│       ├── utils/geo.ts     # Spherical trigonometry, Slerp, spatial indexes
│       ├── config/vessel.ts # PC4 vessel speed and turn specifications
│       ├── types/           # Shared TypeScript schemas
│       └── pages/           # AntarcticOverview.tsx (top-level state container)
├── scripts/                 # Offline data pipeline, benchmarks, verification suite
├── .licenses/               # License and attribution material
├── CODEBASE_MANUAL.md       # In-depth engineering reference
├── PHASE_8_ROUTING_PERFORMANCE_INVESTIGATION_REPORT.md
├── PHASE_8_ROUTING_PERFORMANCE_IMPLEMENTATION_REPORT.md
└── ship-route-generation-plan.md
```

Each of `frontend/`, `scripts/` and `data/` has its own README.

---

## Getting started

### Prerequisites

- Node.js 18 or newer, and npm
- Python 3.10 or 3.11, **only** if you want to regenerate the datasets

### Run the app

```bash
git clone https://github.com/2023abhisheksharma/new_sih_2026_Deadline_driven.git
cd new_sih_2026_Deadline_driven/frontend

npm install
npm run dev
```

The app runs at <http://localhost:5173/>.

### Build for production

```bash
cd frontend
npm run build      # type-checks, then builds to frontend/dist/
npm run preview    # serve the production build locally
```

The production bundle is large (roughly 5 MB for the main chunk and 4.8 MB for the routing worker before gzip) because it includes CesiumJS and the routing engine.

---

## Using the app

1. Choose a **departure** and a **destination** from the port list, or click a port on the globe. Antarctic research stations are included.
2. Wait a moment while the route resolves. The interface stays interactive, and choosing new ports cancels the calculation in progress.
3. Switch between the **3D globe** and the **2D tactical radar**.
4. Use the **layer toggles** to show or hide the polar water mesh, coastlines, ice shelves, tracked icebergs, grounded icebergs, drifting trajectories and the route corridor.
5. Read the **mission panel**:
   - **Summary:** distance (NM and km), duration, fuel estimate and hazard status.
   - **Waypoints:** cumulative distance, heading, speed and timestamp per waypoint.
   - **Hazards:** icebergs sorted by distance to the route, with critical threats highlighted. Click one to focus it.
6. If a route cannot be made safely, the app says so instead of drawing a path.

---

## Testing and verification

Run the routing verification suite from the repository root:

```bash
node scripts/verify_production_routing.mjs
```

It asserts, for each corridor: expected topology and status, exact port endpoints, zero land or ice-shelf collisions, and a hazard audit that executes. Correct rejections (fjord, Suez) count as passes.

Other benchmarks (topology cases, smoothing, end-to-end) are described in [`scripts/README.md`](scripts/README.md).

---

## Regenerating the datasets

Only needed if you change the raw port, coastline or iceberg data. Run from the repository root, in this order:

```bash
pip install geopandas shapely fiona pyproj numpy

python3 scripts/process_ports.py
node scripts/build_southern_land_rings.mjs
node scripts/clean_polar_water_graph.mjs
node scripts/discover_gateways.mjs
python3 scripts/process_icebergs.py
python3 scripts/process_sentinel1_icebergs.py
python3 scripts/process_drifting_icebergs.py
python3 scripts/validate_icebergs.py
```

---

## Known limitations and roadmap

**Current limitations**

- **Sea ice is static.** The polar graph avoids land and permanent ice shelves but does not model seasonal pack ice or polynyas.
- **No weather routing.** Speed and kinematics come from vessel limits and ice regime only.
- **Drift data is historical.** The hazard audit compares the route with recorded observations, not a forecast of where each iceberg will be at arrival time.
- **Hazards do not change the route.** Ice hazards are reported to the navigator, not fed back into path cost.
- **Some global routes are rejected.** The MARNET network's canal and strait paths (for example Suez) pass through land polygons at 10 m resolution, so strict validation refuses routes such as Rotterdam → Singapore.
- **Isolated fjord ports are refused** (for example Puerto Natales) rather than routed across land.
- **Fuel and endurance figures are illustrative.** They come from a simple PC4 model, not a certified vessel performance curve.

**Roadmap**

- Daily sea-ice concentration ingestion (AMSR2 / NSIDC) that re-weights or disables graph edges.
- Wind and wave forecasts (ECMWF / GFS) for weather-aware routing.
- Forward projection of iceberg positions from the recorded drift vectors, to the vessel's actual arrival time.
- Feed hazard risk into the path cost, and re-plan automatically during a simulated voyage.
- Optional backend for live data feeds.

---

## Documentation index

| Document | What it covers |
| --- | --- |
| [`CODEBASE_MANUAL.md`](CODEBASE_MANUAL.md) | Architecture, mathematics, per-file reference, runbook and troubleshooting |
| [`PHASE_8_ROUTING_PERFORMANCE_INVESTIGATION_REPORT.md`](PHASE_8_ROUTING_PERFORMANCE_INVESTIGATION_REPORT.md) | Profiling and root-cause analysis of the browser freezes |
| [`PHASE_8_ROUTING_PERFORMANCE_IMPLEMENTATION_REPORT.md`](PHASE_8_ROUTING_PERFORMANCE_IMPLEMENTATION_REPORT.md) | The fixes (Web Worker, A\*, memoisation, gateway pruning) and measured results |
| [`ship-route-generation-plan.md`](ship-route-generation-plan.md) | Original plan for global route generation with `searoute` and AIS data |

For the latest solver and performance figures, the Phase 8 reports are the reference.

---

## Team

**Deadline_Driven** · Smart India Hackathon 2026 · Problem Statement SIH26059

| Name | Role |
| --- | --- |
| Abhishek Sharma | <!-- TODO: role --> |
| <!-- TODO: name --> | <!-- TODO: role --> |

---

## Data credits and license

Data sources: US NGA World Port Index (Pub 150), COMNAP, Natural Earth, SCAR Antarctic Digital Database, US National Ice Center, ESA Sentinel-1, and the BYU / USNIC scatterometer iceberg record. Each dataset's provenance is in its `metadata/source.json` under `data/`, and license material is in `.licenses/`.

**Code license:** no `LICENSE` file is in the repository yet. Add one (MIT is a common choice for hackathon projects) and update this section.
