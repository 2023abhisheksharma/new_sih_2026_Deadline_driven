/**
 * Real-world Circum-Antarctic Grounded Iceberg Record
 * Source: Institute for Marine and Antarctic Studies (IMAS), University of Tasmania (UTAS)
 * Publication: Earth System Science Data (ESSD 2026), DOI: 10.25959/54sx-pt47 / 10.5194/essd-18-6017-2026
 * Coordinate Reference System: WGS84 (EPSG:4326)
 */
export type FastIceOverlapStatus = 'Outside' | 'Inside' | 'Partial';

export interface Sentinel1GroundedIcebergRecord {
  id: string;
  orbit: string;
  timestamp: string;
  dateRange: string;
  areaKm2: number;
  bedDepthM: number;
  acquisitionMode: string;
  latitude: number;
  longitude: number;
  fastIceStatus: FastIceOverlapStatus;
  vertexCount: number;
  boundaryCoordinates: [number, number][]; // [longitude, latitude][]
}
