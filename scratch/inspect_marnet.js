
const fs = require("fs");
const { DEFAULT_MARNET: marnet20 } = require("searoute-ts/marnet-20km");
const { DEFAULT_MARNET: marnet100 } = require("searoute-ts");

console.log("20km MARNET features count:", marnet20.features.length);
console.log("100km MARNET features count:", marnet100.features.length);

// Extract unique vertices and edges for 20km
const edges = [];
for (const feat of marnet20.features) {
  const coords = feat.geometry.coordinates;
  for (let i = 0; i < coords.length - 1; i++) {
    edges.push([coords[i], coords[i+1], feat.properties]);
  }
}
fs.writeFileSync("scratch/marnet20_edges.json", JSON.stringify(edges));
console.log("Total edge segments in 20km MARNET:", edges.length);
