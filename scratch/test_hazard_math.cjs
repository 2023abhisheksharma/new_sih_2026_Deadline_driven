const R = 6371008.8; // Mean Earth radius in meters

function toRad(deg) {
  return (deg * Math.PI) / 180.0;
}

function toDeg(rad) {
  return (rad * 180.0) / Math.PI;
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

// 3D Cartesian coordinates on unit sphere
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

/**
 * Calculates geodesic distance in meters from a point P to a great circle segment AB on the sphere.
 */
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

  // Normal to great circle containing A and B
  const vAB = cross(vA, vB);
  const n = normalize(vAB);

  // If A and B are antipodal or identical
  if (norm(vAB) < 1e-12) {
    return Math.min(distPA, distPB);
  }

  // Projection of P onto great circle plane
  const dPlane = dot(vP, n); // Sine of angular distance to great circle
  const vProj = [
    vP[0] - dPlane * n[0],
    vP[1] - dPlane * n[1],
    vP[2] - dPlane * n[2]
  ];
  const vProjNorm = normalize(vProj);

  // Check if vProj lies between A and B on the arc
  // Cross product test: (vA x vProj) . n >= 0 and (vProj x vB) . n >= 0
  const c1 = dot(cross(vA, vProjNorm), n);
  const c2 = dot(cross(vProjNorm, vB), n);

  if (c1 >= -1e-9 && c2 >= -1e-9) {
    // Projected point falls inside the segment arc
    const angularDistRad = Math.asin(Math.min(1.0, Math.max(-1.0, Math.abs(dPlane))));
    return angularDistRad * R;
  }

  return Math.min(distPA, distPB);
}

// Test case:
const d1 = pointToSegmentGeodesicDistanceMeters(-63.0, -58.5, -68.3, -54.8, -58.0, -62.0);
console.log("Point to segment distance (meters):", d1, "(km):", (d1 / 1000.0).toFixed(2));

// Test against actual route calculation in node
const fs = require('fs');
const usnic = JSON.parse(fs.readFileSync('frontend/public/data/icebergs.json', 'utf8'));
const s1 = JSON.parse(fs.readFileSync('frontend/public/data/sentinel1_grounded_icebergs.json', 'utf8'));
const byu = JSON.parse(fs.readFileSync('frontend/public/data/drifting_iceberg_trajectories.json', 'utf8'));

console.log("USNIC count:", usnic.length);
console.log("S1 count:", s1.length);
console.log("BYU count:", byu.length);
