import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let osmtogeojson;
try {
  const module = await import('osmtogeojson');
  osmtogeojson = module.default ?? module;
  if (typeof osmtogeojson !== 'function') throw new Error('default export is not a function');
} catch (error) {
  console.error(`Cannot resolve osmtogeojson. Install project dependencies before running this script.\n${error.message}`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const campuses = [
  {
    id: 'clear-water-bay',
    name: 'The Hong Kong University of Science and Technology',
    shortName: 'HKUST',
    boundaryId: 'way/40664120',
    bbox: [22.3317, 114.2615, 22.3405, 114.27],
    filterBuildingsToCampus: false,
  },
  {
    id: 'guangzhou',
    name: 'The Hong Kong University of Science and Technology (Guangzhou)',
    shortName: 'HKUST(GZ)',
    boundaryId: 'way/894157108',
    bbox: [22.8829, 113.4708, 22.9008, 113.4874],
    filterBuildingsToCampus: true,
  },
];

const EARTH_RADIUS = 6378137;
const rad = (degrees) => degrees * Math.PI / 180;
const round = (value) => Math.round(value * 1000) / 1000;
const tagsOf = (feature) => feature.properties?.tags ?? feature.properties ?? {};
const idOf = (feature, index) => String(feature.id ?? feature.properties?.id ?? `feature-${index}`);

function makeProjector(origin) {
  return ([lon, lat]) => [
    round(rad(lon - origin.lon) * Math.cos(rad(origin.lat)) * EARTH_RADIUS),
    round(-rad(lat - origin.lat) * EARTH_RADIUS),
  ];
}

function cleanRing(ring, project) {
  if (!Array.isArray(ring)) return [];
  const points = [];
  for (const coordinate of ring) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
    const point = project(coordinate);
    const previous = points.at(-1);
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) points.push(point);
  }
  if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
  return points.length >= 3 ? points : [];
}

function polygonsFromFeature(feature, project) {
  const geometry = feature.geometry;
  if (!geometry) return [];
  const source = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  const polygons = [];
  for (const polygon of source) {
    if (!Array.isArray(polygon) || polygon.length === 0) continue;
    const outer = cleanRing(polygon[0], project);
    if (outer.length < 3) continue;
    const holes = polygon.slice(1).map((ring) => cleanRing(ring, project)).filter((ring) => ring.length >= 3);
    polygons.push({ outer, holes });
  }
  return polygons;
}

function linesFromFeature(feature, project) {
  const geometry = feature.geometry;
  if (!geometry) return [];
  const source = geometry.type === 'LineString'
    ? [geometry.coordinates]
    : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
  return source.map((line) => {
    const points = [];
    for (const coordinate of line) {
      const point = project(coordinate);
      const previous = points.at(-1);
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) points.push(point);
    }
    return points;
  }).filter((line) => line.length >= 2);
}

function canonicalRing(ring) {
  const candidates = [ring, [...ring].reverse()].map((candidate) => {
    let start = 0;
    for (let index = 1; index < candidate.length; index += 1) {
      if (JSON.stringify(candidate[index]) < JSON.stringify(candidate[start])) start = index;
    }
    return [...candidate.slice(start), ...candidate.slice(0, start)];
  });
  return JSON.stringify(candidates[0]) <= JSON.stringify(candidates[1]) ? candidates[0] : candidates[1];
}

function buildingSignature(polygons) {
  const canonical = polygons.map((polygon) => ({
    outer: canonicalRing(polygon.outer),
    holes: polygon.holes.map(canonicalRing).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  }));
  canonical.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(canonical);
}

function ringArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    area += ring[index][0] * ring[next][1] - ring[next][0] * ring[index][1];
  }
  return Math.abs(area) / 2;
}

function ringCentroid(ring) {
  let twiceArea = 0;
  let x = 0;
  let z = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    const cross = ring[index][0] * ring[next][1] - ring[next][0] * ring[index][1];
    twiceArea += cross;
    x += (ring[index][0] + ring[next][0]) * cross;
    z += (ring[index][1] + ring[next][1]) * cross;
  }
  if (Math.abs(twiceArea) < 0.001) return ring[0];
  const centroid = [x / (3 * twiceArea), z / (3 * twiceArea)];
  return pointInRing(centroid, ring) ? centroid : ring[0];
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x, z] = point;
    const [xi, zi] = ring[index];
    const [xj, zj] = ring[previous];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  return pointInRing(point, polygon.outer) && !polygon.holes.some((hole) => pointInRing(point, hole));
}

function pointInPolygons(point, polygons) {
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared));
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dz);
}

function distanceToLine(point, line) {
  let distance = Infinity;
  for (let index = 1; index < line.length; index += 1) {
    distance = Math.min(distance, distanceToSegment(point, line[index - 1], line[index]));
  }
  return distance;
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function buildingHeight(tags) {
  const height = parseNumber(tags.height);
  if (height !== null && height > 0) {
    const metres = /ft|feet/i.test(tags.height) ? height * 0.3048 : height;
    return { height: round(Math.max(2, metres)), heightSource: 'osm' };
  }
  const levels = parseNumber(tags['building:levels']);
  if (levels !== null && levels > 0) return { height: round(Math.max(2, levels * 3)), heightSource: 'levels' };
  const kind = tags.building ?? tags['building:part'] ?? 'yes';
  const defaults = {
    apartments: 12,
    commercial: 12,
    hospital: 15,
    industrial: 8,
    office: 15,
    residential: 9,
    roof: 3,
    school: 9,
    university: 12,
    yes: 9,
  };
  return { height: defaults[kind] ?? (tags['building:part'] ? 3 : 9), heightSource: 'estimated' };
}

function roadWidth(tags) {
  const width = parseNumber(tags.width);
  if (width !== null && width > 0) return width;
  const defaults = {
    cycleway: 2.5,
    footway: 2,
    living_street: 4,
    motorway: 7,
    path: 1.5,
    pedestrian: 4,
    primary: 6.5,
    residential: 5,
    secondary: 6,
    service: 4,
    steps: 1.5,
    tertiary: 5.5,
    track: 3,
    trunk: 7,
  };
  return defaults[tags.highway] ?? 4;
}

function areaKind(tags) {
  if (tags.natural === 'water' || tags.water || ['basin', 'reservoir'].includes(tags.landuse)) return 'water';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'wood';
  if (['grass', 'greenfield', 'meadow', 'village_green'].includes(tags.landuse)
    || ['garden', 'park', 'golf_course'].includes(tags.leisure)
    || ['grass', 'scrub', 'heath'].includes(tags.natural)) return 'grass';
  if (['pitch', 'playground', 'stadium', 'sports_centre'].includes(tags.leisure)) return 'grass';
  if ((tags.highway === 'pedestrian' && tags.area === 'yes') || tags.place === 'square' || tags.amenity === 'marketplace') return 'pedestrian';
  return null;
}

function hashSeed(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomGenerator(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function sampleLine(points, spacing) {
  const segments = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
    if (length > 0) {
      segments.push({ start: points[index - 1], end: points[index], from: total, to: total + length });
      total += length;
    }
  }
  const samples = [];
  for (let distance = spacing / 2; distance < total; distance += spacing) {
    const segment = segments.find((candidate) => distance >= candidate.from && distance <= candidate.to);
    if (!segment) continue;
    const t = (distance - segment.from) / (segment.to - segment.from);
    samples.push([
      round(segment.start[0] + t * (segment.end[0] - segment.start[0])),
      round(segment.start[1] + t * (segment.end[1] - segment.start[1])),
    ]);
  }
  return samples;
}

function polygonBounds(polygons) {
  const points = polygons.flatMap((polygon) => polygon.outer);
  return {
    minX: Math.min(...points.map((point) => point[0])),
    maxX: Math.max(...points.map((point) => point[0])),
    minZ: Math.min(...points.map((point) => point[1])),
    maxZ: Math.max(...points.map((point) => point[1])),
  };
}

async function prepare(campus) {
  const snapshotPath = path.join(root, 'data', 'osm', `${campus.id}.osm.json`);
  const metadataPath = path.join(root, 'data', 'osm', `${campus.id}.meta.json`);
  const [snapshot, sourceMetadata] = await Promise.all([
    readFile(snapshotPath, 'utf8').then(JSON.parse),
    readFile(metadataPath, 'utf8').then(JSON.parse),
  ]);
  const converted = osmtogeojson(snapshot);
  const geojson = {
    type: 'FeatureCollection',
    features: converted.features.filter((feature) => feature?.geometry && Array.isArray(feature.geometry.coordinates)),
  };
  const [south, west, north, east] = campus.bbox;
  const origin = { lon: (west + east) / 2, lat: (south + north) / 2 };
  const project = makeProjector(origin);
  const boundaryFeature = geojson.features.find((feature) => idOf(feature, 0) === campus.boundaryId);
  if (!boundaryFeature) throw new Error(`${campus.id}: boundary ${campus.boundaryId} is missing`);
  const boundaryPolygons = polygonsFromFeature(boundaryFeature, project);
  if (boundaryPolygons.length === 0) throw new Error(`${campus.id}: boundary has no usable polygon`);
  const campusRing = boundaryPolygons[0].outer;

  const buildingMap = new Map();
  const roads = [];
  const areas = [];
  const trees = [];
  const treePositions = new Set();

  for (const [index, feature] of geojson.features.entries()) {
    const id = idOf(feature, index);
    const tags = tagsOf(feature);
    const isBuilding = tags.building && tags.building !== 'no';
    if (isBuilding) {
      const polygons = polygonsFromFeature(feature, project);
      if (polygons.length > 0) {
        const representative = ringCentroid([...polygons].sort((a, b) => ringArea(b.outer) - ringArea(a.outer))[0].outer);
        if (!campus.filterBuildingsToCampus || pointInRing(representative, campusRing)) {
          const height = buildingHeight(tags);
          const candidate = {
            id,
            name: tags.name ?? '',
            kind: tags.building ?? tags['building:part'] ?? 'yes',
            ...height,
            polygons,
          };
          const signature = buildingSignature(polygons);
          const previous = buildingMap.get(signature);
          const rank = (item) => (item.heightSource === 'osm' ? 4 : item.heightSource === 'levels' ? 2 : 0)
            + (item.name ? 1 : 0) + (item.kind !== 'yes' ? 0.5 : 0);
          if (!previous || rank(candidate) > rank(previous)) buildingMap.set(signature, candidate);
        }
      }
    }

    if (tags.highway && tags.highway !== 'no' && tags.area !== 'yes') {
      for (const [lineIndex, points] of linesFromFeature(feature, project).entries()) {
        roads.push({
          id: lineIndex === 0 ? id : `${id}:${lineIndex}`,
          name: tags.name ?? '',
          kind: tags.highway,
          width: roadWidth(tags),
          layer: parseNumber(tags.layer) ?? 0,
          points,
        });
      }
    }

    const kind = areaKind(tags);
    if (kind) {
      const polygons = polygonsFromFeature(feature, project);
      if (polygons.length > 0) areas.push({ id, kind, polygons });
    }
  }

  const buildings = [...buildingMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const buildingPolygons = buildings.flatMap((building) => building.polygons);
  const waterPolygons = areas.filter((area) => area.kind === 'water').flatMap((area) => area.polygons);
  const random = randomGenerator(hashSeed(campus.id));

  function addTree(id, position, source) {
    if (!Number.isFinite(position[0]) || !Number.isFinite(position[1])) return;
    const key = `${round(position[0])},${round(position[1])}`;
    if (treePositions.has(key)) return;
    treePositions.add(key);
    trees.push({
      id,
      position: [round(position[0]), round(position[1])],
      source,
      variant: Math.floor(random() * 3),
      scale: round(0.85 + random() * 0.4),
    });
  }

  function isClearOfFeatures(position, avoidRoads = true) {
    if (pointInPolygons(position, buildingPolygons) || pointInPolygons(position, waterPolygons)) return false;
    if (avoidRoads && roads.some((road) => distanceToLine(position, road.points) < road.width / 2 + 1.5)) return false;
    return true;
  }

  for (const [index, feature] of geojson.features.entries()) {
    const tags = tagsOf(feature);
    const id = idOf(feature, index);
    if (tags.natural === 'tree' && feature.geometry?.type === 'Point') {
      addTree(id, project(feature.geometry.coordinates), 'osm');
    } else if (tags.natural === 'tree_row') {
      for (const [lineIndex, line] of linesFromFeature(feature, project).entries()) {
        for (const [sampleIndex, position] of sampleLine(line, 8).entries()) {
          if (isClearOfFeatures(position, false)) addTree(`${id}:${lineIndex}:${sampleIndex}`, position, 'osm');
        }
      }
    }
  }

  const greenAreas = areas.filter((area) => ['wood', 'grass'].includes(area.kind)).sort((a, b) => a.id.localeCompare(b.id));
  let generatedCount = 0;
  for (const area of greenAreas) {
    for (const polygon of area.polygons) {
      const areaMetres = Math.max(0, ringArea(polygon.outer) - polygon.holes.reduce((sum, hole) => sum + ringArea(hole), 0));
      const forest = area.kind === 'wood';
      const target = Math.min(forest ? 220 : 60, Math.max(2, Math.round(areaMetres / (forest ? 120 : 500))));
      const bounds = polygonBounds([polygon]);
      let placed = 0;
      for (let attempt = 0; attempt < target * 40 && placed < target && generatedCount < 900; attempt += 1) {
        const position = [
          bounds.minX + random() * (bounds.maxX - bounds.minX),
          bounds.minZ + random() * (bounds.maxZ - bounds.minZ),
        ];
        if (!pointInPolygon(position, polygon) || !pointInRing(position, campusRing) || !isClearOfFeatures(position)) continue;
        if (trees.some((tree) => Math.hypot(tree.position[0] - position[0], tree.position[1] - position[1]) < 4)) continue;
        addTree(`generated:${area.id}:${generatedCount}`, position, 'generated');
        generatedCount += 1;
        placed += 1;
      }
    }
  }

  if (greenAreas.length === 0) {
    const bounds = polygonBounds(boundaryPolygons);
    for (let attempt = 0; attempt < 4000 && generatedCount < 80; attempt += 1) {
      const position = [
        bounds.minX + random() * (bounds.maxX - bounds.minX),
        bounds.minZ + random() * (bounds.maxZ - bounds.minZ),
      ];
      if (!pointInRing(position, campusRing) || !isClearOfFeatures(position)) continue;
      if (trees.some((tree) => Math.hypot(tree.position[0] - position[0], tree.position[1] - position[1]) < 8)) continue;
      addTree(`generated:fallback:${generatedCount}`, position, 'generated');
      generatedCount += 1;
    }
  }

  const center = ringCentroid(campusRing);
  const roadPreference = { footway: 0, path: 5, pedestrian: 10, living_street: 20, service: 35, residential: 45, cycleway: 50 };
  const spawnCandidates = roads
    .filter((road) => road.kind in roadPreference)
    .flatMap((road) => road.points.map((position) => ({ position, penalty: roadPreference[road.kind] })))
    .filter(({ position }) => pointInRing(position, campusRing) && !pointInPolygons(position, buildingPolygons) && !pointInPolygons(position, waterPolygons))
    .sort((a, b) => Math.hypot(a.position[0] - center[0], a.position[1] - center[1]) + a.penalty
      - Math.hypot(b.position[0] - center[0], b.position[1] - center[1]) - b.penalty);
  let spawn = spawnCandidates[0]?.position;
  if (!spawn) {
    const bounds = polygonBounds(boundaryPolygons);
    for (let attempt = 0; attempt < 4000 && !spawn; attempt += 1) {
      const position = [bounds.minX + random() * (bounds.maxX - bounds.minX), bounds.minZ + random() * (bounds.maxZ - bounds.minZ)];
      if (pointInRing(position, campusRing) && isClearOfFeatures(position, false)) spawn = position;
    }
  }
  if (!spawn) throw new Error(`${campus.id}: could not find a safe spawn`);

  const projectedCorners = [[west, south], [west, north], [east, south], [east, north]].map(project);
  const bounds = {
    minX: Math.min(...projectedCorners.map((point) => point[0])),
    maxX: Math.max(...projectedCorners.map((point) => point[0])),
    minZ: Math.min(...projectedCorners.map((point) => point[1])),
    maxZ: Math.max(...projectedCorners.map((point) => point[1])),
  };
  const runtime = {
    id: campus.id,
    name: campus.name,
    shortName: campus.shortName,
    origin,
    bbox: campus.bbox,
    bounds,
    campus: campusRing,
    buildings,
    roads,
    areas,
    trees,
    spawn,
    meta: {
      source: 'OpenStreetMap contributors (ODbL)',
      sourceUrl: sourceMetadata.sourceUrl,
      fetchedAt: sourceMetadata.fetchedAt,
      boundaryId: campus.boundaryId,
      bbox: sourceMetadata.bbox,
      coordinateSystem: 'local metres; +x east, +z south',
      rawSnapshot: `data/osm/${campus.id}.osm.json`,
      geojson: `data/geojson/${campus.id}.geojson`,
      generatedTreeCount: generatedCount,
      treeNote: 'source=osm derives from mapped tree or tree-row geometry; source=generated is deterministic illustrative vegetation, not surveyed tree positions.',
      counts: { buildings: buildings.length, roads: roads.length, areas: areas.length, trees: trees.length },
    },
  };

  await mkdir(path.join(root, 'data', 'geojson'), { recursive: true });
  await mkdir(path.join(root, 'public', 'data'), { recursive: true });
  await writeFile(path.join(root, 'data', 'geojson', `${campus.id}.geojson`), `${JSON.stringify(geojson)}\n`);
  await writeFile(path.join(root, 'public', 'data', `${campus.id}.json`), `${JSON.stringify(runtime)}\n`);
  console.log(`${campus.id}: ${buildings.length} buildings, ${roads.length} roads, ${areas.length} areas, ${trees.length} trees (${generatedCount} generated)`);
}

for (const campus of campuses) {
  try {
    await prepare(campus);
  } catch (error) {
    console.error(`${campus.id}: ${error.message}`);
    process.exitCode = 1;
  }
}
