import type { IcebergRecord } from '../types/iceberg';

let cachedIcebergs: IcebergRecord[] | null = null;
let fetchPromise: Promise<IcebergRecord[]> | null = null;

/**
 * Loads real-world Antarctic iceberg dataset sourced from U.S. National Ice Center (USNIC).
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
        throw new Error('Failed to load iceberg dataset: ' + response.status + ' ' + response.statusText);
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
