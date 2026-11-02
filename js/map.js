// County choropleth. us-atlas counties-albers-10m is already projected (pixel coordinates), so no projection library.
import { feature, merge } from 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm';

const TOPOLOGY_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-albers-10m.json';

export const loadTopology = () => fetch(TOPOLOGY_URL).then((r) => {
  if (!r.ok) throw new Error(`County boundaries: HTTP ${r.status}`);
  return r.json();
});

const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flat();
const pathData = (g) => rings(g).map((ring) => 'M' + ring.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z').join('');

function bbox(g) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings(g)) for (const [x, y] of ring) {
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
  }
  return b;
}

// Geometry for one catchment: counties as paths, the merged outline, and the viewBox.
// Returns { counties: [{fips, d}], context: [d...], outline, viewBox, missing: [fips not in the atlas] }.
export function catchmentGeometry(topology, fipsList) {
  const wanted = new Set(fipsList);
  const all = feature(topology, topology.objects.counties).features;
  const inside = all.filter((f) => wanted.has(f.id));
  const boxes = inside.map((f) => bbox(f.geometry));
  const box = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  const pad = Math.max(box[2] - box[0], box[3] - box[1]) * 0.06;
  const view = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
  const nearby = all.filter((f) => {
    if (wanted.has(f.id)) return false;
    const b = bbox(f.geometry);
    return b[0] < view[2] && b[2] > view[0] && b[1] < view[3] && b[3] > view[1];
  });
  const geoms = topology.objects.counties.geometries.filter((g) => wanted.has(g.id));
  return {
    counties: inside.map((f) => ({ fips: f.id, d: pathData(f.geometry) })),
    context: nearby.map((f) => pathData(f.geometry)),
    outline: pathData(merge(topology, geoms)),
    viewBox: `${view[0].toFixed(1)} ${view[1].toFixed(1)} ${(view[2] - view[0]).toFixed(1)} ${(view[3] - view[1]).toFixed(1)}`,
    missing: fipsList.filter((id) => !inside.some((f) => f.id === id)),
  };
}
