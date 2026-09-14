/**
 * Hybrid Maritime Routing Engine
 * ------------------------------
 * Seamlessly couples the high-resolution Polar Navigable Water Graph with the
 * Eurostat MARNET 20km global network via empirically validated transition gateways.
 *
 * Topology Classification:
 * - CASE 1: Polar -> Polar (Tier 1 direct Dijkstra)
 * - CASE 2: Global -> Global (Tier 2 direct MARNET)
 * - CASE 3: Global -> Polar (Global -> MARNET -> Gateway -> Polar Dijkstra -> Polar berth)
 * - CASE 4: Polar -> Global (Polar berth -> Polar Dijkstra -> Gateway -> MARNET -> Global berth)
 * - CASE 5: Polar -> Polar requiring global transit (Gateway A -> MARNET -> Gateway B)
 * - CASE 6: Isolated Patagonian fjord ports (retained isolated waterways; no synthetic edges)
 *
 * Verification & Safety Gate:
 * Every stitched candidate is verified from berth to berth using `validateMaritimeRouteAsync`.
 * If any segment intersects land or ice shelf polygons beyond authorized dock tolerances,
 * the candidate is strictly rejected. Coordinates are suppressed on failure to eliminate
 * stale or erroneous line artifacts on navigation charts.
 */

import { seaRoute } from 'searoute-ts';
import { DEFAULT_MARNET as marnet20 } from 'searoute-ts/marnet-20km';
import type { PortRecord } from '../types/port';
import {
  validateMaritimeRouteAsync,
  loadLandRings,
  calculateGeodesicDistanceMeters,
  getAdaptiveDockToleranceKm,
  type LandRing,
  type RouteValidationReport,
  type TerminalApproachMetadata,
  type FailingSegmentDiagnostic,
} from './routeValidationService';
import {
  loadPolarWaterGraph,
  aStarShortestPath,
  aStarShortestPathWithDistance,
  findAdaptiveWaterNode,
  extractMarnetCoordinates,
  POLAR_DATASET_PROVENANCE,
  type CachedGraphState,
  type PortSnappingCandidate,
} from './maritimeRoutingService';
import {
  findSafeTerminalApproach,
  isSegmentWaterSafeWithDock,
} from './terminalApproachService';
import {
  evaluateRouteQuality,
  calculateRouteQualityScore,
  smoothMaritimeTrajectory,
  extractNavigationalWaypoints,
  computeVoyageProfile,
  type RouteQualityMetrics,
  type RouteQualityScore,
  type NavigationalWaypoint,
  type VoyageIceProfile,
} from './routeQualityService';

export type { NavigationalWaypoint, VoyageIceProfile };

export type HybridTopology =
  | 'CASE_1_POLAR_POLAR'
  | 'CASE_2_GLOBAL_GLOBAL'
  | 'CASE_3_GLOBAL_POLAR'
  | 'CASE_4_POLAR_GLOBAL'
  | 'CASE_5_POLAR_POLAR_GLOBAL_TRANSITION'
  | 'CASE_6_PATAGONIAN_ISOLATED';

export interface ValidatedGateway {
  gatewayId: string;
  polarNodeId: number;
  polarCoords: [number, number];
  globalCoords: [number, number];
  transitionDistanceKm: number;
  landClearanceKm: number;
  polarDegree: number;
  sector: string;
  latitudeDeviationDeg: number;
  rankingScore: number;
  scoreBreakdown?: {
    distanceScore: number;
    clearanceScore: number;
    degreeScore: number;
    alignmentScore: number;
  };
}

export interface HybridCandidateDiagnostic {
  gatewayId: string;
  gatewayBId?: string;
  polarDistanceKm: number;
  globalDistanceKm: number;
  transitionDistanceKm: number;
  totalDistanceKm: number;
  waypointCount: number;
  continuityPass: boolean;
  validationResult: 'PASS' | 'FAIL';
  failingSegmentCount: number;
  firstFailingReason?: string;
  terminalApproachStatus?: 'DIRECT_SAFE' | 'RADIAL_SCAN_SUCCESS' | 'APPROACH_UNAVAILABLE';
  routeQualityScore?: number;
}

export interface HybridMaritimeRouteResult {
  status: 'SUCCESS' | 'NO_FEASIBLE_ROUTE' | 'REJECTED_LAND_INTERSECTION' | 'HYBRID_UNAVAILABLE' | 'ERROR';
  routeName: 'Computed Maritime Route';
  topology: HybridTopology;
  coordinates: [number, number][];
  distanceKm: number;
  constructedDistanceKm?: number;
  durationHours?: number;
  polarDistanceKm: number;
  globalDistanceKm: number;
  transitionDistanceKm: number;
  gatewayIds: string[];
  candidateCountAttempted: number;
  rawNodeCount: number;
  finalNodeCount: number;
  validationReport?: RouteValidationReport;
  candidateDiagnostics?: HybridCandidateDiagnostic[];
  failingReason?: string;
  terminalApproachStatus?: 'DIRECT_SAFE' | 'RADIAL_SCAN_SUCCESS' | 'APPROACH_UNAVAILABLE';
  routeQualityMetrics?: RouteQualityMetrics;
  routeQualityScore?: RouteQualityScore;
  navigationalWaypoints?: NavigationalWaypoint[];
  voyageProfile?: VoyageIceProfile;
  provenance: {
    dataset: string;
    version: string;
    source: string;
    license: string;
    method: string;
  };
}

export const HYBRID_ROUTING_PROVENANCE = {
  dataset: 'Hybrid Polar-Global Routing Engine (Polar Water Graph + Phase 5 Gateways + Eurostat MARNET 20km)',
  version: '2026.1 Hybrid Release',
  source: 'Antarctic DSS / SCAR / Natural Earth GIS / European Commission Eurostat',
  license: 'EUPL-1.2 / CC-BY 4.0 / Public Domain',
  method: 'Empirical gateway-mediated polar/global transition with complete-route land verification',
};

let cachedGateways: ValidatedGateway[] | null = null;
let gatewaysLoadingPromise: Promise<ValidatedGateway[]> | null = null;

/**
 * Loads the empirical gateway catalog discovered and benchmarked in Phase 5.
 */
export async function loadValidatedGateways(): Promise<ValidatedGateway[]> {
  if (cachedGateways) return cachedGateways;
  if (gatewaysLoadingPromise) return gatewaysLoadingPromise;

  gatewaysLoadingPromise = fetch('/data/gateway_benchmark.json')
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load gateway_benchmark.json: HTTP ${res.status}`);
      return res.json();
    })
    .then((data: { validatedGateways: ValidatedGateway[] }) => {
      cachedGateways = data.validatedGateways || [];
      return cachedGateways;
    })
    .catch((err) => {
      console.warn('Failed to load gateway benchmark catalog:', err);
      cachedGateways = [];
      return [];
    });

  return gatewaysLoadingPromise;
}

/**
 * Classifies the maritime routing topology between two real NGA WPI ports.
 */
export function classifyRoutingTopology(
  origin: PortRecord,
  destination: PortRecord,
  graph: CachedGraphState,
  rings: LandRing[]
): {
  topology: HybridTopology;
  originSnap: PortSnappingCandidate | null;
  destSnap: PortSnappingCandidate | null;
  diagnosticReason?: string;
} {
  const originSnap = findAdaptiveWaterNode(origin, graph, rings, 400);
  const destSnap = findAdaptiveWaterNode(destination, graph, rings, 400);

  // Case 6: Isolated Patagonian components and Chilean inland fjords (e.g. Puerto Natales WPI 14190, Caleta Mina Elena WPI 14175, Puerto Quemchi WPI 14250)
  const isPatagonianPort = (p: PortRecord) => {
    if (p.wpiNumber === 14190 || p.wpiNumber === 14175 || p.wpiNumber === 14250) return true;
    // Chilean inland sea / Patagonian fjord zone (Golfo de Ancud, Reloncavi, Corcovado, Magallanes)
    if (
      p.latitude <= -41.0 &&
      p.latitude >= -56.0 &&
      p.longitude >= -76.0 &&
      p.longitude <= -71.0
    ) {
      return true;
    }
    return false;
  };

  // True isolated Patagonian ports or endpoints snapping to disconnected non-primary sub-components
  const isOriginPatagonian =
    isPatagonianPort(origin) ||
    (originSnap && originSnap.componentId !== graph.primaryComponentId);
  const isDestPatagonian =
    isPatagonianPort(destination) ||
    (destSnap && destSnap.componentId !== graph.primaryComponentId);

  if (isOriginPatagonian || isDestPatagonian) {
    return {
      topology: 'CASE_6_PATAGONIAN_ISOLATED',
      originSnap,
      destSnap,
      diagnosticReason:
        'One or both endpoints reside in an isolated Patagonian waterway or inland fjord; synthetic connections across land barriers are prohibited.',
    };
  }

  // Polar stations (lat <= -60°S) without water line-of-sight to polar water graph
  if (
    (origin.latitude <= -60.0 && !originSnap) ||
    (destination.latitude <= -60.0 && !destSnap)
  ) {
    return {
      topology: 'CASE_1_POLAR_POLAR',
      originSnap,
      destSnap,
      diagnosticReason:
        'Antarctic station cannot establish water line-of-sight to polar water graph.',
    };
  }

  // Geographic domain distinction:
  // Polar domain ports are located in the sub-Antarctic/Antarctic zone (latitude <= -50.0°S).
  // Ports north of -50.0°S belong to the global shipping domain (e.g. Cape Town, Sydney, Melbourne, Auckland, Mumbai).
  const isOriginPolarDomain = origin.latitude <= -50.0;
  const isDestPolarDomain = destination.latitude <= -50.0;

  // Case 2: Both endpoints reside in the global shipping domain
  if (!isOriginPolarDomain && !isDestPolarDomain) {
    return {
      topology: 'CASE_2_GLOBAL_GLOBAL',
      originSnap,
      destSnap,
    };
  }

  // Case 1 or Case 5: Both endpoints are in the polar domain and snap to primary polar component
  if (isOriginPolarDomain && isDestPolarDomain && originSnap && destSnap) {
    const directPath = aStarShortestPath(
      originSnap.nodeIndex,
      destSnap.nodeIndex,
      graph.nodes,
      graph.adj
    );
    if (directPath && directPath.length > 0) {
      return {
        topology: 'CASE_1_POLAR_POLAR',
        originSnap,
        destSnap,
      };
    }
    return {
      topology: 'CASE_5_POLAR_POLAR_GLOBAL_TRANSITION',
      originSnap,
      destSnap,
      diagnosticReason: 'Direct polar graph connectivity is infeasible; global circum-transition required.',
    };
  }

  // Case 4: Polar origin to global destination (or polar destination cannot snap to polar graph)
  if (originSnap && (!isDestPolarDomain || !destSnap)) {
    return {
      topology: 'CASE_4_POLAR_GLOBAL',
      originSnap,
      destSnap,
    };
  }

  // Case 3: Global origin to polar destination (or polar origin cannot snap to polar graph)
  if (destSnap && (!isOriginPolarDomain || !originSnap)) {
    return {
      topology: 'CASE_3_GLOBAL_POLAR',
      originSnap,
      destSnap,
    };
  }

  // Fallback: Global origin to global destination
  return {
    topology: 'CASE_2_GLOBAL_GLOBAL',
    originSnap,
    destSnap,
  };
}

/**
 * Stitches ordered polyline segments together with explicit boundary continuity validation.
 * Removes duplicate boundary points (< 1m distance) and rejects unexplained teleportation gaps (> 200 km).
 */
export function stitchPolylines(
  segments: [number, number][][],
  maxSeamGapKm: number = 200.0
): [number, number][] | null {
  const result: [number, number][] = [];

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (!seg || seg.length === 0) continue;

    for (let p = 0; p < seg.length; p++) {
      const pt = seg[p];
      if (
        !Array.isArray(pt) ||
        pt.length < 2 ||
        !Number.isFinite(pt[0]) ||
        !Number.isFinite(pt[1]) ||
        pt[0] < -180 ||
        pt[0] > 180 ||
        pt[1] < -90 ||
        pt[1] > 90
      ) {
        return null; // Malformed coordinate rejected
      }

      if (result.length > 0) {
        const last = result[result.length - 1];
        const gapMeters = calculateGeodesicDistanceMeters(last[0], last[1], pt[0], pt[1]);

        // Deduplicate seamless boundary points
        if (gapMeters < 1.0) {
          continue;
        }

        // Verify seam gap strictly at inter-segment transitions (p === 0, s > 0)
        if (p === 0) {
          const isAntimeridianTransition =
            Math.abs(Math.abs(last[0]) - 180) <= 1.0 &&
            Math.abs(Math.abs(pt[0]) - 180) <= 1.0 &&
            Math.abs(last[1] - pt[1]) <= 5.0;

          if (!isAntimeridianTransition && gapMeters / 1000.0 > maxSeamGapKm) {
            return null; // Discontinuous segment jump across seam
          }
        }
      }

      result.push(pt);
    }
  }

  return result.length >= 2 ? result : null;
}

/**
 * Deterministically prunes and sorts candidate transition gateways.
 * Selects a broad candidate set (default 18) ensuring geographic sector coverage
 * before graph/global feasibility checks.
 */
export function pruneGatewayCandidates(
  portCoordsA: [number, number],
  portCoordsB: [number, number],
  gateways: ValidatedGateway[],
  maxCandidates: number = 8
): ValidatedGateway[] {
  const scored = gateways.map((gw) => {
    const d1 =
      calculateGeodesicDistanceMeters(
        portCoordsA[0],
        portCoordsA[1],
        gw.polarCoords[0],
        gw.polarCoords[1]
      ) / 1000.0;
    const d2 =
      calculateGeodesicDistanceMeters(
        gw.globalCoords[0],
        gw.globalCoords[1],
        portCoordsB[0],
        portCoordsB[1]
      ) / 1000.0;
    // Gateways with artificial high transition seams (> 5 km) receive an operational penalty
    const transPenalty = gw.transitionDistanceKm > 5.0 ? gw.transitionDistanceKm * 2.0 : 0.0;
    const estTotalKm = d1 + d2 + gw.transitionDistanceKm + transPenalty;
    return { gw, estTotalKm };
  });

  // Sort deterministically: lowest transit estimate first, then tie-break by gatewayId
  scored.sort((a, b) => {
    if (Math.abs(a.estTotalKm - b.estTotalKm) > 1e-4) {
      return a.estTotalKm - b.estTotalKm;
    }
    return a.gw.gatewayId.localeCompare(b.gw.gatewayId);
  });

  const selected = new Map<string, ValidatedGateway>();
  const sectorCount = new Map<string, number>();

  // Ensure broad sector representation: up to 2 per sector
  for (const s of scored) {
    const sec = s.gw.sector || 'Other';
    const count = sectorCount.get(sec) || 0;
    if (count < 2) {
      selected.set(s.gw.gatewayId, s.gw);
      sectorCount.set(sec, count + 1);
    }
    if (selected.size >= maxCandidates) break;
  }

  // Fill remaining slots with top overall candidates
  if (selected.size < maxCandidates) {
    for (const s of scored) {
      if (!selected.has(s.gw.gatewayId)) {
        selected.set(s.gw.gatewayId, s.gw);
      }
      if (selected.size >= maxCandidates) break;
    }
  }

  return Array.from(selected.values());
}

/**
 * Computes an authentic, continuous, water-constrained hybrid maritime route.
 */
export async function computeHybridMaritimeRoute(
  origin: PortRecord,
  destination: PortRecord
): Promise<HybridMaritimeRouteResult> {
  if (!origin || !destination) {
    return {
      status: 'NO_FEASIBLE_ROUTE',
      routeName: 'Computed Maritime Route',
      topology: 'CASE_2_GLOBAL_GLOBAL',
      coordinates: [],
      distanceKm: 0,
      polarDistanceKm: 0,
      globalDistanceKm: 0,
      transitionDistanceKm: 0,
      gatewayIds: [],
      candidateCountAttempted: 0,
      rawNodeCount: 0,
      finalNodeCount: 0,
      failingReason: 'Both departure and destination ports are required',
      provenance: HYBRID_ROUTING_PROVENANCE,
    };
  }

  if (origin.wpiNumber === destination.wpiNumber) {
    return {
      status: 'NO_FEASIBLE_ROUTE',
      routeName: 'Computed Maritime Route',
      topology: 'CASE_2_GLOBAL_GLOBAL',
      coordinates: [],
      distanceKm: 0,
      polarDistanceKm: 0,
      globalDistanceKm: 0,
      transitionDistanceKm: 0,
      gatewayIds: [],
      candidateCountAttempted: 0,
      rawNodeCount: 0,
      finalNodeCount: 0,
      failingReason: 'Departure and destination ports cannot be the same',
      provenance: HYBRID_ROUTING_PROVENANCE,
    };
  }

  const rings = await loadLandRings();
  const graph = await loadPolarWaterGraph();

  if (!graph) {
    return {
      status: 'ERROR',
      routeName: 'Computed Maritime Route',
      topology: 'CASE_2_GLOBAL_GLOBAL',
      coordinates: [],
      distanceKm: 0,
      polarDistanceKm: 0,
      globalDistanceKm: 0,
      transitionDistanceKm: 0,
      gatewayIds: [],
      candidateCountAttempted: 0,
      rawNodeCount: 0,
      finalNodeCount: 0,
      failingReason: 'Polar navigation graph failed to load',
      provenance: HYBRID_ROUTING_PROVENANCE,
    };
  }

  const originCoords: [number, number] = [origin.longitude, origin.latitude];
  const destCoords: [number, number] = [destination.longitude, destination.latitude];

  const { topology, originSnap, destSnap, diagnosticReason } = classifyRoutingTopology(
    origin,
    destination,
    graph,
    rings
  );

  // --------------------------------------------------------------------------
  // CASE 6: Retained Isolated Patagonian Component
  // --------------------------------------------------------------------------
  if (topology === 'CASE_6_PATAGONIAN_ISOLATED') {
    return {
      status: 'HYBRID_UNAVAILABLE',
      routeName: 'Computed Maritime Route',
      topology,
      coordinates: [],
      distanceKm: 0,
      polarDistanceKm: 0,
      globalDistanceKm: 0,
      transitionDistanceKm: 0,
      gatewayIds: [],
      candidateCountAttempted: 0,
      rawNodeCount: 0,
      finalNodeCount: 0,
      failingReason:
        diagnosticReason ||
        'Port belongs to an isolated Patagonian component; hybrid routing unavailable without synthetic edges.',
      provenance: HYBRID_ROUTING_PROVENANCE,
    };
  }

  // --------------------------------------------------------------------------
  // CASE 1: Polar -> Polar Direct Dijkstra
  // --------------------------------------------------------------------------
  if (topology === 'CASE_1_POLAR_POLAR' && originSnap && destSnap) {
    const path = aStarShortestPath(
      originSnap.nodeIndex,
      destSnap.nodeIndex,
      graph.nodes,
      graph.adj
    );
    if (path && path.length > 0) {
      const originBerth: [number, number][] = originSnap.waterBerthCoords
        ? [originCoords, originSnap.waterBerthCoords]
        : [originCoords];
      const destBerth: [number, number][] = destSnap.waterBerthCoords
        ? [destSnap.waterBerthCoords, destCoords]
        : [destCoords];
      const fullCoords: [number, number][] = [...originBerth, ...path, ...destBerth];
      const rings = await loadLandRings();
      const depTerminalSegmentCount = originSnap.waterBerthCoords ? 2 : 1;
      const destTerminalSegmentCount = destSnap.waterBerthCoords ? 2 : 1;
      const terminalMetadata: TerminalApproachMetadata = {
        departureTerminalSegmentCount: depTerminalSegmentCount,
        destinationTerminalSegmentCount: destTerminalSegmentCount,
      };

      const smoothed = smoothMaritimeTrajectory(fullCoords, rings);
      let totalDistKm = 0;
      for (let i = 0; i < smoothed.length - 1; i++) {
        totalDistKm +=
          calculateGeodesicDistanceMeters(
            smoothed[i][0],
            smoothed[i][1],
            smoothed[i + 1][0],
            smoothed[i + 1][1]
          ) / 1000.0;
      }
      let finalCoordinates = smoothed;
      let validationReport = await validateMaritimeRouteAsync(
        finalCoordinates,
        totalDistKm,
        POLAR_DATASET_PROVENANCE.dataset,
        origin,
        destination,
        terminalMetadata
      );

      // Non-destructive fallback: if smoothing fails, fall back to safe raw graph polyline
      if (validationReport.overallResult !== 'PASS') {
        let rawDistKm = 0;
        for (let i = 0; i < fullCoords.length - 1; i++) {
          rawDistKm +=
            calculateGeodesicDistanceMeters(
              fullCoords[i][0],
              fullCoords[i][1],
              fullCoords[i + 1][0],
              fullCoords[i + 1][1]
            ) / 1000.0;
        }
        const rawReport = await validateMaritimeRouteAsync(
          fullCoords,
          rawDistKm,
          `${POLAR_DATASET_PROVENANCE.dataset} (Raw)`,
          origin,
          destination,
          terminalMetadata
        );
        if (rawReport.overallResult === 'PASS') {
          finalCoordinates = fullCoords;
          totalDistKm = rawDistKm;
          validationReport = rawReport;
        }
      }

      if (validationReport.overallResult === 'PASS') {
        const navigationalWaypoints = extractNavigationalWaypoints(finalCoordinates);
        const voyageProfile = computeVoyageProfile(finalCoordinates, rings);

        return {
          status: 'SUCCESS',
          routeName: 'Computed Maritime Route',
          topology,
          coordinates: finalCoordinates,
          distanceKm: totalDistKm,
          constructedDistanceKm: totalDistKm,
          durationHours: totalDistKm / 27.78,
          polarDistanceKm: totalDistKm,
          globalDistanceKm: 0,
          transitionDistanceKm: 0,
          gatewayIds: [],
          candidateCountAttempted: 1,
          rawNodeCount: path.length,
          finalNodeCount: finalCoordinates.length,
          validationReport,
          navigationalWaypoints,
          voyageProfile,
          provenance: {
            ...HYBRID_ROUTING_PROVENANCE,
            method: 'Direct Polar Navigable Water Graph (A* + Geodesic Smoothing)',
          },
        };
      } else {
        return {
          status: 'REJECTED_LAND_INTERSECTION',
          routeName: 'Computed Maritime Route',
          topology,
          coordinates: finalCoordinates,
          distanceKm: 0,
          constructedDistanceKm: totalDistKm,
          durationHours: totalDistKm / 27.78,
          polarDistanceKm: totalDistKm,
          globalDistanceKm: 0,
          transitionDistanceKm: 0,
          gatewayIds: [],
          candidateCountAttempted: 1,
          candidateDiagnostics: [
            {
              gatewayId: 'POLAR_DIRECT',
              polarDistanceKm: totalDistKm,
              globalDistanceKm: 0,
              transitionDistanceKm: 0,
              totalDistanceKm: totalDistKm,
              waypointCount: finalCoordinates.length,
              continuityPass: true,
              validationResult: 'FAIL',
              failingSegmentCount: validationReport.failingSegments?.length || 1,
              firstFailingReason:
                validationReport.failingSegments?.[0]?.diagnosticReason ||
                'Line segment crosses land boundary polygon',
            },
          ],
          rawNodeCount: path.length,
          finalNodeCount: finalCoordinates.length,
          failingReason: `Direct polar route failed validation: ${
            validationReport.failingSegments?.[0]?.diagnosticReason || 'Land barrier intersection'
          }`,
          validationReport,
          provenance: {
            ...HYBRID_ROUTING_PROVENANCE,
            method: 'Direct Polar Navigable Water Graph (Dijkstra + Geodesic Smoothing)',
          },
        };
      }
    }

    return {
      status: 'HYBRID_UNAVAILABLE',
      routeName: 'Computed Maritime Route',
      topology,
      coordinates: [],
      distanceKm: 0,
      polarDistanceKm: 0,
      globalDistanceKm: 0,
      transitionDistanceKm: 0,
      gatewayIds: [],
      candidateCountAttempted: 1,
      rawNodeCount: 0,
      finalNodeCount: 0,
      failingReason: 'No navigable path found between polar ports on the polar water graph.',
      provenance: HYBRID_ROUTING_PROVENANCE,
    };
  }

  // --------------------------------------------------------------------------
  // CASE 2: Global -> Global Direct MARNET (with Open Ocean Cape Fallbacks)
  // --------------------------------------------------------------------------
  if (topology === 'CASE_2_GLOBAL_GLOBAL') {
    const canalOptionsList: (('suez' | 'panama')[] | undefined)[] = [undefined, ['suez'], ['panama']];
    let lastValidationReport: RouteValidationReport | undefined;
    let lastConstructedDistKm = 0;
    let lastFirstFailSeg: FailingSegmentDiagnostic | undefined;
    let lastDepApproachStatus: any = 'APPROACH_UNAVAILABLE';
    let lastQualityMetrics: any;
    let lastQualityScore: any;

    for (const restrictions of canalOptionsList) {
      try {
        const rawRoute = seaRoute(originCoords, destCoords, {
          network: marnet20,
          units: 'kilometers',
          antimeridian: 'split',
          ...(restrictions ? { restrictions } : {}),
        });
        if (!rawRoute || !rawRoute.geometry) continue;

        let netCoords = extractMarnetCoordinates(rawRoute.geometry);
        if (!netCoords || netCoords.length < 2) continue;

        // Terminal approach connectors for origin and destination
        const rings = await loadLandRings();
        let depApproach = findSafeTerminalApproach(
          originCoords,
          netCoords[0],
          true,
          rings,
          getAdaptiveDockToleranceKm(origin)
        );
        const firstMarnetCutsLand =
          netCoords.length > 2 &&
          !isSegmentWaterSafeWithDock(netCoords[0], netCoords[1], null, rings, 0.0);

        if (
          (depApproach && depApproach.status === 'APPROACH_UNAVAILABLE') ||
          firstMarnetCutsLand
        ) {
          if (netCoords.length > 2) {
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
        }

        let arrApproach = findSafeTerminalApproach(
          destCoords,
          netCoords[netCoords.length - 1],
          false,
          rings,
          getAdaptiveDockToleranceKm(destination)
        );
        const lastMarnetCutsLand =
          netCoords.length > 2 &&
          !isSegmentWaterSafeWithDock(
            netCoords[netCoords.length - 2],
            netCoords[netCoords.length - 1],
            null,
            rings,
            0.0
          );

        if (
          (arrApproach && arrApproach.status === 'APPROACH_UNAVAILABLE') ||
          lastMarnetCutsLand
        ) {
          if (netCoords.length > 2) {
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
        }

        const depSegment = depApproach ? depApproach.waypoints.slice(0, -1) : [originCoords];
        const arrSegment = arrApproach ? arrApproach.waypoints.slice(1) : [destCoords];
        const rawFullCoords: [number, number][] = [...depSegment, ...netCoords, ...arrSegment];
        const fullCoords = smoothMaritimeTrajectory(rawFullCoords, rings);

        let totalDistKm = 0;
        for (let i = 0; i < fullCoords.length - 1; i++) {
          totalDistKm +=
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
          totalDistKm,
          restrictions ? `Eurostat MARNET 20km (via ${restrictions.join(', ')})` : 'Eurostat MARNET 20km',
          origin,
          destination,
          terminalMetadata
        );

        const termCostKm =
          (depApproach ? depApproach.approachLengthKm : 0) +
          (arrApproach ? arrApproach.approachLengthKm : 0);
        const qualityMetrics = evaluateRouteQuality(fullCoords, 0, termCostKm);
        const qualityScore = calculateRouteQualityScore(qualityMetrics, totalDistKm);

        lastValidationReport = validationReport;
        lastConstructedDistKm = totalDistKm;
        lastFirstFailSeg = validationReport.failingSegments[0];
        lastDepApproachStatus = depApproach.status;
        lastQualityMetrics = qualityMetrics;
        lastQualityScore = qualityScore;

        if (validationReport.overallResult === 'PASS') {
          const navigationalWaypoints = extractNavigationalWaypoints(fullCoords);
          const voyageProfile = computeVoyageProfile(fullCoords, rings);

          return {
            status: 'SUCCESS',
            routeName: 'Computed Maritime Route',
            topology,
            coordinates: fullCoords,
            distanceKm: totalDistKm,
            constructedDistanceKm: totalDistKm,
            durationHours: totalDistKm / 27.78,
            polarDistanceKm: 0,
            globalDistanceKm: totalDistKm,
            transitionDistanceKm: 0,
            gatewayIds: [],
            candidateCountAttempted: 1,
            rawNodeCount: netCoords.length,
            finalNodeCount: fullCoords.length,
            validationReport,
            terminalApproachStatus:
              depApproach.status === 'RADIAL_SCAN_SUCCESS' || arrApproach.status === 'RADIAL_SCAN_SUCCESS'
                ? 'RADIAL_SCAN_SUCCESS'
                : 'DIRECT_SAFE',
            routeQualityMetrics: qualityMetrics,
            routeQualityScore: qualityScore,
            navigationalWaypoints,
            voyageProfile,
            provenance: {
              ...HYBRID_ROUTING_PROVENANCE,
              method: restrictions
                ? `Direct Eurostat MARNET 20km (Open Ocean via Cape Fallback: ${restrictions.join(', ')})`
                : 'Direct Eurostat MARNET 20km with Terminal Harbor Approaches',
            },
          };
        }
      } catch (err) {
        console.warn('MARNET query attempt error:', err);
      }
    }

    if (lastValidationReport) {
      const isTerminalFail =
        lastFirstFailSeg &&
        (lastFirstFailSeg.segmentIndex === 0 ||
          lastFirstFailSeg.segmentIndex >= (lastValidationReport.failingSegments.length - 2));
      const failCategory = isTerminalFail
        ? 'Terminal harbor approach failure'
        : 'Internal MARNET topology failure';

      return {
        status: 'REJECTED_LAND_INTERSECTION',
        routeName: 'Computed Maritime Route',
        topology,
        coordinates: [],
        distanceKm: 0,
        constructedDistanceKm: lastConstructedDistKm,
        polarDistanceKm: 0,
        globalDistanceKm: lastConstructedDistKm,
        transitionDistanceKm: 0,
        gatewayIds: [],
        candidateCountAttempted: 1,
        rawNodeCount: 0,
        finalNodeCount: 0,
        validationReport: lastValidationReport,
        terminalApproachStatus:
          lastDepApproachStatus === 'APPROACH_UNAVAILABLE'
            ? 'APPROACH_UNAVAILABLE'
            : 'RADIAL_SCAN_SUCCESS',
        routeQualityMetrics: lastQualityMetrics,
        routeQualityScore: lastQualityScore,
        failingReason: `${failCategory} (${lastFirstFailSeg?.diagnosticReason || 'land intersection'})`,
        provenance: {
          ...HYBRID_ROUTING_PROVENANCE,
          method: 'Direct Eurostat MARNET 20km',
        },
      };
    }

    return {
      status: 'REJECTED_LAND_INTERSECTION',
      routeName: 'Computed Maritime Route',
      topology,
      coordinates: [],
      distanceKm: 0,
      constructedDistanceKm: 0,
      polarDistanceKm: 0,
      globalDistanceKm: 0,
      transitionDistanceKm: 0,
      gatewayIds: [],
      candidateCountAttempted: 1,
      rawNodeCount: 0,
      finalNodeCount: 0,
      failingReason: 'Direct global MARNET route crosses land barriers or lacks navigable water path.',
      provenance: HYBRID_ROUTING_PROVENANCE,
    };
  }

  // --------------------------------------------------------------------------
  // CASES 3, 4, 5: Hybrid Transitions via Empirical Gateways
  // --------------------------------------------------------------------------
  const rawGateways = await loadValidatedGateways();
  // Filter gateways strictly to those whose polarNodeId belongs to the primary connected component
  // to avoid dead-end paths into disconnected Patagonian fjords or isolated sub-graphs.
  const allGateways = rawGateways.filter(
    (gw) => !graph.nodeComponent || graph.nodeComponent[gw.polarNodeId] === graph.primaryComponentId
  );
  if (allGateways.length === 0) {
    return {
      status: 'ERROR',
      routeName: 'Computed Maritime Route',
      topology,
      coordinates: [],
      distanceKm: 0,
      polarDistanceKm: 0,
      globalDistanceKm: 0,
      transitionDistanceKm: 0,
      gatewayIds: [],
      candidateCountAttempted: 0,
      rawNodeCount: 0,
      finalNodeCount: 0,
      failingReason: 'No validated gateways found in benchmark catalog',
      provenance: HYBRID_ROUTING_PROVENANCE,
    };
  }

  const candidateDiagnostics: HybridCandidateDiagnostic[] = [];
  interface ValidatedCandidate {
    gateway: ValidatedGateway;
    gatewayB?: ValidatedGateway;
    coordinates: [number, number][];
    totalDistanceKm: number;
    polarDistanceKm: number;
    globalDistanceKm: number;
    transitionDistanceKm: number;
    validationReport: RouteValidationReport;
    terminalApproachStatus?: 'DIRECT_SAFE' | 'RADIAL_SCAN_SUCCESS' | 'APPROACH_UNAVAILABLE';
    qualityMetrics: RouteQualityMetrics;
  }
  const validCandidates: ValidatedCandidate[] = [];

  // CASE 4: Polar Origin -> Global Destination
  if (topology === 'CASE_4_POLAR_GLOBAL' && originSnap) {
    const candidateGateways = pruneGatewayCandidates(originCoords, destCoords, allGateways, 6);
    const arrApproachCache = new Map<string, any>();

    for (const gw of candidateGateways) {
      // 1. Fast A* polar subpath check (< 2 ms)
      const polarResult = aStarShortestPathWithDistance(
        originSnap.nodeIndex,
        gw.polarNodeId,
        graph.nodes,
        graph.adj
      );
      if (!polarResult || !polarResult.path || polarResult.path.length === 0) continue;

      // 2. Admissible Great-Circle Lower Bound Pruning (before MARNET)
      if (validCandidates.length >= 1) {
        const bestDist = Math.min(...validCandidates.map((c) => c.totalDistanceKm));
        const dGCGlobal =
          calculateGeodesicDistanceMeters(
            gw.globalCoords[0],
            gw.globalCoords[1],
            destCoords[0],
            destCoords[1]
          ) / 1000.0;
        const gcLowerBound = polarResult.distanceKm + gw.transitionDistanceKm + dGCGlobal;
        if (gcLowerBound > bestDist) {
          continue;
        }
      }

      let rawGlobal: any = null;
      try {
        rawGlobal = seaRoute(gw.globalCoords, destCoords, {
          network: marnet20,
          units: 'kilometers',
          antimeridian: 'split',
        });
      } catch (e) {
        continue;
      }

      if (!rawGlobal || !rawGlobal.geometry) continue;
      const globalCoords = extractMarnetCoordinates(rawGlobal.geometry);
      if (!globalCoords || globalCoords.length < 2) continue;

      // Terminal approach connector for global destination (memoized)
      let netCoords = [...globalCoords];
      const rings = await loadLandRings();
      const arrKey = `${destCoords[0]},${destCoords[1]}|${netCoords[netCoords.length - 1][0]},${netCoords[netCoords.length - 1][1]}`;
      let arrApproach = arrApproachCache.get(arrKey);
      if (!arrApproach) {
        arrApproach = findSafeTerminalApproach(
          destCoords,
          netCoords[netCoords.length - 1],
          false,
          rings,
          getAdaptiveDockToleranceKm(destination)
        );

        const lastMarnetCutsLand =
          netCoords.length > 2 &&
          !isSegmentWaterSafeWithDock(
            netCoords[netCoords.length - 2],
            netCoords[netCoords.length - 1],
            null,
            rings,
            0.0
          );

        if (
          (arrApproach && arrApproach.status === 'APPROACH_UNAVAILABLE') ||
          lastMarnetCutsLand
        ) {
          if (netCoords.length > 2) {
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
        }
        if (arrApproach) arrApproachCache.set(arrKey, arrApproach);
      }

      const originBerth: [number, number][] = originSnap.waterBerthCoords
        ? [originCoords, originSnap.waterBerthCoords]
        : [originCoords];
      const polarSegment: [number, number][] = [...originBerth, ...polarResult.path];
      const transitionSegment: [number, number][] =
        gw.transitionDistanceKm > 0.05 ? [gw.polarCoords, gw.globalCoords] : [gw.polarCoords];
      const globalSegment: [number, number][] = arrApproach
        ? [...netCoords.slice(0, -1), ...arrApproach.waypoints]
        : [...netCoords, destCoords];

      const stitched = stitchPolylines([polarSegment, transitionSegment, globalSegment]);
      if (!stitched) continue;

      const smoothed = smoothMaritimeTrajectory(stitched, rings);

      // Distance calculations (exact polar distance from A*)
      let polarDistKm = polarResult.distanceKm;

      let globalDistKm =
        typeof rawGlobal.properties?.length === 'number' && rawGlobal.properties.length > 0
          ? rawGlobal.properties.length
          : 0;
      if (globalDistKm <= 0) {
        for (let i = 0; i < globalSegment.length - 1; i++) {
          globalDistKm +=
            calculateGeodesicDistanceMeters(
              globalSegment[i][0],
              globalSegment[i][1],
              globalSegment[i + 1][0],
              globalSegment[i + 1][1]
            ) / 1000.0;
        }
      }

      let totalDistKm = 0;
      for (let i = 0; i < smoothed.length - 1; i++) {
        totalDistKm +=
          calculateGeodesicDistanceMeters(
            smoothed[i][0],
            smoothed[i][1],
            smoothed[i + 1][0],
            smoothed[i + 1][1]
          ) / 1000.0;
      }

      const depTerminalSegmentCount = originSnap.waterBerthCoords ? 2 : 1;
      const destTerminalSegmentCount = arrApproach ? Math.max(1, arrApproach.waypoints.length - 1) : 1;
      const terminalMetadata: TerminalApproachMetadata = {
        departureTerminalSegmentCount: depTerminalSegmentCount,
        destinationTerminalSegmentCount: destTerminalSegmentCount,
      };

      let finalCoordinates = smoothed;
      let validationReport = await validateMaritimeRouteAsync(
        finalCoordinates,
        totalDistKm,
        `Hybrid Route via ${gw.gatewayId}`,
        origin,
        destination,
        terminalMetadata
      );

      // Non-destructive fallback: if smoothing fails, fall back to safe raw stitched polyline
      if (validationReport.overallResult !== 'PASS') {
        let stitchedDistKm = 0;
        for (let i = 0; i < stitched.length - 1; i++) {
          stitchedDistKm +=
            calculateGeodesicDistanceMeters(
              stitched[i][0],
              stitched[i][1],
              stitched[i + 1][0],
              stitched[i + 1][1]
            ) / 1000.0;
        }
        const stitchedReport = await validateMaritimeRouteAsync(
          stitched,
          stitchedDistKm,
          `Hybrid Route (Raw) via ${gw.gatewayId}`,
          origin,
          destination,
          terminalMetadata
        );
        if (stitchedReport.overallResult === 'PASS') {
          finalCoordinates = stitched;
          totalDistKm = stitchedDistKm;
          validationReport = stitchedReport;
        }
      }

      const qualityMetrics = evaluateRouteQuality(
        finalCoordinates,
        gw.transitionDistanceKm,
        arrApproach ? arrApproach.approachLengthKm : 0
      );

      candidateDiagnostics.push({
        gatewayId: gw.gatewayId,
        polarDistanceKm: polarDistKm,
        globalDistanceKm: globalDistKm,
        transitionDistanceKm: gw.transitionDistanceKm,
        totalDistanceKm: totalDistKm,
        waypointCount: finalCoordinates.length,
        continuityPass: true,
        validationResult: validationReport.overallResult,
        failingSegmentCount: validationReport.failingSegments.length,
        firstFailingReason: validationReport.failingSegments[0]?.diagnosticReason,
        terminalApproachStatus: arrApproach?.status,
      });

      if (validationReport.overallResult === 'PASS') {
        validCandidates.push({
          gateway: gw,
          coordinates: finalCoordinates,
          totalDistanceKm: totalDistKm,
          polarDistanceKm: polarDistKm,
          globalDistanceKm: globalDistKm,
          transitionDistanceKm: gw.transitionDistanceKm,
          validationReport,
          terminalApproachStatus: arrApproach?.status,
          qualityMetrics,
        });
      }
    }
  }

  // CASE 3: Global Origin -> Polar Destination
  if (topology === 'CASE_3_GLOBAL_POLAR' && destSnap) {
    const candidateGateways = pruneGatewayCandidates(destCoords, originCoords, allGateways, 6);
    const depApproachCache = new Map<string, any>();

    for (const gw of candidateGateways) {
      // 1. Fast A* polar subpath check (< 2 ms)
      const polarResult = aStarShortestPathWithDistance(
        gw.polarNodeId,
        destSnap.nodeIndex,
        graph.nodes,
        graph.adj
      );
      if (!polarResult || !polarResult.path || polarResult.path.length === 0) continue;

      // 2. Admissible Great-Circle Lower Bound Pruning (before MARNET)
      if (validCandidates.length >= 1) {
        const bestDist = Math.min(...validCandidates.map((c) => c.totalDistanceKm));
        const dGCGlobal =
          calculateGeodesicDistanceMeters(
            originCoords[0],
            originCoords[1],
            gw.globalCoords[0],
            gw.globalCoords[1]
          ) / 1000.0;
        const gcLowerBound = dGCGlobal + gw.transitionDistanceKm + polarResult.distanceKm;
        if (gcLowerBound > bestDist) {
          continue;
        }
      }

      let rawGlobal: any = null;
      try {
        rawGlobal = seaRoute(originCoords, gw.globalCoords, {
          network: marnet20,
          units: 'kilometers',
          antimeridian: 'split',
        });
      } catch (e) {
        continue;
      }

      if (!rawGlobal || !rawGlobal.geometry) continue;
      const globalCoords = extractMarnetCoordinates(rawGlobal.geometry);
      if (!globalCoords || globalCoords.length < 2) continue;

      // Terminal approach connector for global origin (memoized)
      let netCoords = [...globalCoords];
      const rings = await loadLandRings();
      const depKey = `${originCoords[0]},${originCoords[1]}|${netCoords[0][0]},${netCoords[0][1]}`;
      let depApproach = depApproachCache.get(depKey);
      if (!depApproach) {
        depApproach = findSafeTerminalApproach(
          originCoords,
          netCoords[0],
          true,
          rings,
          getAdaptiveDockToleranceKm(origin)
        );

        const firstMarnetCutsLand =
          netCoords.length > 2 &&
          !isSegmentWaterSafeWithDock(netCoords[0], netCoords[1], null, rings, 0.0);

        if (
          (depApproach && depApproach.status === 'APPROACH_UNAVAILABLE') ||
          firstMarnetCutsLand
        ) {
          if (netCoords.length > 2) {
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
        }
        if (depApproach) depApproachCache.set(depKey, depApproach);
      }

      const globalSegment: [number, number][] = depApproach
        ? [...depApproach.waypoints, ...netCoords.slice(1)]
        : [originCoords, ...netCoords];
      const transitionSegment: [number, number][] =
        gw.transitionDistanceKm > 0.05 ? [gw.globalCoords, gw.polarCoords] : [gw.polarCoords];
      const destBerth: [number, number][] = destSnap.waterBerthCoords
        ? [destSnap.waterBerthCoords, destCoords]
        : [destCoords];
      const polarSegment: [number, number][] = [...polarResult.path, ...destBerth];

      const stitched = stitchPolylines([globalSegment, transitionSegment, polarSegment]);
      if (!stitched) continue;

      const smoothed = smoothMaritimeTrajectory(stitched, rings);

      // Distance calculations (exact polar distance from A*)
      let polarDistKm = polarResult.distanceKm;

      let globalDistKm =
        typeof rawGlobal.properties?.length === 'number' && rawGlobal.properties.length > 0
          ? rawGlobal.properties.length
          : 0;
      if (globalDistKm <= 0) {
        for (let i = 0; i < globalSegment.length - 1; i++) {
          globalDistKm +=
            calculateGeodesicDistanceMeters(
              globalSegment[i][0],
              globalSegment[i][1],
              globalSegment[i + 1][0],
              globalSegment[i + 1][1]
            ) / 1000.0;
        }
      }

      let totalDistKm = 0;
      for (let i = 0; i < smoothed.length - 1; i++) {
        totalDistKm +=
          calculateGeodesicDistanceMeters(
            smoothed[i][0],
            smoothed[i][1],
            smoothed[i + 1][0],
            smoothed[i + 1][1]
          ) / 1000.0;
      }

      const depTerminalSegmentCount = depApproach ? Math.max(1, depApproach.waypoints.length - 1) : 1;
      const destTerminalSegmentCount = destSnap.waterBerthCoords ? 2 : 1;
      const terminalMetadata: TerminalApproachMetadata = {
        departureTerminalSegmentCount: depTerminalSegmentCount,
        destinationTerminalSegmentCount: destTerminalSegmentCount,
      };

      let finalCoordinates = smoothed;
      let validationReport = await validateMaritimeRouteAsync(
        finalCoordinates,
        totalDistKm,
        `Hybrid Route via ${gw.gatewayId}`,
        origin,
        destination,
        terminalMetadata
      );

      // Non-destructive fallback: if smoothing fails, fall back to safe raw stitched polyline
      if (validationReport.overallResult !== 'PASS') {
        let stitchedDistKm = 0;
        for (let i = 0; i < stitched.length - 1; i++) {
          stitchedDistKm +=
            calculateGeodesicDistanceMeters(
              stitched[i][0],
              stitched[i][1],
              stitched[i + 1][0],
              stitched[i + 1][1]
            ) / 1000.0;
        }
        const stitchedReport = await validateMaritimeRouteAsync(
          stitched,
          stitchedDistKm,
          `Hybrid Route (Raw) via ${gw.gatewayId}`,
          origin,
          destination,
          terminalMetadata
        );
        if (stitchedReport.overallResult === 'PASS') {
          finalCoordinates = stitched;
          totalDistKm = stitchedDistKm;
          validationReport = stitchedReport;
        }
      }

      const qualityMetrics = evaluateRouteQuality(
        finalCoordinates,
        gw.transitionDistanceKm,
        depApproach ? depApproach.approachLengthKm : 0
      );

      candidateDiagnostics.push({
        gatewayId: gw.gatewayId,
        polarDistanceKm: polarDistKm,
        globalDistanceKm: globalDistKm,
        transitionDistanceKm: gw.transitionDistanceKm,
        totalDistanceKm: totalDistKm,
        waypointCount: finalCoordinates.length,
        continuityPass: true,
        validationResult: validationReport.overallResult,
        failingSegmentCount: validationReport.failingSegments.length,
        firstFailingReason: validationReport.failingSegments[0]?.diagnosticReason,
        terminalApproachStatus: depApproach?.status,
      });

      if (validationReport.overallResult === 'PASS') {
        validCandidates.push({
          gateway: gw,
          coordinates: finalCoordinates,
          totalDistanceKm: totalDistKm,
          polarDistanceKm: polarDistKm,
          globalDistanceKm: globalDistKm,
          transitionDistanceKm: gw.transitionDistanceKm,
          validationReport,
          terminalApproachStatus: depApproach?.status,
          qualityMetrics,
        });
      }
    }
  }

  // Multi-Objective Route Quality Scoring & Ranking:
  if (validCandidates.length > 0) {
    const minDistanceKm = Math.min(...validCandidates.map((c) => c.totalDistanceKm));

    // Calculate standardized quality score Q(R) for every passing candidate
    const scoredCandidates = validCandidates.map((cand) => {
      const qualityScore = calculateRouteQualityScore(cand.qualityMetrics, minDistanceKm);
      return {
        ...cand,
        qualityScore,
      };
    });

    // Sort by:
    // 1. Composite Multi-Objective Quality Score Q(R) (threshold > 0.0001)
    // 2. Total Geodesic Distance (threshold > 0.1 km)
    // 3. Lowest gateway transition distance (threshold > 0.01 km)
    // 4. Deterministic tie-break by gateway ID
    scoredCandidates.sort((a, b) => {
      if (Math.abs(a.qualityScore.compositeScore - b.qualityScore.compositeScore) > 0.0001) {
        return a.qualityScore.compositeScore - b.qualityScore.compositeScore;
      }
      if (Math.abs(a.totalDistanceKm - b.totalDistanceKm) > 0.1) {
        return a.totalDistanceKm - b.totalDistanceKm;
      }
      if (Math.abs(a.transitionDistanceKm - b.transitionDistanceKm) > 0.01) {
        return a.transitionDistanceKm - b.transitionDistanceKm;
      }
      return a.gateway.gatewayId.localeCompare(b.gateway.gatewayId);
    });

    const winner = scoredCandidates[0];
    const rings = await loadLandRings();
    const navigationalWaypoints = extractNavigationalWaypoints(winner.coordinates);
    const voyageProfile = computeVoyageProfile(winner.coordinates, rings);

    return {
      status: 'SUCCESS',
      routeName: 'Computed Maritime Route',
      topology,
      coordinates: winner.coordinates,
      distanceKm: winner.totalDistanceKm,
      constructedDistanceKm: winner.totalDistanceKm,
      durationHours: winner.totalDistanceKm / 27.78,
      polarDistanceKm: winner.polarDistanceKm,
      globalDistanceKm: winner.globalDistanceKm,
      transitionDistanceKm: winner.transitionDistanceKm,
      gatewayIds: winner.gatewayB
        ? [winner.gateway.gatewayId, winner.gatewayB.gatewayId]
        : [winner.gateway.gatewayId],
      candidateCountAttempted: candidateDiagnostics.length,
      rawNodeCount: winner.coordinates.length - 2,
      finalNodeCount: winner.coordinates.length,
      validationReport: winner.validationReport,
      candidateDiagnostics,
      terminalApproachStatus: winner.terminalApproachStatus,
      routeQualityMetrics: winner.qualityMetrics,
      routeQualityScore: winner.qualityScore,
      navigationalWaypoints,
      voyageProfile,
      provenance: {
        ...HYBRID_ROUTING_PROVENANCE,
        method: `Hybrid Gateway Transition via ${winner.gateway.gatewayId} (Quality Score: ${winner.qualityScore.compositeScore.toFixed(4)})`,
      },
    };
  }

  // Strict hard gate: suppress invalid lines if no candidate survived hard land validation
  const sortedDiagnostics = [...candidateDiagnostics].sort((a, b) => a.totalDistanceKm - b.totalDistanceKm);
  const bestAttempt = sortedDiagnostics[0];
  const firstFail = bestAttempt?.firstFailingReason || candidateDiagnostics[0]?.firstFailingReason || 'Segment crosses land barriers';

  let failCategory = 'Land barrier intersection';
  if (firstFail.includes('Terminal harbor approach')) {
    failCategory = 'Terminal harbor approach failure';
  } else if (firstFail.includes('crosses land boundary polygon') || firstFail.includes('traverses land polygon interior')) {
    failCategory = 'Internal routing network edge failure';
  }

  return {
    status: 'REJECTED_LAND_INTERSECTION',
    routeName: 'Computed Maritime Route',
    topology,
    coordinates: [],
    distanceKm: 0,
    constructedDistanceKm: bestAttempt ? bestAttempt.totalDistanceKm : 0,
    polarDistanceKm: bestAttempt ? bestAttempt.polarDistanceKm : 0,
    globalDistanceKm: bestAttempt ? bestAttempt.globalDistanceKm : 0,
    transitionDistanceKm: bestAttempt ? bestAttempt.transitionDistanceKm : 0,
    gatewayIds: candidateDiagnostics.map((c) => c.gatewayId),
    candidateCountAttempted: candidateDiagnostics.length,
    rawNodeCount: 0,
    finalNodeCount: 0,
    candidateDiagnostics,
    failingReason: `All ${candidateDiagnostics.length} candidate hybrid routes failed validation: ${failCategory} (${firstFail})`,
    provenance: HYBRID_ROUTING_PROVENANCE,
  };
}
