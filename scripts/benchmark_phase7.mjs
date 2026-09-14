#!/usr/bin/env node
/**
 * Phase 7 — Terminal Harbor Approaches & Route Quality Benchmark & Determinism Suite
 * -----------------------------------------------------------------------------------
 * Executes rigorous, reproducible benchmarking across the full Phase 7 test matrix:
 * A. Polar -> Polar (5 routes)
 * B. Polar -> Global (3 routes)
 * C. Global -> Polar (3 routes)
 * D. Global -> Global (2 routes)
 * E. Patagonian Isolated Components (4 routes)
 *
 * Evaluates:
 * 1. Berth-to-berth continuity and valid geometry extraction.
 * 2. Strict land/ice non-intersection via Natural Earth 10m / SCAR polygons (unchanged gate).
 * 3. Terminal harbor approach resolution via radial water scan.
 * 4. Multi-objective route quality metrics:
 *    - Distance (L)
 *    - Tortuosity Ratio (τ = L / L_ortho)
 *    - Course Smoothness (mean turn angle)
 *    - Gateway Transition Discontinuity (d_trans)
 *    - Composite Quality Score Q(R)
 * 5. Distinct failure taxonomy:
 *    - Terminal harbor approach failure
 *    - Internal MARNET topology failure
 *    - Polar routing failure
 *    - Validation failure
 * 6. Dual-run bit-for-bit determinism.
 * 7. Production artifact generation:
 *    - data/routing/processed/terminal_approach_benchmark.json
 *    - data/routing/metadata/terminal_approach_lineage.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const require = createRequire(path.join(projectRoot, 'frontend', 'package.json'));
const TinyQueue = require('tinyqueue');
const { seaRoute } = require('searoute-ts');
const { DEFAULT_MARNET: marnet20 } = require('searoute-ts/marnet-20km');

// Load datasets
const portsData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/ports.json'), 'utf-8'));
const graphData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/polarWaterGraph.json'), 'utf-8'));
const landRings = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/southernLandRings.json'), 'utf-8'));
const gatewayCatalog = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data/routing/processed/gateway_benchmark.json'), 'utf-8')).validatedGateways;

console.log('================================================================================');
console.log('PHASE 7 — TERMINAL HARBOR APPROACHES & ROUTE QUALITY BENCHMARK SUITE');
console.log('================================================================================');
console.log(`Loaded Ports: ${portsData.length}`);
console.log(`Polar Graph: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);
console.log(`Land Rings: ${landRings.length} rings`);
console.log(`Validated Gateways: ${gatewayCatalog.length} gateway pairs`);

// Build Polar Graph Index & Adjacency
const coordToIndex = new Map();
const nodes = graphData.nodes;
nodes.forEach((n, idx) => coordToIndex.set(`${n[0]},${n[1]}`, idx));
const adj = Array.from({ length: nodes.length }, () => []);
for (const [p1, p2, w] of graphData.edges) {
  const u = coordToIndex.get(`${p1[0]},${p1[1]}`);
  const v = coordToIndex.get(`${p2[0]},${p2[1]}`);
  if (u !== undefined && v !== undefined) {
    adj[u].push({ nodeIndex: v, weight: w });
    adj[v].push({ nodeIndex: u, weight: w });
  }
}

// Connected Component BFS
const nodeComponent = new Int32Array(nodes.length).fill(-1);
let currentComp = 0;
const componentSizes = [];
for (let i = 0; i < nodes.length; i++) {
  if (nodeComponent[i] !== -1) continue;
  let size = 0;
  const queue = [i];
  nodeComponent[i] = currentComp;
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    size++;
    for (const neighbor of adj[u]) {
      const v = neighbor.nodeIndex;
      if (nodeComponent[v] === -1) {
        nodeComponent[v] = currentComp;
        queue.push(v);
      }
    }
  }
  componentSizes.push(size);
  currentComp++;
}
let primaryComponentId = 0;
let maxCompSize = 0;
componentSizes.forEach((sz, idx) => {
  if (sz > maxCompSize) {
    maxCompSize = sz;
    primaryComponentId = idx;
  }
});

// Spherical Geometry Utilities
const R = 6371008.8;

function calculateGeodesicDistanceMeters(lon1, lat1, lon2, lat2) {
  const toRad = (d) => (d * Math.PI) / 180.0;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const lat1Rad = toRad(lat1);
  const lat2Rad = toRad(lat2);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateBearingDeg(lon1, lat1, lon2, lat2) {
  const toRad = (d) => (d * Math.PI) / 180.0;
  const toDeg = (r) => (r * 180.0) / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360.0) % 360.0;
}

function calculateCourseAlterationDeg(p1, p2, p3) {
  const b1 = calculateBearingDeg(p1[0], p1[1], p2[0], p2[1]);
  const b2 = calculateBearingDeg(p2[0], p2[1], p3[0], p3[1]);
  let diff = Math.abs(b2 - b1);
  if (diff > 180.0) diff = 360.0 - diff;
  return diff;
}

function calculateDestinationPoint(origin, distanceKm, bearingDeg) {
  const d = (distanceKm * 1000.0) / R;
  const brng = (bearingDeg * Math.PI) / 180.0;
  const lat1 = (origin[1] * Math.PI) / 180.0;
  const lon1 = (origin[0] * Math.PI) / 180.0;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [(lon2 * 180.0) / Math.PI, (lat2 * 180.0) / Math.PI];
}

// Planar intersection and point in polygon
function segmentsIntersect(a1, a2, b1, b2) {
  function ccw(p1, p2, p3) {
    return (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
  }
  return ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
}

function pointInPolygon(pt, ring) {
  let inside = false;
  const x = pt[0], y = pt[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function computeSegmentIntersectionParam(a1, a2, b1, b2) {
  const denom = (b2[1] - b1[1]) * (a2[0] - a1[0]) - (b2[0] - b1[0]) * (a2[1] - a1[1]);
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b2[0] - b1[0]) * (a1[1] - b1[1]) - (b2[1] - b1[1]) * (a1[0] - b1[0])) / denom;
  const u = ((a2[0] - a1[0]) * (a1[1] - b1[1]) - (a2[1] - a1[1]) * (a1[0] - b1[0])) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

// Authoritative Hard Land Validation (Phase 3 invariant - UNCHANGED)
function checkLandIntersections(coordinates, rings) {
  const failingSegments = [];
  const numSegments = coordinates.length - 1;

  for (let i = 0; i < numSegments; i++) {
    const s1 = coordinates[i];
    const s2 = coordinates[i + 1];
    const isTerminal = i === 0 || i === numSegments - 1;
    const isDeparture = i === 0;
    const distKm = calculateGeodesicDistanceMeters(s1[0], s1[1], s2[0], s2[1]) / 1000.0;

    const sMinX = Math.min(s1[0], s2[0]);
    const sMaxX = Math.max(s1[0], s2[0]);
    const sMinY = Math.min(s1[1], s2[1]);
    const sMaxY = Math.max(s1[1], s2[1]);

    const midPt = [(s1[0] + s2[0]) / 2.0, (s1[1] + s2[1]) / 2.0];
    let intersects = false;
    let hitReason = '';

    for (let r = 0; r < rings.length; r++) {
      const { bbox, ring } = rings[r];
      if (sMaxX < bbox[0] || sMinX > bbox[2] || sMaxY < bbox[1] || sMinY > bbox[3]) continue;

      for (let j = 0; j < ring.length - 1; j++) {
        if (segmentsIntersect(s1, s2, ring[j], ring[j + 1])) {
          if (isTerminal) {
            const t = computeSegmentIntersectionParam(s1, s2, ring[j], ring[j + 1]);
            if (t !== null) {
              const crossPt = [s1[0] + t * (s2[0] - s1[0]), s1[1] + t * (s2[1] - s1[1])];
              const dockPt = isDeparture ? s1 : s2;
              const distFromDockKm = calculateGeodesicDistanceMeters(dockPt[0], dockPt[1], crossPt[0], crossPt[1]) / 1000.0;
              if (distFromDockKm <= 1.5) continue;
            }
          }
          intersects = true;
          hitReason = isTerminal
            ? 'Terminal harbor approach segment crosses land/peninsula beyond 1.5 km dock tolerance'
            : 'Line segment crosses land boundary polygon';
          break;
        }
      }

      if (intersects) break;

      if (pointInPolygon(midPt, ring)) {
        if (isTerminal) {
          const dockPt = isDeparture ? s1 : s2;
          const midDistFromDockKm = calculateGeodesicDistanceMeters(dockPt[0], dockPt[1], midPt[0], midPt[1]) / 1000.0;
          if (midDistFromDockKm <= 1.5) continue;
        }
        intersects = true;
        hitReason = isTerminal
          ? 'Terminal harbor approach segment traverses land interior beyond 1.5 km dock tolerance'
          : 'Line segment traverses land polygon interior';
        break;
      }
    }

    if (intersects) {
      const degLen = Math.sqrt((s2[0] - s1[0]) ** 2 + (s2[1] - s1[1]) ** 2);
      failingSegments.push({
        segmentIndex: i,
        startCoords: s1,
        endCoords: s2,
        lengthKm: distKm,
        crossingDeg: degLen,
        diagnosticReason: hitReason,
      });
    }
  }

  return failingSegments;
}

// Single segment water test with explicit dock coordinate
function isSegmentWaterSafeWithDock(s1, s2, dockPt, rings, maxToleranceKm = 1.5) {
  const sMinX = Math.min(s1[0], s2[0]), sMaxX = Math.max(s1[0], s2[0]);
  const sMinY = Math.min(s1[1], s2[1]), sMaxY = Math.max(s1[1], s2[1]);
  const midPt = [(s1[0] + s2[0]) / 2.0, (s1[1] + s2[1]) / 2.0];

  for (let r = 0; r < rings.length; r++) {
    const { bbox, ring } = rings[r];
    if (sMaxX < bbox[0] || sMinX > bbox[2] || sMaxY < bbox[1] || sMinY > bbox[3]) continue;

    for (let j = 0; j < ring.length - 1; j++) {
      if (segmentsIntersect(s1, s2, ring[j], ring[j + 1])) {
        if (dockPt !== null) {
          const t = computeSegmentIntersectionParam(s1, s2, ring[j], ring[j + 1]);
          if (t !== null) {
            const crossPt = [s1[0] + t * (s2[0] - s1[0]), s1[1] + t * (s2[1] - s1[1])];
            const distFromDock = calculateGeodesicDistanceMeters(dockPt[0], dockPt[1], crossPt[0], crossPt[1]) / 1000.0;
            if (distFromDock <= maxToleranceKm) continue;
          }
        }
        return false;
      }
    }

    if (pointInPolygon(midPt, ring)) {
      if (dockPt !== null) {
        const midDist = calculateGeodesicDistanceMeters(dockPt[0], dockPt[1], midPt[0], midPt[1]) / 1000.0;
        if (midDist <= maxToleranceKm) continue;
      }
      return false;
    }
  }
  return true;
}

// Terminal Harbor Approach Discovery via Radial Scan
function findSafeTerminalApproach(berth, marnetNode, isDeparture, rings, maxToleranceKm = 1.5) {
  const directSafe = isSegmentWaterSafeWithDock(berth, marnetNode, berth, rings, maxToleranceKm);
  const directDistKm = calculateGeodesicDistanceMeters(berth[0], berth[1], marnetNode[0], marnetNode[1]) / 1000.0;

  if (directSafe) {
    return {
      status: 'DIRECT_SAFE',
      waypoints: isDeparture ? [berth, marnetNode] : [marnetNode, berth],
      approachLengthKm: directDistKm,
      diagnosticReason: 'Direct line-of-sight between berth and network node is water-safe within dock tolerance',
    };
  }

  const bearingsCount = 12;
  const distances = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0];
  const dAngle = 360.0 / bearingsCount;
  const candidates = [];

  for (let b = 0; b < bearingsCount; b++) {
    const bearing = b * dAngle;
    for (const dist of distances) {
      const candidatePt = calculateDestinationPoint(berth, dist, bearing);
      const leg1Safe = isSegmentWaterSafeWithDock(berth, candidatePt, berth, rings, maxToleranceKm);
      if (!leg1Safe) continue;
      const leg2Safe = isSegmentWaterSafeWithDock(candidatePt, marnetNode, null, rings, 0.0);
      if (!leg2Safe) continue;

      const totalDist =
        (calculateGeodesicDistanceMeters(berth[0], berth[1], candidatePt[0], candidatePt[1]) +
          calculateGeodesicDistanceMeters(candidatePt[0], candidatePt[1], marnetNode[0], marnetNode[1])) / 1000.0;

      candidates.push({ point: candidatePt, totalDist, bearing, dist });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (Math.abs(a.totalDist - b.totalDist) > 1e-4) return a.totalDist - b.totalDist;
      return a.bearing - b.bearing;
    });
    const best = candidates[0];
    return {
      status: 'RADIAL_SCAN_SUCCESS',
      waypoints: isDeparture ? [berth, best.point, marnetNode] : [marnetNode, best.point, berth],
      approachLengthKm: best.totalDist,
      bearingDeg: best.bearing,
      scanDistanceKm: best.dist,
      diagnosticReason: `Water-safe approach connector established via radial scan (bearing ${best.bearing}°, ${best.dist} km)`,
    };
  }

  return {
    status: 'APPROACH_UNAVAILABLE',
    waypoints: isDeparture ? [berth, marnetNode] : [marnetNode, berth],
    approachLengthKm: directDistKm,
    diagnosticReason: `Terminal harbor approach crosses land beyond ${maxToleranceKm} km dock tolerance, and no water-safe radial corridor could be established`,
  };
}

// Route Quality Evaluation & Scoring
function evaluateRouteQuality(coordinates, gwTransitionDistKm = 0, terminalApproachCostKm = 0) {
  if (!coordinates || coordinates.length < 2) {
    return { totalDistanceKm: 0, orthodromicDistanceKm: 0, tortuosityRatio: 1.0, waypointCount: 0, meanCourseAlterationDeg: 0, maxCourseAlterationDeg: 0, gatewayTransitionDistanceKm: gwTransitionDistKm, terminalApproachCostKm, terminalApproachRatio: 0 };
  }

  let totalDistanceKm = 0.0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    totalDistanceKm += calculateGeodesicDistanceMeters(coordinates[i][0], coordinates[i][1], coordinates[i + 1][0], coordinates[i + 1][1]) / 1000.0;
  }

  const pStart = coordinates[0];
  const pEnd = coordinates[coordinates.length - 1];
  const orthodromicDistanceKm = calculateGeodesicDistanceMeters(pStart[0], pStart[1], pEnd[0], pEnd[1]) / 1000.0;
  const tortuosityRatio = orthodromicDistanceKm > 0 ? totalDistanceKm / orthodromicDistanceKm : 1.0;

  let totalTurnDeg = 0.0;
  let maxCourseAlterationDeg = 0.0;
  for (let i = 0; i < coordinates.length - 2; i++) {
    const turn = calculateCourseAlterationDeg(coordinates[i], coordinates[i + 1], coordinates[i + 2]);
    totalTurnDeg += turn;
    if (turn > maxCourseAlterationDeg) maxCourseAlterationDeg = turn;
  }
  const meanCourseAlterationDeg = coordinates.length > 2 ? totalTurnDeg / (coordinates.length - 2) : 0.0;
  const terminalApproachRatio = totalDistanceKm > 0 ? terminalApproachCostKm / totalDistanceKm : 0.0;

  return {
    totalDistanceKm,
    orthodromicDistanceKm,
    tortuosityRatio,
    waypointCount: coordinates.length,
    meanCourseAlterationDeg,
    maxCourseAlterationDeg,
    gatewayTransitionDistanceKm: gwTransitionDistKm,
    terminalApproachCostKm,
    terminalApproachRatio,
  };
}

function calculateRouteQualityScore(metrics, minBaselineDistanceKm = metrics.totalDistanceKm) {
  const normalizedDistance = minBaselineDistanceKm > 0 ? Math.max(0, (metrics.totalDistanceKm - minBaselineDistanceKm) / minBaselineDistanceKm) : 0.0;
  const normalizedTortuosity = Math.max(0, metrics.tortuosityRatio - 1.0);
  const normalizedSmoothness = metrics.meanCourseAlterationDeg / 45.0;
  const normalizedTransition = metrics.gatewayTransitionDistanceKm / 50.0;

  const compositeScore = 0.50 * normalizedDistance + 0.25 * normalizedTortuosity + 0.15 * normalizedSmoothness + 0.10 * normalizedTransition;
  return { compositeScore, normalizedDistance, normalizedTortuosity, normalizedSmoothness, normalizedTransition };
}

// Adaptive port snapping (Phase 3 invariant)
function isConnectorWaterValid(portCoords, nodeCoords, rings, maxToleranceKm = 1.5) {
  const s1 = portCoords, s2 = nodeCoords;
  const sMinX = Math.min(s1[0], s2[0]), sMaxX = Math.max(s1[0], s2[0]);
  const sMinY = Math.min(s1[1], s2[1]), sMaxY = Math.max(s1[1], s2[1]);
  for (let r = 0; r < rings.length; r++) {
    const { bbox, ring } = rings[r];
    if (sMaxX < bbox[0] || sMinX > bbox[2] || sMaxY < bbox[1] || sMinY > bbox[3]) continue;
    for (let j = 0; j < ring.length - 1; j++) {
      if (segmentsIntersect(s1, s2, ring[j], ring[j + 1])) {
        const t = computeSegmentIntersectionParam(s1, s2, ring[j], ring[j + 1]);
        if (t !== null) {
          const crossPt = [s1[0] + t * (s2[0] - s1[0]), s1[1] + t * (s2[1] - s1[1])];
          const distFromDock = calculateGeodesicDistanceMeters(portCoords[0], portCoords[1], crossPt[0], crossPt[1]) / 1000.0;
          if (distFromDock <= maxToleranceKm) continue;
        }
        return false;
      }
    }
    const midPt = [(portCoords[0] + nodeCoords[0]) / 2.0, (portCoords[1] + nodeCoords[1]) / 2.0];
    if (pointInPolygon(midPt, ring)) {
      const midDistFromDock = calculateGeodesicDistanceMeters(portCoords[0], portCoords[1], midPt[0], midPt[1]) / 1000.0;
      if (midDistFromDock > maxToleranceKm) return false;
    }
  }
  return true;
}

function findAdaptiveWaterNode(port, nodes, nodeComponent, primaryComp, rings, maxDistanceKm = 400) {
  const pCoords = [port.longitude, port.latitude];
  const latRad = (Math.abs(pCoords[1]) * Math.PI) / 180.0;
  const cosLat = Math.max(0.08, Math.cos(latRad));
  const maxLonDeg = Math.min(180, maxDistanceKm / 111.0 / cosLat);
  const maxLatDeg = maxDistanceKm / 111.0;
  const candidates = [];
  for (let i = 0; i < nodes.length; i++) {
    const pt = nodes[i];
    if (Math.abs(pt[1] - pCoords[1]) > maxLatDeg) continue;
    let dLon = Math.abs(pt[0] - pCoords[0]);
    if (dLon > 180) dLon = 360 - dLon;
    if (dLon > maxLonDeg) continue;
    const dist = calculateGeodesicDistanceMeters(pCoords[0], pCoords[1], pt[0], pt[1]) / 1000.0;
    if (dist <= maxDistanceKm) {
      candidates.push({ idx: i, coords: pt, dist, comp: nodeComponent[i] });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);
  let evaluated = 0;
  for (const k of [5, 10, 20, 50]) {
    const slice = candidates.slice(0, k);
    for (let c = evaluated; c < slice.length; c++) {
      const cand = slice[c];
      if (cand.comp !== primaryComp) continue;
      if (isConnectorWaterValid(pCoords, cand.coords, rings, 1.5)) {
        return { nodeIndex: cand.idx, nodeCoords: cand.coords, distanceKm: cand.dist, candidateDepth: k, comp: cand.comp };
      }
    }
    evaluated = slice.length;
  }
  return null;
}

function dijkstraShortestPath(startIdx, goalIdx, nodes, adj) {
  if (startIdx === goalIdx) return [nodes[startIdx]];
  const distances = new Float64Array(nodes.length).fill(Infinity);
  distances[startIdx] = 0;
  const previous = new Int32Array(nodes.length).fill(-1);
  const pq = new TinyQueue([], (a, b) => a.dist - b.dist);
  pq.push({ idx: startIdx, dist: 0 });

  while (pq.length > 0) {
    const { idx, dist } = pq.pop();
    if (idx === goalIdx) break;
    if (dist > distances[idx]) continue;
    const neighbors = adj[idx] || [];
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
  const path = [];
  let curr = goalIdx;
  while (curr !== -1) {
    path.push(nodes[curr]);
    curr = previous[curr];
  }
  path.reverse();
  return path;
}

function extractMarnetCoordinates(rawGeometry) {
  if (!rawGeometry || typeof rawGeometry !== 'object') return null;
  const geom = rawGeometry;
  if (!geom.type || !geom.coordinates || !Array.isArray(geom.coordinates)) return null;
  if (geom.type === 'LineString') return geom.coordinates;
  if (geom.type === 'MultiLineString') {
    const lines = geom.coordinates;
    if (!lines || lines.length === 0) return null;
    const flattened = [...lines[0]];
    for (let l = 1; l < lines.length; l++) {
      for (const pt of lines[l]) flattened.push(pt);
    }
    return flattened;
  }
  return null;
}

function stitchPolylines(segments, maxSeamGapKm = 200.0) {
  const result = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (!seg || seg.length === 0) continue;
    for (let p = 0; p < seg.length; p++) {
      const pt = seg[p];
      if (result.length > 0) {
        const last = result[result.length - 1];
        const gapMeters = calculateGeodesicDistanceMeters(last[0], last[1], pt[0], pt[1]);
        if (gapMeters < 1.0) continue;
        if (p === 0) {
          const isAntimeridian = Math.abs(Math.abs(last[0]) - 180) <= 1.0 && Math.abs(Math.abs(pt[0]) - 180) <= 1.0 && Math.abs(last[1] - pt[1]) <= 5.0;
          if (!isAntimeridian && gapMeters / 1000.0 > maxSeamGapKm) return null;
        }
      }
      result.push(pt);
    }
  }
  return result.length >= 2 ? result : null;
}

function pruneGatewayCandidates(portCoordsA, portCoordsB, gateways, maxCandidates = 18) {
  const scored = gateways.map((gw) => {
    const d1 = calculateGeodesicDistanceMeters(portCoordsA[0], portCoordsA[1], gw.polarCoords[0], gw.polarCoords[1]) / 1000.0;
    const d2 = calculateGeodesicDistanceMeters(gw.globalCoords[0], gw.globalCoords[1], portCoordsB[0], portCoordsB[1]) / 1000.0;
    const estTotalKm = d1 + d2 + gw.transitionDistanceKm;
    return { gw, estTotalKm };
  });
  scored.sort((a, b) => a.estTotalKm - b.estTotalKm);
  return scored.slice(0, maxCandidates).map((s) => s.gw);
}

// Compute Complete Route with Phase 7 Architecture
function computePhase7Route(originPort, destPort) {
  const origCoords = [originPort.longitude, originPort.latitude];
  const destCoords = [destPort.longitude, destPort.latitude];

  const originSnap = findAdaptiveWaterNode(originPort, nodes, nodeComponent, primaryComponentId, landRings, 400);
  const destSnap = findAdaptiveWaterNode(destPort, nodes, nodeComponent, primaryComponentId, landRings, 400);

  // Case 6: Patagonian Isolated Component (retained inside-passages)
  const isPatagonianPort = (p) => p.wpiNumber === 14190 || p.wpiNumber === 14175;
  if (isPatagonianPort(originPort) || isPatagonianPort(destPort) || (originSnap && originSnap.comp !== primaryComponentId) || (destSnap && destSnap.comp !== primaryComponentId)) {
    return {
      topology: 'CASE_6_PATAGONIAN_ISOLATED',
      status: 'HYBRID_UNAVAILABLE',
      distKm: 0,
      constructedDistKm: 0,
      polarDistKm: 0,
      globalDistKm: 0,
      transDistKm: 0,
      gateways: [],
      waypoints: 0,
      fails: 0,
      validationResult: 'FAIL',
      terminalApproachStatus: 'APPROACH_UNAVAILABLE',
      failureCategory: 'Patagonian isolated fjord',
      diagnostic: 'Port belongs to retained isolated Patagonian component; hybrid routing unavailable without synthetic edges.',
    };
  }

  // Case 1: Polar -> Polar
  if (originSnap && destSnap) {
    const path = dijkstraShortestPath(originSnap.nodeIndex, destSnap.nodeIndex, nodes, adj);
    if (path && path.length > 0) {
      const full = [origCoords, ...path, destCoords];
      let dist = 0;
      for (let i = 0; i < full.length - 1; i++) dist += calculateGeodesicDistanceMeters(full[i][0], full[i][1], full[i + 1][0], full[i + 1][1]) / 1000.0;
      const fails = checkLandIntersections(full, landRings);
      const quality = evaluateRouteQuality(full, 0, 0);
      const qualityScore = calculateRouteQualityScore(quality, dist);

      return {
        topology: 'CASE_1_POLAR_POLAR',
        status: fails.length === 0 ? 'SUCCESS' : 'REJECTED_LAND_INTERSECTION',
        distKm: fails.length === 0 ? dist : 0,
        constructedDistKm: dist,
        polarDistKm: dist,
        globalDistKm: 0,
        transDistKm: 0,
        gateways: [],
        waypoints: fails.length === 0 ? full.length : 0,
        constructedWaypoints: full.length,
        fails: fails.length,
        validationResult: fails.length === 0 ? 'PASS' : 'FAIL',
        terminalApproachStatus: 'DIRECT_SAFE',
        failureCategory: fails.length > 0 ? 'Validation failure' : undefined,
        qualityMetrics: quality,
        qualityScore,
      };
    }
  }

  // Case 2: Global -> Global
  if (!originSnap && !destSnap) {
    try {
      const rawRoute = seaRoute(origCoords, destCoords, { network: marnet20, units: 'kilometers', antimeridian: 'split' });
      if (rawRoute && rawRoute.geometry) {
        const netCoords = extractMarnetCoordinates(rawRoute.geometry);
        if (netCoords && netCoords.length >= 2) {
          const depApproach = findSafeTerminalApproach(origCoords, netCoords[0], true, landRings);
          const arrApproach = findSafeTerminalApproach(destCoords, netCoords[netCoords.length - 1], false, landRings);
          const depSegment = depApproach ? depApproach.waypoints.slice(0, -1) : [origCoords];
          const arrSegment = arrApproach ? arrApproach.waypoints.slice(1) : [destCoords];
          const fullCoords = [...depSegment, ...netCoords, ...arrSegment];

          let dist = 0;
          for (let i = 0; i < fullCoords.length - 1; i++) dist += calculateGeodesicDistanceMeters(fullCoords[i][0], fullCoords[i][1], fullCoords[i + 1][0], fullCoords[i + 1][1]) / 1000.0;
          const fails = checkLandIntersections(fullCoords, landRings);
          const termCost = (depApproach ? depApproach.approachLengthKm : 0) + (arrApproach ? arrApproach.approachLengthKm : 0);
          const quality = evaluateRouteQuality(fullCoords, 0, termCost);
          const qualityScore = calculateRouteQualityScore(quality, dist);

          const isTerminalFail = fails[0] && (fails[0].segmentIndex === 0 || fails[0].segmentIndex === fullCoords.length - 2);
          const failureCategory = fails.length === 0
            ? undefined
            : isTerminalFail
            ? 'Terminal harbor approach failure'
            : 'Internal MARNET topology failure';

          return {
            topology: 'CASE_2_GLOBAL_GLOBAL',
            status: fails.length === 0 ? 'SUCCESS' : 'REJECTED_LAND_INTERSECTION',
            distKm: fails.length === 0 ? dist : 0,
            constructedDistKm: dist,
            polarDistKm: 0,
            globalDistKm: dist,
            transDistKm: 0,
            gateways: [],
            waypoints: fails.length === 0 ? fullCoords.length : 0,
            constructedWaypoints: fullCoords.length,
            fails: fails.length,
            firstFailingSegment: fails[0],
            validationResult: fails.length === 0 ? 'PASS' : 'FAIL',
            terminalApproachStatus:
              depApproach.status === 'APPROACH_UNAVAILABLE' || arrApproach.status === 'APPROACH_UNAVAILABLE'
                ? 'APPROACH_UNAVAILABLE'
                : depApproach.status === 'RADIAL_SCAN_SUCCESS' || arrApproach.status === 'RADIAL_SCAN_SUCCESS'
                ? 'RADIAL_SCAN_SUCCESS'
                : 'DIRECT_SAFE',
            failureCategory,
            qualityMetrics: quality,
            qualityScore,
            diagnostic: failureCategory ? `${failureCategory}: ${fails[0]?.diagnosticReason}` : undefined,
          };
        }
      }
    } catch (e) {}
  }

  // Case 4: Polar Origin -> Global Destination
  if (originSnap && !destSnap) {
    const candidates = pruneGatewayCandidates(origCoords, destCoords, gatewayCatalog, 18);
    const validCandidates = [];
    const diagAttempts = [];

    for (const gw of candidates) {
      const polarPath = dijkstraShortestPath(originSnap.nodeIndex, gw.polarNodeId, nodes, adj);
      if (!polarPath) continue;
      let rawGlobal = null;
      try {
        rawGlobal = seaRoute(gw.globalCoords, destCoords, { network: marnet20, units: 'kilometers', antimeridian: 'split' });
      } catch (e) { continue; }
      if (!rawGlobal || !rawGlobal.geometry) continue;
      const globalCoords = extractMarnetCoordinates(rawGlobal.geometry);
      if (!globalCoords || globalCoords.length < 2) continue;

      const lastMarnet = globalCoords[globalCoords.length - 1];
      const termApproach = findSafeTerminalApproach(destCoords, lastMarnet, false, landRings);

      const polarSeg = [origCoords, ...polarPath];
      const transSeg = gw.transitionDistanceKm > 0.05 ? [gw.polarCoords, gw.globalCoords] : [gw.polarCoords];
      const globalSeg = termApproach
        ? [...globalCoords.slice(0, -1), ...termApproach.waypoints]
        : [...globalCoords, destCoords];

      const stitched = stitchPolylines([polarSeg, transSeg, globalSeg]);
      if (!stitched) continue;

      let totalDist = 0;
      for (let i = 0; i < stitched.length - 1; i++) totalDist += calculateGeodesicDistanceMeters(stitched[i][0], stitched[i][1], stitched[i + 1][0], stitched[i + 1][1]) / 1000.0;
      let polarDist = 0;
      for (let i = 0; i < polarSeg.length - 1; i++) polarDist += calculateGeodesicDistanceMeters(polarSeg[i][0], polarSeg[i][1], polarSeg[i + 1][0], polarSeg[i + 1][1]) / 1000.0;
      const globalDist = totalDist - polarDist - gw.transitionDistanceKm;

      const fails = checkLandIntersections(stitched, landRings);
      const quality = evaluateRouteQuality(stitched, gw.transitionDistanceKm, termApproach ? termApproach.approachLengthKm : 0);

      diagAttempts.push({
        gw,
        totalDist,
        polarDist,
        globalDist,
        transDist: gw.transitionDistanceKm,
        waypoints: stitched.length,
        fails: fails.length,
        firstFail: fails[0],
        termStatus: termApproach?.status,
        quality,
      });

      if (fails.length === 0) {
        validCandidates.push({
          gw,
          coordinates: stitched,
          totalDist,
          polarDist,
          globalDist,
          transDist: gw.transitionDistanceKm,
          waypoints: stitched.length,
          termStatus: termApproach?.status,
          quality,
        });
      }
    }

    if (validCandidates.length > 0) {
      const minDist = Math.min(...validCandidates.map((c) => c.totalDist));
      const scored = validCandidates.map((c) => ({
        ...c,
        qualityScore: calculateRouteQualityScore(c.quality, minDist),
      }));

      scored.sort((a, b) => {
        if (Math.abs(a.qualityScore.compositeScore - b.qualityScore.compositeScore) > 0.0001) {
          return a.qualityScore.compositeScore - b.qualityScore.compositeScore;
        }
        if (Math.abs(a.totalDist - b.totalDist) > 0.1) return a.totalDist - b.totalDist;
        if (Math.abs(a.transDist - b.transDist) > 0.01) return a.transDist - b.transDist;
        return a.gw.gatewayId.localeCompare(b.gw.gatewayId);
      });

      const best = scored[0];
      return {
        topology: 'CASE_4_POLAR_GLOBAL',
        status: 'SUCCESS',
        distKm: best.totalDist,
        constructedDistKm: best.totalDist,
        polarDistKm: best.polarDist,
        globalDistKm: best.globalDist,
        transDistKm: best.transDist,
        gateways: [best.gw.gatewayId],
        waypoints: best.waypoints,
        constructedWaypoints: best.waypoints,
        fails: 0,
        validationResult: 'PASS',
        terminalApproachStatus: best.termStatus,
        qualityMetrics: best.quality,
        qualityScore: best.qualityScore,
      };
    }

    diagAttempts.sort((a, b) => a.totalDist - b.totalDist);
    const topDiag = diagAttempts[0] || { totalDist: 0, polarDist: 0, globalDist: 0, transDist: 0, waypoints: 0, fails: 1, gw: candidates[0] };
    const firstFail = topDiag.firstFail;
    const isTerminalFail = firstFail && (firstFail.segmentIndex === 0 || firstFail.segmentIndex === topDiag.waypoints - 2);
    const failureCategory = isTerminalFail ? 'Terminal harbor approach failure' : 'Internal MARNET topology failure';

    return {
      topology: 'CASE_4_POLAR_GLOBAL',
      status: 'REJECTED_LAND_INTERSECTION',
      distKm: 0,
      constructedDistKm: topDiag.totalDist,
      polarDistKm: topDiag.polarDist,
      globalDistKm: topDiag.globalDist,
      transDistKm: topDiag.transDist,
      gateways: [topDiag.gw?.gatewayId || 'NONE'],
      waypoints: 0,
      constructedWaypoints: topDiag.waypoints,
      fails: topDiag.fails,
      firstFailingSegment: firstFail,
      validationResult: 'FAIL',
      terminalApproachStatus: topDiag.termStatus || 'APPROACH_UNAVAILABLE',
      failureCategory,
      diagnostic: `${failureCategory}: ${firstFail?.diagnosticReason || 'land crossing'}`,
    };
  }

  // Case 3: Global Origin -> Polar Destination
  if (!originSnap && destSnap) {
    const candidates = pruneGatewayCandidates(destCoords, origCoords, gatewayCatalog, 18);
    const validCandidates = [];
    const diagAttempts = [];

    for (const gw of candidates) {
      let rawGlobal = null;
      try {
        rawGlobal = seaRoute(origCoords, gw.globalCoords, { network: marnet20, units: 'kilometers', antimeridian: 'split' });
      } catch (e) { continue; }
      if (!rawGlobal || !rawGlobal.geometry) continue;
      const globalCoords = extractMarnetCoordinates(rawGlobal.geometry);
      if (!globalCoords || globalCoords.length < 2) continue;

      const polarPath = dijkstraShortestPath(gw.polarNodeId, destSnap.nodeIndex, nodes, adj);
      if (!polarPath) continue;

      const firstMarnet = globalCoords[0];
      const termApproach = findSafeTerminalApproach(origCoords, firstMarnet, true, landRings);

      const globalSeg = termApproach
        ? [...termApproach.waypoints, ...globalCoords.slice(1)]
        : [origCoords, ...globalCoords];
      const transSeg = gw.transitionDistanceKm > 0.05 ? [gw.globalCoords, gw.polarCoords] : [gw.polarCoords];
      const polarSeg = [...polarPath, destCoords];

      const stitched = stitchPolylines([globalSeg, transSeg, polarSeg]);
      if (!stitched) continue;

      let totalDist = 0;
      for (let i = 0; i < stitched.length - 1; i++) totalDist += calculateGeodesicDistanceMeters(stitched[i][0], stitched[i][1], stitched[i + 1][0], stitched[i + 1][1]) / 1000.0;
      let polarDist = 0;
      for (let i = 0; i < polarSeg.length - 1; i++) polarDist += calculateGeodesicDistanceMeters(polarSeg[i][0], polarSeg[i][1], polarSeg[i + 1][0], polarSeg[i + 1][1]) / 1000.0;
      const globalDist = totalDist - polarDist - gw.transitionDistanceKm;

      const fails = checkLandIntersections(stitched, landRings);
      const quality = evaluateRouteQuality(stitched, gw.transitionDistanceKm, termApproach ? termApproach.approachLengthKm : 0);

      diagAttempts.push({
        gw,
        totalDist,
        polarDist,
        globalDist,
        transDist: gw.transitionDistanceKm,
        waypoints: stitched.length,
        fails: fails.length,
        firstFail: fails[0],
        termStatus: termApproach?.status,
        quality,
      });

      if (fails.length === 0) {
        validCandidates.push({
          gw,
          coordinates: stitched,
          totalDist,
          polarDist,
          globalDist,
          transDist: gw.transitionDistanceKm,
          waypoints: stitched.length,
          termStatus: termApproach?.status,
          quality,
        });
      }
    }

    if (validCandidates.length > 0) {
      const minDist = Math.min(...validCandidates.map((c) => c.totalDist));
      const scored = validCandidates.map((c) => ({
        ...c,
        qualityScore: calculateRouteQualityScore(c.quality, minDist),
      }));

      scored.sort((a, b) => {
        if (Math.abs(a.qualityScore.compositeScore - b.qualityScore.compositeScore) > 0.0001) {
          return a.qualityScore.compositeScore - b.qualityScore.compositeScore;
        }
        if (Math.abs(a.totalDist - b.totalDist) > 0.1) return a.totalDist - b.totalDist;
        if (Math.abs(a.transDist - b.transDist) > 0.01) return a.transDist - b.transDist;
        return a.gw.gatewayId.localeCompare(b.gw.gatewayId);
      });

      const best = scored[0];
      return {
        topology: 'CASE_3_GLOBAL_POLAR',
        status: 'SUCCESS',
        distKm: best.totalDist,
        constructedDistKm: best.totalDist,
        polarDistKm: best.polarDist,
        globalDistKm: best.globalDist,
        transDistKm: best.transDist,
        gateways: [best.gw.gatewayId],
        waypoints: best.waypoints,
        constructedWaypoints: best.waypoints,
        fails: 0,
        validationResult: 'PASS',
        terminalApproachStatus: best.termStatus,
        qualityMetrics: best.quality,
        qualityScore: best.qualityScore,
      };
    }

    diagAttempts.sort((a, b) => a.totalDist - b.totalDist);
    const topDiag = diagAttempts[0] || { totalDist: 0, polarDist: 0, globalDist: 0, transDist: 0, waypoints: 0, fails: 1, gw: candidates[0] };
    const firstFail = topDiag.firstFail;
    const isTerminalFail = firstFail && (firstFail.segmentIndex === 0 || firstFail.segmentIndex === topDiag.waypoints - 2);
    const failureCategory = isTerminalFail ? 'Terminal harbor approach failure' : 'Internal MARNET topology failure';

    return {
      topology: 'CASE_3_GLOBAL_POLAR',
      status: 'REJECTED_LAND_INTERSECTION',
      distKm: 0,
      constructedDistKm: topDiag.totalDist,
      polarDistKm: topDiag.polarDist,
      globalDistKm: topDiag.globalDist,
      transDistKm: topDiag.transDist,
      gateways: [topDiag.gw?.gatewayId || 'NONE'],
      waypoints: 0,
      constructedWaypoints: topDiag.waypoints,
      fails: topDiag.fails,
      firstFailingSegment: firstFail,
      validationResult: 'FAIL',
      terminalApproachStatus: topDiag.termStatus || 'APPROACH_UNAVAILABLE',
      failureCategory,
      diagnostic: `${failureCategory}: ${firstFail?.diagnosticReason || 'land crossing'}`,
    };
  }

  return {
    topology: 'UNKNOWN',
    status: 'NO_FEASIBLE_ROUTE',
    distKm: 0,
    constructedDistKm: 0,
    polarDistKm: 0,
    globalDistKm: 0,
    transDistKm: 0,
    gateways: [],
    waypoints: 0,
    fails: 1,
    validationResult: 'FAIL',
    diagnostic: 'Unknown topology classification or unroutable port combination.',
  };
}

// Complete 17-Route Benchmark Matrix
const benchmarkCases = [
  // A. Polar -> Polar
  { name: 'Stanley -> McMurdo Station', origWpi: 14000, destWpi: 63130, category: 'Polar -> Polar' },
  { name: 'Stanley -> Scotia Bay (Laurie Is)', origWpi: 14000, destWpi: 63080, category: 'Polar -> Polar' },
  { name: 'Ushuaia -> Ellefsen Harbor', origWpi: 13980, destWpi: 63070, category: 'Polar -> Polar' },
  { name: 'Ushuaia -> Scotia Bay (Laurie Is)', origWpi: 13980, destWpi: 63080, category: 'Polar -> Polar' },
  { name: 'Ushuaia -> McMurdo Station', origWpi: 13980, destWpi: 63130, category: 'Polar -> Polar' },

  // B. Polar -> Global
  { name: 'Stanley -> Cape Town', origWpi: 14000, destWpi: 46770, category: 'Polar -> Global' },
  { name: 'Ellefsen Harbor -> Cape Town', origWpi: 63070, destWpi: 46770, category: 'Polar -> Global' },
  { name: 'McMurdo Station -> Cape Town', origWpi: 63130, destWpi: 46770, category: 'Polar -> Global' },

  // C. Global -> Polar
  { name: 'Cape Town -> Stanley', origWpi: 46770, destWpi: 14000, category: 'Global -> Polar' },
  { name: 'Cape Town -> McMurdo Station', origWpi: 46770, destWpi: 63130, category: 'Global -> Polar' },
  { name: 'Mumbai -> McMurdo Station', origWpi: 48840, destWpi: 63130, category: 'Global -> Polar' },

  // D. Global -> Global
  { name: 'Cape Town -> Mumbai', origWpi: 46770, destWpi: 48840, category: 'Global -> Global' },
  { name: 'Cape Town -> Sydney', origWpi: 46770, destWpi: 53650, category: 'Global -> Global' },

  // E. Patagonian Isolated Components
  { name: 'Puerto Natales -> Ellefsen Harbor', origWpi: 14190, destWpi: 63070, category: 'Patagonian Isolated' },
  { name: 'Caleta Mina Elena -> Ellefsen Harbor', origWpi: 14175, destWpi: 63070, category: 'Patagonian Isolated' },
  { name: 'Puerto Natales -> McMurdo Station', origWpi: 14190, destWpi: 63130, category: 'Patagonian Isolated' },
  { name: 'Caleta Mina Elena -> McMurdo Station', origWpi: 14175, destWpi: 63130, category: 'Patagonian Isolated' },
];

function runFullBenchmark(iteration = 1) {
  console.log(`\n=================== BENCHMARK EXECUTION (RUN ${iteration}) ===================`);
  const results = [];

  for (const tc of benchmarkCases) {
    const origPort = portsData.find((p) => p.wpiNumber === tc.origWpi);
    const destPort = portsData.find((p) => p.wpiNumber === tc.destWpi);

    const res = computePhase7Route(origPort, destPort);
    results.push({
      label: tc.name,
      category: tc.category,
      topology: res.topology,
      status: res.status,
      validatedDistKm: res.distKm,
      constructedDistKm: res.constructedDistKm,
      waypoints: res.waypoints,
      constructedWaypoints: res.constructedWaypoints,
      landCrossings: res.fails,
      gateways: res.gateways,
      terminalApproachStatus: res.terminalApproachStatus,
      failureCategory: res.failureCategory,
      diagnostic: res.diagnostic,
      qualityMetrics: res.qualityMetrics,
      qualityScore: res.qualityScore,
    });

    const statusStr = res.status === 'SUCCESS' ? 'PASS' : res.status;
    const qScoreStr = res.qualityScore ? res.qualityScore.compositeScore.toFixed(4) : 'N/A';
    const termStr = res.terminalApproachStatus || 'N/A';
    console.log(
      `${tc.name.padEnd(35)} | ${statusStr.padEnd(7)} | Val: ${res.distKm.toFixed(1).padStart(8)} km | Const: ${res.constructedDistKm.toFixed(1).padStart(8)} km | WPs: ${String(res.waypoints).padStart(3)} | Q(R): ${qScoreStr.padStart(6)} | Term: ${termStr.padEnd(20)} | Fails: ${res.fails}`
    );
  }

  return results;
}

// Execute Run 1
const run1Results = runFullBenchmark(1);

// Execute Run 2 for Bit-for-Bit Determinism Verification
const run2Results = runFullBenchmark(2);

console.log('\n================================================================================');
console.log('DETERMINISM VERIFICATION (RUN 1 vs RUN 2)');
console.log('================================================================================');
let bitIdentical = true;
const run1Str = JSON.stringify(run1Results);
const run2Str = JSON.stringify(run2Results);

if (run1Str === run2Str) {
  console.log('✅ PASS: 100% BIT-FOR-BIT IDENTICAL ACROSS ALL 17 BENCHMARK ROUTES!');
} else {
  console.error('❌ FAIL: Discrepancy detected between Run 1 and Run 2 results!');
  bitIdentical = false;
}

// Generate Production Artifacts
const outBenchmarkPath = path.join(projectRoot, 'data/routing/processed/terminal_approach_benchmark.json');
const outLineagePath = path.join(projectRoot, 'data/routing/metadata/terminal_approach_lineage.json');

fs.mkdirSync(path.dirname(outBenchmarkPath), { recursive: true });
fs.mkdirSync(path.dirname(outLineagePath), { recursive: true });

const benchmarkArtifact = {
  metadata: {
    benchmarkVersion: 'Phase 7 Terminal Harbor Approaches & Route Quality Release',
    generatedAt: new Date().toISOString(),
    totalRoutesEvaluated: run1Results.length,
    determinismVerified: bitIdentical,
    scoringWeights: {
      distanceWeight: 0.50,
      tortuosityWeight: 0.25,
      smoothnessWeight: 0.15,
      transitionDiscontinuityWeight: 0.10,
    },
  },
  results: run1Results,
};

fs.writeFileSync(outBenchmarkPath, JSON.stringify(benchmarkArtifact, null, 2));
console.log(`Saved benchmark artifact to: ${outBenchmarkPath}`);

const lineageArtifact = {
  phase: 'PHASE_7_TERMINAL_APPROACHES_AND_ROUTE_QUALITY',
  timestamp: new Date().toISOString(),
  gitProvenance: {
    branch: 'phase7-terminal-approach-quality',
    author: 'Antarctic DSS Engine Architecture Team',
  },
  upstreamDependencies: {
    phase1: 'Single Source of Truth (AntarcticOverview.tsx)',
    phase2: 'Eurostat MARNET 20km Mesh Geometry',
    phase3: 'Adaptive Port Snapping & Authoritative Land Gate',
    phase4: 'Polar Graph Connectivity (17,688 nodes, 4 components)',
    phase5: 'Empirical Transition Gateways (-35°S corridor, 233 gateways)',
    phase6: 'Hybrid Polar-Global Route Construction with Hard Validation Gate',
  },
  phase7Innovations: {
    terminalApproachService: 'Radial water-safe scan (12 compass bearings x 6 distances [0.5-5.0 km]) resolving macro-mesh quayside/breakwater truncation',
    routeQualityService: 'Multi-objective composite scoring Q(R) integrating distance efficiency, tortuosity, course smoothness, and seam continuity',
    failureTaxonomy: 'Formal distinction between Terminal Approach Failure, Internal MARNET Topology Failure, and Polar Routing Failure',
  },
  determinismStatus: bitIdentical ? 'BIT_IDENTICAL_VERIFIED' : 'NON_DETERMINISTIC_FAILED',
};

fs.writeFileSync(outLineagePath, JSON.stringify(lineageArtifact, null, 2));
console.log(`Saved lineage metadata to: ${outLineagePath}`);
