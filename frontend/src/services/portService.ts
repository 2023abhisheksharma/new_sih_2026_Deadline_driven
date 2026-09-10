/**
 * Port Directory & Search Service
 * --------------------------------
 * Manages loading, caching, and multi-tier fuzzy searching of real-world
 * maritime ports from the National Geospatial-Intelligence Agency (NGA)
 * World Port Index (Pub 150).
 */

import type { PortRecord } from '../types/port';

let cachedPorts: PortRecord[] | null = null;
let fetchPromise: Promise<PortRecord[]> | null = null;

/**
 * Asynchronously loads the official NGA World Port Index dataset.
 * Caches results in-memory after initial network request.
 *
 * @returns Promise resolving to an array of PortRecord items
 */
export async function loadPortDataset(): Promise<PortRecord[]> {
  if (cachedPorts) {
    return cachedPorts;
  }

  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const response = await fetch('/data/ports.json');
      if (!response.ok) {
        throw new Error(`Failed to load port dataset: HTTP ${response.status} ${response.statusText}`);
      }
      const data: PortRecord[] = await response.json();
      cachedPorts = data;
      return data;
    } catch (err) {
      console.error('Error loading real-world port dataset:', err);
      fetchPromise = null;
      throw err;
    }
  })();

  return fetchPromise;
}

/**
 * Searches real-world NGA WPI ports using a weighted relevance scoring heuristic.
 *
 * Scoring Priorities:
 * 1. Exact or prefix match on numeric World Port Index Number (+1000 / +500)
 * 2. Exact, prefix, or substring match on Main Port Name (+500 / +300 / +150)
 * 3. Exact, prefix, or substring match on Alternate Port Name (+400 / +250 / +100)
 * 4. Match on Country Code (+80 / +40) or Region Name (+30)
 *
 * @param ports Loaded array of PortRecord objects
 * @param query User search string (e.g. "Ushuaia", "63090", "Falkland")
 * @param limit Maximum results to return (default: 6)
 * @returns Sorted array of matching PortRecord objects
 */
export function searchPorts(ports: PortRecord[], query: string, limit: number = 6): PortRecord[] {
  if (!query || !query.trim()) return [];
  const q = query.trim().toLowerCase();

  const isNumeric = /^\d+$/.test(q);
  const qNum = isNumeric ? parseInt(q, 10) : null;

  const results: { port: PortRecord; score: number }[] = [];

  for (let i = 0; i < ports.length; i++) {
    const p = ports[i];
    const name = p.portName.toLowerCase();
    const alt = p.alternatePortName ? p.alternatePortName.toLowerCase() : '';
    const country = p.countryCode ? p.countryCode.toLowerCase() : '';
    const region = p.regionName ? p.regionName.toLowerCase() : '';

    let score = 0;

    // 1. Numeric WPI ID Matching
    if (qNum !== null && p.wpiNumber === qNum) {
      score += 1000;
    } else if (qNum !== null && p.wpiNumber.toString().startsWith(q)) {
      score += 500;
    }

    // 2. Main Port Name Matching
    if (name === q) {
      score += 500;
    } else if (name.startsWith(q)) {
      score += 300;
    } else if (name.includes(q)) {
      score += 150;
    }

    // 3. Alternate Port Name Matching
    if (alt && alt === q) {
      score += 400;
    } else if (alt && alt.startsWith(q)) {
      score += 250;
    } else if (alt && alt.includes(q)) {
      score += 100;
    }

    // 4. Geographic Country Code / Region Matching
    if (country === q) {
      score += 80;
    } else if (country.startsWith(q)) {
      score += 40;
    } else if (region.includes(q)) {
      score += 30;
    }

    if (score > 0) {
      results.push({ port: p, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map((r) => r.port);
}
