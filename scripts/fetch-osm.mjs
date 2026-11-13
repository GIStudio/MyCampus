import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'data', 'osm');
const force = process.argv.includes('--force');

const campuses = [
  {
    id: 'clear-water-bay',
    name: 'HKUST Clear Water Bay',
    boundaryId: 'way/40664120',
    bbox: [22.3317, 114.2615, 22.3405, 114.27],
  },
  {
    id: 'guangzhou',
    name: 'HKUST(GZ)',
    boundaryId: 'way/894157108',
    bbox: [22.8829, 113.4708, 22.9008, 113.4874],
  },
  {
    id: 'edinburgh',
    name: 'University of Edinburgh',
    boundaryId: 'way/9529767',
    bbox: [55.9408, -3.1932, 55.9473, -3.1823],
  },
  {
    id: 'cug-wuhan',
    name: 'China University of Geosciences (Wuhan)',
    boundaryId: 'relation/10790904',
    bbox: [30.5165, 114.3893, 30.5341, 114.4044],
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isValidSnapshot(file) {
  try {
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(snapshot.elements) && snapshot.elements.length > 0;
  } catch {
    return false;
  }
}

async function isValidMetadata(file) {
  try {
    const metadata = JSON.parse(await readFile(file, 'utf8'));
    return typeof metadata.sourceUrl === 'string' && typeof metadata.fetchedAt === 'string';
  } catch {
    return false;
  }
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MyCampus-OSM-Pipeline/1.0 (educational campus visualization)',
      },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`OSM API returned ${response.status} ${response.statusText}`);
    return await response.text();
  } catch (error) {
    console.warn(`Node fetch unavailable; retrying with curl: ${error.message}`);
    const { stdout } = await promisify(execFile)('curl', [
      '-fSsL', '--connect-timeout', '30', '--max-time', '180',
      '-H', 'Accept: application/json',
      '-H', 'User-Agent: MyCampus-OSM-Pipeline/1.0 (educational campus visualization)',
      url,
    ], { maxBuffer: 100 * 1024 * 1024 });
    return stdout;
  }
}

async function download(campus) {
  const [south, west, north, east] = campus.bbox;
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${west},${south},${east},${north}`;
  const snapshotPath = path.join(outputDir, `${campus.id}.osm.json`);
  const metadataPath = path.join(outputDir, `${campus.id}.meta.json`);

  if (!force && await isValidSnapshot(snapshotPath) && await isValidMetadata(metadataPath)) {
    console.log(`Using cached ${campus.id}: ${path.relative(root, snapshotPath)}`);
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const body = await fetchText(url);
      const snapshot = JSON.parse(body);
      if (!Array.isArray(snapshot.elements) || snapshot.elements.length === 0) {
        throw new Error('OSM response contains no elements');
      }
      const temporaryPath = `${snapshotPath}.tmp`;
      await writeFile(temporaryPath, body);
      await rename(temporaryPath, snapshotPath);
      const metadata = {
        id: campus.id,
        name: campus.name,
        source: 'OpenStreetMap API 0.6 map.json',
        sourceUrl: url,
        fetchedAt: new Date().toISOString(),
        bbox: { south, west, north, east },
        boundaryId: campus.boundaryId,
        elementCount: snapshot.elements.length,
        osmBase: snapshot.osm_base ?? null,
        generator: snapshot.generator ?? null,
      };
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      console.log(`Downloaded ${campus.id}: ${snapshot.elements.length} elements`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(2 ** attempt * 1000);
    }
  }
  throw new Error(`Failed to download ${campus.id}: ${lastError.message}`);
}

await mkdir(outputDir, { recursive: true });
const results = await Promise.allSettled(campuses.map(download));
const failures = results.filter((result) => result.status === 'rejected');
if (failures.length > 0) {
  for (const failure of failures) console.error(failure.reason.message);
  process.exitCode = 1;
}
