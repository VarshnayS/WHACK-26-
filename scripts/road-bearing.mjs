/**
 * scripts/road-bearing.mjs: measure the corridor angle from a named OSM road
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * Usage: node scripts/road-bearing.mjs ["University Road"]
 *
 * Reads ORIGIN_LAT/LON, CORRIDOR_LENGTH and CORRIDOR_HALF_WIDTH from src/config.ts, downloads the
 * road's geometry from Overpass (built-in fetch), and searches every compass bearing (0.5° steps)
 * for the one whose corridor (centred on the origin) contains the most of the road, tie-broken by
 * the smallest sideways spread. Paste the printed value into CORRIDOR_BEARING in src/config.ts.
 * Roads curve, so a straight corridor is a compromise; the output says how much of the road fits.
 */
import { makeCorridor, makeProjection, queryOverpass, readConfig } from './lib/osm-common.mjs';

const ROAD_NAME = process.argv[2] ?? 'University Road';
const { lat, lon, length, halfWidth } = await readConfig();
const radius = Math.ceil(Math.hypot(length / 2, halfWidth) + 50);

const json = await queryOverpass(
  `[out:json][timeout:60];
way["highway"]["name"="${ROAD_NAME.replace(/"/g, '\\"')}"](around:${radius},${lat},${lon});
out geom;`,
  'road-bearing',
);
const ways = json.elements ?? [];
if (ways.length === 0) throw new Error(`No highway named "${ROAD_NAME}" within ${radius} m of the origin`);

// Densify every way to ~1 m spacing so long straight segments count as much as curvy ones.
const { toEN } = makeProjection(lat, lon);
const points = [];
for (const way of ways) {
  const g = way.geometry.map((p) => toEN(p.lat, p.lon));
  for (let i = 1; i < g.length; i++) {
    const [a, b] = [g[i - 1], g[i]];
    const segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let t = 0; t < segment; t += 1) points.push([a[0] + ((b[0] - a[0]) * t) / segment, a[1] + ((b[1] - a[1]) * t) / segment]);
  }
}

let best = null;
for (let bearing = 0; bearing < 180; bearing += 0.5) {
  const corridor = makeCorridor({ length, halfWidth, bearing });
  let inLength = 0;
  let inside = 0;
  let spread = 0;
  for (const [e, n] of points) {
    const [along, across] = corridor.toCorridor(e, n);
    if (Math.abs(along) > length / 2) continue;
    inLength++;
    if (Math.abs(across) <= halfWidth) inside++;
    spread = Math.max(spread, Math.abs(across));
  }
  if (inLength === 0) continue;
  const score = inside / inLength;
  if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && spread < best.spread)) {
    best = { bearing, score, spread };
  }
}

console.log(`[road-bearing] "${ROAD_NAME}": ${ways.length} OSM ways (${ways.map((w) => w.id).join(', ')})`);
console.log(
  `[road-bearing] best corridor bearing ${best.bearing.toFixed(1)}° clockwise from north: ` +
    `${(best.score * 100).toFixed(1)}% of the road within ±${length / 2} m along stays within ±${halfWidth} m across ` +
    `(furthest ${best.spread.toFixed(1)} m from the centre line)`,
);
console.log(`[road-bearing] set in src/config.ts: export const CORRIDOR_BEARING = ${best.bearing.toFixed(1)};`);
