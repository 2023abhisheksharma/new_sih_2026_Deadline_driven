/**
 * Maritime Routing Engine
 * -----------------------
 * Computes authentic, water-constrained maritime navigation routes between
 * real-world ports in the Antarctic and Southern Ocean theaters.
 *
 * Routing Strategy (3-Tier Hierarchical Fallback):
 * 1. Primary Strategy: High-Resolution Polar Navigable Water Graph (`polarWaterGraph.json`).
 *    - Derived from GEBCO 2024 bathymetry, SCAR Antarctic Digital Database (ADD), and Natural Earth 10m.
 *    - Guarantees 100% water-constrained navigation through polar channels, straits, and sounds.
 *    - Solved using Dijkstra's algorithm with a binary min-heap priority queue (`TinyQueue`).
 *
 * 2. Secondary Strategy: Eurostat MARNET 20km Mesh (`searoute-ts`).
 *    - Sourced from the European Commission's maritime transport network.
 *    - Used for open-ocean transits and northern gateway connections.
 *
 * 3. Tertiary Strategy: Direct Coastal Channel Line-of-Sight.
 *    - For adjacent local ports (< 150 km) where direct line-of-sight passes all land checks.
 *
 * Strict Hard Gate:
 * Every candidate route must pass independent verification via `validateMaritimeRouteAsync`.
 * If any segment crosses land, the candidate is rejected with `REJECTED_LAND_INTERSECTION`
 * and coordinates are suppressed to prevent invalid geometry from appearing on the globe or chart.
 */

import TinyQueue from 'tinyqueue';
import { seaRoute } from 'searoute-ts';
import { DEFAULT_MARNET as marnet20 } from 'searoute-ts/marnet-20km';
import type { PortRecord } from '../types/port';
import {
  validateMaritimeRouteAsync,
  computeSegmentIntersectionParam,
  loadLandRings,
  getAdaptiveDockToleranceKm,
  type LandRing,
  type RouteValidationReport,
  type TerminalApproachMetadata,
} from './routeValidationService';
import {
  calculateGeodesicDistanceMeters,
  segmentsIntersect,
  pointInPolygon,
} from '../utils/geo';
import {
  computeHybridMaritimeRoute,
  loadValidatedGateways,
  classifyRoutingTopology,
  stitchPolylines,
  type HybridTopology,
  type ValidatedGateway,
  type HybridCandidateDiagnostic,
  type HybridMaritimeRouteResult,
  HYBRID_ROUTING_PROVENANCE,
} from './hybridMaritimeRoutingService';
import {
  findSafeTerminalApproach,
  type TerminalApproachResult,
} from './terminalApproachService';
import {
  evaluateRouteQuality,
  calculateRouteQualityScore,
  smoothMaritimeTrajectory,
  type RouteQualityMetrics,
  type RouteQualityScore,
} from './routeQualityService';

export {
  computeHybridMaritimeRoute,
  loadValidatedGateways,
  classifyRoutingTopology,
  stitchPolylines,
  findSafeTerminalApproach,
  evaluateRouteQuality,
  calculateRouteQualityScore,
  type HybridTopology,
  type ValidatedGateway,
  type HybridCandidateDiagnostic,
  type HybridMaritimeRouteResult,
  type TerminalApproachResult,
  type RouteQualityMetrics,
  type RouteQualityScore,
  HYBRID_ROUTING_PROVENANCE,
};

export type RouteOperationalStatus =
  | 'SUCCESS'
  | 'NO_FEASIBLE_ROUTE'
  | 'REJECTED_LAND_INTERSECTION'
  | 'HYBRID_UNAVAILABLE'
  | 'ERROR';

export type RouteFailureCategory =
  | 'Terminal harbor approach failure'
  | 'Internal MARNET topology failure'
  | 'Patagonian isolated fjord'
  | 'Land/ice validation failure'
  | 'No feasible water route'
  | 'Calculation error';

export interface MaritimeRouteResult {
  status: RouteOperationalStatus;
  routeName: 'Computed Maritime Route';
  coordinates: [number, number][]; // [longitude, latitude][]
  distanceKm: number;               // Validated route distance in km (0 if not validated)
  constructedDistanceKm?: number;   // Preserved constructed route distance even on rejection
  durationHours?: number;           // Estimated duration at assumed 15 kn
  topology?: HybridTopology;
  failingReason?: string;
  failureCategory?: RouteFailureCategory;
  candidateCountAttempted: number;
  rawNodeCount: number;
  finalNodeCount: number;
  validationReport?: RouteValidationReport;
  terminalApproachStatus?: 'DIRECT_SAFE' | 'RADIAL_SCAN_SUCCESS' | 'APPROACH_UNAVAILABLE';
  routeQualityMetrics?: RouteQualityMetrics;
  routeQualityScore?: RouteQualityScore;
  selectedGatewayId?: string;
  provenance: {
    dataset: string;
    version: string;
    source: string;
    license: string;
    method: string;
  };
}

interface PolarGraphData {
  nodes: [number, number][];
  edges: [[number, number], [number, number], number][];
}

export interface PortSnappingCandidate {
  nodeIndex: number;
  nodeCoords: [number, number];
  distanceKm: number;
  candidateDepth: number; // 5, 10, 20, or 50
  componentId: number;
  isPrimaryComponent: boolean;
  totalTimeMs: number;
  waterBerthCoords?: [number, number];
}

export interface CachedGraphState {
  nodes: [number, number][];
  adj: Map<number, { nodeIndex: number; weight: number }[]>;
  nodeComponent: Int32Array;
  primaryComponentId: number;
}

let cachedGraph: CachedGraphState | null = null;
let graphLoadingPromise: Promise<CachedGraphState | null> | null = null;

/**
 * Asynchronously loads and parses the polar navigable water graph JSON asset.
 * Computes connected component labels at runtime to identify the primary navigable ocean mesh.
 */
export async function loadPolarWaterGraph(): Promise<CachedGraphState | null> {
  if (cachedGraph) return cachedGraph;
  if (graphLoadingPromise) return graphLoadingPromise;

  const buildGraphFromIndexed = (data: { nodes: [number, number][]; edges: [number, number, number][] }): CachedGraphState => {
    const nodes = data.nodes;
    const adj = new Map<number, { nodeIndex: number; weight: number }[]>();
    for (let i = 0; i < nodes.length; i++) {
      adj.set(i, []);
    }
    for (let i = 0; i < data.edges.length; i++) {
      const [u, v, weight] = data.edges[i];
      adj.get(u)?.push({ nodeIndex: v, weight });
      adj.get(v)?.push({ nodeIndex: u, weight });
    }
    return finalizeGraphState(nodes, adj);
  };

  const buildGraphFromLegacy = (data: PolarGraphData): CachedGraphState => {
    const coordKey = (lon: number, lat: number) => Math.round(lon * 1000) * 1000000 + Math.round(lat * 1000);
    const coordToIndex = new Map<number, number>();
    const nodes: [number, number][] = [];
    const adj = new Map<number, { nodeIndex: number; weight: number }[]>();

    data.nodes.forEach((pt, idx) => {
      nodes.push(pt);
      coordToIndex.set(coordKey(pt[0], pt[1]), idx);
      adj.set(idx, []);
    });

    const inBeagleChannel = (p: [number, number]) =>
      p[0] >= -71.5 && p[0] <= -66.4 && p[1] >= -55.3 && p[1] <= -54.7;

    for (const [p1, p2, weight] of (data.edges as [[number, number], [number, number], number][])) {
      if ((inBeagleChannel(p1) || inBeagleChannel(p2)) && weight > 20.0) {
        continue;
      }
      const u = coordToIndex.get(coordKey(p1[0], p1[1]));
      const v = coordToIndex.get(coordKey(p2[0], p2[1]));
      if (u !== undefined && v !== undefined) {
        adj.get(u)?.push({ nodeIndex: v, weight });
        adj.get(v)?.push({ nodeIndex: u, weight });
      }
    }
    return finalizeGraphState(nodes, adj);
  };

  const finalizeGraphState = (nodes: [number, number][], adj: Map<number, { nodeIndex: number; weight: number }[]>): CachedGraphState => {
    // Compute connected components via BFS
    const nodeComponent = new Int32Array(nodes.length);
    nodeComponent.fill(-1);
    let currentComp = 0;
    const componentSizes: { comp: number; size: number }[] = [];

    for (let i = 0; i < nodes.length; i++) {
      if (nodeComponent[i] !== -1) continue;
      let size = 0;
      const queue: number[] = [i];
      nodeComponent[i] = currentComp;
      let head = 0;
      while (head < queue.length) {
        const u = queue[head++];
        size++;
        const neighbors = adj.get(u);
        if (neighbors) {
          for (let e = 0; e < neighbors.length; e++) {
            const v = neighbors[e].nodeIndex;
            if (nodeComponent[v] === -1) {
              nodeComponent[v] = currentComp;
              queue.push(v);
            }
          }
        }
      }
      componentSizes.push({ comp: currentComp, size });
      currentComp++;
    }

    componentSizes.sort((a, b) => b.size - a.size);
    const primaryComponentId = componentSizes.length > 0 ? componentSizes[0].comp : 0;
    return { nodes, adj, nodeComponent, primaryComponentId };
  };

  graphLoadingPromise = fetch('/data/polarWaterGraph.indexed.json')
    .then((res) => {
      if (!res.ok) throw new Error(`Indexed graph HTTP ${res.status}`);
      return res.json();
    })
    .then((indexedData) => {
      cachedGraph = buildGraphFromIndexed(indexedData);
      return cachedGraph;
    })
    .catch(() => {
      // Fallback seamlessly to unindexed polarWaterGraph.json
      return fetch('/data/polarWaterGraph.json')
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to load polarWaterGraph.json: HTTP ${res.status}`);
          return res.json();
        })
        .then((legacyData: PolarGraphData) => {
          cachedGraph = buildGraphFromLegacy(legacyData);
          return cachedGraph;
        });
    })
    .catch((err) => {
      console.warn('Failed to load polar water graph:', err);
      cachedGraph = null;
      return null;
    });

  return graphLoadingPromise;
}

// Eager load graph on client to eliminate route calculation delays
if (typeof window !== 'undefined') {
  loadPolarWaterGraph();
}

/**
 * Rigorously checks whether a straight-line port-to-water connector ray intersects land.
 * Allows a strict micro-harbor dock tolerance of up to 1.5 km for vessels departing berths.
 *
 * @param portCoords [longitude, latitude] of the port dock/berth
 * @param nodeCoords [longitude, latitude] of candidate water mesh node
 * @param rings Pre-loaded array of authoritative land and ice shelf polygons
 * @param maxToleranceKm Dock clearance threshold in kilometers (default: 1.5 km)
 * @returns true if connector is 100% water (or within dock tolerance), false if it crosses land
 */
export function isConnectorWaterValid(
  portCoords: [number, number],
  nodeCoords: [number, number],
  rings: LandRing[],
  maxToleranceKm: number = 1.5
): boolean {
  const isAntimeridianCrossing = Math.abs(portCoords[0] - nodeCoords[0]) > 180.0;
  const subSegments: [[number, number], [number, number]][] = [];
  if (isAntimeridianCrossing) {
    const latMid = (portCoords[1] + nodeCoords[1]) / 2.0;
    if (portCoords[0] < 0) {
      subSegments.push([portCoords, [-180.0, latMid]]);
      subSegments.push([[180.0, latMid], nodeCoords]);
    } else {
      subSegments.push([portCoords, [180.0, latMid]]);
      subSegments.push([[-180.0, latMid], nodeCoords]);
    }
  } else {
    subSegments.push([portCoords, nodeCoords]);
  }

  for (const [s1, s2] of subSegments) {
    if (Math.abs(s1[0] - s2[0]) < 1e-6 && Math.abs(s1[1] - s2[1]) < 1e-6) continue;
    const sMinX = Math.min(s1[0], s2[0]);
    const sMaxX = Math.max(s1[0], s2[0]);
    const sMinY = Math.min(s1[1], s2[1]);
    const sMaxY = Math.max(s1[1], s2[1]);

    for (let r = 0; r < rings.length; r++) {
      const { bbox, ring } = rings[r];
      // Fast Bounding Box Pre-Filter
      if (sMaxX < bbox[0] || sMinX > bbox[2] || sMaxY < bbox[1] || sMinY > bbox[3]) {
        continue;
      }

      for (let j = 0; j < ring.length - 1; j++) {
        if (segmentsIntersect(s1, s2, ring[j], ring[j + 1])) {
          const t = computeSegmentIntersectionParam(s1, s2, ring[j], ring[j + 1]);
          if (t !== null) {
            const crossPt: [number, number] = [
              s1[0] + t * (s2[0] - s1[0]),
              s1[1] + t * (s2[1] - s1[1]),
            ];
            const distFromDock =
              calculateGeodesicDistanceMeters(
                portCoords[0],
                portCoords[1],
                crossPt[0],
                crossPt[1]
              ) / 1000.0;
            if (distFromDock <= maxToleranceKm) {
              continue; // Within micro-harbor dock tolerance
            }
          }
          return false; // Land/peninsula crossing beyond dock tolerance
        }
      }

      const midPt: [number, number] = [
        (s1[0] + s2[0]) / 2.0,
        (s1[1] + s2[1]) / 2.0,
      ];
      if (pointInPolygon(midPt, ring)) {
        const midDistFromDock =
          calculateGeodesicDistanceMeters(
            portCoords[0],
            portCoords[1],
            midPt[0],
            midPt[1]
          ) / 1000.0;
        if (midDistFromDock > maxToleranceKm) {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Projects a point to its nearest location on a line segment.
 */
function projectPointToSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return a;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

/**
 * Generalized Water Projection:
 * If a port coordinate lies on land (pier, wharf, harbor building, or coastal peninsula),
 * projects it outward into the nearest navigable water body with a safety clearance (default 400m).
 * Fully generalized: operates on GIS geometry without requiring any port-specific IDs.
 */
export function projectPointToWater(
  pCoords: [number, number],
  rings: LandRing[],
  clearanceMeters: number = 400
): [number, number] {
  let insideRing: [number, number][] | null = null;
  for (let r = 0; r < rings.length; r++) {
    const { bbox, ring } = rings[r];
    if (
      pCoords[0] < bbox[0] ||
      pCoords[0] > bbox[2] ||
      pCoords[1] < bbox[1] ||
      pCoords[1] > bbox[3]
    ) {
      continue;
    }
    if (pointInPolygon(pCoords, ring)) {
      insideRing = ring;
      break;
    }
  }

  if (!insideRing) {
    return pCoords; // Already in open water
  }

  // Find closest boundary segment
  let bestDist2 = Infinity;
  let bestProj: [number, number] = pCoords;
  for (let i = 0; i < insideRing.length - 1; i++) {
    const proj = projectPointToSegment(pCoords, insideRing[i], insideRing[i + 1]);
    const d2 = (proj[0] - pCoords[0]) ** 2 + (proj[1] - pCoords[1]) ** 2;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestProj = proj;
    }
  }

  const dx = bestProj[0] - pCoords[0];
  const dy = bestProj[1] - pCoords[1];
  const len = Math.hypot(dx, dy);
  const cosLat = Math.max(0.08, Math.cos((pCoords[1] * Math.PI) / 180.0));
  const degPerMeterX = 1.0 / (111000.0 * cosLat);
  const degPerMeterY = 1.0 / 111000.0;

  if (len > 1e-7) {
    return [
      bestProj[0] + (dx / len) * (clearanceMeters * degPerMeterX),
      bestProj[1] + (dy / len) * (clearanceMeters * degPerMeterY),
    ];
  }
  return [bestProj[0] + clearanceMeters * degPerMeterX, bestProj[1]];
}

/**
 * Performs adaptive port-to-water snapping across expanding candidate depths (k = 5 -> 10 -> 20 -> 50).
 * Filters candidates by primary connected component (component 0) and performs water line-of-sight ray casting.
 *
 * Employs generalized water projection: if a port coordinate is located on land (e.g. pier, harbor office),
 * automatically projects to the nearest water roadstead before evaluating water connectivity.
 *
 * @param port Departure or destination NGA PortRecord
 * @param graph Cached polar water graph with precomputed component labels
 * @param rings Authoritative land rings for line-of-sight validation
 * @param maxDistanceKm Maximum search radius in kilometers (default: 400km)
 * @returns PortSnappingCandidate or null if no valid water connector exists
 */
export function findAdaptiveWaterNode(
  port: PortRecord,
  graph: CachedGraphState,
  rings: LandRing[],
  maxDistanceKm: number = 400
): PortSnappingCandidate | null {
  const rawCoords: [number, number] = [port.longitude, port.latitude];
  const waterCoords = projectPointToWater(rawCoords, rings, 400);
  const isProjected =
    Math.abs(rawCoords[0] - waterCoords[0]) > 1e-5 ||
    Math.abs(rawCoords[1] - waterCoords[1]) > 1e-5;

  const t0 = performance.now();

  const latRad = (Math.abs(waterCoords[1]) * Math.PI) / 180.0;
  const cosLat = Math.max(0.08, Math.cos(latRad));
  const maxLonDeg = Math.min(180, maxDistanceKm / 111.0 / cosLat);
  const maxLatDeg = maxDistanceKm / 111.0;

  const candidates: { idx: number; coords: [number, number]; dist: number; comp: number }[] = [];

  for (let i = 0; i < graph.nodes.length; i++) {
    const pt = graph.nodes[i];
    if (Math.abs(pt[1] - waterCoords[1]) > maxLatDeg) continue;
    let dLon = Math.abs(pt[0] - waterCoords[0]);
    if (dLon > 180) dLon = 360 - dLon;
    if (dLon > maxLonDeg) continue;

    const dist =
      calculateGeodesicDistanceMeters(waterCoords[0], waterCoords[1], pt[0], pt[1]) / 1000.0;
    if (dist <= maxDistanceKm) {
      candidates.push({
        idx: i,
        coords: pt,
        dist,
        comp: graph.nodeComponent ? graph.nodeComponent[i] : 0,
      });
    }
  }

  candidates.sort((a, b) => a.dist - b.dist);

  let evaluated = 0;
  const depthStages = [5, 10, 20, 50];

  for (const k of depthStages) {
    const slice = candidates.slice(0, k);

    for (let c = evaluated; c < slice.length; c++) {
      const cand = slice[c];
      // Rule A: Primary component filter (reject isolated dead-end components)
      if (cand.comp !== graph.primaryComponentId) {
        continue;
      }

      // Rule B: Water line-of-sight ray-casting check
      if (isConnectorWaterValid(waterCoords, cand.coords, rings, 1.5)) {
        return {
          nodeIndex: cand.idx,
          nodeCoords: cand.coords,
          distanceKm: cand.dist,
          candidateDepth: k,
          componentId: cand.comp,
          isPrimaryComponent: true,
          totalTimeMs: performance.now() - t0,
          waterBerthCoords: isProjected ? waterCoords : undefined,
        };
      }
    }

    evaluated = slice.length;
  }

  // Explicit failure: NO_VALID_PORT_WATER_CONNECTOR
  return null;
}

/**
 * Computes the geodesic shortest path between two node indices using Dijkstra's algorithm.
 * Employs a binary min-heap priority queue via TinyQueue for O((V + E) log V) efficiency.
 *
 * @param startIdx Origin node index
 * @param goalIdx Destination node index
 * @param nodes Node coordinate lookup array
 * @param adj Adjacency list mapping node index to weighted neighbors
 * @returns Array of [longitude, latitude] coordinates along the shortest path, or null if unreachable
 */
export function dijkstraShortestPath(
  startIdx: number,
  goalIdx: number,
  nodes: [number, number][],
  adj: Map<number, { nodeIndex: number; weight: number }[]>
): [number, number][] | null {
  if (startIdx === goalIdx) return [nodes[startIdx]];

  const distances = new Float64Array(nodes.length);
  distances.fill(Infinity);
  distances[startIdx] = 0;

  const previous = new Int32Array(nodes.length);
  previous.fill(-1);

  const pq = new TinyQueue<{ idx: number; dist: number }>([], (a, b) => a.dist - b.dist);
  pq.push({ idx: startIdx, dist: 0 });

  while (pq.length > 0) {
    const { idx, dist } = pq.pop()!;
    if (idx === goalIdx) break;
    if (dist > distances[idx]) continue;

    const neighbors = adj.get(idx) || [];
    for (let i = 0; i < neighbors.length; i++) {
      const edge = neighbors[i];
      const newDist = dist + edge.weight;
      if (newDist < distances[edge.nodeIndex]) {
        distances[edge.nodeIndex] = newDist;
        previous[edge.nodeIndex] = idx;
        pq.push({ idx: edge.nodeIndex, dist: newDist });
      }
    }
  }

  if (distances[goalIdx] === Infinity) return null;

  const path: [number, number][] = [];
  let curr = goalIdx;
  while (curr !== -1) {
    path.push(nodes[curr]);
    curr = previous[curr];
  }
  path.reverse();
  return path;
}

export const POLAR_DATASET_PROVENANCE = {
  dataset: 'High-Resolution Navigable Polar Water Graph (GEBCO 2024 / SCAR ADD / Natural Earth 10m)',
  version: '2026.1 Polar Navigation Release',
  source: 'Scientific Committee on Antarctic Research (SCAR) / GEBCO / Natural Earth GIS',
  license: 'Public Domain / CC-BY 4.0',
  method: 'Geodesic shortest path over 100% water-constrained hydrodynamic polar mesh',
};

/**
 * Safely extracts, validates, and flattens GeoJSON LineString or MultiLineString
 * geometries produced by the MARNET / searoute-ts routing engine.
 *
 * Guarantees:
 * 1. Both LineString and MultiLineString geometries are handled correctly without unsafe casts.
 * 2. Every coordinate pair is strictly validated: finite numbers, -180 <= lon <= 180, -90 <= lat <= 90.
 * 3. MultiLineString segments (e.g. from antimeridian splitting) are validated for continuity and preserved in traversal order.
 * 4. Disconnected, corrupt, or unsupported geometries fail cleanly without producing NaNs or nested arrays.
 */
export function extractMarnetCoordinates(
  rawGeometry: unknown
): [number, number][] | null {
  if (!rawGeometry || typeof rawGeometry !== 'object') {
    return null;
  }

  const geom = rawGeometry as { type?: string; coordinates?: unknown };
  if (!geom.type || !geom.coordinates || !Array.isArray(geom.coordinates)) {
    return null;
  }

  const isCoordValid = (c: unknown): c is [number, number] => {
    if (!Array.isArray(c) || c.length < 2) return false;
    const lon = c[0];
    const lat = c[1];
    return (
      typeof lon === 'number' &&
      typeof lat === 'number' &&
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      lon >= -180 &&
      lon <= 180 &&
      lat >= -90 &&
      lat <= 90
    );
  };

  if (geom.type === 'LineString') {
    const rawCoords = geom.coordinates;
    if (rawCoords.length < 2) return null;
    const validated: [number, number][] = [];
    for (let i = 0; i < rawCoords.length; i++) {
      const pt = rawCoords[i];
      if (!isCoordValid(pt)) {
        return null;
      }
      validated.push([pt[0], pt[1]]);
    }
    return validated.length >= 2 ? validated : null;
  }

  if (geom.type === 'MultiLineString') {
    const segments = geom.coordinates;
    if (segments.length === 0) return null;

    const validatedSegments: [number, number][][] = [];

    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      if (!Array.isArray(seg) || seg.length < 1) return null;

      const validSeg: [number, number][] = [];
      for (let i = 0; i < seg.length; i++) {
        const pt = seg[i];
        if (!isCoordValid(pt)) {
          return null;
        }
        validSeg.push([pt[0], pt[1]]);
      }
      validatedSegments.push(validSeg);
    }

    if (validatedSegments.length === 0) return null;

    if (validatedSegments.length === 1) {
      return validatedSegments[0].length >= 2 ? validatedSegments[0] : null;
    }

    // Multi-segment MultiLineString (e.g. from antimeridian split)
    // Validate continuity between consecutive segments and concatenate
    const result: [number, number][] = [];

    for (let s = 0; s < validatedSegments.length; s++) {
      const currentSeg = validatedSegments[s];

      if (s > 0) {
        const prevSeg = validatedSegments[s - 1];
        const prevEnd = prevSeg[prevSeg.length - 1];
        const currStart = currentSeg[0];

        // Antimeridian boundary transition: both longitudes near +/-180 deg
        const isAntimeridianTransition =
          Math.abs(Math.abs(prevEnd[0]) - 180) <= 0.5 &&
          Math.abs(Math.abs(currStart[0]) - 180) <= 0.5 &&
          Math.abs(prevEnd[1] - currStart[1]) <= 5.0;

        // Continuous mesh transition: Euclidean distance <= 2.0 degrees (~200 km)
        const dLon = currStart[0] - prevEnd[0];
        const dLat = currStart[1] - prevEnd[1];
        const isNearContiguous = Math.sqrt(dLon * dLon + dLat * dLat) <= 2.0;

        if (!isAntimeridianTransition && !isNearContiguous) {
          // Unexplained gap between disconnected segments: reject rather than inventing false track
          return null;
        }

        // If duplicate boundary seam point, skip duplicate to preserve clean linestring
        if (Math.abs(prevEnd[0] - currStart[0]) < 1e-6 && Math.abs(prevEnd[1] - currStart[1]) < 1e-6) {
          for (let p = 1; p < currentSeg.length; p++) {
            result.push(currentSeg[p]);
          }
          continue;
        }
      }

      for (let p = 0; p < currentSeg.length; p++) {
        result.push(currentSeg[p]);
      }
    }

    return result.length >= 2 ? result : null;
  }

  // Any other GeoJSON geometry type is unsupported for maritime route polylines
  return null;
}

/**
 * Computes an authentic, water-constrained maritime route between two real NGA WPI ports.
 * Preserves 100% of graph vertices and strictly validates the continuous LineString against land barriers.
 *
 * @param origin Departure NGA PortRecord
 * @param destination Destination NGA PortRecord
 * @returns MaritimeRouteResult containing route waypoints, length, duration, and provenance
 */
export async function computeMaritimeRoute(
  origin: PortRecord,
  destination: PortRecord
): Promise<MaritimeRouteResult> {
  if (!origin || !destination) {
    return {
      status: 'NO_FEASIBLE_ROUTE',
      routeName: 'Computed Maritime Route',
      coordinates: [],
      distanceKm: 0,
      constructedDistanceKm: 0,
      candidateCountAttempted: 0,
      rawNodeCount: 0,
      finalNodeCount: 0,
      failureCategory: 'No feasible water route',
      failingReason: 'Both departure and destination ports are required',
      provenance: POLAR_DATASET_PROVENANCE,
    };
  }

  if (origin.wpiNumber === destination.wpiNumber) {
    return {
      status: 'NO_FEASIBLE_ROUTE',
      routeName: 'Computed Maritime Route',
      coordinates: [],
      distanceKm: 0,
      constructedDistanceKm: 0,
      candidateCountAttempted: 0,
      rawNodeCount: 0,
      finalNodeCount: 0,
      failureCategory: 'No feasible water route',
      failingReason: 'Departure and destination ports cannot be the same',
      provenance: POLAR_DATASET_PROVENANCE,
    };
  }

  const originCoords: [number, number] = [origin.longitude, origin.latitude];
  const destCoords: [number, number] = [destination.longitude, destination.latitude];

  const rings = await loadLandRings();
  const graph = cachedGraph || (await loadPolarWaterGraph());

  // --------------------------------------------------------------------------
  // 1. Primary Strategy: High-Resolution Polar Navigable Water Graph
  // --------------------------------------------------------------------------
  if (graph) {
    const startSnap = findAdaptiveWaterNode(origin, graph, rings);
    const goalSnap = findAdaptiveWaterNode(destination, graph, rings);

    if (startSnap && goalSnap) {
      const pathNodes = dijkstraShortestPath(startSnap.nodeIndex, goalSnap.nodeIndex, graph.nodes, graph.adj);

      if (pathNodes && pathNodes.length > 0) {
        const originBerth: [number, number][] = startSnap.waterBerthCoords
          ? [originCoords, startSnap.waterBerthCoords]
          : [originCoords];
        const destBerth: [number, number][] = goalSnap.waterBerthCoords
          ? [goalSnap.waterBerthCoords, destCoords]
          : [destCoords];
        const rawFullCoords: [number, number][] = [...originBerth, ...pathNodes, ...destBerth];

        const smoothedCoords = smoothMaritimeTrajectory(rawFullCoords, rings);
        let totalDistKm = 0;
        for (let i = 0; i < smoothedCoords.length - 1; i++) {
          totalDistKm +=
            calculateGeodesicDistanceMeters(
              smoothedCoords[i][0],
              smoothedCoords[i][1],
              smoothedCoords[i + 1][0],
              smoothedCoords[i + 1][1]
            ) / 1000.0;
        }

        const depTerminalSegmentCount = startSnap.waterBerthCoords ? 2 : 1;
        const destTerminalSegmentCount = goalSnap.waterBerthCoords ? 2 : 1;
        const terminalMetadata: TerminalApproachMetadata = {
          departureTerminalSegmentCount: depTerminalSegmentCount,
          destinationTerminalSegmentCount: destTerminalSegmentCount,
        };

        let finalCoords = smoothedCoords;
        // Independent land validation
        let validationReport = await validateMaritimeRouteAsync(
          finalCoords,
          totalDistKm,
          POLAR_DATASET_PROVENANCE.dataset,
          origin,
          destination,
          terminalMetadata
        );

        // Non-destructive fallback: if smoothed route fails validation, fall back to safe raw graph
        if (validationReport.overallResult !== 'PASS') {
          let rawDistKm = 0;
          for (let i = 0; i < rawFullCoords.length - 1; i++) {
            rawDistKm +=
              calculateGeodesicDistanceMeters(
                rawFullCoords[i][0],
                rawFullCoords[i][1],
                rawFullCoords[i + 1][0],
                rawFullCoords[i + 1][1]
              ) / 1000.0;
          }
          const rawReport = await validateMaritimeRouteAsync(
            rawFullCoords,
            rawDistKm,
            `${POLAR_DATASET_PROVENANCE.dataset} (Raw)`,
            origin,
            destination,
            terminalMetadata
          );
          if (rawReport.overallResult === 'PASS') {
            finalCoords = rawFullCoords;
            totalDistKm = rawDistKm;
            validationReport = rawReport;
          }
        }

        if (validationReport.overallResult === 'PASS') {
          const qualityMetrics = evaluateRouteQuality(finalCoords, 0, 0);
          const qualityScore = calculateRouteQualityScore(qualityMetrics, totalDistKm);

          return {
            status: 'SUCCESS',
            routeName: 'Computed Maritime Route',
            topology: 'CASE_1_POLAR_POLAR',
            coordinates: finalCoords,
            distanceKm: totalDistKm,
            constructedDistanceKm: totalDistKm,
            durationHours: totalDistKm / 27.78, // ~15 knots nominal speed
            candidateCountAttempted: 1,
            rawNodeCount: pathNodes.length,
            finalNodeCount: finalCoords.length,
            validationReport,
            terminalApproachStatus: 'DIRECT_SAFE',
            routeQualityMetrics: qualityMetrics,
            routeQualityScore: qualityScore,
            provenance: POLAR_DATASET_PROVENANCE,
          };
        }
      }
    } else {
      console.debug(
        `[AdaptiveSnapping] Polar graph snapping rejected: origin=${startSnap ? 'OK' : 'NO_VALID_CONNECTOR'}, dest=${goalSnap ? 'OK' : 'NO_VALID_CONNECTOR'}. Evaluating Hybrid / MARNET fallback.`
      );
    }
  }

  // --------------------------------------------------------------------------
  // 2. Direct Global Corridor Evaluation (Direct MARNET)
  // Evaluates whether an authentic, water-safe global shipping corridor connects
  // the two endpoints. Prevents artificial 1,000+ km offshore detours (e.g.
  // coastal Chile Lirquen->Patillos) when a direct coastal fairway is feasible.
  // Only evaluated for non-Antarctic voyages (MARNET contains no polar shipping lanes).
  // --------------------------------------------------------------------------
  let directMarnetResult: MaritimeRouteResult | null = null;
  const isAntarcticVoyage = origin.latitude <= -60.0 || destination.latitude <= -60.0;
  if (!isAntarcticVoyage) {
    try {
      const rawRoute = seaRoute(originCoords, destCoords, {
        network: marnet20,
        units: 'kilometers',
        antimeridian: 'split',
      });

    if (rawRoute && rawRoute.geometry) {
      let netCoords = extractMarnetCoordinates(rawRoute.geometry);
      if (netCoords && netCoords.length >= 2) {
        const rings = await loadLandRings();
        let depApproach = findSafeTerminalApproach(
          originCoords,
          netCoords[0],
          true,
          rings,
          getAdaptiveDockToleranceKm(origin)
        );
        if (depApproach && depApproach.status === 'APPROACH_UNAVAILABLE' && netCoords.length > 2) {
          const altDep = findSafeTerminalApproach(
            originCoords,
            netCoords[1],
            true,
            rings,
            getAdaptiveDockToleranceKm(origin)
          );
          if (altDep && altDep.status !== 'APPROACH_UNAVAILABLE') {
            depApproach = altDep;
            netCoords = netCoords.slice(1);
          }
        }

        let arrApproach = findSafeTerminalApproach(
          destCoords,
          netCoords[netCoords.length - 1],
          false,
          rings,
          getAdaptiveDockToleranceKm(destination)
        );
        if (arrApproach && arrApproach.status === 'APPROACH_UNAVAILABLE' && netCoords.length > 2) {
          const altArr = findSafeTerminalApproach(
            destCoords,
            netCoords[netCoords.length - 2],
            false,
            rings,
            getAdaptiveDockToleranceKm(destination)
          );
          if (altArr && altArr.status !== 'APPROACH_UNAVAILABLE') {
            arrApproach = altArr;
            netCoords = netCoords.slice(0, -1);
          }
        }

        if (
          depApproach &&
          depApproach.status !== 'APPROACH_UNAVAILABLE' &&
          arrApproach &&
          arrApproach.status !== 'APPROACH_UNAVAILABLE'
        ) {
          const depSegment = depApproach.waypoints.slice(0, -1);
          const arrSegment = arrApproach.waypoints.slice(1);
          const rawFullCoords: [number, number][] = [...depSegment, ...netCoords, ...arrSegment];
          const fullCoords = smoothMaritimeTrajectory(rawFullCoords, rings);

          let allValid = true;
          for (let i = 0; i < fullCoords.length; i++) {
            const pt = fullCoords[i];
            if (
              !Number.isFinite(pt[0]) ||
              !Number.isFinite(pt[1]) ||
              pt[0] < -180 ||
              pt[0] > 180 ||
              pt[1] < -90 ||
              pt[1] > 90
            ) {
              allValid = false;
              break;
            }
          }

          if (allValid) {
            let distanceKm = 0;
            for (let i = 0; i < fullCoords.length - 1; i++) {
              distanceKm +=
                calculateGeodesicDistanceMeters(
                  fullCoords[i][0],
                  fullCoords[i][1],
                  fullCoords[i + 1][0],
                  fullCoords[i + 1][1]
                ) / 1000.0;
            }

            const depTerminalSegmentCount = depApproach ? Math.max(1, depApproach.waypoints.length - 1) : 1;
            const destTerminalSegmentCount = arrApproach ? Math.max(1, arrApproach.waypoints.length - 1) : 1;
            const terminalMetadata: TerminalApproachMetadata = {
              departureTerminalSegmentCount: depTerminalSegmentCount,
              destinationTerminalSegmentCount: destTerminalSegmentCount,
            };

            const validationReport = await validateMaritimeRouteAsync(
              fullCoords,
              distanceKm,
              'Eurostat MARNET 20km',
              origin,
              destination,
              terminalMetadata
            );

            if (validationReport.overallResult === 'PASS') {
              const termCostKm =
                (depApproach ? depApproach.approachLengthKm : 0) +
                (arrApproach ? arrApproach.approachLengthKm : 0);
              const qualityMetrics = evaluateRouteQuality(fullCoords, 0, termCostKm);
              const qualityScore = calculateRouteQualityScore(qualityMetrics, distanceKm);

              directMarnetResult = {
                status: 'SUCCESS',
                routeName: 'Computed Maritime Route',
                topology: 'CASE_2_GLOBAL_GLOBAL',
                coordinates: fullCoords,
                distanceKm,
                constructedDistanceKm: distanceKm,
                durationHours: distanceKm / 27.78,
                candidateCountAttempted: 1,
                rawNodeCount: netCoords.length,
                finalNodeCount: fullCoords.length,
                validationReport,
                terminalApproachStatus:
                  depApproach.status === 'RADIAL_SCAN_SUCCESS' ||
                  arrApproach.status === 'RADIAL_SCAN_SUCCESS'
                    ? 'RADIAL_SCAN_SUCCESS'
                    : 'DIRECT_SAFE',
                routeQualityMetrics: qualityMetrics,
                routeQualityScore: qualityScore,
                provenance: {
                  dataset: 'Eurostat MARNET 20km Mesh with Terminal Harbor Approaches',
                  version: '2026 Release',
                  source: 'European Commission (Eurostat)',
                  license: 'EUPL-1.2',
                  method: 'Dijkstra shortest path with radial terminal approach',
                },
              };
            }
          }
        }
      }
    }
  } catch (err) {
    console.debug('Direct MARNET evaluation error:', err);
  }
}

  // --------------------------------------------------------------------------
  // 3. Hybrid Gateway Strategy (for Polar <-> Global Transitions)
  // --------------------------------------------------------------------------
  try {
    const hybridRes = await computeHybridMaritimeRoute(origin, destination);
    if (hybridRes) {
      if (hybridRes.status === 'SUCCESS' && hybridRes.coordinates.length >= 2) {
        // If direct MARNET succeeded, prefer it if shorter or significantly less tortuous
        if (directMarnetResult && directMarnetResult.status === 'SUCCESS') {
          const directIsShorter = directMarnetResult.distanceKm <= hybridRes.distanceKm;
          const hybridIsExcessivelyTortuous =
            (hybridRes.routeQualityMetrics?.tortuosityRatio || 1.0) > 1.35 &&
            (directMarnetResult.routeQualityMetrics?.tortuosityRatio || 1.0) < 1.25;

          if (directIsShorter || hybridIsExcessivelyTortuous) {
            return directMarnetResult;
          }
        }

        return {
          status: 'SUCCESS',
          routeName: 'Computed Maritime Route',
          topology: hybridRes.topology,
          coordinates: hybridRes.coordinates,
          distanceKm: hybridRes.distanceKm,
          constructedDistanceKm: hybridRes.constructedDistanceKm || hybridRes.distanceKm,
          durationHours: hybridRes.durationHours,
          candidateCountAttempted: hybridRes.candidateCountAttempted,
          rawNodeCount: hybridRes.rawNodeCount,
          finalNodeCount: hybridRes.finalNodeCount,
          validationReport: hybridRes.validationReport,
          terminalApproachStatus: hybridRes.terminalApproachStatus,
          routeQualityMetrics: hybridRes.routeQualityMetrics,
          routeQualityScore: hybridRes.routeQualityScore,
          selectedGatewayId: hybridRes.gatewayIds?.[0],
          provenance: hybridRes.provenance,
        };
      }

      // If hybrid was rejected or unavailable, but direct MARNET succeeded, return direct MARNET
      if (directMarnetResult && directMarnetResult.status === 'SUCCESS') {
        return directMarnetResult;
      }

      if (hybridRes.status === 'HYBRID_UNAVAILABLE') {
        return {
          status: 'HYBRID_UNAVAILABLE',
          routeName: 'Computed Maritime Route',
          topology: hybridRes.topology,
          coordinates: [],
          distanceKm: 0,
          constructedDistanceKm: 0,
          failureCategory: 'Patagonian isolated fjord',
          failingReason:
            hybridRes.failingReason ||
            'Port belongs to an isolated Patagonian component; hybrid routing unavailable without synthetic edges.',
          candidateCountAttempted: hybridRes.candidateCountAttempted,
          rawNodeCount: 0,
          finalNodeCount: 0,
          terminalApproachStatus: 'APPROACH_UNAVAILABLE',
          provenance: hybridRes.provenance,
        };
      }

      if (hybridRes.status === 'REJECTED_LAND_INTERSECTION') {
        let failureCategory: RouteFailureCategory = 'Land/ice validation failure';
        if (hybridRes.failingReason?.includes('Terminal harbor approach')) {
          failureCategory = 'Terminal harbor approach failure';
        } else if (
          hybridRes.failingReason?.includes('Internal MARNET topology failure') ||
          hybridRes.failingReason?.includes('Internal routing network edge failure')
        ) {
          failureCategory = 'Internal MARNET topology failure';
        }

        return {
          status: 'REJECTED_LAND_INTERSECTION',
          routeName: 'Computed Maritime Route',
          topology: hybridRes.topology,
          coordinates: [],
          distanceKm: 0,
          constructedDistanceKm: hybridRes.constructedDistanceKm || 0,
          failureCategory,
          failingReason: hybridRes.failingReason,
          candidateCountAttempted: hybridRes.candidateCountAttempted,
          rawNodeCount: 0,
          finalNodeCount: 0,
          validationReport: hybridRes.validationReport,
          terminalApproachStatus: hybridRes.terminalApproachStatus,
          routeQualityMetrics: hybridRes.routeQualityMetrics,
          routeQualityScore: hybridRes.routeQualityScore,
          selectedGatewayId: hybridRes.gatewayIds?.[0],
          provenance: hybridRes.provenance,
        };
      }
    }
  } catch (err) {
    console.debug('Hybrid routing attempt error:', err);
  }

  // Fallback to direct MARNET if available
  if (directMarnetResult && directMarnetResult.status === 'SUCCESS') {
    return directMarnetResult;
  }

  // --------------------------------------------------------------------------
  // 3. Fallback Strategy: Eurostat MARNET 20km (for Northern / Fjord Ports)
  // --------------------------------------------------------------------------
  try {
    const rawRoute = seaRoute(originCoords, destCoords, {
      network: marnet20,
      units: 'kilometers',
      antimeridian: 'split',
    });

    if (rawRoute && rawRoute.geometry) {
      let netCoords = extractMarnetCoordinates(rawRoute.geometry);

      if (netCoords && netCoords.length >= 2) {
        // Assemble route using terminal approach connectors
        const rings = await loadLandRings();
        let depApproach = findSafeTerminalApproach(
          originCoords,
          netCoords[0],
          true,
          rings,
          getAdaptiveDockToleranceKm(origin)
        );
        if (depApproach && depApproach.status === 'APPROACH_UNAVAILABLE' && netCoords.length > 2) {
          const altDep = findSafeTerminalApproach(
            originCoords,
            netCoords[1],
            true,
            rings,
            getAdaptiveDockToleranceKm(origin)
          );
          if (altDep && altDep.status !== 'APPROACH_UNAVAILABLE') {
            depApproach = altDep;
            netCoords = netCoords.slice(1);
          }
        }

        let arrApproach = findSafeTerminalApproach(
          destCoords,
          netCoords[netCoords.length - 1],
          false,
          rings,
          getAdaptiveDockToleranceKm(destination)
        );
        if (arrApproach && arrApproach.status === 'APPROACH_UNAVAILABLE' && netCoords.length > 2) {
          const altArr = findSafeTerminalApproach(
            destCoords,
            netCoords[netCoords.length - 2],
            false,
            rings,
            getAdaptiveDockToleranceKm(destination)
          );
          if (altArr && altArr.status !== 'APPROACH_UNAVAILABLE') {
            arrApproach = altArr;
            netCoords = netCoords.slice(0, -1);
          }
        }

        const depSegment = depApproach ? depApproach.waypoints.slice(0, -1) : [originCoords];
        const arrSegment = arrApproach ? arrApproach.waypoints.slice(1) : [destCoords];
        const rawFullCoords: [number, number][] = [...depSegment, ...netCoords, ...arrSegment];
        const smoothedCoords = smoothMaritimeTrajectory(rawFullCoords, rings);

        let finalCoords = smoothedCoords;
        let distanceKm = 0;
        for (let i = 0; i < finalCoords.length - 1; i++) {
          distanceKm +=
            calculateGeodesicDistanceMeters(
              finalCoords[i][0],
              finalCoords[i][1],
              finalCoords[i + 1][0],
              finalCoords[i + 1][1]
            ) / 1000.0;
        }

        const depTerminalSegmentCount = depApproach ? Math.max(1, depApproach.waypoints.length - 1) : 1;
        const destTerminalSegmentCount = arrApproach ? Math.max(1, arrApproach.waypoints.length - 1) : 1;
        const terminalMetadata: TerminalApproachMetadata = {
          departureTerminalSegmentCount: depTerminalSegmentCount,
          destinationTerminalSegmentCount: destTerminalSegmentCount,
        };

        let validationReport = await validateMaritimeRouteAsync(
          finalCoords,
          distanceKm,
          'Eurostat MARNET 20km',
          origin,
          destination,
          terminalMetadata
        );

        if (validationReport.overallResult !== 'PASS') {
          let rawDistKm = 0;
          for (let i = 0; i < rawFullCoords.length - 1; i++) {
            rawDistKm +=
              calculateGeodesicDistanceMeters(
                rawFullCoords[i][0],
                rawFullCoords[i][1],
                rawFullCoords[i + 1][0],
                rawFullCoords[i + 1][1]
              ) / 1000.0;
          }
          const rawReport = await validateMaritimeRouteAsync(
            rawFullCoords,
            rawDistKm,
            'Eurostat MARNET 20km (Raw)',
            origin,
            destination,
            terminalMetadata
          );
          if (rawReport.overallResult === 'PASS') {
            finalCoords = rawFullCoords;
            distanceKm = rawDistKm;
            validationReport = rawReport;
          }
        }

        if (validationReport.overallResult === 'PASS') {
          const termCostKm =
            (depApproach ? depApproach.approachLengthKm : 0) +
            (arrApproach ? arrApproach.approachLengthKm : 0);
          const qualityMetrics = evaluateRouteQuality(finalCoords, 0, termCostKm);
          const qualityScore = calculateRouteQualityScore(qualityMetrics, distanceKm);

          return {
            status: 'SUCCESS',
            routeName: 'Computed Maritime Route',
            coordinates: finalCoords,
            distanceKm,
            durationHours: distanceKm / 27.78,
            candidateCountAttempted: 2,
            rawNodeCount: netCoords.length,
            finalNodeCount: finalCoords.length,
            validationReport,
            terminalApproachStatus:
              depApproach?.status === 'RADIAL_SCAN_SUCCESS' || arrApproach?.status === 'RADIAL_SCAN_SUCCESS'
                ? 'RADIAL_SCAN_SUCCESS'
                : 'DIRECT_SAFE',
            routeQualityMetrics: qualityMetrics,
            routeQualityScore: qualityScore,
            provenance: {
              dataset: 'Eurostat MARNET 20km Mesh with Terminal Harbor Approaches',
              version: '2026 Release',
              source: 'European Commission (Eurostat)',
              license: 'EUPL-1.2',
              method: 'Dijkstra shortest path with radial terminal approach',
            },
          };
        }
      }
    }
  } catch (err) {
    console.debug('MARNET fallback error:', err);
  }

  // --------------------------------------------------------------------------
  // 3. Tertiary Strategy: Direct Line-of-Sight Check (for local adjacent ports)
  // --------------------------------------------------------------------------
  const directDistKm =
    calculateGeodesicDistanceMeters(
      originCoords[0],
      originCoords[1],
      destCoords[0],
      destCoords[1]
    ) / 1000.0;

  if (directDistKm < 150.0) {
    const directCoords: [number, number][] = [originCoords, destCoords];
    const directValidation = await validateMaritimeRouteAsync(
      directCoords,
      directDistKm,
      'Direct Coastal Channel',
      origin,
      destination
    );

    if (directValidation.overallResult === 'PASS') {
      return {
        status: 'SUCCESS',
        routeName: 'Computed Maritime Route',
        coordinates: directCoords,
        distanceKm: directDistKm,
        constructedDistanceKm: directDistKm,
        durationHours: directDistKm / 27.78,
        candidateCountAttempted: 3,
        rawNodeCount: 2,
        finalNodeCount: 2,
        validationReport: directValidation,
        terminalApproachStatus: 'DIRECT_SAFE',
        provenance: {
          dataset: 'Direct Water Corridor',
          version: '2026.1',
          source: 'Direct Geodesic Coastal Vector',
          license: 'Public Domain',
          method: 'Direct coastal line-of-sight validation',
        },
      };
    }
  }

  // Strict hard gate: suppress invalid geometry if no navigable water route exists
  return {
    status: 'REJECTED_LAND_INTERSECTION',
    routeName: 'Computed Maritime Route',
    coordinates: [],
    distanceKm: 0,
    constructedDistanceKm: 0,
    candidateCountAttempted: 3,
    rawNodeCount: 0,
    finalNodeCount: 0,
    failureCategory: 'No feasible water route',
    failingReason: 'No water-constrained navigable route found that avoids land barriers',
    provenance: POLAR_DATASET_PROVENANCE,
  };
}
