/**
 * Southern Ocean & Antarctic Landmass Service
 * -------------------------------------------
 * Asynchronously loads and memory-caches authoritative coastline and ice shelf
 * polygon rings (derived from Natural Earth 10m physical vector data & SCAR ADD).
 *
 * Used for:
 * 1. 2D Tactical View coastline rendering.
 * 2. Independent route validation against land barrier intersections.
 */

export interface LandPolygonRing {
  /** Geographic bounding box: [minLon, minLat, maxLon, maxLat] in degrees */
  bbox: [number, number, number, number];
  /** Boundary coordinate vertices in WGS84: [[lon, lat], ...] */
  ring: [number, number][];
}

/** Legacy type alias for backwards compatibility across services */
export type LandRing = LandPolygonRing;

let cachedLandRings: LandPolygonRing[] | null = null;
let landLoadingPromise: Promise<LandPolygonRing[]> | null = null;

/**
 * Loads and caches real Antarctic and Southern Ocean landmass polygon rings.
 * Memory cached after initial network request.
 *
 * @returns Promise resolving to an array of LandPolygonRing objects
 */
export async function loadSouthernLandRings(): Promise<LandPolygonRing[]> {
  if (cachedLandRings) {
    return cachedLandRings;
  }

  if (landLoadingPromise) {
    return landLoadingPromise;
  }

  landLoadingPromise = (async () => {
    try {
      const response = await fetch('/data/southernLandRings.json');
      if (!response.ok) {
        throw new Error(`Failed to fetch southernLandRings.json: HTTP ${response.status} ${response.statusText}`);
      }
      const data: LandPolygonRing[] = await response.json();
      cachedLandRings = data;
      return data;
    } catch (err) {
      console.error('Error loading southern land rings:', err);
      cachedLandRings = [];
      return [];
    } finally {
      landLoadingPromise = null;
    }
  })();

  return landLoadingPromise;
}

/** Legacy function alias for backwards compatibility */
export const loadLandRings = loadSouthernLandRings;

// Eager load in browser environment to eliminate routing cold-start latency
if (typeof window !== 'undefined') {
  loadSouthernLandRings();
}
