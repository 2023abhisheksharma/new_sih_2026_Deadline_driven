/**
 * Empirical Boundary Benchmark for Polar-Global Transition Latitudes
 * -------------------------------------------------------------------
 * Evaluates candidate boundary latitudes: -31°, -33°, -35°, -37°, -40°
 *
 * Measures:
 * 1. Polar node density in primary component (Component 0)
 * 2. MARNET global network vertex availability
 * 3. Spatial pairing & geodesic transition distances
 * 4. Land/ice barrier non-intersection (LOS validation)
 * 5. Clearance to land barriers
 * 6. Sectoral coverage across the 7 Southern Ocean perimeter sectors
 *
 * Output: data/routing/processed/boundary_benchmark.json
 */

import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire('/home/abhishek/projects/new_sih_2026/frontend/package.json');
const { DEFAULT_MARNET } = require('searoute-ts/marnet-20km');

const graphPath = './frontend/public/data/polarWaterGraph.json';
const ringsPath = './frontend/public/data/southernLandRings.json';
const outputPath = './data/routing/processed/boundary_benchmark.json';

console.log('--- STARTING EMPIRICAL BOUNDARY BENCHMARK ---');

const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
const rings = JSON.parse(fs.readFileSync(ringsPath, 'utf-8'));

// Build graph topology & components
const coordMap = new Map();
graph.nodes.forEach((n, idx) => coordMap.set(`${n[0]},${n[1]}`, idx));
const adj = Array.from({ length: graph.nodes.length }, () => []);
for (const [p1, p2, w] of graph.edges) {
  const u = coordMap.get(`${p1[0]},${p1[1]}`);
  const v = coordMap.get(`${p2[0]},${p2[1]}`);
  if (u !== undefined && v !== undefined) {
    adj[u].push({ v, w });
    adj[v].push({ v: u, w });
  }
}

const componentId = new Int32Array(graph.nodes.length).fill(-1);
let currentComp = 0;
const componentSizes = [];
for (let i = 0; i < graph.nodes.length; i++) {
  if (componentId[i] !== -1) continue;
  let size = 0;
  const queue = [i];
  componentId[i] = currentComp;
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    size++;
    for (const neighbor of adj[u]) {
      const v = neighbor.v;
      if (componentId[v] === -1) {
        componentId[v] = currentComp;
        queue.push(v);
      }
    }
  }
  componentSizes.push({ comp: currentComp, size });
  currentComp++;
}
componentSizes.sort((a, b) => b.size - a.size);
const primaryComponentId = componentSizes[0].comp;

console.log(`Polar graph loaded: ${graph.nodes.length} nodes, primary component: ${primaryComponentId} (${componentSizes[0].size} nodes)`);

// Extract unique MARNET vertices
const marnetVerticesMap = new Map();
for (const f of DEFAULT_MARNET.features) {
  if (f.geometry && f.geometry.coordinates) {
    for (const pt of f.geometry.coordinates) {
      const key = `${pt[0].toFixed(5)},${pt[1].toFixed(5)}`;
      if (!marnetVerticesMap.has(key)) {
        marnetVerticesMap.set(key, [pt[0], pt[1]]);
      }
    }
  }
}
const marnetVertices = Array.from(marnetVerticesMap.values());
console.log(`MARNET unique vertices extracted: ${marnetVertices.length}`);

// Geodesic math & geometry helpers
function calculateGeodesicDistanceMeters(lon1, lat1, lon2, lat2) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function segmentsIntersect(a1, a2, b1, b2) {
  function ccw(p1, p2, p3) {
    return (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
  }
  return ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
}

function pointInPolygon(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function isWaterLineOfSight(p1, p2, rings) {
  const sMinX = Math.min(p1[0], p2[0]);
  const sMaxX = Math.max(p1[0], p2[0]);
  const sMinY = Math.min(p1[1], p2[1]);
  const sMaxY = Math.max(p1[1], p2[1]);

  for (let r = 0; r < rings.length; r++) {
    const { bbox, ring } = rings[r];
    if (sMaxX < bbox[0] || sMinX > bbox[2] || sMaxY < bbox[1] || sMinY > bbox[3]) continue;

    for (let j = 0; j < ring.length - 1; j++) {
      if (segmentsIntersect(p1, p2, ring[j], ring[j + 1])) {
        return false;
      }
    }

    const midPt = [(p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0];
    if (pointInPolygon(midPt, ring)) {
      return false;
    }
  }
  return true;
}

function isPointInLand(pt, rings) {
  for (let r = 0; r < rings.length; r++) {
    const { bbox, ring } = rings[r];
    if (pt[0] >= bbox[0] && pt[0] <= bbox[2] && pt[1] >= bbox[1] && pt[1] <= bbox[3]) {
      if (pointInPolygon(pt, ring)) return true;
    }
  }
  return false;
}

function getDistanceToLandKm(pt, rings) {
  let minDistM = Infinity;
  // Check bounding boxes within 3 degrees
  for (let r = 0; r < rings.length; r++) {
    const { bbox, ring } = rings[r];
    if (pt[0] < bbox[0] - 3 || pt[0] > bbox[2] + 3 || pt[1] < bbox[1] - 3 || pt[1] > bbox[3] + 3) continue;
    for (let j = 0; j < ring.length; j += 4) { // sample vertices
      const d = calculateGeodesicDistanceMeters(pt[0], pt[1], ring[j][0], ring[j][1]);
      if (d < minDistM) minDistM = d;
    }
  }
  return minDistM / 1000.0;
}

function getSector(lon) {
  // Normalize lon to [-180, 180]
  let l = lon;
  while (l < -180) l += 360;
  while (l > 180) l -= 360;

  if (l >= -70 && l < -50) return 'Drake Passage / Antarctic Peninsula';
  if (l >= -50 && l < -20) return 'Weddell Sea Sector';
  if (l >= -20 && l < 20) return 'Atlantic Southern Ocean';
  if (l >= 20 && l < 115) return 'Indian Ocean Sector';
  if (l >= 115 && l < 150) return 'Australian Sector';
  if ((l >= 150 && l <= 180) || (l >= -180 && l < -150)) return 'Ross Sea / New Zealand Sector';
  if (l >= -150 && l < -70) return 'Pacific Southern Ocean';
  return 'Unknown';
}

const ALL_SECTORS = [
  'Drake Passage / Antarctic Peninsula',
  'Weddell Sea Sector',
  'Atlantic Southern Ocean',
  'Indian Ocean Sector',
  'Australian Sector',
  'Ross Sea / New Zealand Sector',
  'Pacific Southern Ocean',
];

// Benchmark Candidate Latitudes
const candidateLatitudes = [-31, -33, -35, -37, -40];
const CORRIDOR_HALF_WIDTH_DEG = 0.75; // +/- 0.75° corridor

const benchmarkResults = [];

for (const targetLat of candidateLatitudes) {
  console.log(`\nEvaluating Candidate Latitude: ${targetLat}°S (corridor: ${targetLat - CORRIDOR_HALF_WIDTH_DEG}° to ${targetLat + CORRIDOR_HALF_WIDTH_DEG}°)...`);

  const minL = targetLat - CORRIDOR_HALF_WIDTH_DEG;
  const maxL = targetLat + CORRIDOR_HALF_WIDTH_DEG;

  // Polar nodes in corridor
  const polarCandidates = [];
  for (let i = 0; i < graph.nodes.length; i++) {
    const pt = graph.nodes[i];
    if (pt[1] >= minL && pt[1] <= maxL) {
      polarCandidates.push({
        nodeId: i,
        coords: pt,
        comp: componentId[i],
        degree: adj[i].length,
      });
    }
  }

  // MARNET vertices in corridor
  const marnetCandidates = [];
  for (let i = 0; i < marnetVertices.length; i++) {
    const pt = marnetVertices[i];
    if (pt[1] >= minL && pt[1] <= maxL) {
      marnetCandidates.push({
        id: i,
        coords: pt,
      });
    }
  }

  // Filter polar candidates by primary component
  const primaryPolar = polarCandidates.filter(p => p.comp === primaryComponentId);
  const nonPrimaryCount = polarCandidates.length - primaryPolar.length;

  // Spatial matching: for each polar node, find nearest MARNET candidate
  let viablePairs = [];
  let rejectedLand = 0;
  let rejectedLos = 0;
  let rejectedTooFar = 0;

  for (const p of primaryPolar) {
    // Check if polar node is in land
    if (isPointInLand(p.coords, rings)) {
      rejectedLand++;
      continue;
    }

    // Find nearest MARNET vertex within 150 km
    let bestMarnet = null;
    let bestDistKm = Infinity;
    for (const m of marnetCandidates) {
      // Rough lon filter (accounting for cos lat)
      const dLon = Math.abs(m.coords[0] - p.coords[0]);
      if (dLon > 3.0 && dLon < 357.0) continue;

      const d = calculateGeodesicDistanceMeters(p.coords[0], p.coords[1], m.coords[0], m.coords[1]) / 1000.0;
      if (d < bestDistKm) {
        bestDistKm = d;
        bestMarnet = m;
      }
    }

    if (!bestMarnet || bestDistKm > 100.0) {
      rejectedTooFar++;
      continue;
    }

    // Validate MARNET endpoint not in land
    if (isPointInLand(bestMarnet.coords, rings)) {
      rejectedLand++;
      continue;
    }

    // Line of sight validation
    if (!isWaterLineOfSight(p.coords, bestMarnet.coords, rings)) {
      rejectedLos++;
      continue;
    }

    const landClearanceKm = getDistanceToLandKm(p.coords, rings);
    const sector = getSector(p.coords[0]);

    viablePairs.push({
      polarNodeId: p.nodeId,
      polarCoords: p.coords,
      globalCoords: bestMarnet.coords,
      transitionDistanceKm: bestDistKm,
      landClearanceKm: Math.min(landClearanceKm, 500.0), // cap for display
      degree: p.degree,
      sector,
      latitudeDeviationDeg: Math.abs(p.coords[1] - targetLat),
    });
  }

  // Deduplicate pairs by polar coordinate
  const uniquePairs = [];
  const seenPolar = new Set();
  for (const pair of viablePairs) {
    const key = `${pair.polarCoords[0]},${pair.polarCoords[1]}`;
    if (!seenPolar.has(key)) {
      seenPolar.add(key);
      uniquePairs.push(pair);
    }
  }

  // Sector breakdown
  const sectorCounts = {};
  ALL_SECTORS.forEach(s => sectorCounts[s] = 0);
  uniquePairs.forEach(p => {
    sectorCounts[p.sector] = (sectorCounts[p.sector] || 0) + 1;
  });
  const coveredSectors = ALL_SECTORS.filter(s => sectorCounts[s] > 0);

  // Transition distance stats
  const dists = uniquePairs.map(p => p.transitionDistanceKm).sort((a, b) => a - b);
  const minTransDist = dists.length > 0 ? dists[0] : 0;
  const medianTransDist = dists.length > 0 ? dists[Math.floor(dists.length / 2)] : 0;
  const meanTransDist = dists.length > 0 ? dists.reduce((a, b) => a + b, 0) / dists.length : 0;
  const p90TransDist = dists.length > 0 ? dists[Math.floor(dists.length * 0.9)] : 0;

  // Land clearance stats
  const clearances = uniquePairs.map(p => p.landClearanceKm).sort((a, b) => a - b);
  const minClearance = clearances.length > 0 ? clearances[0] : 0;
  const medianClearance = clearances.length > 0 ? clearances[Math.floor(clearances.length / 2)] : 0;

  console.log(`  - Polar Candidates in Corridor: ${polarCandidates.length} (${primaryPolar.length} in primary component, ${nonPrimaryCount} non-primary)`);
  console.log(`  - MARNET Candidates in Corridor: ${marnetCandidates.length}`);
  console.log(`  - Viable Gateway Pairs: ${uniquePairs.length}`);
  console.log(`  - Sector Coverage: ${coveredSectors.length} / ${ALL_SECTORS.length} sectors`);
  console.log(`  - Transition Distances: Min = ${minTransDist.toFixed(1)} km, Median = ${medianTransDist.toFixed(1)} km, Mean = ${meanTransDist.toFixed(1)} km, P90 = ${p90TransDist.toFixed(1)} km`);
  console.log(`  - Land Clearance: Min = ${minClearance.toFixed(1)} km, Median = ${medianClearance.toFixed(1)} km`);
  console.log(`  - Rejections: Too Far (>100km): ${rejectedTooFar}, Land Collision: ${rejectedLand}, LOS Crossing: ${rejectedLos}`);

  benchmarkResults.push({
    targetLatitudeDeg: targetLat,
    corridorHalfWidthDeg: CORRIDOR_HALF_WIDTH_DEG,
    polarCandidateCount: polarCandidates.length,
    primaryPolarCount: primaryPolar.length,
    nonPrimaryPolarCount: nonPrimaryCount,
    marnetCandidateCount: marnetCandidates.length,
    viableGatewayPairCount: uniquePairs.length,
    rejections: {
      distanceExceeded: rejectedTooFar,
      landIntersection: rejectedLand,
      lineOfSightBlocked: rejectedLos,
      nonPrimaryComponent: nonPrimaryCount,
    },
    transitionDistanceKm: {
      min: parseFloat(minTransDist.toFixed(2)),
      median: parseFloat(medianTransDist.toFixed(2)),
      mean: parseFloat(meanTransDist.toFixed(2)),
      p90: parseFloat(p90TransDist.toFixed(2)),
    },
    landClearanceKm: {
      min: parseFloat(minClearance.toFixed(2)),
      median: parseFloat(medianClearance.toFixed(2)),
    },
    sectorCoverage: {
      totalSectorsCovered: coveredSectors.length,
      totalSectors: ALL_SECTORS.length,
      coveredSectors,
      sectorDistribution: sectorCounts,
    },
    sampleGateways: uniquePairs.slice(0, 5),
  });
}

// Compare & Rank candidate latitudes objectively
console.log('\n--- COMPARISON OF CANDIDATE BOUNDARIES ---');
console.log('Lat (°S) | Polar Nodes | MARNET Vertices | Viable Gateways | Median Trans (km) | Median Clear (km) | Sectors Covered');
console.log('---------|-------------|-----------------|-----------------|-------------------|-------------------|----------------');
benchmarkResults.forEach(r => {
  console.log(
    `${String(r.targetLatitudeDeg).padStart(8)} | ` +
    `${String(r.primaryPolarCount).padStart(11)} | ` +
    `${String(r.marnetCandidateCount).padStart(15)} | ` +
    `${String(r.viableGatewayPairCount).padStart(15)} | ` +
    `${r.transitionDistanceKm.median.toFixed(1).padStart(17)} | ` +
    `${r.landClearanceKm.median.toFixed(1).padStart(17)} | ` +
    `${(r.sectorCoverage.totalSectorsCovered + '/' + r.sectorCoverage.totalSectors).padStart(15)}`
  );
});

// Save artifact
fs.writeFileSync(outputPath, JSON.stringify(benchmarkResults, null, 2), 'utf-8');
console.log(`\nBenchmark results saved to ${outputPath}`);
