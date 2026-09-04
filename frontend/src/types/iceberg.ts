/**
 * Real-world Antarctic Iceberg Record from U.S. National Ice Center (USNIC)
 * Official source: National Oceanic and Atmospheric Administration (NOAA) / USNIC
 * Coordinate Reference System: WGS84 (EPSG:4326)
 */
export interface IcebergRecord {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  length: string;
  width: string;
  lengthNm: number | null;
  widthNm: number | null;
  areaSqKm: number;
  areaSqNm: number;
  areaSqMi: number;
  status: string;
  lastUpdate: string;
  hasRealBoundary: boolean;
  vertexCount: number;
  boundaryCoordinates: [number, number][]; // [longitude, latitude][]
}
