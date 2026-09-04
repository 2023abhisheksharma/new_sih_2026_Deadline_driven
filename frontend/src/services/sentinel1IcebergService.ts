import type { Sentinel1GroundedIcebergRecord } from '../types/sentinel1Iceberg';

let cachedGroundedIcebergs: Sentinel1GroundedIcebergRecord[] | null = null;
let fetchPromise: Promise<Sentinel1GroundedIcebergRecord[]> | null = null;

/**
 * Loads real-world Sentinel-1 Circum-Antarctic Grounded Iceberg Dataset (39,619 stationary targets)
 * Source: IMAS / UTAS / Copernicus ESSD (DOI: 10.25959/54sx-pt47)
 */
export async function loadSentinel1GroundedIcebergDataset(): Promise<Sentinel1GroundedIcebergRecord[]> {
  if (cachedGroundedIcebergs) {
    return cachedGroundedIcebergs;
  }

  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const response = await fetch('/data/sentinel1_grounded_icebergs.json');
      if (!response.ok) {
        throw new Error('Failed to load Sentinel-1 grounded iceberg dataset: ' + response.status + ' ' + response.statusText);
      }
      const data: Sentinel1GroundedIcebergRecord[] = await response.json();
      cachedGroundedIcebergs = data;
      return data;
    } catch (err) {
      console.error('Error loading Sentinel-1 grounded iceberg dataset:', err);
      fetchPromise = null;
      throw err;
    }
  })();

  return fetchPromise;
}
