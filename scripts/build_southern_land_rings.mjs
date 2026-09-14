import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const currentPath = path.join(projectRoot, 'frontend/public/data/southernLandRings.json');
const icePath = path.join(projectRoot, 'data/ne_10m_antarctic_ice_shelves_polys.geojson');

console.log('Loading existing land rings...');
const existingRings = JSON.parse(fs.readFileSync(currentPath, 'utf-8'));
console.log(`Loaded ${existingRings.length} existing land rings.`);

console.log('Loading Antarctic ice shelves...');
const iceData = JSON.parse(fs.readFileSync(icePath, 'utf-8'));
console.log(`Loaded ${iceData.features.length} ice shelf features.`);

const newIceRings = [];
for (const feature of iceData.features) {
  const geom = feature.geometry;
  if (!geom) continue;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    for (const rawRing of poly) {
      if (rawRing.length < 3) continue;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const ring = [];
      for (const pt of rawRing) {
        const x = Math.round(pt[0] * 10000) / 10000;
        const y = Math.round(pt[1] * 10000) / 10000;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        ring.push([x, y]);
      }

      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
        ring.push([ring[0][0], ring[0][1]]);
      }

      newIceRings.push({
        bbox: [minX, minY, maxX, maxY],
        ring,
      });
    }
  }
}

console.log(`Extracted ${newIceRings.length} ice shelf rings.`);
const combined = [...existingRings, ...newIceRings];
console.log(`Total combined barrier rings: ${combined.length}`);

fs.writeFileSync(currentPath, JSON.stringify(combined));
console.log(`Successfully wrote combined barrier rings to ${currentPath}`);

const distPath = path.join(projectRoot, 'frontend/dist/data/southernLandRings.json');
if (fs.existsSync(path.dirname(distPath))) {
  fs.writeFileSync(distPath, JSON.stringify(combined));
  console.log(`Also updated ${distPath}`);
}
