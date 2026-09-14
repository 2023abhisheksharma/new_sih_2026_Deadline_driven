import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const require = createRequire(path.join(projectRoot, 'frontend/package.json'));
const { seaRoute } = require('searoute-ts');
const { DEFAULT_MARNET: marnet20 } = require('searoute-ts/marnet-20km');
const TinyQueue = require('tinyqueue');

const portsData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/ports.json'), 'utf-8'));
const graphData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/polarWaterGraph.json'), 'utf-8'));
const landRings = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/southernLandRings.json'), 'utf-8'));
const gatewayCatalog = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data/routing/processed/gateway_benchmark.json'), 'utf-8')).validatedGateways;

const coordToIndex = new Map();
const nodes = graphData.nodes;
nodes.forEach((n, idx) => coordToIndex.set(n[0] + ',' + n[1], idx));
const adj = Array.from({ length: nodes.length }, () => []);
for (const [p1, p2, w] of graphData.edges) {
  const u = coordToIndex.get(p1[0] + ',' + p1[1]);
  const v = coordToIndex.get(p2[0] + ',' + p2[1]);
  if (u !== undefined && v !== undefined) {
    adj[u].push({ nodeIndex: v, weight: w });
    adj[v].push({ nodeIndex: u, weight: w });
  }
}

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
  if (geom.type === 'MultiLineString') return geom.coordinates[0];
  return null;
}

function stitchPolylines(segments, maxSeamGapKm = 200.0) {
  const result = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (!seg || seg.length === 0) continue;
    for (let p = 0; p < seg.length; p++) {
      const pt = seg[p];
      if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return null;
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

const stanley = portsData.find(p => p.wpiNumber === 14000);
const capetown = portsData.find(p => p.wpiNumber === 46770);
const sCoords = [stanley.longitude, stanley.latitude];
const cCoords = [capetown.longitude, capetown.latitude];
const sSnapIdx = 17474;

// 1. Stanley -> Cape Town via GW-+18.0_-35.0
const gw = gatewayCatalog.find(g => g.gatewayId === 'GW-+18.0_-35.0');
const polarPath = dijkstraShortestPath(sSnapIdx, gw.polarNodeId, nodes, adj);
const rawGlobal = seaRoute(gw.globalCoords, cCoords, { network: marnet20, units: 'kilometers', antimeridian: 'split' });
const globalCoords = extractMarnetCoordinates(rawGlobal.geometry);

const pSeg = [sCoords, ...polarPath];
const tSeg = [gw.polarCoords];
const gSeg = [...globalCoords, cCoords];

const stitchedS2C = stitchPolylines([pSeg, tSeg, gSeg]);

console.log('================================================================================');
console.log('EXACT STITCHED GEOMETRY BEFORE SUPPRESSION: STANLEY -> CAPE TOWN');
console.log('================================================================================');
console.log('Gateway ID: ' + gw.gatewayId);
console.log('Gateway Coordinates: Polar ' + JSON.stringify(gw.polarCoords) + ' -> Global ' + JSON.stringify(gw.globalCoords));
console.log('Total Stitched Waypoints: ' + stitchedS2C.length);
let cumDist = 0;
for (let i = 0; i < stitchedS2C.length; i++) {
  const pt = stitchedS2C[i];
  let segDist = 0;
  if (i > 0) {
    const prev = stitchedS2C[i-1];
    segDist = calculateGeodesicDistanceMeters(prev[0], prev[1], pt[0], pt[1]) / 1000.0;
    cumDist += segDist;
  }
  let label = '';
  if (i === 0) label = ' [ORIGIN BERTH: Stanley]';
  else if (i === 1) label = ' [POLAR GRAPH SNAP: node 17474]';
  else if (i === 31) label = ' [GATEWAY TRANSITION: ' + gw.gatewayId + ']';
  else if (i === stitchedS2C.length - 1) label = ' [DESTINATION BERTH: Cape Town]';
  else if (i === stitchedS2C.length - 2) label = ' [MARNET HARBOR ENTRY NODE]';
  console.log(`WP ${String(i).padStart(2)}: [${pt[0].toFixed(5).padStart(10)}, ${pt[1].toFixed(5).padStart(10)}] | +${segDist.toFixed(1).padStart(6)} km | cum: ${cumDist.toFixed(1).padStart(7)} km${label}`);
}

// 2. Cape Town -> Stanley via GW-+18.0_-35.0
const rawGlobalRev = seaRoute(cCoords, gw.globalCoords, { network: marnet20, units: 'kilometers', antimeridian: 'split' });
const globalCoordsRev = extractMarnetCoordinates(rawGlobalRev.geometry);
const polarPathRev = dijkstraShortestPath(gw.polarNodeId, sSnapIdx, nodes, adj);
const gSegRev = [cCoords, ...globalCoordsRev];
const tSegRev = [gw.polarCoords];
const pSegRev = [...polarPathRev, sCoords];
const stitchedC2S = stitchPolylines([gSegRev, tSegRev, pSegRev]);

console.log('\n================================================================================');
console.log('EXACT STITCHED GEOMETRY BEFORE SUPPRESSION: CAPE TOWN -> STANLEY');
console.log('================================================================================');
console.log('Gateway ID: ' + gw.gatewayId);
console.log('Gateway Coordinates: Global ' + JSON.stringify(gw.globalCoords) + ' -> Polar ' + JSON.stringify(gw.polarCoords));
console.log('Total Stitched Waypoints: ' + stitchedC2S.length);
let cumDistRev = 0;
for (let i = 0; i < stitchedC2S.length; i++) {
  const pt = stitchedC2S[i];
  let segDist = 0;
  if (i > 0) {
    const prev = stitchedC2S[i-1];
    segDist = calculateGeodesicDistanceMeters(prev[0], prev[1], pt[0], pt[1]) / 1000.0;
    cumDistRev += segDist;
  }
  let label = '';
  if (i === 0) label = ' [ORIGIN BERTH: Cape Town]';
  else if (i === 1) label = ' [MARNET HARBOR DEPARTURE NODE]';
  else if (i === 4) label = ' [GATEWAY TRANSITION: ' + gw.gatewayId + ']';
  else if (i === stitchedC2S.length - 1) label = ' [DESTINATION BERTH: Stanley]';
  else if (i === stitchedC2S.length - 2) label = ' [POLAR GRAPH SNAP: node 17474]';
  console.log(`WP ${String(i).padStart(2)}: [${pt[0].toFixed(5).padStart(10)}, ${pt[1].toFixed(5).padStart(10)}] | +${segDist.toFixed(1).padStart(6)} km | cum: ${cumDistRev.toFixed(1).padStart(7)} km${label}`);
}
