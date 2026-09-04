const fs = require('fs');
const TinyQueue = require('tinyqueue');

const R = 6371008.8;

function toRad(deg) { return (deg * Math.PI) / 180.0; }
function calculateGeodesicDistanceMeters(lon1, lat1, lon2, lat2) {
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dphi = toRad(lat2 - lat1), dlambda = toRad(lon2 - lon1);
  const a = Math.sin(dphi / 2.0) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2.0) ** 2;
  return R * 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
}
function toCartesianUnit(lonDeg, latDeg) {
  const phi = toRad(latDeg), lambda = toRad(lonDeg);
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}
function dot(u, v) { return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; }
function cross(u, v) { return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; }
function norm(u) { return Math.sqrt(dot(u, u)); }
function normalize(u) { const len = norm(u); return len === 0 ? [0,0,0] : [u[0]/len, u[1]/len, u[2]/len]; }

function pointToSegmentGeodesicDistanceMeters(pLon, pLat, aLon, aLat, bLon, bLat) {
  const distPA = calculateGeodesicDistanceMeters(pLon, pLat, aLon, aLat);
  const distPB = calculateGeodesicDistanceMeters(pLon, pLat, bLon, bLat);
  const distAB = calculateGeodesicDistanceMeters(aLon, aLat, bLon, bLat);
  if (distAB < 1e-3) return distPA;

  const vA = toCartesianUnit(aLon, aLat);
  const vB = toCartesianUnit(bLon, bLat);
  const vP = toCartesianUnit(pLon, pLat);
  const vAB = cross(vA, vB);
  const n = normalize(vAB);
  if (norm(vAB) < 1e-12) return Math.min(distPA, distPB);

  const dPlane = dot(vP, n);
  const vProj = [vP[0] - dPlane * n[0], vP[1] - dPlane * n[1], vP[2] - dPlane * n[2]];
  const vProjNorm = normalize(vProj);

  if (dot(cross(vA, vProjNorm), n) >= -1e-9 && dot(cross(vProjNorm, vB), n) >= -1e-9) {
    const angularDistRad = Math.asin(Math.min(1.0, Math.max(-1.0, Math.abs(dPlane))));
    return angularDistRad * R;
  }
  return Math.min(distPA, distPB);
}

function segmentsIntersect(p1, p2, p3, p4) {
  function ccw(a, b, c) { return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]); }
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

function pointInPolygon(point, ring) {
  const x = point[0], y = point[1];
  let inside = false, n = ring.length;
  if (n < 3) return false;
  let p1 = ring[0];
  for (let i = 1; i <= n; i++) {
    const p2 = ring[i % n];
    if (y > Math.min(p1[1], p2[1]) && y <= Math.max(p1[1], p2[1]) && x <= Math.max(p1[0], p2[0])) {
      if (p1[1] !== p2[1]) {
        const xinters = ((y - p1[1]) * (p2[0] - p1[0])) / (p2[1] - p1[1]) + p1[0];
        if (p1[0] === p2[0] || x <= xinters) inside = !inside;
      }
    }
    p1 = p2;
  }
  return inside;
}

const graphData = JSON.parse(fs.readFileSync('frontend/public/data/polarWaterGraph.json', 'utf8'));
const coordToIndex = new Map(), nodes = [], adj = new Map();
graphData.nodes.forEach((pt, idx) => {
  nodes.push(pt);
  coordToIndex.set(`${pt[0]},${pt[1]}`, idx);
  adj.set(idx, []);
});
for (const [p1, p2, weight] of graphData.edges) {
  const u = coordToIndex.get(`${p1[0]},${p1[1]}`), v = coordToIndex.get(`${p2[0]},${p2[1]}`);
  if (u !== undefined && v !== undefined) {
    adj.get(u).push({ nodeIndex: v, weight });
    adj.get(v).push({ nodeIndex: u, weight });
  }
}

function findNearestWaterNodeIndex(target, maxDistanceKm = 400) {
  let bestIdx = null, bestDist = Infinity;
  const latRad = (Math.abs(target[1]) * Math.PI) / 180.0;
  const cosLat = Math.max(0.08, Math.cos(latRad));
  const maxLonDeg = Math.min(180, (maxDistanceKm / 111.0) / cosLat);
  const maxLatDeg = maxDistanceKm / 111.0;
  for (let i = 0; i < nodes.length; i++) {
    const pt = nodes[i];
    if (Math.abs(pt[1] - target[1]) > maxLatDeg) continue;
    let dLon = Math.abs(pt[0] - target[0]);
    if (dLon > 180) dLon = 360 - dLon;
    if (dLon > maxLonDeg) continue;
    const dist = calculateGeodesicDistanceMeters(target[0], target[1], pt[0], pt[1]) / 1000.0;
    if (dist < bestDist && dist <= maxDistanceKm) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function dijkstra(startIdx, goalIdx) {
  if (startIdx === goalIdx) return [nodes[startIdx]];
  const distances = new Float64Array(nodes.length); distances.fill(Infinity); distances[startIdx] = 0;
  const previous = new Int32Array(nodes.length); previous.fill(-1);
  const pq = new TinyQueue([], (a, b) => a.dist - b.dist); pq.push({ idx: startIdx, dist: 0 });
  while (pq.length > 0) {
    const { idx, dist } = pq.pop();
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
  const path = []; let curr = goalIdx;
  while (curr !== -1) { path.push(nodes[curr]); curr = previous[curr]; }
  path.reverse(); return path;
}

const usnic = JSON.parse(fs.readFileSync('frontend/public/data/icebergs.json', 'utf8'));
const s1 = JSON.parse(fs.readFileSync('frontend/public/data/sentinel1_grounded_icebergs.json', 'utf8'));
const byu = JSON.parse(fs.readFileSync('frontend/public/data/drifting_iceberg_trajectories.json', 'utf8'));
const ports = JSON.parse(fs.readFileSync('frontend/public/data/ports.json', 'utf8'));

// Test multiple routes:
// 1. Ushuaia (13980) -> Admiralty Bay (63090)
// 2. Ushuaia (13980) -> Port Lockroy (63100)
// 3. Grytviken (14060) -> Admiralty Bay (63090)

const routePairs = [
  { dep: 13980, dest: 63090, label: "Ushuaia -> Admiralty Bay" },
  { dep: 13980, dest: 63100, label: "Ushuaia -> Port Lockroy" },
  { dep: 14060, dest: 63090, label: "Grytviken -> Admiralty Bay" }
];

for (const pair of routePairs) {
  const p1 = ports.find(p => p.wpiNumber === pair.dep);
  const p2 = ports.find(p => p.wpiNumber === pair.dest);
  const sIdx = findNearestWaterNodeIndex([p1.longitude, p1.latitude]);
  const gIdx = findNearestWaterNodeIndex([p2.longitude, p2.latitude]);
  const pNodes = dijkstra(sIdx, gIdx);
  const full = [[p1.longitude, p1.latitude], ...pNodes, [p2.longitude, p2.latitude]];

  // Run analysis
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of full) {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  const NEARBY_THRESHOLD_KM = 25.0;
  const NEARBY_THRESHOLD_M = NEARBY_THRESHOLD_KM * 1000.0;
  minLat -= NEARBY_THRESHOLD_KM / 111.0;
  maxLat += NEARBY_THRESHOLD_KM / 111.0;
  minLon -= NEARBY_THRESHOLD_KM / (111.0 * Math.max(0.1, Math.cos(toRad(Math.max(Math.abs(minLat), Math.abs(maxLat))))));
  maxLon += NEARBY_THRESHOLD_KM / (111.0 * Math.max(0.1, Math.cos(toRad(Math.max(Math.abs(minLat), Math.abs(maxLat))))));

  const hazards = [];

  // USNIC
  for (const berg of usnic) {
    if (berg.latitude < minLat || berg.latitude > maxLat || berg.longitude < minLon || berg.longitude > maxLon) continue;
    let minD = Infinity, isect = false, segIdx = -1;
    const poly = berg.boundaryCoordinates;
    for (let i = 0; i < full.length - 1; i++) {
      const a = full[i], b = full[i+1];
      if (poly && poly.length >= 3) {
        if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) { isect = true; minD = 0; segIdx = i; break; }
        for (let j = 0; j < poly.length - 1; j++) {
          if (segmentsIntersect(a, b, poly[j], poly[j+1])) { isect = true; minD = 0; segIdx = i; break; }
        }
        if (isect) break;
        for (let j = 0; j < poly.length; j++) {
          const d = pointToSegmentGeodesicDistanceMeters(poly[j][0], poly[j][1], a[0], a[1], b[0], b[1]);
          if (d < minD) { minD = d; segIdx = i; }
        }
      } else {
        const d = pointToSegmentGeodesicDistanceMeters(berg.longitude, berg.latitude, a[0], a[1], b[0], b[1]);
        if (d < minD) { minD = d; segIdx = i; }
      }
    }
    if (isect || minD <= NEARBY_THRESHOLD_M) {
      hazards.push({ id: berg.id, src: 'USNIC', rel: isect || minD <= 50 ? 'INTERSECTING' : 'NEARBY', distKm: minD / 1000.0, seg: `${segIdx} → ${segIdx+1}` });
    }
  }

  // Sentinel-1
  for (let b = 0; b < s1.length; b++) {
    const berg = s1[b];
    if (berg.latitude < minLat || berg.latitude > maxLat || berg.longitude < minLon || berg.longitude > maxLon) continue;
    let minD = Infinity, isect = false, segIdx = -1;
    const poly = berg.boundaryCoordinates;
    for (let i = 0; i < full.length - 1; i++) {
      const a = full[i], b = full[i+1];
      if (poly && poly.length >= 3) {
        if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) { isect = true; minD = 0; segIdx = i; break; }
        for (let j = 0; j < poly.length - 1; j++) {
          if (segmentsIntersect(a, b, poly[j], poly[j+1])) { isect = true; minD = 0; segIdx = i; break; }
        }
        if (isect) break;
        const dC = pointToSegmentGeodesicDistanceMeters(berg.longitude, berg.latitude, a[0], a[1], b[0], b[1]);
        if (dC < minD) { minD = dC; segIdx = i; }
        if (dC < NEARBY_THRESHOLD_M * 1.5) {
          for (let j = 0; j < poly.length; j++) {
            const d = pointToSegmentGeodesicDistanceMeters(poly[j][0], poly[j][1], a[0], a[1], b[0], b[1]);
            if (d < minD) { minD = d; segIdx = i; }
          }
        }
      } else {
        const d = pointToSegmentGeodesicDistanceMeters(berg.longitude, berg.latitude, a[0], a[1], b[0], b[1]);
        if (d < minD) { minD = d; segIdx = i; }
      }
    }
    if (isect || minD <= NEARBY_THRESHOLD_M) {
      hazards.push({ id: berg.id, src: 'Sentinel-1', rel: isect || minD <= 50 ? 'INTERSECTING' : 'NEARBY', distKm: minD / 1000.0, seg: `${segIdx} → ${segIdx+1}`, status: berg.fastIceStatus });
    }
  }

  // BYU/NIC
  for (const berg of byu) {
    if (!berg.latestPos) continue;
    const lat = berg.latestPos.lat, lon = berg.latestPos.lon;
    if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;
    let minD = Infinity, segIdx = -1;
    for (let i = 0; i < full.length - 1; i++) {
      const a = full[i], b = full[i+1];
      const d = pointToSegmentGeodesicDistanceMeters(lon, lat, a[0], a[1], b[0], b[1]);
      if (d < minD) { minD = d; segIdx = i; }
    }
    if (minD <= NEARBY_THRESHOLD_M) {
      hazards.push({ id: berg.id, src: 'BYU/NIC', rel: minD <= 50 ? 'INTERSECTING' : 'NEARBY', distKm: minD / 1000.0, seg: `${segIdx} → ${segIdx+1}`, date: berg.end });
    }
  }

  console.log(`\n=== Route: ${pair.label} (${full.length} nodes) ===`);
  console.log(`Total hazards: ${hazards.length}`);
  console.log(`USNIC: ${hazards.filter(h => h.src === 'USNIC').length}`);
  console.log(`Sentinel-1: ${hazards.filter(h => h.src === 'Sentinel-1').length}`);
  console.log(`BYU/NIC: ${hazards.filter(h => h.src === 'BYU/NIC').length}`);
  if (hazards.length > 0) {
    console.log("Top hazards:", hazards.slice(0, 5));
  }
}
