import type { PortRecord } from "../types/port";

let cachedPorts: PortRecord[] | null = null;
let fetchPromise: Promise<PortRecord[]> | null = null;

/**
 * Loads real-world port dataset sourced from NGA World Port Index (Pub 150).
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
      const response = await fetch("/data/ports.json");
      if (!response.ok) {
        throw new Error("Failed to load port dataset: " + response.status + " " + response.statusText);
      }
      const data: PortRecord[] = await response.json();
      cachedPorts = data;
      return data;
    } catch (err) {
      console.error("Error loading real-world port dataset:", err);
      fetchPromise = null;
      throw err;
    }
  })();

  return fetchPromise;
}

/**
 * Searches real-world NGA WPI ports by name, alternate name, country, region, or WPI ID.
 * Returns top results matching query in order of relevance.
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

    // 1. Exact or prefix match on WPI Number
    if (qNum !== null && p.wpiNumber === qNum) {
      score += 1000;
    } else if (qNum !== null && p.wpiNumber.toString().startsWith(q)) {
      score += 500;
    }

    // 2. Exact or substring match on Port Name
    if (name === q) {
      score += 500;
    } else if (name.startsWith(q)) {
      score += 300;
    } else if (name.includes(q)) {
      score += 150;
    }

    // 3. Alternate name match
    if (alt && alt === q) {
      score += 400;
    } else if (alt && alt.startsWith(q)) {
      score += 250;
    } else if (alt && alt.includes(q)) {
      score += 100;
    }

    // 4. Country / Region match
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
