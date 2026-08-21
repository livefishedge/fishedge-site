/* FishEdge data worker: keep network JSON parsing and bathymetry contour
 * preparation off the dashboard's main thread. */
'use strict';

const bathyGrids = new Map();

function post(id, ok, result, error) {
  self.postMessage({ id, ok, result, error });
}

function contourSegments(grid, level, sx, sy, extent) {
  const [vx0, vy0, vx1, vy1] = extent;
  const segments = [];
  const { xAxis, yAxis, depth } = grid;
  for (let row = 1; row < yAxis.length - 1; row += sx ? sy : 1) {
    const lat = yAxis[row];
    if (lat < vy0 || lat > vy1) continue;
    const nextLat = yAxis[Math.min(row + sy, yAxis.length - 1)];
    for (let col = 1; col < xAxis.length - 1; col += sx) {
      const lon = xAxis[col];
      if (lon < vx0 || lon > vx1) continue;
      const nr = Math.min(row + sy, yAxis.length - 1);
      const nc = Math.min(col + sx, xAxis.length - 1);
      const tl = depth[row]?.[col], tr = depth[row]?.[nc];
      const br = depth[nr]?.[nc], bl = depth[nr]?.[col];
      if (![tl, tr, br, bl].every(Number.isFinite)) continue;
      const crossings = [];
      if ((tl < level) !== (tr < level)) {
        const t = (level - tl) / (tr - tl);
        crossings.push([lon + t * (xAxis[nc] - lon), lat]);
      }
      if ((bl < level) !== (br < level)) {
        const t = (level - bl) / (br - bl);
        crossings.push([lon + t * (xAxis[nc] - lon), nextLat]);
      }
      if ((tl < level) !== (bl < level)) {
        const t = (level - tl) / (bl - tl);
        crossings.push([lon, lat + t * (nextLat - lat)]);
      }
      if ((tr < level) !== (br < level)) {
        const t = (level - tr) / (br - tr);
        crossings.push([xAxis[nc], lat + t * (nextLat - lat)]);
      }
      if (crossings.length >= 2) {
        const pair = crossings.slice(0, 2);
        const d0 = Math.hypot(pair[0][0] - vx0, pair[0][1] - vy0);
        const d1 = Math.hypot(pair[1][0] - vx0, pair[1][1] - vy0);
        if (d0 > 0.01 && d1 > 0.01 && Math.hypot(pair[0][0] - pair[1][0], pair[0][1] - pair[1][1]) > 0.01) {
          segments.push(pair);
        }
      }
    }
  }
  return segments;
}

self.onmessage = async event => {
  const { id, type } = event.data || {};
  try {
    if (type === 'fetch-json') {
      const response = await fetch(event.data.url, { cache: event.data.cache || 'default' });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${event.data.url}`);
      post(id, true, JSON.parse(await response.text()));
      return;
    }
    if (type === 'init-bathy') {
      bathyGrids.set(event.data.key, {
        xAxis: event.data.xAxis,
        yAxis: event.data.yAxis,
        depth: event.data.depth,
      });
      post(id, true, true);
      return;
    }
    if (type === 'contours') {
      const grid = bathyGrids.get(event.data.key);
      if (!grid) throw new Error('Bathymetry grid is not initialized');
      const segments = [];
      for (const level of event.data.levels || []) {
        for (const segment of contourSegments(grid, level, event.data.sx, event.data.sy, event.data.extent)) {
          segments.push({ level, segment });
        }
      }
      post(id, true, segments);
      return;
    }
    throw new Error(`Unknown worker operation: ${type}`);
  } catch (error) {
    post(id, false, null, error?.message || String(error));
  }
};
