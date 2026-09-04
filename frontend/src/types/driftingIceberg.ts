/**
 * Real-world BYU / NIC Antarctic Drifting Iceberg Trajectory Record
 * Source: Brigham Young University (BYU) MERS / National Ice Center (NIC)
 * URL: https://www.scp.byu.edu/data/iceberg/database1.html
 * Coordinate Reference System: WGS84 (EPSG:4326)
 */
export interface DriftingIcebergTrajectoryRecord {
  id: string;
  points: number;
  start: string;
  end: string;
  startPos: {
    lat: number;
    lon: number;
    sensor: string;
  };
  latestPos: {
    lat: number;
    lon: number;
    sensor: string;
  };
  maxNorthLat: number;
  openOcean: boolean;
  coords: [number, number][]; // [longitude, latitude][]
}
