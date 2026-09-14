/**
 * Terminal Harbor Approach Routing Service
 * ----------------------------------------
 * Bridges the spatial resolution gap between real-world NGA WPI port berths
 * and coarse macro-mesh networks (e.g. Eurostat MARNET 20km).
 *
 * Physical Problem:
 * Global shipping networks like MARNET terminate at offshore fairway nodes,
 * often 2–30 km outside natural harbors, sounds, or breakwaters. Drawing an
 * unconstrained straight line from the berth to the nearest network node
 * frequently cuts across quaysides, breakwaters, headlands, or peninsulas.
 *
 * Solution Mechanism:
 * 1. Direct Evaluation: Test whether the direct line from berth to network node
 *    is already water-safe (respecting the authoritative 1.5 km dock tolerance).
 * 2. Radial Water-Safe Scan: If direct connection crosses land, perform an
 *    outward radial search along 12 compass bearings at expanding distances
 *    (0.5 km to 5.0 km) to find an intermediate water point that:
 *      a. Connects to the berth within the 1.5 km dock tolerance zone.
 *      b. Connects to the offshore network node with STRICT 0.0 km land tolerance.
 * 3. Clean Rejection: If no safe intermediate water point can be found (e.g.
 *    deep rias like Sydney Harbour without inner channel fairway geometry),
 *    returns null / APPROACH_UNAVAILABLE without fabricating unverified paths.
 */

import {
  calculateGeodesicDistanceMeters,
  calculateBearingDeg,
  pointInPolygon,
  calculateDestinationPoint,
  sphericalSegmentsIntersect,
  computeSphericalIntersectionParam,
  pointToSegmentGeodesicDistanceMeters,
  slerpCoordinates,
  SpatialEdgeGrid,
} from '../utils/geo';
import {
  type LandRing,
} from './routeValidationService';
import { getSpatialPolygonGrid } from './landService';

export interface TerminalApproachResult {
  status: 'DIRECT_SAFE' | 'RADIAL_SCAN_SUCCESS' | 'APPROACH_UNAVAILABLE';
  waypoints: [number, number][];
  approachLengthKm: number;
  intermediatePointCount: number;
  bearingDeg?: number;
  scanDistanceKm?: number;
  diagnosticReason: string;
}

export { calculateDestinationPoint };

let cachedEdgeGrid: SpatialEdgeGrid | null = null;
let cachedRingsRef: LandRing[] | null = null;

/**
 * Returns or builds a cached SpatialEdgeGrid index for authoritative land barrier rings.
 */
export function getSpatialEdgeGrid(rings: LandRing[]): SpatialEdgeGrid {
  if (cachedEdgeGrid && cachedRingsRef === rings) return cachedEdgeGrid;
  cachedEdgeGrid = new SpatialEdgeGrid(rings, 2.0);
  cachedRingsRef = rings;
  return cachedEdgeGrid;
}

/**
 * Verifies if a single line segment is water-safe against authoritative land rings.
 * Uses exact 3D spherical arc-polygon intersection geometry on the WGS84 sphere.
 * If dockPt is provided, intersections within maxToleranceKm of dockPt are permitted.
 * If dockPt is null, strictly 0.0 km land tolerance is enforced (open water).
 * If minClearanceKm > 0 (for open-water navigation), verifies that the segment maintains
 * the required safety clearance buffer from all land barrier boundaries.
 */
export function isSegmentWaterSafeWithDock(
  s1: [number, number],
  s2: [number, number],
  dockPt: [number, number] | null,
  rings: LandRing[],
  maxToleranceKm: number = 1.5,
  minClearanceKm: number = 0.0
): boolean {
  const isAntimeridianCrossing = Math.abs(s1[0] - s2[0]) > 180.0;
  const subSegments: [[number, number], [number, number]][] = [];
  if (isAntimeridianCrossing) {
    const latMid = (s1[1] + s2[1]) / 2.0;
    if (s1[0] < 0) {
      subSegments.push([s1, [-180.0, latMid]]);
      subSegments.push([[180.0, latMid], s2]);
    } else {
      subSegments.push([s1, [180.0, latMid]]);
      subSegments.push([[-180.0, latMid], s2]);
    }
  } else {
    subSegments.push([s1, s2]);
  }

  const edgeGrid = getSpatialEdgeGrid(rings);

  for (const [p1, p2] of subSegments) {
    if (Math.abs(p1[0] - p2[0]) < 1e-6 && Math.abs(p1[1] - p2[1]) < 1e-6) {
      continue;
    }

    const marginDeg = Math.max(0.6, (Math.max(maxToleranceKm, minClearanceKm) * 1.5) / 111.0);
    const minLon = Math.min(p1[0], p2[0]) - marginDeg;
    const maxLon = Math.max(p1[0], p2[0]) + marginDeg;
    const minLat = Math.min(p1[1], p2[1]) - marginDeg;
    const maxLat = Math.max(p1[1], p2[1]) + marginDeg;

    // 1. Exact 3D Spherical Edge Crossings & Clearance Buffer via Spatial Index
    const candidateEdges = edgeGrid.queryCandidateEdges(minLon, minLat, maxLon, maxLat);
    const clrDeg = (minClearanceKm * 1.1) / 111.0;
    const sMinLon = Math.min(p1[0], p2[0]) - clrDeg;
    const sMaxLon = Math.max(p1[0], p2[0]) + clrDeg;
    const sMinLat = Math.min(p1[1], p2[1]) - clrDeg;
    const sMaxLat = Math.max(p1[1], p2[1]) + clrDeg;
    const segMinLon = Math.min(p1[0], p2[0]);
    const segMaxLon = Math.max(p1[0], p2[0]);
    const segMinLat = Math.min(p1[1], p2[1]);
    const segMaxLat = Math.max(p1[1], p2[1]);
    const midLat = (p1[1] + p2[1]) / 2.0;
    const cosLat = Math.max(0.1, Math.cos((midLat * Math.PI) / 180.0));

    for (let e = 0; e < candidateEdges.length; e++) {
      const { p1: e1, p2: e2 } = candidateEdges[e];

      // Exact spherical arc intersection test
      if (sphericalSegmentsIntersect(p1, p2, e1, e2)) {
        if (dockPt !== null) {
          const t = computeSphericalIntersectionParam(p1, p2, e1, e2);
          if (t !== null) {
            const crossPt = slerpCoordinates(p1, p2, t);
            const distFromDock =
              calculateGeodesicDistanceMeters(dockPt[0], dockPt[1], crossPt[0], crossPt[1]) / 1000.0;
            if (distFromDock <= maxToleranceKm) {
              continue;
            }
          }
        }
        return false;
      }

      // Maritime coastal clearance buffer check for open water legs
      if (minClearanceKm > 0 && dockPt === null) {
        if (Math.max(e1[0], e2[0]) < sMinLon || Math.min(e1[0], e2[0]) > sMaxLon ||
            Math.max(e1[1], e2[1]) < sMinLat || Math.min(e1[1], e2[1]) > sMaxLat) {
          continue;
        }

        const dxDeg = Math.max(0, Math.max(segMinLon - e1[0], e1[0] - segMaxLon));
        const dyDeg = Math.max(0, Math.max(segMinLat - e1[1], e1[1] - segMaxLat));
        const minPossibleDistKm = Math.hypot(dxDeg * cosLat, dyDeg) * 111.0;
        if (minPossibleDistKm > minClearanceKm) {
          continue;
        }

        const d = pointToSegmentGeodesicDistanceMeters(e1[0], e1[1], p1[0], p1[1], p2[0], p2[1]) / 1000.0;
        if (d < minClearanceKm) return false;
      }
    }

    // 2. Interior Polygon Containment Check (multi-sample testing)
    const segLenKm = calculateGeodesicDistanceMeters(p1[0], p1[1], p2[0], p2[1]) / 1000.0;
    const sampleTs = segLenKm > 15.0 ? [0.25, 0.5, 0.75] : [0.5];
    const polygonGrid = getSpatialPolygonGrid(rings);

    for (const t of sampleTs) {
      const samplePt = t === 0.5 ? [(p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0] as [number, number] : slerpCoordinates(p1, p2, t);
      const candidateRings = polygonGrid.queryPointCandidates(samplePt[0], samplePt[1]);

      for (let r = 0; r < candidateRings.length; r++) {
        const { bbox, ring } = candidateRings[r];
        if (samplePt[0] < bbox[0] || samplePt[0] > bbox[2] || samplePt[1] < bbox[1] || samplePt[1] > bbox[3]) {
          continue;
        }

        if (pointInPolygon(samplePt, ring)) {
          if (dockPt !== null) {
            const midDistFromDock =
              calculateGeodesicDistanceMeters(dockPt[0], dockPt[1], samplePt[0], samplePt[1]) / 1000.0;
            if (midDistFromDock <= maxToleranceKm) {
              continue;
            }
          }
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Discovers an authentic, water-constrained terminal approach connecting a port berth
 * to an offshore routing network node (e.g. MARNET).
 *
 * @param berth Geographic coordinate of the port berth [lon, lat]
 * @param marnetNode Geographic coordinate of the offshore network node [lon, lat]
 * @param isDeparture True if the route is departing from this berth, false if arriving
 * @param rings Authoritative land boundary polygons
 * @param maxDockToleranceKm Maximum allowed quayside/pier tolerance (default 1.5 km)
 */
export function findSafeTerminalApproach(
  berth: [number, number],
  marnetNode: [number, number],
  isDeparture: boolean,
  rings: LandRing[],
  maxDockToleranceKm: number = 1.5
): TerminalApproachResult {
  // 1. Evaluate direct connection
  const directSafe = isSegmentWaterSafeWithDock(
    berth,
    marnetNode,
    berth,
    rings,
    maxDockToleranceKm
  );

  const directDistKm =
    calculateGeodesicDistanceMeters(berth[0], berth[1], marnetNode[0], marnetNode[1]) / 1000.0;

  if (directSafe) {
    const waypoints: [number, number][] = isDeparture
      ? [berth, marnetNode]
      : [marnetNode, berth];
    return {
      status: 'DIRECT_SAFE',
      waypoints,
      approachLengthKm: directDistKm,
      intermediatePointCount: 0,
      diagnosticReason: 'Direct line-of-sight between berth and network node is water-safe within dock tolerance',
    };
  }

  // 2. Radial Water-Safe Scan outward from berth
  // 36 compass directions across empirical distances (0.5 km to 25.0 km) for natural rias, sounds, and bays
  const bearingsCount = 36;
  const distances = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0, 16.0, 20.0, 25.0];
  const dAngle = 360.0 / bearingsCount;
  const candidateSolutions: {
    point: [number, number];
    totalDistKm: number;
    bearing: number;
    dist: number;
  }[] = [];

  // Intermediate candidate points that are water-safe from the berth
  const validBerthCandidates: {
    point: [number, number];
    bearing: number;
    dist: number;
  }[] = [];

  for (let b = 0; b < bearingsCount; b++) {
    const bearing = b * dAngle;
    for (let d = 0; d < distances.length; d++) {
      const dist = distances[d];
      const candidatePt = calculateDestinationPoint(berth, dist, bearing);

      // Leg 1: Berth <-> Candidate point (berth is dockPt, maxDockToleranceKm allowed)
      const leg1Safe = isSegmentWaterSafeWithDock(
        berth,
        candidatePt,
        berth,
        rings,
        maxDockToleranceKm
      );
      if (!leg1Safe) continue;

      validBerthCandidates.push({ point: candidatePt, bearing, dist });

      // Leg 2: Candidate point <-> MARNET node (open ocean leg, STRICT 0.0 km land tolerance!)
      const leg2Safe = isSegmentWaterSafeWithDock(
        candidatePt,
        marnetNode,
        null,
        rings,
        0.0
      );
      if (!leg2Safe) continue;

      const totalDist =
        (calculateGeodesicDistanceMeters(berth[0], berth[1], candidatePt[0], candidatePt[1]) +
          calculateGeodesicDistanceMeters(
            candidatePt[0],
            candidatePt[1],
            marnetNode[0],
            marnetNode[1]
          )) /
        1000.0;

      candidateSolutions.push({
        point: candidatePt,
        totalDistKm: totalDist,
        bearing,
        dist,
      });
    }
  }

  if (candidateSolutions.length > 0) {
    // Sort deterministically: shortest total distance first, tie-break by bearing
    candidateSolutions.sort((a, b) => {
      if (Math.abs(a.totalDistKm - b.totalDistKm) > 1e-4) {
        return a.totalDistKm - b.totalDistKm;
      }
      return a.bearing - b.bearing;
    });

    const best = candidateSolutions[0];
    const waypoints: [number, number][] = isDeparture
      ? [berth, best.point, marnetNode]
      : [marnetNode, best.point, berth];

    return {
      status: 'RADIAL_SCAN_SUCCESS',
      waypoints,
      approachLengthKm: best.totalDistKm,
      intermediatePointCount: 1,
      bearingDeg: best.bearing,
      scanDistanceKm: best.dist,
      diagnosticReason: `Water-safe approach connector established via radial scan (bearing ${best.bearing}°, ${best.dist} km into open water)`,
    };
  }

  // 2b. Progressive 2-Stage Fairway Search:
  // If no single-hop candidate can see marnetNode directly (e.g. natural bays, rias, or breakwaters),
  // search from the valid harbor candidates for an outer fairway point that rounds the harbor entrance.
  // Evaluate furthest seaward candidates first to clear inner-harbor landmasses.
  if (validBerthCandidates.length > 0) {
    validBerthCandidates.sort((a, b) => b.dist - a.dist);
    const testCandidates = validBerthCandidates.slice(0, 16);
    for (const hc of testCandidates) {
      const fairwayPts = findFairwayConnector(hc.point, marnetNode, rings);
      if (fairwayPts && fairwayPts.length > 0) {
        let totalDist = calculateGeodesicDistanceMeters(berth[0], berth[1], hc.point[0], hc.point[1]);
        let prev = hc.point;
        for (const fp of fairwayPts) {
          totalDist += calculateGeodesicDistanceMeters(prev[0], prev[1], fp[0], fp[1]);
          prev = fp;
        }
        totalDist += calculateGeodesicDistanceMeters(prev[0], prev[1], marnetNode[0], marnetNode[1]);
        const totalDistKm = totalDist / 1000.0;

        const intermediate = [hc.point, ...fairwayPts];
        const waypoints: [number, number][] = isDeparture
          ? [berth, ...intermediate, marnetNode]
          : [marnetNode, ...intermediate.slice().reverse(), berth];

        return {
          status: 'RADIAL_SCAN_SUCCESS',
          waypoints,
          approachLengthKm: totalDistKm,
          intermediatePointCount: intermediate.length,
          bearingDeg: hc.bearing,
          scanDistanceKm: hc.dist,
          diagnosticReason: `Water-safe progressive fairway approach established (${intermediate.length} fairway waypoints around harbor entrance into open sea)`,
        };
      }
    }
  }

  // 3. Clean Rejection: No safe corridor found with available macro geometry
  return {
    status: 'APPROACH_UNAVAILABLE',
    waypoints: isDeparture ? [berth, marnetNode] : [marnetNode, berth],
    approachLengthKm: directDistKm,
    intermediatePointCount: 0,
    diagnosticReason: `Terminal harbor approach crosses land beyond ${maxDockToleranceKm} km dock tolerance, and no water-safe radial corridor could be established`,
  };
}

/**
 * Discovers an intermediate fairway waypoint rounding an outer harbor headland or breakwater
 * connecting an inner-harbor water point to an offshore maritime network node.
 */
function findFairwayConnector(
  p1: [number, number],
  p2: [number, number],
  rings: LandRing[]
): [number, number][] | null {
  const distKm = calculateGeodesicDistanceMeters(p1[0], p1[1], p2[0], p2[1]) / 1000.0;
  if (distKm < 1.0) return null;

  const trackBearing = calculateBearingDeg(p1[0], p1[1], p2[0], p2[1]);
  const perpLeft = (trackBearing + 270.0) % 360.0;
  const perpRight = (trackBearing + 90.0) % 360.0;

  // Test fractions along the track (0.2, 0.35, 0.5, 0.7) and offsets up to 80 km
  const fractions = [0.2, 0.35, 0.5, 0.7];
  const maxOffsetKm = Math.min(100.0, Math.max(15.0, distKm * 0.5));
  const offsetSteps = [3.0, 6.0, 12.0, 20.0, 35.0, 50.0, 80.0];

  for (const frac of fractions) {
    const anchorPt = slerpCoordinates(p1, p2, frac);
    for (const offsetKm of offsetSteps) {
      if (offsetKm > maxOffsetKm) continue;
      for (const bearing of [perpLeft, perpRight]) {
        const detourPt = calculateDestinationPoint(anchorPt, offsetKm, bearing);

        // Verify detour point is not in land
        let inLand = false;
        for (let r = 0; r < rings.length; r++) {
          const { bbox, ring } = rings[r];
          if (detourPt[0] < bbox[0] || detourPt[0] > bbox[2] || detourPt[1] < bbox[1] || detourPt[1] > bbox[3]) continue;
          if (pointInPolygon(detourPt, ring)) {
            inLand = true;
            break;
          }
        }
        if (inLand) continue;

        // Verify both sub-legs are strictly water-safe (0.0 km open ocean)
        if (!isSegmentWaterSafeWithDock(p1, detourPt, null, rings, 0.0, 0.0)) continue;
        if (!isSegmentWaterSafeWithDock(detourPt, p2, null, rings, 0.0, 0.0)) continue;

        return [detourPt];
      }
    }
  }

  // Radial outward scan from p1 to round natural rias, sounds, and peninsulas
  const radialDistances = [5.0, 10.0, 15.0, 20.0, 25.0, 30.0];
  for (let b = 0; b < 36; b++) {
    const bearing = b * 10.0;
    for (const d of radialDistances) {
      if (d > distKm * 0.85) continue;
      const detourPt = calculateDestinationPoint(p1, d, bearing);

      let inLand = false;
      for (let r = 0; r < rings.length; r++) {
        const { bbox, ring } = rings[r];
        if (detourPt[0] < bbox[0] || detourPt[0] > bbox[2] || detourPt[1] < bbox[1] || detourPt[1] > bbox[3]) continue;
        if (pointInPolygon(detourPt, ring)) {
          inLand = true;
          break;
        }
      }
      if (inLand) continue;

      if (!isSegmentWaterSafeWithDock(p1, detourPt, null, rings, 0.0, 0.0)) continue;
      if (!isSegmentWaterSafeWithDock(detourPt, p2, null, rings, 0.0, 0.0)) continue;

      return [detourPt];
    }
  }

  return null;
}
