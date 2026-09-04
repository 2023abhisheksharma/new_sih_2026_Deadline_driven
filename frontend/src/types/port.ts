/**
 * Real-world Port Record from NGA World Port Index (Pub 150)
 * Official source: National Geospatial-Intelligence Agency (NGA)
 * Coordinate Reference System: WGS84 (EPSG:4326)
 */
export interface PortRecord {
  wpiNumber: number;
  portName: string;
  alternatePortName: string | null;
  unLocode: string | null;
  countryCode: string | null;
  regionName: string | null;
  waterBody: string | null;
  seaArea: string | null;
  latitude: number;
  longitude: number;
  harborSize: string | null;
  harborType: string | null;
  harborUse: string | null;
  shelter: string | null;
  entranceIce: string | null;
  entranceSwell: string | null;
  facilitiesAnchorage: string | null;
  facilitiesIceMooring: string | null;
  servicesIceBreaking: string | null;
  maxVesselLength: number | null;
  maxVesselBeam: number | null;
  maxVesselDraft: number | null;
  channelDepth: string | null;
  anchorageDepth: string | null;
  cargoPierDepth: string | null;
  sailingDirection: string | null;
  publicationLink: string | null;
}
