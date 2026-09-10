/**
 * BYU / NIC Drifting Iceberg Database Service
 * -------------------------------------------
 * Loads multi-decadal Antarctic drifting iceberg tracking records
 * sourced from Brigham Young University (BYU) Microwave Earth Remote Sensing (MERS)
 * Laboratory and the National Ice Center (NIC).
 *
 * Dataset Properties:
 * - Scope: 624 distinct icebergs, 483,116 scatterometer observations (1976–2026).
 * - Sensors: ASCAT, QuikSCAT, NSCAT, Seasat SASS, optical/radar NIC tracking.
 * - Coordinates: Authentic WGS84 geographic drift tracks across the Southern Ocean.
 */

import type { DriftingIcebergTrajectoryRecord } from '../types/driftingIceberg';

let cachedDriftingTrajectories: DriftingIcebergTrajectoryRecord[] | null = null;
let fetchPromise: Promise<DriftingIcebergTrajectoryRecord[]> | null = null;

/**
 * Loads and memory-caches the BYU / NIC Antarctic Drifting Iceberg Trajectories dataset.
 *
 * @returns Promise resolving to an array of DriftingIcebergTrajectoryRecord objects
 */
export async function loadDriftingIcebergDataset(): Promise<DriftingIcebergTrajectoryRecord[]> {
  if (cachedDriftingTrajectories) {
    return cachedDriftingTrajectories;
  }

  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const response = await fetch('/data/drifting_iceberg_trajectories.json');
      if (!response.ok) {
        throw new Error(`Failed to load drifting iceberg dataset: HTTP ${response.status} ${response.statusText}`);
      }
      const data: DriftingIcebergTrajectoryRecord[] = await response.json();
      cachedDriftingTrajectories = data;
      return data;
    } catch (err) {
      console.error('Error loading drifting iceberg dataset:', err);
      fetchPromise = null;
      throw err;
    }
  })();

  return fetchPromise;
}
