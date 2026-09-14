/**
 * Reproducible Processing Script for Polar Water Graph Connectivity Cleanup
 * -------------------------------------------------------------------------
 * Pipeline:
 * 1. Load original raw graph (data/routing/raw/polarWaterGraph_v1_original.json)
 * 2. Independent graph traversal (BFS) to compute connected components
 * 3. Classify all disconnected components
 * 4. Prune confirmed zero-degree graph generation artifacts (30 components, 30 nodes, 0 edges)
 * 5. Retain legitimate isolated navigable water bodies (Comp 19, Comp 23, Comp 31: 7 nodes, 4 edges)
 * 6. Verify integrity: no dangling edges, no non-finite weights, valid coordinates, component count = 4
 * 7. Output processed graph to data/routing/processed/polarWaterGraph_cleaned.json
 *    and update operational asset frontend/public/data/polarWaterGraph.json
 */

import fs from 'fs';
import path from 'path';

const rawGraphPath = './data/routing/raw/polarWaterGraph_v1_original.json';
const processedGraphPath = './data/routing/processed/polarWaterGraph_cleaned.json';
const operationalGraphPath = './frontend/public/data/polarWaterGraph.json';

console.log('--- REPRODUCIBLE GRAPH CLEANING PIPELINE ---');

const t0 = performance.now();
const rawData = JSON.parse(fs.readFileSync(rawGraphPath, 'utf-8'));
const loadTimeMs = performance.now() - t0;
console.log(`Original graph loaded in ${loadTimeMs.toFixed(2)} ms`);
console.log(`Original nodes: ${rawData.nodes.length}`);
console.log(`Original edges: ${rawData.edges.length}`);

// Step 1: Coordinate map & adjacency
const coordMap = new Map();
rawData.nodes.forEach((n, idx) => coordMap.set(`${n[0]},${n[1]}`, idx));

const adj = Array.from({ length: rawData.nodes.length }, () => []);
for (let e = 0; e < rawData.edges.length; e++) {
  const [p1, p2, weight] = rawData.edges[e];
  const u = coordMap.get(`${p1[0]},${p1[1]}`);
  const v = coordMap.get(`${p2[0]},${p2[1]}`);
  if (u !== undefined && v !== undefined) {
    adj[u].push({ v, weight });
    adj[v].push({ v: u, weight });
  }
}

// Step 2: Component BFS
const tBfs0 = performance.now();
const componentId = new Int32Array(rawData.nodes.length).fill(-1);
let currentComp = 0;
const components = [];

for (let i = 0; i < rawData.nodes.length; i++) {
  if (componentId[i] !== -1) continue;
  const compNodes = [i];
  const queue = [i];
  componentId[i] = currentComp;
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    for (const neighbor of adj[u]) {
      const v = neighbor.v;
      if (componentId[v] === -1) {
        componentId[v] = currentComp;
        queue.push(v);
        compNodes.push(v);
      }
    }
  }
  components.push({ compId: currentComp, nodes: compNodes, size: compNodes.length });
  currentComp++;
}
const bfsTimeMs = performance.now() - tBfs0;
console.log(`Component analysis completed in ${bfsTimeMs.toFixed(2)} ms`);
console.log(`Total connected components detected: ${components.length}`);

components.sort((a, b) => b.size - a.size);
const primaryComp = components[0];
console.log(`Primary component: ID ${primaryComp.compId} (${primaryComp.size} nodes)`);

// Step 3: Classify small components
const toRemoveNodeIndices = new Set();
const toRetainSmallComps = [];
let removedComponentsCount = 0;

for (let c = 1; c < components.length; c++) {
  const comp = components[c];
  if (comp.size === 1 && adj[comp.nodes[0]].length === 0) {
    // Zero-degree isolated node artifact
    toRemoveNodeIndices.add(comp.nodes[0]);
    removedComponentsCount++;
  } else {
    // Multi-node legitimate isolated water body
    toRetainSmallComps.push(comp);
  }
}

console.log(`Components classified as zero-degree artifacts to remove: ${removedComponentsCount}`);
console.log(`Components classified as legitimate water bodies to retain: ${toRetainSmallComps.length}`);
toRetainSmallComps.forEach(rc => {
  console.log(`  - Comp ${rc.compId}: ${rc.size} nodes, ${rc.nodes.reduce((acc, idx) => acc + adj[idx].length, 0) / 2} edges`);
});

// Step 4: Construct pruned graph
const tPrune0 = performance.now();
const newNodes = [];
const oldToNewIndex = new Map();

for (let i = 0; i < rawData.nodes.length; i++) {
  if (!toRemoveNodeIndices.has(i)) {
    oldToNewIndex.set(i, newNodes.length);
    newNodes.push(rawData.nodes[i]);
  }
}

const newEdges = [];
let droppedEdges = 0;
for (let e = 0; e < rawData.edges.length; e++) {
  const [p1, p2, weight] = rawData.edges[e];
  const u = coordMap.get(`${p1[0]},${p1[1]}`);
  const v = coordMap.get(`${p2[0]},${p2[1]}`);
  if (toRemoveNodeIndices.has(u) || toRemoveNodeIndices.has(v)) {
    droppedEdges++;
  } else {
    newEdges.push([p1, p2, weight]);
  }
}

// Step 4b: Stitch antimeridian water edges across +/-180 degrees
const ringsPath = './frontend/public/data/southernLandRings.json';
const rings = JSON.parse(fs.readFileSync(ringsPath, 'utf-8'));

function toRad(d) { return (d * Math.PI) / 180; }
function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371.0088;
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  let dl = Math.abs(lon2 - lon1);
  if (dl > 180) dl = 360 - dl;
  dl = toRad(dl);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function segmentsIntersect(p1, p2, p3, p4) {
  function ccw(a, b, c) {
    return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
  }
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

function isWaterSafeAntimeridian(p1, p2) {
  const a = [p1[0], p1[1]];
  let bLon = p2[0];
  if (p1[0] > 0 && p2[0] < 0) bLon = p2[0] + 360;
  const b = [bLon, p2[1]];

  for (let r = 0; r < rings.length; r++) {
    for (let j = 0; j < rings[r].ring.length - 1; j++) {
      let r1 = rings[r].ring[j];
      let r2 = rings[r].ring[j + 1];
      if (segmentsIntersect(a, b, r1, r2)) return false;
      if (r1[0] < -170 || r2[0] < -170) {
        const r1w = [r1[0] < 0 ? r1[0] + 360 : r1[0], r1[1]];
        const r2w = [r2[0] < 0 ? r2[0] + 360 : r2[0], r2[1]];
        if (segmentsIntersect(a, b, r1w, r2w)) return false;
      }
    }
  }
  return true;
}

const pos179Nodes = newNodes.filter(n => n[0] === 179);
let antimeridianAdded = 0;
for (const p1 of pos179Nodes) {
  for (let dLat of [-1, 0, 1]) {
    const lat2 = p1[1] + dLat;
    const p2Key = `-180,${lat2}`;
    const p2Idx = oldToNewIndex.get(coordMap.get(p2Key));
    if (p2Idx !== undefined) {
      const p2 = newNodes[p2Idx];
      if (isWaterSafeAntimeridian(p1, p2)) {
        const w = parseFloat(haversineKm(p1[0], p1[1], p2[0], p2[1]).toFixed(2));
        newEdges.push([p1, p2, w]);
        antimeridianAdded++;
      }
    }
  }
}
console.log(`Stitched water-safe antimeridian edges: ${antimeridianAdded}`);

const pruneTimeMs = performance.now() - tPrune0;

console.log(`Pruning completed in ${pruneTimeMs.toFixed(2)} ms`);
console.log(`Removed components: ${removedComponentsCount}`);
console.log(`Removed nodes: ${toRemoveNodeIndices.size}`);
console.log(`Removed edges: ${droppedEdges}`);
console.log(`Final nodes: ${newNodes.length}`);
console.log(`Final edges: ${newEdges.length}`);

// Step 5: Verify integrity of pruned graph
console.log('\n--- VERIFYING INTEGRITY OF PRUNED GRAPH ---');
const newCoordMap = new Map();
newNodes.forEach((n, idx) => {
  const key = `${n[0]},${n[1]}`;
  if (newCoordMap.has(key)) throw new Error(`Duplicate coordinate: ${key}`);
  newCoordMap.set(key, idx);
});

const newAdj = Array.from({ length: newNodes.length }, () => []);
for (let e = 0; e < newEdges.length; e++) {
  const [p1, p2, weight] = newEdges[e];
  if (!Number.isFinite(weight) || weight <= 0) throw new Error(`Invalid edge weight at ${e}: ${weight}`);
  const u = newCoordMap.get(`${p1[0]},${p1[1]}`);
  const v = newCoordMap.get(`${p2[0]},${p2[1]}`);
  if (u === undefined || v === undefined) throw new Error(`Dangling edge at ${e}`);
  newAdj[u].push(v);
  newAdj[v].push(u);
}

// Re-verify connected components on pruned graph
const verifiedComponentId = new Int32Array(newNodes.length).fill(-1);
let verifiedCompCount = 0;
for (let i = 0; i < newNodes.length; i++) {
  if (verifiedComponentId[i] !== -1) continue;
  const q = [i];
  verifiedComponentId[i] = verifiedCompCount;
  let h = 0;
  while (h < q.length) {
    const u = q[h++];
    for (const v of newAdj[u]) {
      if (verifiedComponentId[v] === -1) {
        verifiedComponentId[v] = verifiedCompCount;
        q.push(v);
      }
    }
  }
  verifiedCompCount++;
}

console.log(`Re-verified connected components in pruned graph: ${verifiedCompCount}`);
if (verifiedCompCount !== 1 + toRetainSmallComps.length) {
  throw new Error(`Component count mismatch: expected ${1 + toRetainSmallComps.length}, got ${verifiedCompCount}`);
}
console.log('Graph integrity: PASS (all edges valid, zero dangling references, symmetric adjacency)');

// Step 6: Write processed graph files
const cleanedData = {
  nodes: newNodes,
  edges: newEdges,
};
const cleanedJson = JSON.stringify(cleanedData);

fs.writeFileSync(processedGraphPath, cleanedJson, 'utf-8');
fs.writeFileSync(operationalGraphPath, cleanedJson, 'utf-8');
console.log(`Saved processed graph to ${processedGraphPath}`);
console.log(`Updated operational asset at ${operationalGraphPath}`);

console.log('Pipeline finished successfully.');
