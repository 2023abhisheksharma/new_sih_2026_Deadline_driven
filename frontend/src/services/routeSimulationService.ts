import { calculateGeodesicDistanceMeters } from './iceHazardService';

export interface RouteSimulationPoint {
  coordinate: [number, number]; // [longitude, latitude]
  headingDegrees: number;
  segmentIndex: number;
  distanceTraveledMeters: number;
  distanceRemainingMeters: number;
  totalDistanceMeters: number;
  progressPercent: number;
  isCompleted: boolean;
}

export interface RouteGeometryProfile {
  coordinates: [number, number][];
  segmentDistances: number[]; // meters per segment
  cumulativeDistances: number[]; // meters at each vertex
  totalDistanceMeters: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180.0;

/**
 * Calculates initial great-circle bearing from point 1 to point 2 in degrees [0, 360).
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
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlambda);

  const brng = (Math.atan2(y, x) * 180.0) / Math.PI;
  return (brng + 360.0) % 360.0;
}

/**
 * Builds distance profile along route vertices.
 */
export function buildRouteGeometryProfile(
  coordinates: [number, number][]
): RouteGeometryProfile | null {
  if (!coordinates || coordinates.length < 2) return null;

  const segmentDistances: number[] = [];
  const cumulativeDistances: number[] = [0];
  let totalDistanceMeters = 0;

  for (let i = 0; i < coordinates.length - 1; i++) {
    const [lon1, lat1] = coordinates[i];
    const [lon2, lat2] = coordinates[i + 1];
    const dist = calculateGeodesicDistanceMeters(lon1, lat1, lon2, lat2);
    segmentDistances.push(dist);
    totalDistanceMeters += dist;
    cumulativeDistances.push(totalDistanceMeters);
  }

  return {
    coordinates,
    segmentDistances,
    cumulativeDistances,
    totalDistanceMeters,
  };
}

/**
 * Interpolates vessel position, heading, and metrics along the route at a given cumulative distance.
 */
export function evaluateSimulationPoint(
  profile: RouteGeometryProfile,
  distanceMeters: number
): RouteSimulationPoint {
  const { coordinates, cumulativeDistances, segmentDistances, totalDistanceMeters } = profile;

  if (totalDistanceMeters <= 0 || distanceMeters <= 0) {
    const heading =
      coordinates.length >= 2
        ? calculateBearingDegrees(
            coordinates[0][0],
            coordinates[0][1],
            coordinates[1][0],
            coordinates[1][1]
          )
        : 0;

    return {
      coordinate: [coordinates[0][0], coordinates[0][1]],
      headingDegrees: heading,
      segmentIndex: 0,
      distanceTraveledMeters: 0,
      distanceRemainingMeters: totalDistanceMeters,
      totalDistanceMeters,
      progressPercent: 0,
      isCompleted: false,
    };
  }

  if (distanceMeters >= totalDistanceMeters) {
    const lastIdx = coordinates.length - 1;
    const heading =
      lastIdx >= 1
        ? calculateBearingDegrees(
            coordinates[lastIdx - 1][0],
            coordinates[lastIdx - 1][1],
            coordinates[lastIdx][0],
            coordinates[lastIdx][1]
          )
        : 0;

    return {
      coordinate: [coordinates[lastIdx][0], coordinates[lastIdx][1]],
      headingDegrees: heading,
      segmentIndex: Math.max(0, coordinates.length - 2),
      distanceTraveledMeters: totalDistanceMeters,
      distanceRemainingMeters: 0,
      totalDistanceMeters,
      progressPercent: 100.0,
      isCompleted: true,
    };
  }

  // Find active segment
  let segIdx = 0;
  for (let i = 0; i < segmentDistances.length; i++) {
    if (distanceMeters <= cumulativeDistances[i + 1]) {
      segIdx = i;
      break;
    }
  }

  const segStartDist = cumulativeDistances[segIdx];
  const segLength = segmentDistances[segIdx];
  const fraction = segLength > 0 ? (distanceMeters - segStartDist) / segLength : 0;
  const clampedFraction = Math.max(0.0, Math.min(1.0, fraction));

  const [aLon, aLat] = coordinates[segIdx];
  const [bLon, bLat] = coordinates[segIdx + 1];

  // Geodesic Linear Interpolation along segment
  const curLon = aLon + (bLon - aLon) * clampedFraction;
  const curLat = aLat + (bLat - aLat) * clampedFraction;
  const heading = calculateBearingDegrees(aLon, aLat, bLon, bLat);

  return {
    coordinate: [curLon, curLat],
    headingDegrees: heading,
    segmentIndex: segIdx,
    distanceTraveledMeters: distanceMeters,
    distanceRemainingMeters: Math.max(0, totalDistanceMeters - distanceMeters),
    totalDistanceMeters,
    progressPercent: (distanceMeters / totalDistanceMeters) * 100.0,
    isCompleted: false,
  };
}
