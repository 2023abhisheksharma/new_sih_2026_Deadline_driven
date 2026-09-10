/**
 * USNIC Antarctic Macro-Iceberg Dataset Service
 * ---------------------------------------------
 * Loads authoritative Antarctic iceberg records sourced from the
 * U.S. National Ice Center (NOAA / U.S. Navy / U.S. Coast Guard).
 *
 * Dataset Properties:
 * - Features: 33 active tracked macro-icebergs (size >= 10 NM²).
 * - Coordinates: WGS84 (EPSG:4326), reprojected from South Pole Polar Stereographic.
 * - Attributes: Real tracked polygon boundaries, length/width dimensions in NM, update dates.
 */

import type { IcebergRecord } from '../types/iceberg';

let cachedIcebergs: IcebergRecord[] | null = null;
let fetchPromise: Promise<IcebergRecord[]> | null = null;

/**
 * Loads and memory-caches the official USNIC Antarctic iceberg dataset.
 *
 * @returns Promise resolving to an array of IcebergRecord objects
 */
export async function loadIcebergDataset(): Promise<IcebergRecord[]> {
  if (cachedIcebergs) {
    return cachedIcebergs;
  }

  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const response = await fetch('/data/icebergs.json');
      if (!response.ok) {
        throw new Error(`Failed to load iceberg dataset: HTTP ${response.status} ${response.statusText}`);
      }
      const data: IcebergRecord[] = await response.json();
      cachedIcebergs = data;
      return data;
    } catch (err) {
      console.error('Error loading real-world iceberg dataset:', err);
      fetchPromise = null;
      throw err;
    }
  })();

  return fetchPromise;
}
