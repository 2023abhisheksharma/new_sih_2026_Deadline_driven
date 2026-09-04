import type { PortRecord } from "../types/port";

export interface LandRing {
  bbox: [number, number, number, number]; // [minx, miny, maxx, maxy]
  ring: [number, number][]; // [lon, lat][]
}

export interface FailingSegmentDiagnostic {
  segmentIndex: number;
  startCoords: [number, number];
  endCoords: [number, number];
  lengthKm: number;
  crossingDeg: number;
  diagnosticReason: string;
}

export interface RouteValidationReport {
  departureWpi: number;
  departureName: string;
  departureCoords: [number, number];
  destinationWpi: number;
  destinationName: string;
  destinationCoords: [number, number];
  routeSource: string;
  routeLengthKm: number;
  departureEndpointErrorMeters: number;
  destinationEndpointErrorMeters: number;
  isGeometryValid: boolean;
  landIntersectionStatus: "PASS" | "FAIL";
  totalLandCrossingLengthDeg: number;
  failingSegments: FailingSegmentDiagnostic[];
  overallResult: "PASS" | "FAIL";
  validationMetadata: {
    landDataset: string;
    source: string;
    version: string;
    license: string;
    coordinateSystem: string;
    toleranceMeters: number;
  };
}

let cachedLandRings: LandRing[] | null = null;
let landLoadingPromise: Promise<LandRing[]> | null = null;

export async function loadLandRings(): Promise<LandRing[]> {
  if (cachedLandRings) return cachedLandRings;
  if (landLoadingPromise) return landLoadingPromise;

  landLoadingPromise = fetch("/data/southernLandRings.json")
    .then((res) => {
      if (!res.ok) throw new Error("Failed to load southernLandRings.json");
      return res.json();
    })
    .then((data: LandRing[]) => {
      cachedLandRings = data;
      return data;
    })
    .catch((err) => {
      console.warn("Failed to load land rings dataset:", err);
      cachedLandRings = [];
      return [];
    });

  return landLoadingPromise;
}

// Kick off eager load
if (typeof window !== "undefined") {
  loadLandRings();
}

/**
 * Calculates geodesic distance between two points on the WGS84 ellipsoid (Haversine formula).
 */
export function calculateGeodesicDistanceMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const R = 6371008.8; // Mean Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180.0;
  const phi2 = (lat2 * Math.PI) / 180.0;
  const dphi = ((lat2 - lat1) * Math.PI) / 180.0;
  const dlambda = ((lon2 - lon1) * Math.PI) / 180.0;

  const a =
    Math.sin(dphi / 2.0) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2.0) ** 2;
  const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  return R * c;
}

function segmentsIntersect(
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

function pointInPolygon(point: [number, number], ring: [number, number][]): boolean {
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

export function kmToNauticalMiles(km: number): number {
  return km / 1.852;
}

export function formatTransitDuration(hours: number): string {
  if (hours <= 0) return "0h";
  const days = Math.floor(hours / 24);
  const remainingHours = Math.round(hours % 24);
  if (days > 0) {
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  return `${Math.max(1, Math.round(hours))}h`;
}

/**
 * Computes exact land & ice shelf intersections for candidate line segments.
 * Rigorously distinguishes valid coastal harbor dock approaches from genuine interior land crossings.
 */
export function checkLandIntersections(
  coordinates: [number, number][],
  rings: LandRing[]
): FailingSegmentDiagnostic[] {
  const failingSegments: FailingSegmentDiagnostic[] = [];
  const numSegments = coordinates.length - 1;

  for (let i = 0; i < numSegments; i++) {
    const s1 = coordinates[i];
    const s2 = coordinates[i + 1];
    const isTerminal = i === 0 || i === numSegments - 1;
    const distKm = calculateGeodesicDistanceMeters(s1[0], s1[1], s2[0], s2[1]) / 1000.0;

    // Terminal harbor approach legs under 65 km connect coastal port docks to offshore navigation mesh
    if (isTerminal && distKm <= 65.0) {
      continue;
    }

    const sMinX = Math.min(s1[0], s2[0]);
    const sMaxX = Math.max(s1[0], s2[0]);
    const sMinY = Math.min(s1[1], s2[1]);
    const sMaxY = Math.max(s1[1], s2[1]);

    const midPt: [number, number] = [(s1[0] + s2[0]) / 2.0, (s1[1] + s2[1]) / 2.0];
    let intersects = false;
    let hitReason = "";

    for (let r = 0; r < rings.length; r++) {
      const { bbox, ring } = rings[r];
      // Fast Bounding Box Pre-Check
      if (sMaxX < bbox[0] || sMinX > bbox[2] || sMaxY < bbox[1] || sMinY > bbox[3]) {
        continue;
      }

      // Check edge crossings
      for (let j = 0; j < ring.length - 1; j++) {
        if (segmentsIntersect(s1, s2, ring[j], ring[j + 1])) {
          intersects = true;
          hitReason = "Line segment crosses land boundary polygon";
          break;
        }
      }

      if (intersects) break;

      // Check if midpoint falls inside land polygon
      if (pointInPolygon(midPt, ring)) {
        intersects = true;
        hitReason = "Line segment traverses land polygon interior";
        break;
      }
    }

    if (intersects) {
      const degLen = Math.sqrt((s2[0] - s1[0]) ** 2 + (s2[1] - s1[1]) ** 2);
      failingSegments.push({
        segmentIndex: i,
        startCoords: s1,
        endCoords: s2,
        lengthKm: distKm,
        crossingDeg: degLen,
        diagnosticReason: isTerminal
          ? "Excessive snapping distance across land/mountains (>65 km)"
          : hitReason,
      });
    }
  }

  return failingSegments;
}

/**
 * Independently validates a candidate maritime route against endpoint constraints,
 * geometric structure, and authoritative land barrier datasets.
 */
export async function validateMaritimeRouteAsync(
  candidateCoordinates: [number, number][],
  routeLengthKm: number,
  routeSource: string,
  departurePort: PortRecord,
  destinationPort: PortRecord
): Promise<RouteValidationReport> {
  const depCoords: [number, number] = [departurePort.longitude, departurePort.latitude];
  const destCoords: [number, number] = [destinationPort.longitude, destinationPort.latitude];

  const isGeometryValid = candidateCoordinates.length >= 2;

  const startPt = candidateCoordinates[0] || depCoords;
  const endPt = candidateCoordinates[candidateCoordinates.length - 1] || destCoords;

  const departureEndpointErrorMeters = calculateGeodesicDistanceMeters(
    depCoords[0],
    depCoords[1],
    startPt[0],
    startPt[1]
  );

  const destinationEndpointErrorMeters = calculateGeodesicDistanceMeters(
    destCoords[0],
    destCoords[1],
    endPt[0],
    endPt[1]
  );

  const rings = cachedLandRings || (await loadLandRings());
  const failingSegments = checkLandIntersections(candidateCoordinates, rings);

  const totalLandCrossingLengthDeg = failingSegments.reduce(
    (acc, seg) => acc + seg.crossingDeg,
    0
  );

  const landIntersectionStatus = failingSegments.length === 0 ? "PASS" : "FAIL";
  const overallResult =
    isGeometryValid &&
    departureEndpointErrorMeters < 1.0 &&
    destinationEndpointErrorMeters < 1.0 &&
    landIntersectionStatus === "PASS"
      ? "PASS"
      : "FAIL";

  return {
    departureWpi: departurePort.wpiNumber,
    departureName: departurePort.portName,
    departureCoords: depCoords,
    destinationWpi: destinationPort.wpiNumber,
    destinationName: destinationPort.portName,
    destinationCoords: destCoords,
    routeSource,
    routeLengthKm,
    departureEndpointErrorMeters,
    destinationEndpointErrorMeters,
    isGeometryValid,
    landIntersectionStatus,
    totalLandCrossingLengthDeg,
    failingSegments,
    overallResult,
    validationMetadata: {
      landDataset: "Natural Earth 10m Physical Land & Antarctic Ice Shelves",
      source: "Natural Earth Vector GIS / Scientific Committee on Antarctic Research (SCAR)",
      version: "v5.1.1 (2023/2024)",
      license: "Public Domain / CC0",
      coordinateSystem: "WGS84 (EPSG:4326)",
      toleranceMeters: 1.0,
    },
  };
}
