const fs = require('fs');
const TinyQueue = require('tinyqueue');

const R = 6371008.8; // Mean Earth radius in meters

function toRad(deg) {
  return (deg * Math.PI) / 180.0;
}

function calculateGeodesicDistanceMeters(lon1, lat1, lon2, lat2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dphi = toRad(lat2 - lat1);
  const dlambda = toRad(lon2 - lon1);

  const a =
    Math.sin(dphi / 2.0) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2.0) ** 2;
  const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  return R * c;
}

function toCartesianUnit(lonDeg, latDeg) {
  const phi = toRad(latDeg);
  const lambda = toRad(lonDeg);
  return [
    Math.cos(phi) * Math.cos(lambda),
    Math.cos(phi) * Math.sin(lambda),
    Math.sin(phi)
  ];
}

function dot(u, v) {
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
}

function cross(u, v) {
  return [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0]
  ];
}

function norm(u) {
  return Math.sqrt(dot(u, u));
}

function normalize(u) {
  const len = norm(u);
  if (len === 0) return [0, 0, 0];
  return [u[0] / len, u[1] / len, u[2] / len];
}

function pointToSegmentGeodesicDistanceMeters(pLon, pLat, aLon, aLat, bLon, bLat) {
  const distPA = calculateGeodesicDistanceMeters(pLon, pLat, aLon, aLat);
  const distPB = calculateGeodesicDistanceMeters(pLon, pLat, bLon, bLat);
  const distAB = calculateGeodesicDistanceMeters(aLon, aLat, bLon, bLat);

  if (distAB < 1e-3) {
    return distPA;
  }

  const vA = toCartesianUnit(aLon, aLat);
  const vB = toCartesianUnit(bLon, bLat);
  const vP = toCartesianUnit(pLon, pLat);

  const vAB = cross(vA, vB);
  const n = normalize(vAB);

  if (norm(vAB) < 1e-12) {
    return Math.min(distPA, distPB);
  }

  const dPlane = dot(vP, n);
  const vProj = [
    vP[0] - dPlane * n[0],
    vP[1] - dPlane * n[1],
    vP[2] - dPlane * n[2]
  ];
  const vProjNorm = normalize(vProj);

  const c1 = dot(cross(vA, vProjNorm), n);
  const c2 = dot(cross(vProjNorm, vB), n);

  if (c1 >= -1e-9 && c2 >= -1e-9) {
    const angularDistRad = Math.asin(Math.min(1.0, Math.max(-1.0, Math.abs(dPlane))));
    return angularDistRad * R;
  }

  return Math.min(distPA, distPB);
}

function segmentsIntersect(p1, p2, p3, p4) {
  function ccw(a, b, c) {
    return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
  }
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

function pointInPolygon(point, ring) {
  const x = point[0];
  const y = point[1];
  let inside = false;
  const n = ring.length;
  if (n < 3) return false;

  let p1 = ring[0];
  for (let i = 1; i <= n; i++) {
    const p2 = ring[i % n];
    if (y > Math.min(p1[1], p2[1])) {
      if (y <= Math.max(p1[1], p2[1])) {
        if (x <= Math.max(p1[0], p2[0])) {
          if (p1[1] !== p2[1]) {
            const xinters = ((y - p1[1]) * (p2[0] - p1[0])) / (p2[1] - p1[1]) + p1[0];
            if (p1[0] === p2[0] || x <= xinters) {
              inside = !inside;
            }
          }
        }
      }
    }
    p1 = p2;
  }
  return inside;
}

// Load polar water graph
const graphData = JSON.parse(fs.readFileSync('frontend/public/data/polarWaterGraph.json', 'utf8'));
const coordToIndex = new Map();
const nodes = [];
const adj = new Map();

graphData.nodes.forEach((pt, idx) => {
  nodes.push(pt);
  coordToIndex.set(`${pt[0]},${pt[1]}`, idx);
  adj.set(idx, []);
});

for (const [p1, p2, weight] of graphData.edges) {
  const u = coordToIndex.get(`${p1[0]},${p1[1]}`);
  const v = coordToIndex.get(`${p2[0]},${p2[1]}`);
  if (u !== undefined && v !== undefined) {
    adj.get(u).push({ nodeIndex: v, weight });
    adj.get(v).push({ nodeIndex: u, weight });
  }
}

function findNearestWaterNodeIndex(target, maxDistanceKm = 400) {
  let bestIdx = null;
  let bestDist = Infinity;
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

function dijkstraShortestPath(startIdx, goalIdx) {
  if (startIdx === goalIdx) return [nodes[startIdx]];

  const distances = new Float64Array(nodes.length);
  distances.fill(Infinity);
  distances[startIdx] = 0;

  const previous = new Int32Array(nodes.length);
  previous.fill(-1);

  const pq = new TinyQueue([], (a, b) => a.dist - b.dist);
  pq.push({ idx: startIdx, dist: 0 });

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

  const path = [];
  let curr = goalIdx;
  while (curr !== -1) {
    path.push(nodes[curr]);
    curr = previous[curr];
  }
  path.reverse();
  return path;
}

// Load real datasets
const usnic = JSON.parse(fs.readFileSync('frontend/public/data/icebergs.json', 'utf8'));
const s1 = JSON.parse(fs.readFileSync('frontend/public/data/sentinel1_grounded_icebergs.json', 'utf8'));
const byu = JSON.parse(fs.readFileSync('frontend/public/data/drifting_iceberg_trajectories.json', 'utf8'));
const ports = JSON.parse(fs.readFileSync('frontend/public/data/ports.json', 'utf8'));

// Test Route 1: Stanley (WPI 14000) to Ellefsen Harbor (WPI 63070)
const pDep = ports.find(p => p.wpiNumber === 14000);
const pDest = ports.find(p => p.wpiNumber === 63070);

console.log(`Testing Route: ${pDep.portName} (WPI ${pDep.wpiNumber}) → ${pDest.portName} (WPI ${pDest.wpiNumber})`);

const startIdx = findNearestWaterNodeIndex([pDep.longitude, pDep.latitude]);
const goalIdx = findNearestWaterNodeIndex([pDest.longitude, pDest.latitude]);

const pathNodes = dijkstraShortestPath(startIdx, goalIdx);
const fullCoords = [[pDep.longitude, pDep.latitude], ...pathNodes, [pDest.longitude, pDest.latitude]];

console.log(`Route computed with ${fullCoords.length} vertices.`);

// Perform Hazard Analysis on fullCoords
const NEARBY_THRESHOLD_KM = 25.0;
const NEARBY_THRESHOLD_METERS = NEARBY_THRESHOLD_KM * 1000.0;
const INTERSECTION_BUFFER_METERS = 50.0;

let minRouteLon = Infinity, maxRouteLon = -Infinity;
let minRouteLat = Infinity, maxRouteLat = -Infinity;
for (const [lon, lat] of fullCoords) {
  if (lon < minRouteLon) minRouteLon = lon;
  if (lon > maxRouteLon) maxRouteLon = lon;
  if (lat < minRouteLat) minRouteLat = lat;
  if (lat > maxRouteLat) maxRouteLat = lat;
}

const latBuffer = NEARBY_THRESHOLD_KM / 111.0;
const cosLatMax = Math.max(0.1, Math.cos(toRad(Math.max(Math.abs(minRouteLat), Math.abs(maxRouteLat)))));
const lonBuffer = Math.min(180, NEARBY_THRESHOLD_KM / (111.0 * cosLatMax));

minRouteLat -= latBuffer;
maxRouteLat += latBuffer;
minRouteLon -= lonBuffer;
maxRouteLon += lonBuffer;

console.time("Hazard analysis execution");

const detectedHazards = [];

// USNIC
for (const berg of usnic) {
  if (berg.latitude < minRouteLat || berg.latitude > maxRouteLat) continue;
  if (berg.longitude < minRouteLon || berg.longitude > maxRouteLon) continue;

  let minDistance = Infinity;
  let intersecting = false;
  let bestSegIdx = -1;
  let bestSegStart = null;
  let bestSegEnd = null;

  const poly = berg.boundaryCoordinates;

  for (let i = 0; i < fullCoords.length - 1; i++) {
    const s1 = fullCoords[i];
    const s2 = fullCoords[i + 1];

    if (poly && poly.length >= 3) {
      if (pointInPolygon(s1, poly) || pointInPolygon(s2, poly)) {
        intersecting = true;
        minDistance = 0;
        bestSegIdx = i;
        bestSegStart = s1;
        bestSegEnd = s2;
        break;
      }
      for (let j = 0; j < poly.length - 1; j++) {
        if (segmentsIntersect(s1, s2, poly[j], poly[j + 1])) {
          intersecting = true;
          minDistance = 0;
          bestSegIdx = i;
          bestSegStart = s1;
          bestSegEnd = s2;
          break;
        }
      }
      if (intersecting) break;

      for (let j = 0; j < poly.length; j++) {
        const d = pointToSegmentGeodesicDistanceMeters(poly[j][0], poly[j][1], s1[0], s1[1], s2[0], s2[1]);
        if (d < minDistance) {
          minDistance = d;
          bestSegIdx = i;
          bestSegStart = s1;
          bestSegEnd = s2;
        }
      }
    } else {
      const d = pointToSegmentGeodesicDistanceMeters(berg.longitude, berg.latitude, s1[0], s1[1], s2[0], s2[1]);
      if (d < minDistance) {
        minDistance = d;
        bestSegIdx = i;
        bestSegStart = s1;
        bestSegEnd = s2;
      }
    }
  }

  if (intersecting || minDistance <= NEARBY_THRESHOLD_METERS) {
    detectedHazards.push({
      icebergId: berg.id,
      name: berg.name,
      source: 'USNIC',
      relationship: intersecting || minDistance <= INTERSECTION_BUFFER_METERS ? 'INTERSECTING' : 'NEARBY',
      minDistanceMeters: minDistance,
      minDistanceKm: minDistance / 1000.0,
      minDistanceNm: (minDistance / 1000.0) / 1.852,
      segmentIndex: bestSegIdx,
      segment: `${bestSegIdx} → ${bestSegIdx + 1}`,
      lat: berg.latitude,
      lon: berg.longitude,
      length: berg.length,
      width: berg.width
    });
  }
}

// Sentinel-1
for (let bIdx = 0; bIdx < s1.length; bIdx++) {
  const berg = s1[bIdx];
  if (berg.latitude < minRouteLat || berg.latitude > maxRouteLat) continue;
  if (berg.longitude < minRouteLon || berg.longitude > maxRouteLon) continue;

  let minDistance = Infinity;
  let intersecting = false;
  let bestSegIdx = -1;
  let bestSegStart = null;
  let bestSegEnd = null;

  const poly = berg.boundaryCoordinates;

  for (let i = 0; i < fullCoords.length - 1; i++) {
    const s1Pt = fullCoords[i];
    const s2Pt = fullCoords[i + 1];

    if (poly && poly.length >= 3) {
      if (pointInPolygon(s1Pt, poly) || pointInPolygon(s2Pt, poly)) {
        intersecting = true;
        minDistance = 0;
        bestSegIdx = i;
        bestSegStart = s1Pt;
        bestSegEnd = s2Pt;
        break;
      }
      for (let j = 0; j < poly.length - 1; j++) {
        if (segmentsIntersect(s1Pt, s2Pt, poly[j], poly[j + 1])) {
          intersecting = true;
          minDistance = 0;
          bestSegIdx = i;
          bestSegStart = s1Pt;
          bestSegEnd = s2Pt;
          break;
        }
      }
      if (intersecting) break;

      const dCentroid = pointToSegmentGeodesicDistanceMeters(berg.longitude, berg.latitude, s1Pt[0], s1Pt[1], s2Pt[0], s2Pt[1]);
      if (dCentroid < minDistance) {
        minDistance = dCentroid;
        bestSegIdx = i;
        bestSegStart = s1Pt;
        bestSegEnd = s2Pt;
      }

      if (dCentroid < NEARBY_THRESHOLD_METERS * 1.5) {
        for (let j = 0; j < poly.length; j++) {
          const d = pointToSegmentGeodesicDistanceMeters(poly[j][0], poly[j][1], s1Pt[0], s1Pt[1], s2Pt[0], s2Pt[1]);
          if (d < minDistance) {
            minDistance = d;
            bestSegIdx = i;
            bestSegStart = s1Pt;
            bestSegEnd = s2Pt;
          }
        }
      }
    } else {
      const d = pointToSegmentGeodesicDistanceMeters(berg.longitude, berg.latitude, s1Pt[0], s1Pt[1], s2Pt[0], s2Pt[1]);
      if (d < minDistance) {
        minDistance = d;
        bestSegIdx = i;
        bestSegStart = s1Pt;
        bestSegEnd = s2Pt;
      }
    }
  }

  if (intersecting || minDistance <= NEARBY_THRESHOLD_METERS) {
    detectedHazards.push({
      icebergId: berg.id,
      source: 'Sentinel-1',
      relationship: intersecting || minDistance <= INTERSECTION_BUFFER_METERS ? 'INTERSECTING' : 'NEARBY',
      minDistanceMeters: minDistance,
      minDistanceKm: minDistance / 1000.0,
      minDistanceNm: (minDistance / 1000.0) / 1.852,
      segmentIndex: bestSegIdx,
      segment: `${bestSegIdx} → ${bestSegIdx + 1}`,
      lat: berg.latitude,
      lon: berg.longitude,
      areaKm2: berg.areaKm2,
      fastIceStatus: berg.fastIceStatus
    });
  }
}

// BYU/NIC
for (const berg of byu) {
  if (!berg.latestPos) continue;
  const lat = berg.latestPos.lat;
  const lon = berg.latestPos.lon;

  if (lat < minRouteLat || lat > maxRouteLat) continue;
  if (lon < minRouteLon || lon > maxRouteLon) continue;

  let minDistance = Infinity;
  let bestSegIdx = -1;
  let bestSegStart = null;
  let bestSegEnd = null;

  for (let i = 0; i < fullCoords.length - 1; i++) {
    const s1Pt = fullCoords[i];
    const s2Pt = fullCoords[i + 1];

    const d = pointToSegmentGeodesicDistanceMeters(lon, lat, s1Pt[0], s1Pt[1], s2Pt[0], s2Pt[1]);
    if (d < minDistance) {
      minDistance = d;
      bestSegIdx = i;
      bestSegStart = s1Pt;
      bestSegEnd = s2Pt;
    }
  }

  if (minDistance <= NEARBY_THRESHOLD_METERS) {
    detectedHazards.push({
      icebergId: berg.id,
      source: 'BYU/NIC',
      relationship: minDistance <= INTERSECTION_BUFFER_METERS ? 'INTERSECTING' : 'NEARBY',
      minDistanceMeters: minDistance,
      minDistanceKm: minDistance / 1000.0,
      minDistanceNm: (minDistance / 1000.0) / 1.852,
      segmentIndex: bestSegIdx,
      segment: `${bestSegIdx} → ${bestSegIdx + 1}`,
      lat: lat,
      lon: lon,
      latestDate: berg.end,
      sensor: berg.latestPos.sensor
    });
  }
}

console.timeEnd("Hazard analysis execution");

detectedHazards.sort((a, b) => a.minDistanceMeters - b.minDistanceMeters);

console.log(`Total detected hazards: ${detectedHazards.length}`);
console.log("Summary of hazards:");
console.log(JSON.stringify(detectedHazards.slice(0, 15), null, 2));
