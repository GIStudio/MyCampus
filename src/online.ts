import osmtogeojson from 'osmtogeojson';
import type {
  AreaData,
  BuildingData,
  CampusData,
  CampusDefinition,
  Point,
  PolygonData,
  RoadData,
  TerrainData,
  TreeData,
} from './types';

type BBox = [number, number, number, number];
type Tags = Record<string, string>;
interface OsmFeature {
  id: string;
  properties?: Tags & { tags?: Tags };
  geometry?: { type: string; coordinates: any };
}
interface TerrainTile { x: number; y: number; heights: Float64Array; source: string }

const EARTH_RADIUS = 6378137;
const TILE_SIZE = 256;
const TERRAIN_ZOOM = 15;
const rad = (degrees: number) => degrees * Math.PI / 180;
const deg = (radians: number) => radians * 180 / Math.PI;
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const featureTags = (feature: OsmFeature): Tags => feature.properties?.tags ?? feature.properties ?? {};

function projector(bbox: BBox) {
  const [south, west, north, east] = bbox;
  const origin = { lon: (west + east) / 2, lat: (south + north) / 2 };
  const project = ([lon, lat]: Point): Point => [
    round(rad(lon - origin.lon) * Math.cos(rad(origin.lat)) * EARTH_RADIUS),
    round(-rad(lat - origin.lat) * EARTH_RADIUS),
  ];
  const corners: Point[] = [[west, south], [west, north], [east, south], [east, north]];
  const projected = corners.map(project);
  return {
    origin,
    project,
    bounds: {
      minX: Math.min(...projected.map((point) => point[0])),
      maxX: Math.max(...projected.map((point) => point[0])),
      minZ: Math.min(...projected.map((point) => point[1])),
      maxZ: Math.max(...projected.map((point) => point[1])),
    },
  };
}

function cleanRing(ring: Point[], project: (point: Point) => Point): Point[] {
  const points: Point[] = [];
  for (const coordinate of ring) {
    const point = project(coordinate);
    const previous = points.at(-1);
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) points.push(point);
  }
  if (points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]) points.pop();
  return points.length >= 3 ? points : [];
}

function polygons(feature: OsmFeature, project: (point: Point) => Point): PolygonData[] {
  const geometry = feature.geometry;
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return [];
  const source = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const result: PolygonData[] = [];
  for (const polygon of source) {
    const outer = cleanRing(polygon[0], project);
    if (outer.length < 3) continue;
    result.push({
      outer,
      holes: polygon.slice(1).map((ring: Point[]) => cleanRing(ring, project)).filter((ring: Point[]) => ring.length >= 3),
    });
  }
  return result;
}

function lines(feature: OsmFeature, project: (point: Point) => Point): Point[][] {
  const geometry = feature.geometry;
  if (!geometry || !['LineString', 'MultiLineString'].includes(geometry.type)) return [];
  const source = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  return source.map((line: Point[]) => {
    const points: Point[] = [];
    for (const coordinate of line) {
      const point = project(coordinate);
      const previous = points.at(-1);
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) points.push(point);
    }
    return points;
  }).filter((line: Point[]) => line.length >= 2);
}

function pointInRing(point: Point, ring: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x, z] = point;
    const [xi, zi] = ring[index];
    const [xj, zj] = ring[previous];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: Point, polygon: PolygonData): boolean {
  return pointInRing(point, polygon.outer) && !polygon.holes.some((hole) => pointInRing(point, hole));
}

function ringArea(ring: Point[]): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    area += ring[index][0] * ring[next][1] - ring[next][0] * ring[index][1];
  }
  return Math.abs(area) / 2;
}

function centroid(ring: Point[]): Point {
  let area = 0;
  let x = 0;
  let z = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    const cross = ring[index][0] * ring[next][1] - ring[next][0] * ring[index][1];
    area += cross;
    x += (ring[index][0] + ring[next][0]) * cross;
    z += (ring[index][1] + ring[next][1]) * cross;
  }
  const result: Point = Math.abs(area) < 0.001 ? ring[0] : [x / (3 * area), z / (3 * area)];
  return pointInRing(result, ring) ? result : ring[0];
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared));
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dz);
}

function distanceToRing(point: Point, ring: Point[]): number {
  let distance = Infinity;
  for (let index = 0; index < ring.length; index += 1) {
    distance = Math.min(distance, distanceToSegment(point, ring[index], ring[(index + 1) % ring.length]));
  }
  return distance;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function buildingHeight(tags: Tags): { height: number; heightSource: string } {
  const height = parseNumber(tags.height);
  if (height !== null && height > 0) return { height: round(Math.max(2, /ft|feet/i.test(tags.height) ? height * 0.3048 : height)), heightSource: 'osm' };
  const levels = parseNumber(tags['building:levels']);
  if (levels !== null && levels > 0) return { height: round(Math.max(2, levels * 3)), heightSource: 'levels' };
  const defaults: Record<string, number> = { apartments: 12, residential: 9, university: 12, roof: 3, school: 9, yes: 9 };
  return { height: defaults[tags.building] ?? 9, heightSource: 'estimated' };
}

function roadWidth(tags: Tags): number {
  return parseNumber(tags.width) ?? ({ footway: 2, path: 1.5, pedestrian: 4, service: 4, residential: 5, tertiary: 5.5, secondary: 6, motorway: 7, steps: 1.5, cycleway: 2.5 } as Record<string, number>)[tags.highway] ?? 4;
}

function areaKind(tags: Tags): AreaData['kind'] | null {
  if (tags.natural === 'water' || tags.water || ['basin', 'reservoir'].includes(tags.landuse)) return 'water';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'wood';
  if (['grass', 'greenfield', 'meadow', 'village_green'].includes(tags.landuse) || ['garden', 'park', 'pitch', 'playground'].includes(tags.leisure) || ['grass', 'scrub', 'heath'].includes(tags.natural)) return 'grass';
  if ((tags.highway === 'pedestrian' && tags.area === 'yes') || tags.place === 'square') return 'pedestrian';
  return null;
}

function tileCoordinates(bbox: BBox): { x: number; y: number }[] {
  const [south, west, north, east] = bbox;
  const scale = 2 ** TERRAIN_ZOOM;
  const tx = (lon: number) => Math.floor((lon + 180) / 360 * scale);
  const ty = (lat: number) => Math.floor((1 - Math.asinh(Math.tan(rad(lat))) / Math.PI) / 2 * scale);
  const tiles = [];
  for (let y = ty(north); y <= ty(south); y += 1) for (let x = tx(west); x <= tx(east); x += 1) tiles.push({ x, y });
  if (tiles.length > 16) throw new Error('覆盖范围需要过多地形瓦片，请缩小半径');
  return tiles;
}

function cleanTile(pixels: Uint8ClampedArray): Float64Array {
  const values = new Float64Array(TILE_SIZE * TILE_SIZE);
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 4;
    const elevation = pixels[offset] * 256 + pixels[offset + 1] + pixels[offset + 2] / 256 - 32768;
    values[index] = elevation < -100 ? Number.NaN : elevation;
  }
  let missing = values.filter(Number.isNaN).length;
  while (missing > 0) {
    const next = new Float64Array(values);
    for (let y = 0; y < TILE_SIZE; y += 1) {
      for (let x = 0; x < TILE_SIZE; x += 1) {
        const index = y * TILE_SIZE + x;
        if (!Number.isNaN(values[index])) continue;
        const neighbors = [];
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < TILE_SIZE && ny >= 0 && ny < TILE_SIZE) {
            const value = values[ny * TILE_SIZE + nx];
            if (Number.isFinite(value)) neighbors.push(value);
          }
        }
        if (neighbors.length) next[index] = neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length;
      }
    }
    values.set(next);
    const remaining = values.filter(Number.isNaN).length;
    if (remaining >= missing) throw new Error('地形瓦片存在无法修复的空洞');
    missing = remaining;
  }
  return values;
}

async function fetchTerrainTile(x: number, y: number, signal: AbortSignal): Promise<TerrainTile> {
  const response = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TERRAIN_ZOOM}/${x}/${y}.png`, { signal });
  if (!response.ok) throw new Error(`地形瓦片请求失败：HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法初始化地形解码器');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    x,
    y,
    heights: cleanTile(context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data),
    source: response.headers.get('x-amz-meta-x-imagery-sources') ?? '',
  };
}

function sampleTiles(tiles: Map<string, Float64Array>, lon: number, lat: number): number {
  const scale = 2 ** TERRAIN_ZOOM * TILE_SIZE;
  const globalX = (lon + 180) / 360 * scale;
  const globalY = (1 - Math.asinh(Math.tan(rad(lat))) / Math.PI) / 2 * scale;
  const tx = Math.floor(globalX / TILE_SIZE);
  const ty = Math.floor(globalY / TILE_SIZE);
  const heights = tiles.get(`${tx}/${ty}`);
  if (!heights) throw new Error('地形瓦片未覆盖学校范围');
  const localX = globalX - tx * TILE_SIZE;
  const localY = globalY - ty * TILE_SIZE;
  const x0 = Math.floor(localX);
  const y0 = Math.floor(localY);
  const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
  const y1 = Math.min(y0 + 1, TILE_SIZE - 1);
  const fx = localX - x0;
  const fy = localY - y0;
  const at = (x: number, y: number) => heights[y * TILE_SIZE + x];
  const north = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const south = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return north * (1 - fy) + south * fy;
}

async function fetchTerrain(bbox: BBox, origin: { lon: number; lat: number }, bounds: CampusData['bounds'], signal: AbortSignal): Promise<TerrainData> {
  const coordinates = tileCoordinates(bbox);
  const tiles = new Map<string, Float64Array>();
  const sources = new Set<string>();
  let completed = 0;
  for (const coordinate of coordinates) {
    const tile = await fetchTerrainTile(coordinate.x, coordinate.y, signal);
    tiles.set(`${tile.x}/${tile.y}`, tile.heights);
    if (tile.source) sources.add(tile.source);
    completed += 1;
  }
  if (completed === 0) throw new Error('没有可用的地形数据');
  const columns = Math.round((bounds.maxX - bounds.minX) / 8) + 1;
  const rows = Math.round((bounds.maxZ - bounds.minZ) / 8) + 1;
  const heights = [];
  for (let row = 0; row < rows; row += 1) {
    const z = bounds.minZ + (bounds.maxZ - bounds.minZ) * row / (rows - 1);
    const lat = origin.lat - deg(z / EARTH_RADIUS);
    for (let column = 0; column < columns; column += 1) {
      const x = bounds.minX + (bounds.maxX - bounds.minX) * column / (columns - 1);
      const lon = origin.lon + deg(x / (EARTH_RADIUS * Math.cos(rad(origin.lat))));
      heights.push(round(sampleTiles(tiles, lon, lat), 1));
    }
  }
  return {
    source: 'Mapzen/Tilezen Terrain Tiles (AWS Open Data)',
    sourceUrl: 'https://registry.opendata.aws/terrain-tiles/',
    attribution: [...sources].some((item) => item.includes('eudem/'))
      ? 'Produced using Copernicus data and information funded by the European Union - EU-DEM layers'
      : 'SRTM data courtesy of the U.S. Geological Survey',
    zoom: TERRAIN_ZOOM,
    tileUrls: coordinates.map((tile) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TERRAIN_ZOOM}/${tile.x}/${tile.y}.png`),
    fetchedAt: new Date().toISOString(),
    rows,
    columns,
    ...bounds,
    minElevation: Math.min(...heights),
    maxElevation: Math.max(...heights),
    heights,
  };
}

function sampleTerrain(terrain: TerrainData, [x, z]: Point): number {
  const column = Math.max(0, Math.min(terrain.columns - 1, (x - terrain.minX) / (terrain.maxX - terrain.minX) * (terrain.columns - 1)));
  const row = Math.max(0, Math.min(terrain.rows - 1, (z - terrain.minZ) / (terrain.maxZ - terrain.minZ) * (terrain.rows - 1)));
  const x0 = Math.floor(column);
  const y0 = Math.floor(row);
  const x1 = Math.min(x0 + 1, terrain.columns - 1);
  const y1 = Math.min(y0 + 1, terrain.rows - 1);
  const fx = column - x0;
  const fy = row - y0;
  const at = (x: number, y: number) => terrain.heights[y * terrain.columns + x];
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function flattenBuildingPads(terrain: TerrainData, buildings: BuildingData[]): void {
  const bufferMetres = 8;
  const pads = buildings.flatMap((building) => building.polygons.map((polygon, index) => {
    const samples = [sampleTerrain(terrain, centroid(polygon.outer))];
    for (const point of polygon.outer) samples.push(sampleTerrain(terrain, point));
    for (let row = 0; row < terrain.rows; row += 1) {
      const z = terrain.minZ + (terrain.maxZ - terrain.minZ) * row / (terrain.rows - 1);
      for (let column = 0; column < terrain.columns; column += 1) {
        const x = terrain.minX + (terrain.maxX - terrain.minX) * column / (terrain.columns - 1);
        if (pointInRing([x, z], polygon.outer)) samples.push(terrain.heights[row * terrain.columns + column]);
      }
    }
    const baseElevation = round(median(samples), 1);
    polygon.baseElevation = baseElevation;
    const xs = polygon.outer.map((point) => point[0]);
    const zs = polygon.outer.map((point) => point[1]);
    return {
      id: `${building.id}:${index}`,
      polygon,
      outer: polygon.outer,
      baseElevation,
      minX: Math.min(...xs) - bufferMetres,
      maxX: Math.max(...xs) + bufferMetres,
      minZ: Math.min(...zs) - bufferMetres,
      maxZ: Math.max(...zs) + bufferMetres,
    };
  })).sort((a, b) => a.id.localeCompare(b.id));
  for (const a of pads) for (const b of pads) {
    if (a.id >= b.id) continue;
    const overlap = a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ &&
      (pointInRing(a.outer[0], b.outer) || pointInRing(b.outer[0], a.outer) || distanceToRing(a.outer[0], b.outer) === 0);
    if (overlap) {
      const base = round(median([a.baseElevation, b.baseElevation]), 1);
      a.baseElevation = base;
      b.baseElevation = base;
      a.polygon.baseElevation = base;
      b.polygon.baseElevation = base;
    }
  }
  const source = [...terrain.heights];
  for (let row = 0; row < terrain.rows; row += 1) {
    const z = terrain.minZ + (terrain.maxZ - terrain.minZ) * row / (terrain.rows - 1);
    for (let column = 0; column < terrain.columns; column += 1) {
      const x = terrain.minX + (terrain.maxX - terrain.minX) * column / (terrain.columns - 1);
      let selected: { baseElevation: number; weight: number } | null = null;
      for (const pad of pads) {
        if (x < pad.minX || x > pad.maxX || z < pad.minZ || z > pad.maxZ) continue;
        const inside = pointInRing([x, z], pad.outer);
        const distance = inside ? 0 : distanceToRing([x, z], pad.outer);
        if (distance >= bufferMetres) continue;
        const t = distance / bufferMetres;
        const weight = inside ? 1 : 1 - t * t * (3 - 2 * t);
        if (!selected || weight > selected.weight) selected = { baseElevation: pad.baseElevation, weight };
      }
      if (!selected) continue;
      const index = row * terrain.columns + column;
      terrain.heights[index] = round(source[index] + (selected.baseElevation - source[index]) * selected.weight, 1);
    }
  }
  terrain.minElevation = Math.min(...terrain.heights);
  terrain.maxElevation = Math.max(...terrain.heights);
  terrain.buildingPads = { count: pads.length, bufferMetres };
}

export async function buildOnlineCampus(
  definition: CampusDefinition,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<CampusData> {
  const bbox = definition.bbox;
  if (!bbox) throw new Error('该学校缺少在线获取范围');
  onProgress('在线获取 OpenStreetMap 校园数据…');
  const [south, west, north, east] = bbox;
  const response = await fetch(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${west},${south},${east},${north}`, { signal });
  if (!response.ok) throw new Error(`OSM 请求失败：HTTP ${response.status}。请稍后重试或缩小范围。`);
  const snapshot = await response.json();
  if (!Array.isArray(snapshot.elements) || snapshot.elements.length === 0) throw new Error('该范围没有 OSM 数据');

  onProgress('在线获取并解码地形瓦片…');
  const { origin, project, bounds } = projector(bbox);
  const terrain = await fetchTerrain(bbox, origin, bounds, signal);
  onProgress('转换建筑、道路与校园景观…');
  const converted = osmtogeojson(snapshot) as unknown as { features: OsmFeature[] };
  const features = converted.features.filter((feature) => feature.geometry);
  const center = project([origin.lon, origin.lat]);
  const university = features
    .filter((feature) => featureTags(feature).amenity === 'university')
    .flatMap((feature) => polygons(feature, project))
    .filter((polygon) => pointInRing(center, polygon.outer))
    .sort((a, b) => ringArea(a.outer) - ringArea(b.outer))[0];
  const campus = university?.outer ?? [
    [bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ],
    [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ],
  ] as Point[];

  const buildingMap = new Map<string, BuildingData>();
  const roads: RoadData[] = [];
  const areas: AreaData[] = [];
  const trees: TreeData[] = [];
  for (const [index, feature] of features.entries()) {
    const tags = featureTags(feature);
    const id = String(feature.id ?? `feature-${index}`);
    if (tags.building && tags.building !== 'no') {
      const shapes = polygons(feature, project);
      if (shapes.length && (!university || pointInRing(centroid(shapes[0].outer), campus))) {
        const building: BuildingData = { id, name: tags.name ?? '', kind: tags.building, ...buildingHeight(tags), polygons: shapes };
        buildingMap.set(JSON.stringify(shapes.map((shape) => shape.outer)), building);
      }
    }
    if (tags.highway && tags.area !== 'yes') {
      for (const points of lines(feature, project)) roads.push({ id, name: tags.name ?? '', kind: tags.highway, width: roadWidth(tags), layer: parseNumber(tags.layer) ?? 0, points });
    }
    const kind = areaKind(tags);
    if (kind) {
      const shapes = polygons(feature, project);
      if (shapes.length) areas.push({ id, kind, polygons: shapes });
    }
    if (tags.natural === 'tree' && feature.geometry?.type === 'Point') {
      trees.push({ id, position: project(feature.geometry.coordinates), source: 'osm', variant: trees.length % 3, scale: 1 });
    }
  }
  const buildings = [...buildingMap.values()];
  if (buildings.length === 0) throw new Error('该范围没有可构建的 OSM 建筑，请调整中心或半径');
  flattenBuildingPads(terrain, buildings);
  const buildingShapes = buildings.flatMap((building) => building.polygons);
  const spawnRoad = roads
    .filter((road) => ['footway', 'path', 'pedestrian', 'service', 'residential'].includes(road.kind))
    .flatMap((road) => road.points)
    .filter((point) => pointInRing(point, campus) && !buildingShapes.some((polygon) => pointInPolygon(point, polygon)))
    .sort((a, b) => Math.hypot(a[0] - center[0], a[1] - center[1]) - Math.hypot(b[0] - center[0], b[1] - center[1]))[0];
  const spawn = spawnRoad ?? (pointInPolygon(center, university ?? { outer: campus, holes: [] }) && !buildingShapes.some((polygon) => pointInPolygon(center, polygon)) ? center : null);
  if (!spawn) throw new Error('无法在校园内找到安全出生点，请调整范围');

  return {
    id: definition.id,
    name: definition.name,
    shortName: definition.shortName,
    origin,
    bbox,
    bounds,
    campus,
    buildings,
    roads,
    areas,
    trees,
    terrain,
    spawn,
    meta: {
      source: 'OpenStreetMap contributors (ODbL); Mapzen/Tilezen Terrain Tiles',
      fetchedAt: new Date().toISOString(),
      online: true,
      coordinateSystem: 'local metres; +x east, +z south',
      counts: { buildings: buildings.length, roads: roads.length, areas: areas.length, trees: trees.length },
    },
  };
}
