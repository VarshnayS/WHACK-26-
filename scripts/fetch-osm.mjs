/**
 * scripts/fetch-osm.mjs: downloads OSM highway ways in the play corridor to public/osm.json
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * Run once, online:  npm run fetch:osm
 * Reads ORIGIN_LAT/LON and CORRIDOR_LENGTH/HALF_WIDTH/BEARING from src/config.ts (single source of
 * truth; nothing is hard-coded here), queries the Overpass API for every highway way in the
 * corridor's bounding box (built-in fetch, no packages, no result cap), then clips each way to the
 * corridor rectangle. Where a way crosses the boundary a new node (negative id) is added on the
 * boundary, so paths end exactly at the walls. Output matches OsmData in src/world/osm.ts.
 * OSM data is © OpenStreetMap contributors (ODbL).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT_DIR, makeCorridor, makeProjection, queryOverpass, readConfig } from './lib/osm-common.mjs';

const OUT_FILE = path.join(ROOT_DIR, 'public', 'osm.json');
/** Extra metres around the corridor's bounding box so ways crossing the boundary are complete. */
const BBOX_MARGIN = 20;

/** Paths people walk on. Everything else that is a real road counts as 'road'. Keep in sync with osm.ts. */
const FOOTWAY_HIGHWAYS = new Set(['footway', 'pedestrian', 'path', 'steps', 'cycleway', 'bridleway', 'track', 'corridor']);
/** Not real paths/roads; skipped. */
const SKIP_HIGHWAYS = new Set(['proposed', 'construction', 'abandoned', 'disused', 'platform', 'bus_stop', 'elevator', 'street_lamp', 'services', 'rest_area']);
/** Only these tags are kept, to keep osm.json small. */
const KEEP_TAGS = ['highway', 'name', 'oneway', 'service', 'footway', 'area', 'access', 'junction', 'lanes'];
const EPS = 1e-9;

async function main() {
  const cfg = await readConfig();
  const projection = makeProjection(cfg.lat, cfg.lon);
  const corridor = makeCorridor(cfg);

  // Bounding box (south, west, north, east) of the corridor corners plus a margin.
  const corners = corridor.corners(BBOX_MARGIN).map(([e, n]) => projection.toLatLon(e, n));
  const s = Math.min(...corners.map((c) => c[0]));
  const n = Math.max(...corners.map((c) => c[0]));
  const w = Math.min(...corners.map((c) => c[1]));
  const e = Math.max(...corners.map((c) => c[1]));
  const bbox = [s, w, n, e].map((v) => v.toFixed(7)).join(',');
  console.log(
    `[fetch-osm] origin ${cfg.lat}, ${cfg.lon}; corridor ${cfg.length} m x ±${cfg.halfWidth} m at ${cfg.bearing}°; bbox ${bbox}`,
  );

  const json = await queryOverpass(
    `[out:json][timeout:90];
way["highway"](${bbox});
(._;>;);
out body;`,
    'fetch-osm',
  );
  const elements = Array.isArray(json.elements) ? json.elements : [];

  const nodeById = new Map();
  const rawWays = [];
  for (const el of elements) {
    if (el.type === 'node') nodeById.set(el.id, el);
    else if (el.type === 'way' && el.tags?.highway && !SKIP_HIGHWAYS.has(el.tags.highway)) rawWays.push(el);
  }

  // --- clip every way to the corridor ------------------------------------------------------
  const outNodes = new Map(); // id -> { id, lat, lon }
  let nextSyntheticId = -1;
  const keepNode = (id) => {
    const node = nodeById.get(id);
    outNodes.set(id, { id, lat: Number(node.lat.toFixed(7)), lon: Number(node.lon.toFixed(7)) });
    return id;
  };
  const boundaryNode = (p, q, t) => {
    const [lat, lon] = projection.toLatLon(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t);
    const id = nextSyntheticId--;
    outNodes.set(id, { id, lat: Number(lat.toFixed(7)), lon: Number(lon.toFixed(7)) });
    return id;
  };

  const ways = [];
  for (const way of rawWays) {
    const ids = way.nodes.filter((id) => nodeById.has(id));
    const pts = ids.map((id) => {
      const node = nodeById.get(id);
      return projection.toEN(node.lat, node.lon);
    });
    const tags = {};
    for (const key of KEEP_TAGS) if (way.tags[key] !== undefined) tags[key] = way.tags[key];
    const kind = FOOTWAY_HIGHWAYS.has(way.tags.highway) ? 'footway' : 'road';

    const pieces = [];
    let current = null;
    for (let i = 1; i < pts.length; i++) {
      const clip = corridor.clipSegment(pts[i - 1], pts[i]);
      if (!clip || clip[1] - clip[0] < EPS) {
        if (current) pieces.push(current);
        current = null;
        continue;
      }
      const [t0, t1] = clip;
      if (!current || t0 > EPS) {
        if (current) pieces.push(current);
        current = [t0 <= EPS ? keepNode(ids[i - 1]) : boundaryNode(pts[i - 1], pts[i], t0)];
      }
      current.push(t1 >= 1 - EPS ? keepNode(ids[i]) : boundaryNode(pts[i - 1], pts[i], t1));
      if (t1 < 1 - EPS) {
        pieces.push(current);
        current = null;
      }
    }
    if (current) pieces.push(current);

    pieces
      .filter((p) => p.length >= 2)
      .forEach((nodeIds, part) => ways.push({ id: way.id, ...(pieces.length > 1 ? { part } : {}), kind, nodeIds, tags }));
  }

  // Drop nodes no kept way uses (a node can be kept by one way and unused after another's clip).
  const used = new Set(ways.flatMap((wy) => wy.nodeIds));
  const nodes = [...outNodes.values()].filter((node) => used.has(node.id));

  const data = {
    attribution: '© OpenStreetMap contributors',
    license: 'ODbL 1.0 (https://www.openstreetmap.org/copyright)',
    generated: new Date().toISOString(),
    origin: { lat: cfg.lat, lon: cfg.lon },
    corridor: { length: cfg.length, halfWidth: cfg.halfWidth, bearing: cfg.bearing },
    nodes,
    ways,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(data));

  const footways = ways.filter((wy) => wy.kind === 'footway').length;
  const boundary = nodes.filter((node) => node.id < 0).length;
  console.log(
    `[fetch-osm] ${rawWays.length} highway ways in the bounding box; after clipping to the corridor: ` +
      `${ways.length} ways (${footways} footway, ${ways.length - footways} road), ${nodes.length} nodes ` +
      `(${boundary} on the boundary) -> public/osm.json`,
  );
}

main().catch((err) => {
  console.error(`[fetch-osm] failed: ${err.message}`);
  process.exitCode = 1;
});
