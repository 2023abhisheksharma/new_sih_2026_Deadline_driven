export interface LandPolygonRing {
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  ring: [number, number][]; // [lon, lat][]
}

let cachedLandRings: LandPolygonRing[] | null = null;
let landLoadingPromise: Promise<LandPolygonRing[]> | null = null;

/**
 * Loads and caches real Antarctic and Southern Ocean landmass polygon rings.
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
        throw new Error(`Failed to fetch southernLandRings.json: HTTP ${response.status}`);
      }
      const data: LandPolygonRing[] = await response.json();
      cachedLandRings = data;
      return data;
    } catch (err) {
      console.error('Error loading southern land rings:', err);
      return [];
    } finally {
      landLoadingPromise = null;
    }
  })();

  return landLoadingPromise;
}
