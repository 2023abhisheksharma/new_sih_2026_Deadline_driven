/**
 * Iceberg Hazard Analysis Domain Types
 * ------------------------------------
 * Defines structured types for spatial intersection and proximity analysis
 * between calculated maritime routes and real-world iceberg observations.
 */

export type IceHazardSource = 'USNIC' | 'Sentinel-1' | 'BYU/NIC';

export type IceHazardRelationship = 'INTERSECTING' | 'NEARBY';

export interface IcebergHazardDetails {
  // USNIC metadata
  usnicLength?: string;
  usnicWidth?: string;
  usnicAreaSqKm?: number;
  usnicStatus?: string;
  usnicLastUpdate?: string;

  // Sentinel-1 metadata
  sentinel1AreaKm2?: number;
  sentinel1BedDepthM?: number;
  sentinel1FastIceStatus?: string;
  sentinel1Timestamp?: string;
  sentinel1Orbit?: string;

  // BYU/NIC metadata
  byuNicSensor?: string;
  byuNicLatestDate?: string;
  byuNicTrackPoints?: number;
  byuNicOpenOcean?: boolean;
  byuNicTemporalNote?: string;
}

export interface IcebergHazardItem {
  icebergId: string;
  icebergName?: string;
  sourceDataset: IceHazardSource;
  relationship: IceHazardRelationship;
  minDistanceMeters: number;
  minDistanceKm: number;
  minDistanceNm: number;
  routeSegmentIndex: number; // 0-based index of segment [i -> i+1]
  routeSegmentStart: [number, number]; // [lon, lat]
  routeSegmentEnd: [number, number]; // [lon, lat]
  icebergPosition: [number, number]; // [lon, lat] centroid / latest observation
  hasGeometry: boolean;
  geometryType?: 'Polygon' | 'Point';
  vertexCount?: number;
  boundaryCoordinates?: [number, number][];
  details: IcebergHazardDetails;
}

export interface IceHazardThresholds {
  nearbyThresholdKm: number;
  nearbyThresholdNm: number;
  intersectionBufferMeters: number;
  description: string;
}

export interface IceHazardSummary {
  totalHazards: number;
  intersectingCount: number;
  nearbyCount: number;
  usnic: {
    total: number;
    intersecting: number;
    nearby: number;
  };
  sentinel1: {
    total: number;
    intersecting: number;
    nearby: number;
    outsideFastIce: number;
    insideFastIce: number;
    partialFastIce: number;
  };
  byuNic: {
    total: number;
    intersecting: number;
    nearby: number;
  };
}

export interface IceHazardAnalysisReport {
  timestamp: string;
  thresholds: IceHazardThresholds;
  routeMetrics: {
    totalDistanceKm: number;
    totalDistanceNm: number;
    segmentCount: number;
    waypointCount: number;
  };
  summary: IceHazardSummary;
  hazards: IcebergHazardItem[]; // Sorted ascending by minDistanceMeters
}
