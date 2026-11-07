/**
 * scripts/lib/osm-common.mjs: shared helpers for the OSM scripts (built-ins only)
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * - readConfig(): ORIGIN_* and CORRIDOR_* straight from src/config.ts (single source of truth)
 * - queryOverpass(): POST to Overpass with a mirror fallback and retries
 * - Corridor maths in local east/north metres (matches src/world/playArea.ts to within cm)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEG = Math.PI / 180;
const EARTH_RADIUS = 6378137;

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const USER_AGENT = 'blind-simulator-osm-fetch/1.0 (hackathon project)';

function readConfigNumber(source, name) {
  const match = new RegExp(`export const ${name}\\s*=\\s*(-?[\\d.]+)\\s*;`).exec(source);
  if (!match) throw new Error(`Could not read ${name} from src/config.ts (expected "export const ${name} = <number>;")`);
  return Number(match[1]);
}

/** Origin and corridor settings from src/config.ts. */
export async function readConfig() {
  const source = await readFile(path.join(ROOT_DIR, 'src', 'config.ts'), 'utf8');
  return {
    lat: readConfigNumber(source, 'ORIGIN_LAT'),
    lon: readConfigNumber(source, 'ORIGIN_LON'),
    length: readConfigNumber(source, 'CORRIDOR_LENGTH'),
    halfWidth: readConfigNumber(source, 'CORRIDOR_HALF_WIDTH'),
    bearing: readConfigNumber(source, 'CORRIDOR_BEARING'),
  };
}

/** Run an Overpass QL query; tries each endpoint up to twice. Returns the parsed JSON. */
export async function queryOverpass(query, label = 'osm') {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const endpoint of ENDPOINTS) {
      const host = new URL(endpoint).host;
      try {
        console.log(`[${label}] querying ${host} ...`);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        console.warn(`[${label}] ${host} failed: ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw lastError;
}

/** Local projection around the origin: [east, north] metres <-> lat/lon degrees. */
export function makeProjection(lat0, lon0) {
  const kx = DEG * EARTH_RADIUS * Math.cos(lat0 * DEG);
  const ky = DEG * EARTH_RADIUS;
  return {
    toEN: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (e, n) => [lat0 + n / ky, lon0 + e / kx],
  };
}

/** Corridor frame: along = metres along the road bearing, across = metres to the left/right. */
export function makeCorridor({ length, halfWidth, bearing }) {
  const ux = Math.sin(bearing * DEG); // along-road unit vector in (east, north)
  const uy = Math.cos(bearing * DEG);
  const halfLength = length / 2;
  const toCorridor = (e, n) => [e * ux + n * uy, -e * uy + n * ux];
  const fromCorridor = (along, across) => [along * ux - across * uy, along * uy + across * ux];
  const inside = (e, n, eps = 1e-6) => {
    const [a, c] = toCorridor(e, n);
    return Math.abs(a) <= halfLength + eps && Math.abs(c) <= halfWidth + eps;
  };

  /**
   * Clip segment p->q (east/north) to the corridor rectangle (Liang–Barsky in corridor coordinates).
   * Returns [t0, t1] (fractions along the segment) or null if the segment misses the corridor.
   */
  const clipSegment = (p, q) => {
    const [a0, c0] = toCorridor(p[0], p[1]);
    const [a1, c1] = toCorridor(q[0], q[1]);
    let t0 = 0;
    let t1 = 1;
    const da = a1 - a0;
    const dc = c1 - c0;
    const checks = [
      [-da, a0 + halfLength],
      [da, halfLength - a0],
      [-dc, c0 + halfWidth],
      [dc, halfWidth - c0],
    ];
    for (const [pk, qk] of checks) {
      if (pk === 0) {
        if (qk < 0) return null;
      } else {
        const r = qk / pk;
        if (pk < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
        if (t0 > t1) return null;
      }
    }
    return [t0, t1];
  };

  /** Corner points of the corridor (east/north), padded by `margin` metres. */
  const corners = (margin = 0) =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sa, sc]) => fromCorridor(sa * (halfLength + margin), sc * (halfWidth + margin)));

  return { toCorridor, fromCorridor, inside, clipSegment, corners, halfLength, halfWidth };
}
