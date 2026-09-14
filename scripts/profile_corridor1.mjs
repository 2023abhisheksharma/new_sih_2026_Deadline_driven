import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.startsWith('/')) {
    const filePath = path.join(projectRoot, 'frontend/public', url);
    if (fs.existsSync(filePath)) {
      return new Response(fs.readFileSync(filePath), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  return origFetch(url, opts);
};

const portsData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/ports.json'), 'utf-8'));
const darwin = portsData.find(x => x.wpiNumber === 54670);
const mcmurdo = portsData.find(x => x.wpiNumber === 63130);

console.log('Loading modules...');
const { computeHybridMaritimeRoute } = await import('../frontend/src/services/hybridMaritimeRoutingService.ts');

console.log('Starting computeHybridMaritimeRoute...');
const t0 = performance.now();
const res = await computeHybridMaritimeRoute(darwin, mcmurdo);
console.log('Finished in', ((performance.now() - t0)/1000).toFixed(2), 's');
console.log('Status:', res?.status);
console.log('Failing reason:', res?.failingReason);
console.log('Distance:', res?.distanceKm);
console.log('Waypoints:', res?.coordinates?.length);
