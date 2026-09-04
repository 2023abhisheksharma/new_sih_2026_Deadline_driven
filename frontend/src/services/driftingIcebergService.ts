import type { DriftingIcebergTrajectoryRecord } from '../types/driftingIceberg';

let cachedDriftingTrajectories: DriftingIcebergTrajectoryRecord[] | null = null;
let fetchPromise: Promise<DriftingIcebergTrajectoryRecord[]> | null = null;

/**
 * Loads real-world BYU / NIC Antarctic Drifting Iceberg Trajectories (624 icebergs, multi-decadal tracks)
 * Source: BYU Microwave Earth Remote Sensing Laboratory & National Ice Center (NIC)
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
        throw new Error('Failed to load drifting iceberg dataset: ' + response.status + ' ' + response.statusText);
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
