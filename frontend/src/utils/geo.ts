/**
 * Geospatial & Spherical Mathematics Utility Module
 * -------------------------------------------------
 * Centralizes all geodesic, spherical trigonometric, vector algebra, and
 * geometric intersection calculations for the Antarctic Navigation DSS.
 *
 * All coordinates follow the WGS84 standard (EPSG:4326):
 * - Longitude: [-180.0, 180.0] degrees (positive East, negative West)
 * - Latitude:  [-90.0,  90.0]  degrees (positive North, negative South)
 * - Datum:     WGS84 Reference Ellipsoid
 */

/**
 * WGS84 mean Earth radius in meters according to IUGG (International Union
 * of Geodesy and Geophysics) definition: R1 = (2a + b) / 3 ≈ 6,371,008.8 meters.
 */
export const EARTH_RADIUS_METERS = 6371008.8;

/** Standard international nautical mile defined as exactly 1,852 meters. */
export const METERS_PER_NAUTICAL_MILE = 1852.0;

/** Standard international nautical mile defined as exactly 1.852 kilometers. */
export const KM_PER_NAUTICAL_MILE = 1.852;

// ============================================================================
// 1. Angle & Unit Conversions
// ============================================================================

/**
 * Converts degrees to radians.
 */
export function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180.0;
}
export const degreesToRadians = toRad;

/**
 * Converts radians to degrees.
 */
export function toDeg(radians: number): number {
  return (radians * 180.0) / Math.PI;
}
export const radiansToDegrees = toDeg;


/**
 * Converts kilometers to international nautical miles (NM).
 */
export function kmToNauticalMiles(km: number): number {
  return km / KM_PER_NAUTICAL_MILE;
}

/**
 * Converts international nautical miles (NM) to kilometers.
 */
export function nauticalMilesToKm(nm: number): number {
  return nm * KM_PER_NAUTICAL_MILE;
}

/**
 * Converts meters to international nautical miles (NM).
 */
export function metersToNauticalMiles(meters: number): number {
  return meters / METERS_PER_NAUTICAL_MILE;
}

/**
 * Formats a voyage duration in decimal hours into a human-readable transit string (e.g. "3d 4h" or "14h").
 */
export function formatTransitDuration(hours: number): string {
  if (hours <= 0) return '0h';
  const days = Math.floor(hours / 24);
  const remainingHours = Math.round(hours % 24);
  if (days > 0) {
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  return `${Math.max(1, Math.round(hours))}h`;
}

// ============================================================================
// 2. Spherical Geodesic Distances & Bearings (Haversine & Azimuth)
// ============================================================================

/**
 * Computes great-circle distance between two points on the WGS84 sphere using the Haversine formula.
 *
 * Formula:
 *   a = sin²(Δφ/2) + cos(φ1) * cos(φ2) * sin²(Δλ/2)
 *   c = 2 * atan2(√a, √(1-a))
 *   d = R * c
 *
 * @param lon1 Longitude of point 1 in degrees
 * @param lat1 Latitude of point 1 in degrees
 * @param lon2 Longitude of point 2 in degrees
 * @param lat2 Latitude of point 2 in degrees
 * @returns Geodesic distance in meters
 */
export function calculateGeodesicDistanceMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dphi = toRad(lat2 - lat1);
  const dlambda = toRad(lon2 - lon1);

  const a =
    Math.sin(dphi / 2.0) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2.0) ** 2;
  const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  return EARTH_RADIUS_METERS * c;
}

export const haversineDistanceMeters = calculateGeodesicDistanceMeters;

export function haversineDistanceKm(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  return calculateGeodesicDistanceMeters(lon1, lat1, lon2, lat2) / 1000.0;
}


/**
 * Calculates initial great-circle forward azimuth (bearing) from point 1 to point 2.
 * Returns clockwise angle in degrees from true North in range [0, 360).
 *
 * @param lon1 Start longitude in degrees
 * @param lat1 Start latitude in degrees
 * @param lon2 End longitude in degrees
 * @param lat2 End latitude in degrees
 */
export function calculateBearingDegrees(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dlambda = toRad(lon2 - lon1);

  const y = Math.sin(dlambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlambda);

  const brng = (Math.atan2(y, x) * 180.0) / Math.PI;
  return (brng + 360.0) % 360.0;
}

// ============================================================================
// 3. 3D Spherical Vector Projection (Point-to-Segment Minimum Geodesic Distance)
// ============================================================================

export type Vector3 = [number, number, number];

/**
 * Converts geographic coordinates (lon, lat in degrees) to a 3D Cartesian unit vector on the unit sphere.
 */
export function toCartesianUnit(lonDeg: number, latDeg: number): Vector3 {
  const phi = toRad(latDeg);
  const lambda = toRad(lonDeg);
  return [
    Math.cos(phi) * Math.cos(lambda),
    Math.cos(phi) * Math.sin(lambda),
    Math.sin(phi),
  ];
}

/** Vector dot product in R³. */
export function dot(u: Vector3, v: Vector3): number {
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
}

/** Vector cross product in R³. */
export function cross(u: Vector3, v: Vector3): Vector3 {
  return [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
}

/** Vector Euclidean norm (length) in R³. */
export function norm(u: Vector3): number {
  return Math.sqrt(dot(u, u));
}

/** Normalizes a 3D vector to unit length. */
export function normalize(u: Vector3): Vector3 {
  const len = norm(u);
  if (len === 0) return [0, 0, 0];
  return [u[0] / len, u[1] / len, u[2] / len];
}

/**
 * Calculates the exact minimum geodesic distance in meters from an arbitrary point P
 * to a great-circle line segment AB on the sphere.
 *
 * Method:
 * 1. Computes the normal n = normalize(vA × vB) of the plane containing great circle AB.
 * 2. Projects P onto the plane: vProj = vP - (vP · n) n.
 * 3. Tests whether vProj falls within the angular wedge between A and B using cross-product signs:
 *    (vA × vProj) · n >= 0  AND  (vProj × vB) · n >= 0.
 * 4. If inside wedge, the distance is the perpendicular angular arc: asin(|vP · n|) * R.
 * 5. Otherwise, the closest point on segment AB is one of its endpoints: min(dist(P, A), dist(P, B)).
 *
 * @param pLon Point P longitude
 * @param pLat Point P latitude
 * @param aLon Segment vertex A longitude
 * @param aLat Segment vertex A latitude
 * @param bLon Segment vertex B longitude
 * @param bLat Segment vertex B latitude
 * @returns Minimum geodesic distance in meters
 */
export function pointToSegmentGeodesicDistanceMeters(
  pLon: number,
  pLat: number,
  aLon: number,
  aLat: number,
  bLon: number,
  bLat: number
): number {
  const distPA = calculateGeodesicDistanceMeters(pLon, pLat, aLon, aLat);
  const distPB = calculateGeodesicDistanceMeters(pLon, pLat, bLon, bLat);
  const distAB = calculateGeodesicDistanceMeters(aLon, aLat, bLon, bLat);

  // If segment endpoints are effectively coincident (< 1mm)
  if (distAB < 1e-3) {
    return distPA;
  }

  const vA = toCartesianUnit(aLon, aLat);
  const vB = toCartesianUnit(bLon, bLat);
  const vP = toCartesianUnit(pLon, pLat);

  const vAB = cross(vA, vB);
  const n = normalize(vAB);

  // Collinear or antipodal guard
  if (norm(vAB) < 1e-12) {
    return Math.min(distPA, distPB);
  }

  const dPlane = dot(vP, n);
  const vProj: Vector3 = [
    vP[0] - dPlane * n[0],
    vP[1] - dPlane * n[1],
    vP[2] - dPlane * n[2],
  ];
  const vProjNorm = normalize(vProj);

  // Wedge boundary orientation tests
  const c1 = dot(cross(vA, vProjNorm), n);
  const c2 = dot(cross(vProjNorm, vB), n);

  if (c1 >= -1e-9 && c2 >= -1e-9) {
    const angularDistRad = Math.asin(Math.min(1.0, Math.max(-1.0, Math.abs(dPlane))));
    return angularDistRad * EARTH_RADIUS_METERS;
  }

  return Math.min(distPA, distPB);
}

// ============================================================================
// 4. Planar & Polygon Geometry Intersections
// ============================================================================

/**
 * Tests whether two 2D line segments [p1 -> p2] and [p3 -> p4] intersect.
 * Uses orientation counter-clockwise (CCW) testing for robustness.
 */
export function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number]
): boolean {
  function ccw(a: [number, number], b: [number, number], c: [number, number]): boolean {
    return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
  }
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

/**
 * Standard Ray-Casting algorithm to test whether a coordinate point [lon, lat]
 * is strictly inside a closed polygon ring [[lon, lat], ...].
 */
export function pointInPolygon(
  point: [number, number],
  ring: [number, number][]
): boolean {
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
