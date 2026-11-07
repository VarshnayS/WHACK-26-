/**
 * scripts/fetch-osm.mjs: downloads OSM highway ways around the origin to public/osm.json
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * Run once, online:  npm run fetch:osm
 * Reads ORIGIN_LAT, ORIGIN_LON and PLAY_RADIUS from src/config.ts (single source of truth),
 * queries the Overpass API with built-in fetch (no packages) and writes { nodes, ways } in the
 * OsmData shape from src/world/osm.ts. OSM data is © OpenStreetMap contributors (ODbL).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT_DIR, 'src', 'config.ts');
const OUT_FILE = path.join(ROOT_DIR, 'public', 'osm.json');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Paths people walk on. Everything else that is a real road counts as 'road'. Keep in sync with osm.ts. */
const FOOTWAY_HIGHWAYS = new Set(['footway', 'pedestrian', 'path', 'steps', 'cycleway', 'bridleway', 'track', 'corridor']);
/** Not real paths/roads; skipped. */
const SKIP_HIGHWAYS = new Set(['proposed', 'construction', 'abandoned', 'disused', 'platform', 'bus_stop', 'elevator', 'street_lamp', 'services', 'rest_area']);
/** Only these tags are kept, to keep osm.json small. */
const KEEP_TAGS = ['highway', 'name', 'oneway', 'service', 'footway', 'area', 'access', 'junction', 'lanes'];

async function readConfigNumber(source, name) {
  const match = new RegExp(`export const ${name}\\s*=\\s*(-?[\\d.]+)\\s*;`).exec(source);
  if (!match) throw new Error(`Could not read ${name} from src/config.ts (expected "export const ${name} = <number>;")`);
  return Number(match[1]);
}

async function queryOverpass(query) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      console.log(`[fetch-osm] querying ${new URL(endpoint).host} ...`);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'blind-simulator-osm-fetch/1.0 (hackathon project)',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      console.warn(`[fetch-osm] ${new URL(endpoint).host} failed: ${err.message}`);
    }
  }
  throw lastError;
}

async function main() {
  const config = await readFile(CONFIG_FILE, 'utf8');
  const lat = await readConfigNumber(config, 'ORIGIN_LAT');
  const lon = await readConfigNumber(config, 'ORIGIN_LON');
  const radius = await readConfigNumber(config, 'PLAY_RADIUS');

  // Every way tagged highway within the radius, plus all of its nodes (ways are returned whole,
  // so some nodes lie outside the radius; osm.ts clips the path graph to PLAY_RADIUS).
  const query = `[out:json][timeout:90];
way["highway"](around:${radius},${lat},${lon});
(._;>;);
out body;`;

  const json = await queryOverpass(query);
  const elements = Array.isArray(json.elements) ? json.elements : [];

  const nodes = [];
  const ways = [];
  for (const el of elements) {
    if (el.type === 'node') {
      nodes.push({ id: el.id, lat: Number(el.lat.toFixed(7)), lon: Number(el.lon.toFixed(7)) });
    } else if (el.type === 'way' && el.tags?.highway && !SKIP_HIGHWAYS.has(el.tags.highway)) {
      const tags = {};
      for (const key of KEEP_TAGS) if (el.tags[key] !== undefined) tags[key] = el.tags[key];
      ways.push({
        id: el.id,
        kind: FOOTWAY_HIGHWAYS.has(el.tags.highway) ? 'footway' : 'road',
        nodeIds: el.nodes,
        tags,
      });
    }
  }

  // Drop nodes no kept way uses.
  const used = new Set(ways.flatMap((w) => w.nodeIds));
  const keptNodes = nodes.filter((n) => used.has(n.id));

  const data = {
    attribution: '© OpenStreetMap contributors',
    license: 'ODbL 1.0 (https://www.openstreetmap.org/copyright)',
    generated: new Date().toISOString(),
    origin: { lat, lon },
    radius,
    nodes: keptNodes,
    ways,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(data));

  const footways = ways.filter((w) => w.kind === 'footway').length;
  console.log(
    `[fetch-osm] wrote public/osm.json: ${ways.length} ways (${footways} footway, ${ways.length - footways} road), ${keptNodes.length} nodes`,
  );
}

main().catch((err) => {
  console.error(`[fetch-osm] failed: ${err.message}`);
  process.exitCode = 1;
});
