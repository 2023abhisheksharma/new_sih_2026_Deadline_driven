/**
 * Route Simulation & Progress Interpolation Service
 * -------------------------------------------------
 * Manages deterministic vessel progression, bearing calculation, and spatial
 * interpolation along pre-calculated maritime routes.
 *
 * Provides smooth 60fps positioning by pre-computing cumulative geodesic distance
 * profiles and interpolating current vessel position, true heading, and voyage
 * completion metrics.
 */

import { calculateGeodesicDistanceMeters, calculateBearingDegrees } from '../utils/geo';

// Re-export calculateBearingDegrees for backward compatibility
export { calculateBearingDegrees };

export interface RouteSimulationPoint {
  /** Current interpolated vessel position: [longitude, latitude] in degrees */
  coordinate: [number, number];
  /** True heading azimuth in degrees [0, 360) clockwise from North */
  headingDegrees: number;
  /** Zero-based index of the active segment: [segmentIndex -> segmentIndex + 1] */
  segmentIndex: number;
  /** Distance traveled from departure in meters */
  distanceTraveledMeters: number;
  /** Distance remaining to destination in meters */
  distanceRemainingMeters: number;
  /** Total route length in meters */
  totalDistanceMeters: number;
  /** Percentage of route completed [0.0, 100.0] */
  progressPercent: number;
  /** Whether the destination waypoint has been reached */
  isCompleted: boolean;
}

export interface RouteGeometryProfile {
  /** Array of route waypoints: [[lon, lat], ...] */
  coordinates: [number, number][];
  /** Length in meters of each segment i -> i+1 */
  segmentDistances: number[];
  /** Cumulative distance in meters from start at each vertex index */
  cumulativeDistances: number[];
  /** Total route length in meters */
  totalDistanceMeters: number;
}

/**
 * Pre-computes the cumulative distance profile for a series of route waypoints.
 * Enables O(1) or O(log N) segment search during animation frame evaluations.
 *
 * @param coordinates Ordered array of [lon, lat] waypoints
 * @returns RouteGeometryProfile or null if fewer than 2 points
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
 * Interpolates vessel position, heading, and telemetry metrics along a route profile
 * at a given cumulative distance.
 *
 * @param profile Pre-built RouteGeometryProfile
 * @param distanceMeters Target distance from start in meters
 * @returns Evaluated RouteSimulationPoint with position, bearing, and metrics
 */
export function evaluateSimulationPoint(
  profile: RouteGeometryProfile,
  distanceMeters: number
): RouteSimulationPoint {
  const { coordinates, cumulativeDistances, segmentDistances, totalDistanceMeters } = profile;

  // Boundary condition 1: At or before start
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

  // Boundary condition 2: Reached or exceeded destination
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

  // Find active segment [i -> i+1] where distanceMeters falls
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

  // Geodesic Linear Interpolation along active segment
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
