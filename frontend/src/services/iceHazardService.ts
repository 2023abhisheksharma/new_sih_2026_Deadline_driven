/**
 * Real-world Iceberg Spatial Hazard Analysis Service
 * --------------------------------------------------
 * Evaluates calculated maritime routes against three authoritative Antarctic iceberg datasets:
 * 1. USNIC Antarctic Iceberg Dataset (NOAA / USNIC macro-icebergs with real polygon boundaries)
 * 2. Sentinel-1 Circum-Antarctic Grounded Iceberg Dataset (IMAS / UTAS / ESSD 2026 stationary shelf targets)
 * 3. BYU / NIC Antarctic Drifting Iceberg Tracking Database (MERS / NIC multi-decadal latest observations)
 *
 * All distance calculations use rigorous spherical geodesics (WGS84 ellipsoid mean radius R = 6,371,008.8m).
 * Spatial relationships are classified as:
 * - INTERSECTING: Route segment traverses the iceberg polygon or passes within zero margin (<= 50m)
 * - NEARBY: Route passes within the explicitly configured proximity corridor (default: 25.0 km / ~13.5 NM)
 * - NOT_NEARBY: Beyond proximity threshold
 *
 * NOTE: The analysis does NOT modify route geometry and does NOT fabricate synthetic hazards or arbitrary risk scores.
 */

import type { IcebergRecord } from '../types/iceberg';
import type { Sentinel1GroundedIcebergRecord } from '../types/sentinel1Iceberg';
import type { DriftingIcebergTrajectoryRecord } from '../types/driftingIceberg';
import type {
  IceHazardAnalysisReport,
  IcebergHazardItem,
  IceHazardThresholds,
} from '../types/iceHazard';
import {
  calculateGeodesicDistanceMeters,
  pointToSegmentGeodesicDistanceMeters,
  segmentsIntersect,
  pointInPolygon,
  kmToNauticalMiles,
  toRad,
} from '../utils/geo';

// Re-export geodesic functions for backwards compatibility
export { calculateGeodesicDistanceMeters, pointToSegmentGeodesicDistanceMeters };

export const DEFAULT_HAZARD_THRESHOLDS: IceHazardThresholds = {
  nearbyThresholdKm: 25.0,
  nearbyThresholdNm: kmToNauticalMiles(25.0),
  intersectionBufferMeters: 50.0,
  description:
    'Documented decision-support proximity corridor: 25.0 km (~13.5 NM) buffer with 50m geometric intersection threshold',
};

/**
 * Performs rigorous spatial hazard analysis of an existing calculated maritime route against real iceberg datasets.
 *
 * Performance Optimization:
 * Pre-computes a bounding box (latitude and longitude bounds with buffer) over the entire route
 * to discard 99%+ of irrelevant circum-Antarctic iceberg targets before executing detailed segment-to-polygon checks.
 *
 * @param routeCoordinates LineString coordinates [[lon, lat], ...] of the computed route
 * @param usnicIcebergs Active USNIC macro-icebergs with tracked polygon boundaries
 * @param sentinel1Icebergs Grounded icebergs from Sentinel-1 SAR inventory
 * @param driftingIcebergs Latest observations from BYU/NIC scatterometer tracks
 * @param thresholds Configured spatial proximity and intersection thresholds
 * @returns Comprehensive IceHazardAnalysisReport containing sorted hazards and statistical summary
 */
export async function analyzeRouteIcebergHazards(
  routeCoordinates: [number, number][],
  usnicIcebergs: IcebergRecord[],
  sentinel1Icebergs: Sentinel1GroundedIcebergRecord[],
  driftingIcebergs: DriftingIcebergTrajectoryRecord[],
  thresholds: IceHazardThresholds = DEFAULT_HAZARD_THRESHOLDS
): Promise<IceHazardAnalysisReport> {
  const emptyReport: IceHazardAnalysisReport = {
    timestamp: new Date().toISOString(),
    thresholds,
    routeMetrics: {
      totalDistanceKm: 0,
      totalDistanceNm: 0,
      segmentCount: 0,
      waypointCount: routeCoordinates.length,
    },
    summary: {
      totalHazards: 0,
      intersectingCount: 0,
      nearbyCount: 0,
      usnic: { total: 0, intersecting: 0, nearby: 0 },
      sentinel1: {
        total: 0,
        intersecting: 0,
        nearby: 0,
        outsideFastIce: 0,
        insideFastIce: 0,
        partialFastIce: 0,
      },
      byuNic: { total: 0, intersecting: 0, nearby: 0 },
    },
    hazards: [],
  };

  if (!routeCoordinates || routeCoordinates.length < 2) {
    return emptyReport;
  }

  // Calculate total route distance
  let totalDistanceKm = 0;
  for (let i = 0; i < routeCoordinates.length - 1; i++) {
    totalDistanceKm +=
      calculateGeodesicDistanceMeters(
        routeCoordinates[i][0],
        routeCoordinates[i][1],
        routeCoordinates[i + 1][0],
        routeCoordinates[i + 1][1]
      ) / 1000.0;
  }
  const totalDistanceNm = kmToNauticalMiles(totalDistanceKm);

  // Compute spatial bounding box with buffer for fast pre-filtering
  let minRouteLon = Infinity;
  let maxRouteLon = -Infinity;
  let minRouteLat = Infinity;
  let maxRouteLat = -Infinity;

  for (const [lon, lat] of routeCoordinates) {
    if (lon < minRouteLon) minRouteLon = lon;
    if (lon > maxRouteLon) maxRouteLon = lon;
    if (lat < minRouteLat) minRouteLat = lat;
    if (lat > maxRouteLat) maxRouteLat = lat;
  }

  const latBuffer = thresholds.nearbyThresholdKm / 111.0;
  const cosLatMax = Math.max(
    0.08,
    Math.cos(toRad(Math.max(Math.abs(minRouteLat), Math.abs(maxRouteLat))))
  );
  const lonBuffer = Math.min(180, thresholds.nearbyThresholdKm / (111.0 * cosLatMax));

  const bboxMinLat = minRouteLat - latBuffer;
  const bboxMaxLat = maxRouteLat + latBuffer;
  const bboxMinLon = minRouteLon - lonBuffer;
  const bboxMaxLon = maxRouteLon + lonBuffer;

  const nearbyThresholdMeters = thresholds.nearbyThresholdKm * 1000.0;
  const intersectionBufferMeters = thresholds.intersectionBufferMeters;

  const detectedHazards: IcebergHazardItem[] = [];

  // ==========================================================================
  // 1. USNIC Antarctic Icebergs (Macro Icebergs with Multi-vertex Polygons)
  // ==========================================================================
  if (usnicIcebergs && usnicIcebergs.length > 0) {
    for (const berg of usnicIcebergs) {
      if (
        berg.latitude < bboxMinLat ||
        berg.latitude > bboxMaxLat ||
        berg.longitude < bboxMinLon ||
        berg.longitude > bboxMaxLon
      ) {
        continue;
      }

      let minDistance = Infinity;
      let intersecting = false;
      let bestSegIdx = -1;
      let bestSegStart: [number, number] = [0, 0];
      let bestSegEnd: [number, number] = [0, 0];

      const poly = berg.boundaryCoordinates;

      for (let i = 0; i < routeCoordinates.length - 1; i++) {
        const s1 = routeCoordinates[i];
        const s2 = routeCoordinates[i + 1];

        if (poly && poly.length >= 3) {
          // Point in polygon test for route vertices
          if (pointInPolygon(s1, poly) || pointInPolygon(s2, poly)) {
            intersecting = true;
            minDistance = 0;
            bestSegIdx = i;
            bestSegStart = s1;
            bestSegEnd = s2;
            break;
          }

          // Line segment crossing polygon edges
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

          // Distance from segment to polygon boundary vertices
          for (let j = 0; j < poly.length; j++) {
            const d = pointToSegmentGeodesicDistanceMeters(
              poly[j][0],
              poly[j][1],
              s1[0],
              s1[1],
              s2[0],
              s2[1]
            );
            if (d < minDistance) {
              minDistance = d;
              bestSegIdx = i;
              bestSegStart = s1;
              bestSegEnd = s2;
            }
          }
        } else {
          // Centroid distance fallback if no polygon vertices
          const d = pointToSegmentGeodesicDistanceMeters(
            berg.longitude,
            berg.latitude,
            s1[0],
            s1[1],
            s2[0],
            s2[1]
          );
          if (d < minDistance) {
            minDistance = d;
            bestSegIdx = i;
            bestSegStart = s1;
            bestSegEnd = s2;
          }
        }
      }

      if (intersecting || minDistance <= nearbyThresholdMeters) {
        const isIntersecting = intersecting || minDistance <= intersectionBufferMeters;
        detectedHazards.push({
          icebergId: berg.id,
          icebergName: berg.name,
          sourceDataset: 'USNIC',
          relationship: isIntersecting ? 'INTERSECTING' : 'NEARBY',
          minDistanceMeters: isIntersecting ? 0 : minDistance,
          minDistanceKm: isIntersecting ? 0 : minDistance / 1000.0,
          minDistanceNm: isIntersecting ? 0 : kmToNauticalMiles(minDistance / 1000.0),
          routeSegmentIndex: bestSegIdx,
          routeSegmentStart: bestSegStart,
          routeSegmentEnd: bestSegEnd,
          icebergPosition: [berg.longitude, berg.latitude],
          hasGeometry: !!(poly && poly.length >= 3),
          geometryType: poly && poly.length >= 3 ? 'Polygon' : 'Point',
          vertexCount: berg.vertexCount || (poly ? poly.length : 0),
          boundaryCoordinates: poly,
          details: {
            usnicLength: berg.length,
            usnicWidth: berg.width,
            usnicAreaSqKm: berg.areaSqKm,
            usnicStatus: berg.status,
            usnicLastUpdate: berg.lastUpdate,
          },
        });
      }
    }
  }

  // ==========================================================================
  // 2. Sentinel-1 Circum-Antarctic Grounded Icebergs (39,619 Stationary Targets)
  // ==========================================================================
  if (sentinel1Icebergs && sentinel1Icebergs.length > 0) {
    for (let bIdx = 0; bIdx < sentinel1Icebergs.length; bIdx++) {
      const berg = sentinel1Icebergs[bIdx];
      if (
        berg.latitude < bboxMinLat ||
        berg.latitude > bboxMaxLat ||
        berg.longitude < bboxMinLon ||
        berg.longitude > bboxMaxLon
      ) {
        continue;
      }

      let minDistance = Infinity;
      let intersecting = false;
      let bestSegIdx = -1;
      let bestSegStart: [number, number] = [0, 0];
      let bestSegEnd: [number, number] = [0, 0];

      const poly = berg.boundaryCoordinates;

      for (let i = 0; i < routeCoordinates.length - 1; i++) {
        const s1Pt = routeCoordinates[i];
        const s2Pt = routeCoordinates[i + 1];

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

          const dCentroid = pointToSegmentGeodesicDistanceMeters(
            berg.longitude,
            berg.latitude,
            s1Pt[0],
            s1Pt[1],
            s2Pt[0],
            s2Pt[1]
          );
          if (dCentroid < minDistance) {
            minDistance = dCentroid;
            bestSegIdx = i;
            bestSegStart = s1Pt;
            bestSegEnd = s2Pt;
          }

          if (dCentroid < nearbyThresholdMeters * 1.5) {
            for (let j = 0; j < poly.length; j++) {
              const d = pointToSegmentGeodesicDistanceMeters(
                poly[j][0],
                poly[j][1],
                s1Pt[0],
                s1Pt[1],
                s2Pt[0],
                s2Pt[1]
              );
              if (d < minDistance) {
                minDistance = d;
                bestSegIdx = i;
                bestSegStart = s1Pt;
                bestSegEnd = s2Pt;
              }
            }
          }
        } else {
          const d = pointToSegmentGeodesicDistanceMeters(
            berg.longitude,
            berg.latitude,
            s1Pt[0],
            s1Pt[1],
            s2Pt[0],
            s2Pt[1]
          );
          if (d < minDistance) {
            minDistance = d;
            bestSegIdx = i;
            bestSegStart = s1Pt;
            bestSegEnd = s2Pt;
          }
        }
      }

      if (intersecting || minDistance <= nearbyThresholdMeters) {
        const isIntersecting = intersecting || minDistance <= intersectionBufferMeters;
        detectedHazards.push({
          icebergId: berg.id,
          icebergName: `Target ${berg.id} (Grounded)`,
          sourceDataset: 'Sentinel-1',
          relationship: isIntersecting ? 'INTERSECTING' : 'NEARBY',
          minDistanceMeters: isIntersecting ? 0 : minDistance,
          minDistanceKm: isIntersecting ? 0 : minDistance / 1000.0,
          minDistanceNm: isIntersecting ? 0 : kmToNauticalMiles(minDistance / 1000.0),
          routeSegmentIndex: bestSegIdx,
          routeSegmentStart: bestSegStart,
          routeSegmentEnd: bestSegEnd,
          icebergPosition: [berg.longitude, berg.latitude],
          hasGeometry: !!(poly && poly.length >= 3),
          geometryType: poly && poly.length >= 3 ? 'Polygon' : 'Point',
          vertexCount: berg.vertexCount || (poly ? poly.length : 0),
          boundaryCoordinates: poly,
          details: {
            sentinel1AreaKm2: berg.areaKm2,
            sentinel1BedDepthM: berg.bedDepthM,
            sentinel1FastIceStatus: berg.fastIceStatus,
            sentinel1Timestamp: berg.timestamp,
            sentinel1Orbit: berg.orbit,
          },
        });
      }
    }
  }

  // ==========================================================================
  // 3. BYU / NIC Drifting Icebergs (Latest Observed Satellite Positions)
  // ==========================================================================
  if (driftingIcebergs && driftingIcebergs.length > 0) {
    for (const berg of driftingIcebergs) {
      if (!berg.latestPos) continue;
      const lat = berg.latestPos.lat;
      const lon = berg.latestPos.lon;

      if (
        lat < bboxMinLat ||
        lat > bboxMaxLat ||
        lon < bboxMinLon ||
        lon > bboxMaxLon
      ) {
        continue;
      }

      let minDistance = Infinity;
      let bestSegIdx = -1;
      let bestSegStart: [number, number] = [0, 0];
      let bestSegEnd: [number, number] = [0, 0];

      for (let i = 0; i < routeCoordinates.length - 1; i++) {
        const s1Pt = routeCoordinates[i];
        const s2Pt = routeCoordinates[i + 1];

        const d = pointToSegmentGeodesicDistanceMeters(
          lon,
          lat,
          s1Pt[0],
          s1Pt[1],
          s2Pt[0],
          s2Pt[1]
        );
        if (d < minDistance) {
          minDistance = d;
          bestSegIdx = i;
          bestSegStart = s1Pt;
          bestSegEnd = s2Pt;
        }
      }

      if (minDistance <= nearbyThresholdMeters) {
        const isIntersecting = minDistance <= intersectionBufferMeters;
        detectedHazards.push({
          icebergId: berg.id,
          icebergName: `Drifting Iceberg ${berg.id}`,
          sourceDataset: 'BYU/NIC',
          relationship: isIntersecting ? 'INTERSECTING' : 'NEARBY',
          minDistanceMeters: minDistance,
          minDistanceKm: minDistance / 1000.0,
          minDistanceNm: kmToNauticalMiles(minDistance / 1000.0),
          routeSegmentIndex: bestSegIdx,
          routeSegmentStart: bestSegStart,
          routeSegmentEnd: bestSegEnd,
          icebergPosition: [lon, lat],
          hasGeometry: false,
          geometryType: 'Point',
          details: {
            byuNicSensor: berg.latestPos.sensor,
            byuNicLatestDate: berg.end,
            byuNicTrackPoints: berg.points,
            byuNicOpenOcean: berg.openOcean,
            byuNicTemporalNote: `Historical satellite scatterometer track with latest observation recorded on ${berg.end}`,
          },
        });
      }
    }
  }

  // Sort hazards ascending by minimum geodesic distance
  detectedHazards.sort((a, b) => a.minDistanceMeters - b.minDistanceMeters);

  // Compute breakdown metrics
  let intersectingCount = 0;
  let nearbyCount = 0;

  const usnicStats = { total: 0, intersecting: 0, nearby: 0 };
  const sentinel1Stats = {
    total: 0,
    intersecting: 0,
    nearby: 0,
    outsideFastIce: 0,
    insideFastIce: 0,
    partialFastIce: 0,
  };
  const byuNicStats = { total: 0, intersecting: 0, nearby: 0 };

  for (const h of detectedHazards) {
    if (h.relationship === 'INTERSECTING') {
      intersectingCount++;
    } else {
      nearbyCount++;
    }

    if (h.sourceDataset === 'USNIC') {
      usnicStats.total++;
      if (h.relationship === 'INTERSECTING') usnicStats.intersecting++;
      else usnicStats.nearby++;
    } else if (h.sourceDataset === 'Sentinel-1') {
      sentinel1Stats.total++;
      if (h.relationship === 'INTERSECTING') sentinel1Stats.intersecting++;
      else sentinel1Stats.nearby++;

      if (h.details.sentinel1FastIceStatus === 'Outside') sentinel1Stats.outsideFastIce++;
      else if (h.details.sentinel1FastIceStatus === 'Inside') sentinel1Stats.insideFastIce++;
      else if (h.details.sentinel1FastIceStatus === 'Partial') sentinel1Stats.partialFastIce++;
    } else if (h.sourceDataset === 'BYU/NIC') {
      byuNicStats.total++;
      if (h.relationship === 'INTERSECTING') byuNicStats.intersecting++;
      else byuNicStats.nearby++;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    thresholds,
    routeMetrics: {
      totalDistanceKm,
      totalDistanceNm,
      segmentCount: Math.max(0, routeCoordinates.length - 1),
      waypointCount: routeCoordinates.length,
    },
    summary: {
      totalHazards: detectedHazards.length,
      intersectingCount,
      nearbyCount,
      usnic: usnicStats,
      sentinel1: sentinel1Stats,
      byuNic: byuNicStats,
    },
    hazards: detectedHazards,
  };
}
