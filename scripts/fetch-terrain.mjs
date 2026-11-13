import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const campuses = [
  { id: 'clear-water-bay', bbox: [22.3317, 114.2615, 22.3405, 114.27], clampSeaLevel: true },
  { id: 'edinburgh', bbox: [55.9408, -3.1932, 55.9473, -3.1823], clampSeaLevel: false, attribution: 'Produced using Copernicus data and information funded by the European Union - EU-DEM layers' },
  { id: 'cug-wuhan', bbox: [30.5165, 114.3893, 30.5341, 114.4044], clampSeaLevel: false },
];
const zoom = 15;
const tileSize = 256;
const gridSpacing = 5;
const earthRadius = 6378137;
const force = process.argv.includes('--force');
const offline = process.argv.includes('--offline');
assert(!(force && offline), '--force and --offline cannot be used together');

const source = 'Mapzen/Tilezen Terrain Tiles (AWS Open Data)';
const sourceUrl = 'https://registry.opendata.aws/terrain-tiles/';
const tileUrl = (x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`;
const tileDir = path.join(root, 'data', 'terrain', 'tiles');
const tilePath = (x, y) => path.join(tileDir, String(zoom), String(x), `${y}.png`);
const outputPath = (id) => path.join(root, 'data', 'terrain', `${id}.terrain.json`);
const rad = (degrees) => degrees * Math.PI / 180;
const deg = (radians) => radians * 180 / Math.PI;
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tileCoordinates(bbox) {
  const [south, west, north, east] = bbox;
  const scale = 2 ** zoom;
  const x = (lon) => Math.floor((lon + 180) / 360 * scale);
  const y = (lat) => Math.floor((1 - Math.asinh(Math.tan(rad(lat))) / Math.PI) / 2 * scale);
  const tiles = [];
  for (let ty = y(north); ty <= y(south); ty += 1) {
    for (let tx = x(west); tx <= x(east); tx += 1) tiles.push({ x: tx, y: ty });
  }
  return tiles;
}

function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  assert.equal(png.width, tileSize, 'Terrain tile width must be 256 pixels');
  assert.equal(png.height, tileSize, 'Terrain tile height must be 256 pixels');
  return png;
}

async function readTile(x, y) {
  return decodePng(await readFile(tilePath(x, y)));
}

async function downloadTile(tile) {
  const output = tilePath(tile.x, tile.y);
  if (!force) {
    try {
      await readTile(tile.x, tile.y);
      console.log(`Using cached terrain tile ${zoom}/${tile.x}/${tile.y}`);
      return false;
    } catch {
      if (offline) throw new Error(`Missing or invalid cached terrain tile ${path.relative(root, output)}`);
    }
  }
  assert(!offline, `Offline mode requires cached terrain tile ${path.relative(root, output)}`);

  const url = tileUrl(tile.x, tile.y);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'image/png', 'User-Agent': 'MyCampus-Terrain-Pipeline/1.0' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Terrain tile returned ${response.status} ${response.statusText}`);
      const body = Buffer.from(await response.arrayBuffer());
      decodePng(body);
      await mkdir(path.dirname(output), { recursive: true });
      const temporaryPath = `${output}.${process.pid}.tmp`;
      await writeFile(temporaryPath, body);
      await rename(temporaryPath, output);
      console.log(`Downloaded terrain tile ${zoom}/${tile.x}/${tile.y}`);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(2 ** attempt * 1000);
    }
  }
  throw new Error(`Failed to download ${url}: ${lastError.message}`);
}

function cleanElevations(png, clampSeaLevel) {
  const values = new Float64Array(tileSize * tileSize);
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 4;
    const elevation = png.data[offset] * 256 + png.data[offset + 1] + png.data[offset + 2] / 256 - 32768;
    values[index] = elevation < -100 ? Number.NaN : clampSeaLevel ? Math.max(0, elevation) : elevation;
  }
  let missing = values.filter(Number.isNaN).length;
  while (missing > 0) {
    const next = new Float64Array(values);
    for (let y = 0; y < tileSize; y += 1) {
      for (let x = 0; x < tileSize; x += 1) {
        const index = y * tileSize + x;
        if (!Number.isNaN(values[index])) continue;
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= tileSize || ny < 0 || ny >= tileSize) continue;
            const value = values[ny * tileSize + nx];
            if (Number.isFinite(value)) {
              sum += value;
              count += 1;
            }
          }
        }
        if (count > 0) next[index] = sum / count;
      }
    }
    values.set(next);
    const remaining = values.filter(Number.isNaN).length;
    assert(remaining < missing, 'Unable to fill invalid terrain pixels');
    missing = remaining;
  }
  return values;
}

function sampleTiles(tiles, lon, lat) {
  const scale = 2 ** zoom * tileSize;
  const globalX = (lon + 180) / 360 * scale;
  const globalY = (1 - Math.asinh(Math.tan(rad(lat))) / Math.PI) / 2 * scale;
  const tx = Math.floor(globalX / tileSize);
  const ty = Math.floor(globalY / tileSize);
  const png = tiles.get(`${tx}/${ty}`);
  assert(png, `No terrain tile covers ${lon},${lat}`);
  const localX = globalX - tx * tileSize;
  const localY = globalY - ty * tileSize;
  const x0 = Math.floor(localX);
  const y0 = Math.floor(localY);
  const x1 = Math.min(x0 + 1, tileSize - 1);
  const y1 = Math.min(y0 + 1, tileSize - 1);
  const fx = localX - x0;
  const fy = localY - y0;
  const at = (x, y) => png[y * tileSize + x];
  const north = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const south = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return north * (1 - fy) + south * fy;
}

function runtimeBounds(bbox) {
  const [south, west, north, east] = bbox;
  const origin = { lon: (west + east) / 2, lat: (south + north) / 2 };
  const project = ([lon, lat]) => [
    round(rad(lon - origin.lon) * Math.cos(rad(origin.lat)) * earthRadius),
    round(-rad(lat - origin.lat) * earthRadius),
  ];
  const corners = [[west, south], [west, north], [east, south], [east, north]].map(project);
  return {
    origin,
    minX: Math.min(...corners.map((point) => point[0])),
    maxX: Math.max(...corners.map((point) => point[0])),
    minZ: Math.min(...corners.map((point) => point[1])),
    maxZ: Math.max(...corners.map((point) => point[1])),
  };
}

async function buildTerrain(campus) {
  const coordinates = tileCoordinates(campus.bbox);
  const downloads = await Promise.all(coordinates.map(downloadTile));
  let fetchedAt = new Date().toISOString();
  if (!downloads.some(Boolean)) {
    try {
      const previous = JSON.parse(await readFile(outputPath(campus.id), 'utf8'));
      if (Array.isArray(previous.tileUrls) && previous.fetchedAt) fetchedAt = previous.fetchedAt;
    } catch {
    }
  }
  const decodedTiles = new Map(await Promise.all(coordinates.map(async (tile) => [
    `${tile.x}/${tile.y}`,
    cleanElevations(await readTile(tile.x, tile.y), campus.clampSeaLevel),
  ])));
  const { origin, ...bounds } = runtimeBounds(campus.bbox);
  const columns = Math.round((bounds.maxX - bounds.minX) / gridSpacing) + 1;
  const rows = Math.round((bounds.maxZ - bounds.minZ) / gridSpacing) + 1;
  const heights = [];
  for (let row = 0; row < rows; row += 1) {
    const z = bounds.minZ + (bounds.maxZ - bounds.minZ) * row / (rows - 1);
    const lat = origin.lat - deg(z / earthRadius);
    for (let column = 0; column < columns; column += 1) {
      const x = bounds.minX + (bounds.maxX - bounds.minX) * column / (columns - 1);
      const lon = origin.lon + deg(x / (earthRadius * Math.cos(rad(origin.lat))));
      heights.push(round(sampleTiles(decodedTiles, lon, lat), 1));
    }
  }
  const terrain = {
    source,
    sourceUrl,
    attribution: campus.attribution ?? 'SRTM data courtesy of the U.S. Geological Survey',
    zoom,
    tileUrls: coordinates.map((tile) => tileUrl(tile.x, tile.y)),
    fetchedAt,
    rows,
    columns,
    ...bounds,
    minElevation: Math.min(...heights),
    maxElevation: Math.max(...heights),
    heights,
  };
  assert.equal(terrain.heights.length, rows * columns);
  assert(terrain.heights.every(Number.isFinite));
  assert(terrain.minElevation >= -500 && terrain.maxElevation <= 5000, `Unexpected ${campus.id} elevation range`);
  await mkdir(path.dirname(outputPath(campus.id)), { recursive: true });
  await writeFile(outputPath(campus.id), `${JSON.stringify(terrain)}\n`);
  console.log(`${campus.id} terrain: ${rows} rows x ${columns} columns, ${terrain.minElevation} to ${terrain.maxElevation} m`);
}

for (const campus of campuses) await buildTerrain(campus);
