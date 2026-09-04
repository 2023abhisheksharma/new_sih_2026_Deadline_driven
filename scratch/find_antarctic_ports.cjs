const fs = require('fs');
const ports = JSON.parse(fs.readFileSync('frontend/public/data/ports.json', 'utf8'));

const antarcticPorts = ports.filter(p => p.latitude < -50.0);
console.log(`Found ${antarcticPorts.length} ports south of 50°S:`);
for (const p of antarcticPorts.slice(0, 20)) {
  console.log(`- WPI ${p.wpiNumber}: ${p.portName} (${p.countryCode || p.regionName}), Lat: ${p.latitude}, Lon: ${p.longitude}`);
}
