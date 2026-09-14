#!/usr/bin/env node
/**
 * Verification Script for User-Reported Routing Corridors
 * ------------------------------------------------------
 * Tests the 3 exact problematic corridors reported by user:
 * 1. Lirquen -> Caleta Patillos (Chile direct coastal route vs 1,873 NM detour to GW--85.0_-35.0)
 * 2. Stanley -> McMurdo Station (Westward Pacific GC ~6,252 km vs 12,433 km eastward detour)
 * 3. Port De Aracaju -> Nelson (River berth approach & Antimeridian-safe hybrid route)
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

const portsData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/ports.json'), 'utf-8'));
const graphData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/polarWaterGraph.json'), 'utf-8'));
const landRings = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/southernLandRings.json'), 'utf-8'));
const gatewayCatalog = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data/routing/processed/gateway_benchmark.json'), 'utf-8')).validatedGateways;

// Utilities
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

function calculateDestinationPoint(pt, distKm, bearingDeg) {
  const toRad = (d) => (d * Math.PI) / 180.0;
  const toDeg = (r) => (r * 180.0) / Math.PI;
  const lat1 = toRad(pt[1]);
  const lon1 = toRad(pt[0]);
  const brng = toRad(bearingDeg);
  const dr = (distKm * 1000.0) / R;

  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
  return [toDeg(lon2), toDeg(lat2)];
}

function ccw(p1, p2, p3) {
  return (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
}

function segmentsIntersect(a, b, c, d) {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
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

function getAdaptiveDockToleranceKm(port) {
  if (!port || !port.harborType) return 1.5;
  const ht = port.harborType.toLowerCase();
  if (ht.includes('river') || ht.includes('canal')) {
    return 4.5;
  }
  if (ht.includes('natural') || ht.includes('coastal') || ht.includes('breakwater') || ht.includes('tide')) {
    return 2.0;
  }
  return 1.5;
}

function checkLandIntersections(coordinates, rings, depToleranceKm = 1.5, destToleranceKm = 1.5) {
  const failingSegments = [];
  const numSegments = coordinates.length - 1;

  for (let i = 0; i < numSegments; i++) {
    const s1 = coordinates[i];
    const s2 = coordinates[i + 1];
    const isTerminal = i === 0 || i === numSegments - 1;
    const isDeparture = i === 0;
    const dockToleranceKm = isDeparture ? depToleranceKm : destToleranceKm;
    const distKm = calculateGeodesicDistanceMeters(s1[0], s1[1], s2[0], s2[1]) / 1000.0;

    const isAntimeridianCrossing = Math.abs(s1[0] - s2[0]) > 180.0;
    const subSegments = [];
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

    let intersects = false;
    let hitReason = '';

    for (const [p1, p2] of subSegments) {
      if (Math.abs(p1[0] - p2[0]) < 1e-6 && Math.abs(p1[1] - p2[1]) < 1e-6) continue;

      const sMinX = Math.min(p1[0], p2[0]), sMaxX = Math.max(p1[0], p2[0]);
      const sMinY = Math.min(p1[1], p2[1]), sMaxY = Math.max(p1[1], p2[1]);
      const midPt = [(p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0];

      for (let r = 0; r < rings.length; r++) {
        const { bbox, ring } = rings[r];
        if (sMaxX < bbox[0] || sMinX > bbox[2] || sMaxY < bbox[1] || sMinY > bbox[3]) continue;

        for (let j = 0; j < ring.length - 1; j++) {
          if (segmentsIntersect(p1, p2, ring[j], ring[j + 1])) {
            if (isTerminal) {
              const t = computeSegmentIntersectionParam(p1, p2, ring[j], ring[j + 1]);
              if (t !== null) {
                const crossPt = [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
                const dockPt = isDeparture ? s1 : s2;
                const distFromDockKm = calculateGeodesicDistanceMeters(dockPt[0], dockPt[1], crossPt[0], crossPt[1]) / 1000.0;
                if (distFromDockKm <= dockToleranceKm) continue;
              }
            }
            intersects = true;
            hitReason = `Crosses land boundary beyond ${dockToleranceKm} km tolerance`;
            break;
          }
        }
        if (intersects) break;

        if (pointInPolygon(midPt, ring)) {
          if (isTerminal) {
            const dockPt = isDeparture ? s1 : s2;
            const midDist = calculateGeodesicDistanceMeters(dockPt[0], dockPt[1], midPt[0], midPt[1]) / 1000.0;
            if (midDist <= dockToleranceKm) continue;
          }
          intersects = true;
          hitReason = `Traverses polygon interior beyond ${dockToleranceKm} km tolerance`;
          break;
        }
      }
      if (intersects) break;
    }

    if (intersects) {
      failingSegments.push({ segmentIndex: i, start: s1, end: s2, reason: hitReason });
    }
  }

  return failingSegments;
}

function isSegmentWaterSafeWithDock(s1, s2, dockPt, rings, maxToleranceKm = 1.5) {
  const isAntimeridianCrossing = Math.abs(s1[0] - s2[0]) > 180.0;
  const subSegments = [];
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

  for (const [p1, p2] of subSegments) {
    if (Math.abs(p1[0] - p2[0]) < 1e-6 && Math.abs(p1[1] - p2[1]) < 1e-6) continue;

    const sMinX = Math.min(p1[0], p2[0]), sMaxX = Math.max(p1[0], p2[0]);
    const sMinY = Math.min(p1[1], p2[1]), sMaxY = Math.max(p1[1], p2[1]);
    const midPt = [(p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0];

    for (let r = 0; r < rings.length; r++) {
      const { bbox, ring } = rings[r];
      if (sMaxX < bbox[0] || sMinX > bbox[2] || sMaxY < bbox[1] || sMinY > bbox[3]) continue;

      for (let j = 0; j < ring.length - 1; j++) {
        if (segmentsIntersect(p1, p2, ring[j], ring[j + 1])) {
          if (dockPt !== null) {
            const t = computeSegmentIntersectionParam(p1, p2, ring[j], ring[j + 1]);
            if (t !== null) {
              const crossPt = [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
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
  }
  return true;
}

function findSafeTerminalApproach(berth, marnetNode, isDeparture, rings, maxToleranceKm = 1.5) {
  const directSafe = isSegmentWaterSafeWithDock(berth, marnetNode, berth, rings, maxToleranceKm);
  const directDistKm = calculateGeodesicDistanceMeters(berth[0], berth[1], marnetNode[0], marnetNode[1]) / 1000.0;

  if (directSafe) {
    return {
      status: 'DIRECT_SAFE',
      waypoints: isDeparture ? [berth, marnetNode] : [marnetNode, berth],
      approachLengthKm: directDistKm,
    };
  }

  const bearingsCount = 16;
  const distances = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0, 15.0];
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
    candidates.sort((a, b) => a.totalDist - b.totalDist);
    const best = candidates[0];
    return {
      status: 'RADIAL_SCAN_SUCCESS',
      waypoints: isDeparture ? [berth, best.point, marnetNode] : [marnetNode, best.point, berth],
      approachLengthKm: best.totalDist,
      bearingDeg: best.bearing,
      scanDistanceKm: best.dist,
    };
  }

  return {
    status: 'APPROACH_UNAVAILABLE',
    waypoints: isDeparture ? [berth, marnetNode] : [marnetNode, berth],
    approachLengthKm: directDistKm,
  };
}

function extractMarnetCoordinates(geom) {
  if (!geom) return null;
  if (geom.type === 'LineString') return geom.coordinates;
  if (geom.type === 'MultiLineString') {
    const coords = [];
    for (const part of geom.coordinates) {
      if (coords.length > 0 && part.length > 0) {
        const last = coords[coords.length - 1];
        const first = part[0];
        if (Math.abs(last[0] - first[0]) < 1e-4 && Math.abs(last[1] - first[1]) < 1e-4) {
          coords.push(...part.slice(1));
        } else {
          coords.push(...part);
        }
      } else {
        coords.push(...part);
      }
    }
    return coords;
  }
  return null;
}

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
let primaryComponentId = 0, maxCompSize = 0;
componentSizes.forEach((sz, idx) => {
  if (sz > maxCompSize) { maxCompSize = sz; primaryComponentId = idx; }
});

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

function findAdaptiveWaterNode(port, maxDistanceKm = 400) {
  const pCoords = [port.longitude, port.latitude];
  const candidates = [];
  for (let i = 0; i < nodes.length; i++) {
    const d = calculateGeodesicDistanceMeters(pCoords[0], pCoords[1], nodes[i][0], nodes[i][1]) / 1000.0;
    if (d <= maxDistanceKm) {
      candidates.push({ nodeIndex: i, coords: nodes[i], distKm: d, comp: nodeComponent[i] });
    }
  }
  candidates.sort((a, b) => a.distKm - b.distKm);
  const tol = getAdaptiveDockToleranceKm(port);
  for (const c of candidates) {
    if (c.comp === primaryComponentId && isConnectorWaterValid(pCoords, c.coords, landRings, tol)) {
      return c;
    }
  }
  return null;
}

function dijkstraShortestPath(startIdx, targetIdx) {
  if (startIdx === targetIdx) return [nodes[startIdx]];
  const dists = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Int32Array(nodes.length).fill(-1);
  const pq = new TinyQueue([], (a, b) => a.dist - b.dist);

  dists[startIdx] = 0;
  pq.push({ nodeIndex: startIdx, dist: 0 });

  while (pq.length > 0) {
    const { nodeIndex: u, dist: d } = pq.pop();
    if (d > dists[u]) continue;
    if (u === targetIdx) {
      const path = [];
      let curr = targetIdx;
      while (curr !== -1) {
        path.push(nodes[curr]);
        curr = prev[curr];
      }
      path.reverse();
      return path;
    }

    for (const edge of adj[u]) {
      const v = edge.nodeIndex;
      const alt = d + edge.weight;
      if (alt < dists[v]) {
        dists[v] = alt;
        prev[v] = u;
        pq.push({ nodeIndex: v, dist: alt });
      }
    }
  }
  return null;
}

console.log('================================================================================');
console.log('VERIFYING 3 USER-REPORTED TEST CORRIDORS');
console.log('================================================================================\n');

// 1. Lirquen -> Caleta Patillos
console.log('--- TEST 1: Lirquen -> Caleta Patillos (Chile Coastal Corridor) ---');
const lirquen = portsData.find(p => p.wpiNumber === 14425);
const patillos = portsData.find(p => p.wpiNumber === 14671);
const lirquenCoords = [lirquen.longitude, lirquen.latitude];
const patillosCoords = [patillos.longitude, patillos.latitude];

const rawChile = seaRoute(lirquenCoords, patillosCoords, { network: marnet20, units: 'kilometers', antimeridian: 'split' });
let netChile = extractMarnetCoordinates(rawChile.geometry);

let depChile = findSafeTerminalApproach(lirquenCoords, netChile[0], true, landRings, getAdaptiveDockToleranceKm(lirquen));
if (depChile.status === 'APPROACH_UNAVAILABLE' && netChile.length > 2) {
  const alt = findSafeTerminalApproach(lirquenCoords, netChile[1], true, landRings, getAdaptiveDockToleranceKm(lirquen));
  if (alt.status !== 'APPROACH_UNAVAILABLE') {
    depChile = alt;
    netChile = netChile.slice(1);
    console.log(`[TerminalApproach] Forward bay-mouth exit established via netCoords[1] (${depChile.status})`);
  }
}
let arrChile = findSafeTerminalApproach(patillosCoords, netChile[netChile.length - 1], false, landRings, getAdaptiveDockToleranceKm(patillos));

const fullChile = [...depChile.waypoints.slice(0, -1), ...netChile, ...arrChile.waypoints.slice(1)];
let distChile = 0;
for (let i = 0; i < fullChile.length - 1; i++) distChile += calculateGeodesicDistanceMeters(fullChile[i][0], fullChile[i][1], fullChile[i + 1][0], fullChile[i + 1][1]) / 1000.0;
const failsChile = checkLandIntersections(fullChile, landRings, getAdaptiveDockToleranceKm(lirquen), getAdaptiveDockToleranceKm(patillos));

console.log(`Direct Coastal Distance: ${distChile.toFixed(1)} km (${(distChile * 0.539957).toFixed(1)} NM)`);
console.log(`Previous Offshore Detour: 3,469.3 km (1,873.3 NM) via GW--85.0_-35.0`);
console.log(`Path Length Reduction: -${(3469.3 - distChile).toFixed(1)} km (-${((1 - distChile / 3469.3) * 100).toFixed(1)}%)`);
console.log(`Failing Segments: ${failsChile.length}`);
console.log(`Departure Approach: ${depChile.status}`);
console.log(`Arrival Approach: ${arrChile.status}`);
console.log(`Result: ${failsChile.length === 0 ? 'PASS ✅' : 'FAIL ❌'}\n`);

// 2. Stanley -> McMurdo Station
console.log('--- TEST 2: Stanley -> McMurdo Station (Polar Westward GC Route) ---');
const stanley = portsData.find(p => p.wpiNumber === 14000);
const mcmurdo = portsData.find(p => p.wpiNumber === 63130);
const stanleyCoords = [stanley.longitude, stanley.latitude];
const mcmurdoCoords = [mcmurdo.longitude, mcmurdo.latitude];

const startSnap = findAdaptiveWaterNode(stanley, 400);
const goalSnap = findAdaptiveWaterNode(mcmurdo, 400);
const polarPath = dijkstraShortestPath(startSnap.nodeIndex, goalSnap.nodeIndex);
const fullPolar = [stanleyCoords, ...polarPath, mcmurdoCoords];
let distPolar = 0;
for (let i = 0; i < fullPolar.length - 1; i++) distPolar += calculateGeodesicDistanceMeters(fullPolar[i][0], fullPolar[i][1], fullPolar[i + 1][0], fullPolar[i + 1][1]) / 1000.0;
const failsPolar = checkLandIntersections(fullPolar, landRings, getAdaptiveDockToleranceKm(stanley), getAdaptiveDockToleranceKm(mcmurdo));

console.log(`Polar Dijkstra Distance: ${distPolar.toFixed(1)} km (${(distPolar * 0.539957).toFixed(1)} NM)`);
console.log(`Previous Eastward Detour: 12,432.7 km (6,713.0 NM)`);
console.log(`Path Length Reduction: -${(12432.7 - distPolar).toFixed(1)} km (-${((1 - distPolar / 12432.7) * 100).toFixed(1)}%) via Drake Passage / Pacific`);
console.log(`Failing Segments: ${failsPolar.length}`);
console.log(`Result: ${failsPolar.length === 0 ? 'PASS ✅' : 'FAIL ❌'}\n`);

// 3. Port De Aracaju -> Nelson
console.log('--- TEST 3: Port De Aracaju -> Nelson (River Berth & Antimeridian) ---');
const aracaju = portsData.find(p => p.wpiNumber === 12760);
const nelson = portsData.find(p => p.wpiNumber === 55290);
const aracajuCoords = [aracaju.longitude, aracaju.latitude];
const nelsonCoords = [nelson.longitude, nelson.latitude];
const nelsonSnap = findAdaptiveWaterNode(nelson, 400);

const gwPolarIdx = coordToIndex.get('-50,-36');
const gwGlobal = [-49.778, -36.039];
const rawGlobal = seaRoute(aracajuCoords, gwGlobal, { network: marnet20, units: 'kilometers' });
const polarPathNel = dijkstraShortestPath(gwPolarIdx, nelsonSnap.nodeIndex);
const stitched = [aracajuCoords, ...rawGlobal.geometry.coordinates, ...polarPathNel, nelsonCoords];

let distGlobal = 0;
for (let i = 0; i < stitched.length - 1; i++) distGlobal += calculateGeodesicDistanceMeters(stitched[i][0], stitched[i][1], stitched[i + 1][0], stitched[i + 1][1]) / 1000.0;
const failsGlobal = checkLandIntersections(stitched, landRings, getAdaptiveDockToleranceKm(aracaju), getAdaptiveDockToleranceKm(nelson));

console.log(`Validated Route Distance: ${distGlobal.toFixed(1)} km (${(distGlobal * 0.539957).toFixed(1)} NM)`);
console.log(`Departure Dock Tolerance: ${getAdaptiveDockToleranceKm(aracaju)} km (${aracaju.harborType})`);
console.log(`Destination Dock Tolerance: ${getAdaptiveDockToleranceKm(nelson)} km (${nelson.harborType})`);
console.log(`Failing Segments: ${failsGlobal.length}`);
console.log(`Result: ${failsGlobal.length === 0 ? 'PASS ✅' : 'FAIL ❌'}\n`);
