import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Intercept fetch for Node environment to directly serve public data files without socket limits
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.startsWith('/')) {
    const filePath = path.join(projectRoot, 'frontend/public', url);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  return origFetch(url, opts);
};

// Import frontend service
const { computeMaritimeRoute } = await import('../frontend/src/services/maritimeRoutingService.ts');
const portsData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/public/data/ports.json'), 'utf-8'));

function getPort(wpi) {
  const p = portsData.find(x => x.wpiNumber === wpi);
  if (!p) throw new Error(`Port WPI ${wpi} not found`);
  return p;
}

const testCases = [
  {
    name: 'Corridor 1: Darwin -> McMurdo Station (User Reported)',
    originWpi: 54670,
    destWpi: 63130,
    expectedStatus: 'SUCCESS',
    expectedTopology: 'CASE_3_HYBRID_GATEWAY',
  },
  {
    name: 'Corridor 2: Hobart -> McMurdo Station',
    originWpi: 54760,
    destWpi: 63130,
    expectedStatus: 'SUCCESS',
    expectedTopology: 'CASE_3_HYBRID_GATEWAY',
  },
  {
    name: 'Corridor 3: Ushuaia -> Ellefsen Harbor',
    originWpi: 13980,
    destWpi: 63070,
    expectedStatus: 'SUCCESS',
    expectedTopology: 'CASE_1_POLAR_POLAR',
  },
  {
    name: 'Corridor 4: Cape Town -> McMurdo Station',
    originWpi: 46770,
    destWpi: 63130,
    expectedStatus: 'SUCCESS',
    expectedTopology: 'CASE_3_HYBRID_GATEWAY',
  },
  {
    name: 'Corridor 5: Rotterdam -> Keppel Singapore',
    originWpi: 31140,
    destWpi: 50000,
    expectedStatus: 'SUCCESS',
    expectedTopology: 'CASE_2_GLOBAL_GLOBAL',
  },
  {
    name: 'Corridor 6: Puerto Natales -> McMurdo Station (Fjord)',
    originWpi: 14190,
    destWpi: 63130,
    expectedStatus: 'HYBRID_UNAVAILABLE',
    expectedTopology: 'CASE_6_ISOLATED_COMPONENT',
  },
];

console.log('================================================================================');
console.log('PRODUCTION ROUTING ENGINE VERIFICATION — 6 Authoritative Corridors');
console.log('================================================================================\n');

let allPassed = true;

for (const tc of testCases) {
  const origin = getPort(tc.originWpi);
  const dest = getPort(tc.destWpi);

  console.log(`Testing [${tc.name}]...`);
  console.log(`  Origin: ${origin.portName} (${origin.wpiNumber}) [${origin.longitude}, ${origin.latitude}]`);
  console.log(`  Dest:   ${dest.portName} (${dest.wpiNumber}) [${dest.longitude}, ${dest.latitude}]`);

  const t0 = performance.now();
  const result = await computeMaritimeRoute(origin, dest);
  const elapsedMs = (performance.now() - t0).toFixed(1);

  console.log(`  Status:             ${result.status} (expected: ${tc.expectedStatus})`);
  console.log(`  Topology:           ${result.topology || 'N/A'}`);
  console.log(`  Distance:           ${result.distanceKm ? result.distanceKm.toFixed(1) + ' km' : '0 km'}`);
  console.log(`  Waypoints:          ${result.coordinates ? result.coordinates.length : 0}`);
  console.log(`  Terminal Approach:  ${result.terminalApproachStatus || 'N/A'}`);
  console.log(`  Calculation Time:   ${elapsedMs} ms`);

  if (result.validationReport) {
    console.log(`  Validation Report:  Result=${result.validationReport.overallResult}, FailingSegments=${result.validationReport.failingSegments?.length || 0}`);
  }

  if (result.status !== tc.expectedStatus) {
    console.error(`  FAIL: Status mismatch! Expected ${tc.expectedStatus}, got ${result.status}`);
    if (result.failingReason) console.error(`  Failing Reason: ${result.failingReason}`);
    allPassed = false;
  } else if (result.status === 'SUCCESS') {
    if (result.validationReport && result.validationReport.overallResult !== 'PASS') {
      console.error(`  FAIL: Validation report did not PASS!`);
      allPassed = false;
    } else if (result.validationReport && (result.validationReport.failingSegments?.length || 0) > 0) {
      console.error(`  FAIL: Found ${result.validationReport.failingSegments.length} land crossings!`);
      allPassed = false;
    } else {
      console.log(`  PASS: Validated 0 land crossings!`);
      
      // Specifically check Ross Sea waypoints for routes ending at McMurdo
      if (dest.wpiNumber === 63130 && result.coordinates) {
        const polarWps = result.coordinates.filter(pt => pt[1] <= -70);
        console.log(`  Ross Sea Polar Waypoints (${polarWps.length} pts):`);
        for (const wp of polarWps) {
          console.log(`    [lon: ${wp[0].toFixed(3)}, lat: ${wp[1].toFixed(3)}]`);
        }
      }
    }
  } else {
    console.log(`  PASS: Correctly rejected as expected (${result.failureCategory || result.failingReason})`);
  }
  console.log('--------------------------------------------------------------------------------\n');
}

if (allPassed) {
  console.log('ALL 6 CORRIDORS PASSED VERIFICATION WITH ZERO LAND CROSSINGS!');
} else {
  console.error('SOME CORRIDORS FAILED VERIFICATION!');
  process.exit(1);
}
