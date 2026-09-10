/**
 * Sentinel-1 Circum-Antarctic Grounded Iceberg Service
 * ----------------------------------------------------
 * Loads high-resolution stationary iceberg targets derived from Sentinel-1 SAR
 * and deep learning across the continental shelf of Antarctica.
 *
 * Source:
 * Institute for Marine and Antarctic Studies (IMAS), University of Tasmania (UTAS)
 * Publication: Earth System Science Data (ESSD 2026), DOI: 10.25959/54sx-pt47
 *
 * Dataset Properties:
 * - Features: 39,619 stationary iceberg targets.
 * - Classes: Outside fast ice (27,557), Inside fast ice (11,436), Partial overlap (626).
 * - Attributes: Boundary polygon coordinates, surface area (km²), bed depth (m), acquisition date.
 */

import type { Sentinel1GroundedIcebergRecord } from '../types/sentinel1Iceberg';

let cachedGroundedIcebergs: Sentinel1GroundedIcebergRecord[] | null = null;
let fetchPromise: Promise<Sentinel1GroundedIcebergRecord[]> | null = null;

/**
 * Loads and memory-caches the Sentinel-1 Grounded Iceberg dataset.
 *
 * @returns Promise resolving to an array of Sentinel1GroundedIcebergRecord objects
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
        throw new Error(`Failed to load Sentinel-1 dataset: HTTP ${response.status} ${response.statusText}`);
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
