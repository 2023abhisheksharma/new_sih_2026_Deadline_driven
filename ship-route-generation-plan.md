# Real Ship Route Generation — Build Plan

**Where this fits:** one component of your larger navigation system — generating the route a ship would actually sail between two points. Polar ice-avoidance is a separate, later layer (per your own scoping) and isn't addressed here.

---

## 1. Reframe the actual problem

Two ways this usually goes wrong:

- **A\* on a raw grid, no land mask** → straight lines through continents.
- **A\* on a grid WITH a land mask** → technically avoids land, but still isn't "real." Real ships don't take the geometrically shortest sea-avoiding path — they follow a global network of established corridors: IMO Traffic Separation Schemes, canal/strait chokepoints (Suez, Panama, Malacca, Bab-el-Mandeb, Gibraltar), and decades of commercially-optimized routing. That network shows up in AIS density, but it's also already been extracted and packaged as reusable graph data — you don't have to mine it from raw trajectories yourself.

## 2. The tool that solves your literal complaint: `searoute-py`

```bash
pip install searoute
```
```python
import searoute as sr
route = sr.searoute([lon1, lat1], [lon2, lat2])
# -> GeoJSON LineString following real sea lanes, not a straight line
```

- Routes over a pre-built global maritime graph (Dijkstra/A* under the hood, `networkx` or `igraph` backend), correctly threading Suez/Panama/Malacca etc. instead of drawing a geodesic through land.
- This directly solves the exact issue you described — before you touch a single AIS row.
- Its own docs are upfront that it's built for **realistic-looking** routes (visualization-grade), not literal maritime navigation-grade precision. Fine as a system-level waypoint layer, not fine as an actual helm command.
- If its ~4K-edge network is too coarse near coastlines for you later: **`auto-sea-way`** is a newer alternative that builds a much higher-resolution routing graph algorithmically from OpenStreetMap coastlines (H3 hex grid, ~40M cells), self-hosted, handles narrow passages more precisely — heavier to set up. **`scgraph`** is a third option in the same family, worth a quick look for comparison.

## 3. Where your AIS data actually earns its place

Not as the route source — as everything downstream of it:

1. **Validation** — pull real historical tracks for an origin–destination pair, compare against what searoute/asw produces for the same pair, see how close the "curated graph" route gets to what ships actually did.
2. **Your own lane graph (the differentiator)** — grid-bin AIS points → build an adjacency graph from high-density cells → weight edges by traffic density. This gives you an *observed*, not curated, shipping-lane network for the regions your AIS data covers. This is the genuinely research-worthy piece — not something a library hands you for free.
3. **Later** — speed/transit-time/congestion features for ETA or congestion-aware routing. Out of scope for now.

## 4. What you found, assessed

| Source | What it actually is | Verdict for this piece |
|---|---|---|
| `colabsss/ship-trajectory-control-reliability-dataset` | Couldn't confirm contents — Kaggle's listing isn't search-indexed | Check the column list yourself before assuming it's raw lat/lon trajectory data; "control-reliability" in the name suggests it may be something narrower than trajectories |
| `bwandowando` NOAA AIS datasets (2022 / 2025 / 2026) | Confirmed: official NOAA/MarineCadastre AIS, US Coast Guard receiver network, ~1-minute resolution, filtered to the US Exclusive Economic Zone | Real, solid, high-quality AIS — but US-only. Good for §3.1/3.2 above, not for global coverage |
| `nadaemad2002/ais-data-complete-weather` | AIS joined with weather data | Save for the later weather-routing / polar layer, not the core route backbone now |
| `ppotoc/MPC-Autonomous-Ship-Navigation` | MATLAB. Model Predictive Control + COLREG collision avoidance, tested on a small local scenario (Split, Adriatic Sea, 3 waypoints), uses coastline data to treat land as an obstacle for *local* trajectory tracking | Different problem — this controls a ship along a route it already has, avoiding other vessels in real time. Relevant later ("how does the ship follow/adapt the route"), not for generating the route itself |
| `quanganh1999/ShipNaviSim` | Academic (AAMAS 2025), data-driven traffic simulator for the Singapore Strait — 2 years of AIS + imitation learning to reproduce realistic multi-vessel behavior | Also a different problem — vessel interaction/behavior simulation for RL research. Interesting reference for a much later "realistic traffic" layer; heavy to adapt, and geographically narrow |

**Bottom line:** neither GitHub repo is directly implementable for *this* piece — both solve local control/simulation problems, not global route synthesis. The Kaggle NOAA data is real and usable, just US-only.

## 5. The India / Antarctica gap — stated plainly

There's no complete free global AIS archive anywhere — even paid vendors stitch together patchwork terrestrial + satellite feeds. Terrestrial AIS receivers (like NOAA's) only reach roughly 50km from shore, which is why the NOAA data is US-only.

Closest thing to a free global option: **Global Fishing Watch's AIS Vessel Presence dataset** — free, genuinely global (it draws on satellite AIS, so it reaches open ocean), hourly binned positions from 2012 to near-present, available via their public API. It's presence data (one point per vessel per hour, not a dense track), but it does have real coverage across the Indian Ocean and Southern Ocean.

Antarctica itself will stay data-sparse no matter which source you use — very few vessels (icebreakers, research ships, a handful of tourism operators) ever transit there, so there isn't much AIS signal to mine even where satellite coverage technically exists. That's a genuine data-scarcity limit, not a "wrong dataset" problem. For those legs, lean entirely on the graph-based tool from §2, since it doesn't need local AIS density to produce a plausible route. I didn't find a confirmed free bulk Indian-coast historical AIS source — if you need that specifically, worth checking INCOIS / DG Shipping directly rather than guessing here.

## 6. Phased plan

- **Phase 0 (hours, no dataset needed):** `pip install searoute`, run it between two ports on different continents, confirm it threads Suez/Panama instead of drawing a line through them.
- **Phase 1 (MVP):** wrap it as a service — any two lat/lon in, waypoint list out. This alone unblocks the rest of your system.
- **Phase 2 (validation):** download one month of the 2025 NOAA set, pick a few real US voyages, compare the AIS track against the generated route for the same origin–destination pair.
- **Phase 3 (the differentiator):** build your own density-based lane graph from the NOAA data (§3.2), compare it against the curated graph.
- **Phase 4 (later, deferred):** bring in weather + ice-chart data for polar legs, once you're actually ready for that part.

## 7. Explicitly not part of this piece

- MPC / collision-avoidance control — later, once a route already exists
- A from-scratch global AIS pipeline — no free global source exists at the fidelity you'd need
- Iceberg / polar-ice logic — your own call, deferred

---

*One practical note: this layer's ecosystem (searoute, geopandas-style tooling, AIS parsing) is most naturally Python — that's just where the maritime/GIS libraries live, not a recommendation to rebuild your whole stack in it. Expose it as a clean service/API and whatever the rest of your project is written in can just call it.*
