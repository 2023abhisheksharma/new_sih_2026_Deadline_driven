# 🧭 Antarctic Navigation System

### Hybrid Global + Polar Maritime Routing & Ice Hazard Intelligence Engine

Smart India Hackathon 2026 · PS SIH26059 · Team **Deadline_Driven**

A browser-based navigation and decision-support tool that plans safe ship routes anywhere on Earth — including south of **−55°S**, where standard commercial maritime routing networks simply stop. It stitches a global shipping-lane graph to a purpose-built polar water graph, validates every route against real coastlines and ice shelves, and audits it against three independent iceberg datasets, all rendered on a 3D globe and a 2D tactical radar view.

---

## Table of Contents

- [Why This Exists](#why-this-exists)
- [Highlights](#highlights)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [The Six Routing Topology Cases](#the-six-routing-topology-cases)
- [Ice Hazard Risk Tiers](#ice-hazard-risk-tiers)
- [Tech Stack](#tech-stack)
- [Datasets](#datasets)
- [Repository Structure](#repository-structure)
- [Getting Started](#getting-started)
- [Known Limitations & Roadmap](#known-limitations--roadmap)
- [Team](#team)
- [License](#license)

---

## Why This Exists

Standard maritime routing data (e.g. Eurostat's MARNET network) has no edges south of roughly −55°S — there's simply no commercial routing graph covering the Southern Ocean or the Antarctic coastline. On top of that, near the pole:

- Great-circle "shortest paths" often bow south straight through land, peninsulas, or permanent ice shelves.
- Standard point-in-polygon land checks misclassify ships docked at berths as "grounded," because high-resolution coastline data encloses wharves and jetties.
- There's no single feed of iceberg hazard data — tracked giant icebergs, radar-detected grounded icebergs, and historical drift trajectories all come from different sources.

This project builds a dual-core routing engine that bridges the global network to a custom polar water graph, smooths and validates every route against real land geometry, and layers independent ice-hazard auditing on top — without ever silently drawing a route through land.

## Highlights

Numbers from the project's own Phase 8 performance engineering pass:

- **All routing computation runs off the main thread** (dedicated Web Worker) — main-thread blocking time went from ~67.9s to 0.00 ms on long routes, eliminating browser "Page Unresponsive" freezes
- **Continuous 60 FPS** on the 3D globe and 2D tactical radar while a route is calculating in the background
- **A\* spherical-heuristic solver** replaced the original Dijkstra search: **4.18× faster**, with **0.000000 km** path-length error across a 100-pair benchmark
- **Instant cancellation** — switching origin/destination mid-calculation terminates the in-flight worker in under 1 ms
- **Zero land or ice-shelf intersections** across the project's 6 authoritative production test corridors

## Key Features

- 🌐 **Dual-core hybrid routing** — global commercial shipping lanes (`searoute-ts` / Eurostat MARNET) stitched to a custom-built polar water graph via 13 verified transition gateways
- 🧊 **Zero-tolerance land/ice-shelf validation** — every proposed route segment is checked against Natural Earth 10m coastlines and SCAR Antarctic ice shelf boundaries; a route that fails is never rendered, not just flagged
- ⚓ **Adaptive harbor approach engine** — 16-bearing radial raycasting finds true open water clearance for each port instead of using a fixed buffer, so it doesn't cut corners around breakwaters or falsely reject legitimate berths
- 🪢 **Route smoothing** — geodesic string-pulling, great-circle chord densification, and curvature-continuous wheel-over turn fillets so paths look (and are) navigable by a real vessel, not a jagged waypoint chain
- ⚠️ **Multi-source ice hazard auditing** — cross-references three independent iceberg datasets against the route using geodesic point-to-segment distance, and classifies each hazard into a risk tier, without ever moving the route itself
- 🚢 **Kinematic mission scheduling** — per-segment speed, heading, ETA and course-change calculations modeled on a Polar Class 4 (PC4) research vessel
- 🌍 **Dual visualization** — a CesiumJS 3D WGS84 globe and a high-contrast 2D polar-stereographic tactical radar view, kept in sync

## Architecture

```
User selects Departure + Destination
              │
              ▼
   Terminal Harbor Approach Engine  ──►  finds clear open water at both ports
              │
              ▼
     Topology Classifier  ──►  picks 1 of 6 routing cases (see below)
              │
   ┌──────────┴──────────┐
   ▼                     ▼
Global Graph        Polar Water Graph
(searoute-ts /      (custom Dijkstra/A*
 MARNET 20km)        mesh, 7,388 nodes)
   └──────────┬──────────┘
              ▼
   Stitched at Transition Gateway(s)
              │
              ▼
   Route Quality Engine  ──►  string-pulling, chord densification, turn fillets
              │
              ▼
   Zero-Tolerance Validation Gate  ──►  rejects/wipes any route that clips land or ice shelves
              │
              ▼
   Kinematics & Scheduling  ──►  per-segment speed, heading, ETA
              │
              ▼
   Ice Hazard Auditor  ──►  proximity-checks route against 3 iceberg datasets
              │
              ▼
   3D Globe (CesiumJS)  +  2D Tactical Radar View
```

All heavy computation above runs inside a dedicated Web Worker (`frontend/src/workers/routing.worker.ts`) so the UI never freezes while a route resolves.

## The Six Routing Topology Cases

Every departure/destination pair is classified by latitude before routing begins:

| Case | Name | Example | Strategy |
|---|---|---|---|
| 1 | `POLAR_TO_POLAR` | McMurdo → Palmer Station | Pure polar-graph shortest path |
| 2 | `GLOBAL_TO_GLOBAL` | Rotterdam → Singapore | Pure global network (MARNET) |
| 3 | `GLOBAL_TO_POLAR` | Hobart → Casey Station | Global leg → best transition gateway → polar leg |
| 4 | `POLAR_TO_GLOBAL` | McMurdo → Hobart | Reverse of Case 3 |
| 5 | `POLAR_TO_POLAR_GLOBAL_TRANSIT` | McMurdo → Neumayer III | Polar → global → polar, when circling the coast is slower than cutting north |
| 6 | `ISOLATED_FJORD_REJECTION` | Any port in an unreachable fjord | Clean refusal (`HYBRID_UNAVAILABLE`) instead of drawing a route across land |

## Ice Hazard Risk Tiers

Icebergs within a 50 km corridor of the route are classified by geodesic distance:

| Tier | Distance | Meaning |
|---|---|---|
| 🔴 Critical | < 5 km | Immediate collision hazard — mandatory diversion / dead-slow speed |
| 🟠 Severe | 5–15 km | Close proximity — searchlights, ice-strengthened hull protocols |
| 🟡 Warning | 15–30 km | Monitor drift velocity against wind/tidal forecasts |
| 🔵 Advisory | 30–50 km | Logged for situational awareness only |

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend framework** | React 18, TypeScript, Vite |
| **3D globe** | CesiumJS (`vite-plugin-cesium`) |
| **2D tactical view** | HTML5 Canvas, custom polar-stereographic projection |
| **Global routing** | `searoute-ts` (Eurostat MARNET 20km network) |
| **Polar routing** | Custom Dijkstra / A* solver over a hand-built graph, using `tinyqueue` |
| **Concurrency** | Web Worker (`routing.worker.ts`) for all routing computation |
| **Styling** | Tailwind CSS |
| **Icons** | Lucide React |
| **Offline data pipeline** | Python 3.11, GeoPandas, Shapely, NumPy |

There is currently **no backend/API service** in this repo — it's a fully client-side app that fetches pre-processed JSON/GeoJSON from `frontend/public/data/` at runtime. The `scripts/` and `data/` pipelines are offline tooling used to *produce* those static assets, not a live server.

## Datasets

| Dataset | Source | Size | Used for |
|---|---|---|---|
| World Port Index + Antarctic stations | US NGA Publication 150, supplemented with COMNAP station registries | 3,825 ports (3,808 commercial + 17 Antarctic stations) | Departure/destination lookup, harbor approach |
| Coastlines & ice shelves | Natural Earth v5.1.1 (10m) + SCAR Antarctic Digital Database | — | Land/ice-shelf collision validation |
| Polar Water Graph | Custom-built, scrubbed against the above coastlines | 7,388 nodes / 13,228 edges, −40°S to −85°S | Polar leg pathfinding |
| Transition gateways | Auto-discovered between MARNET's southern edge and the polar graph | 13 gateways | Stitching global ↔ polar legs |
| USNIC tracked icebergs | US National Ice Center | 33 giant tabular icebergs (e.g. A-23A, A-68, B-15) | Ice hazard auditing |
| Sentinel-1 SAR grounded icebergs | ESA Sentinel-1 C-band radar | 39,619 detections | Ice hazard auditing |
| Drifting iceberg trajectories | BYU / USNIC scatterometer record (QuikSCAT, ASCAT, ERS-1/2) | 624 trajectories, 1992–2020 | Historical drift-corridor auditing |

## Repository Structure

```
├── data/                          # Offline GIS repository — raw + processed spatial datasets
│   ├── ports/                     # World Port Index (raw CSV → processed GeoJSON)
│   ├── icebergs/                  # USNIC tracked giant icebergs
│   ├── icebergs_satellite/        # Sentinel-1 SAR grounded icebergs
│   ├── icebergs_drifting/         # BYU drifting iceberg trajectories
│   └── routing/                   # Intermediate routing graph artifacts
├── frontend/                      # The application (Vite + React + TypeScript)
│   ├── public/data/               # Final JSON/GeoJSON assets fetched by the app at runtime
│   └── src/
│       ├── components/
│       │   ├── globe/             # CesiumGlobe.tsx — 3D globe viewer
│       │   ├── tactical/          # 2D polar-stereographic radar view
│       │   ├── mission/           # Header, layer toggles, route summary panel
│       │   └── annotations/       # Port/departure/destination/iceberg map pins
│       ├── services/              # All routing, validation, hazard & data-loading logic
│       │   ├── hybridMaritimeRoutingService.ts   # Master orchestrator, 6 topology cases
│       │   ├── maritimeRoutingService.ts         # Polar graph Dijkstra/A* solver
│       │   ├── terminalApproachService.ts        # 16-bearing dock clearance engine
│       │   ├── routeQualityService.ts            # Smoothing, string-pulling, turn fillets
│       │   ├── routeValidationService.ts         # Zero-tolerance land/ice-shelf gate
│       │   ├── iceHazardService.ts                # Multi-source proximity auditing
│       │   ├── routeSimulationService.ts          # Kinematics, speed, ETA scheduling
│       │   ├── landService.ts / portService.ts    # Static data loaders
│       │   └── icebergService.ts / sentinel1IcebergService.ts / driftingIcebergService.ts
│       ├── workers/routing.worker.ts              # Offloads all routing compute off the main thread
│       ├── utils/geo.ts                           # Spherical trig, Slerp, spatial indexing
│       ├── types/                                 # Shared TypeScript schemas
│       ├── config/vessel.ts                       # PC4 vessel speed/turn specifications
│       └── pages/AntarcticOverview.tsx             # Top-level page/state container
├── scripts/                        # Offline data pipeline, benchmarks & verification suite
│   ├── process_ports.py / process_icebergs.py / process_sentinel1_icebergs.py / process_drifting_icebergs.py
│   ├── build_southern_land_rings.mjs / clean_polar_water_graph.mjs / discover_gateways.mjs
│   ├── validate_icebergs.py
│   └── verify_production_routing.mjs   # End-to-end production readiness test runner
├── CODEBASE_MANUAL.md              # In-depth engineering reference for this project
└── PHASE_8_ROUTING_PERFORMANCE_*.md  # Performance engineering reports
```

## Getting Started

### Prerequisites
- Node.js 18+ and npm
- Python 3.10/3.11 (only needed if you're regenerating the datasets, not for running the app)

### Run the app
```bash
git clone https://github.com/2023abhisheksharma/new_sih_2026_Deadline_driven.git
cd new_sih_2026_Deadline_driven/frontend

npm install
npm run dev
```
The app runs at **http://localhost:5173/**.

### Build for production
```bash
cd frontend
npm run build      # outputs to frontend/dist/
npm run preview    # preview the production build locally
```

### Run the routing verification suite
Validates 10 test corridors across all 6 topology cases (endpoint accuracy, zero land collisions, hazard audit execution):
```bash
node scripts/verify_production_routing.mjs
```

### Regenerate the spatial datasets
Only needed if you update raw port/coastline/iceberg source data. Run in order from the repo root:
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

## Known Limitations & Roadmap

Documented directly in `CODEBASE_MANUAL.md` as the path to a production-grade ECDIS-style system:

- **Sea ice concentration is static, not live** — the polar graph guarantees no collisions with land or permanent ice shelves, but doesn't yet model seasonal pack ice or polynyas. Planned: daily AMSR2/NSIDC sea-ice concentration ingestion that dynamically re-weights or disables graph edges.
- **No weather routing yet** — speed/kinematics are based on vessel limits and ice regime only. Planned: ECMWF/GFS wind and wave-height ingestion.
- **Drifting iceberg positions are historical, not projected** — hazard auditing checks the route against recorded observation points rather than a live drift forecast. Planned: use the recorded drift-velocity vectors to project each iceberg's position forward to the vessel's actual arrival time.

## Team

**Deadline_Driven** — Smart India Hackathon 2026, Problem Statement SIH26059

## License

No license file is currently in the repo — worth adding one (MIT is a common default for hackathon/student projects) so others know how they can use this code.
