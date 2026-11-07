/**
 * src/config.ts: location, offsets, radius, grid, arm reach
 * Owner: shared (values tuned by @USERNAME_A on feat/world-foundation; tell the team before editing)
 *
 * Plain constants only: no logic here, so edits never conflict with module code.
 */

/** Street the game is centred on (University of Warwick campus). */
export const ORIGIN_LAT = 52.3793;
export const ORIGIN_LON = -1.5615;

/** Tweak until OSM roads line up with the tile grid (use F + R in game). */
export const YAW_OFFSET = 0; // radians
export const XZ_OFFSET = { x: 0, z: 0 }; // metres

/** Playable area radius in metres. */
export const PLAY_RADIUS = 250;

/** Spacing of the world-space grid lines in metres. */
export const GRID_SIZE = 0.5;

/** Always-visible radius around the player in metres. */
export const ARM_REACH = 0.4;

/** Player eye height in metres. */
export const EYE_HEIGHT = 1.7;

/** Sonar wave speed in metres per second (tuned in src/render/sonarMaterial.ts). */
export const WAVE_SPEED = 30;

/** Tile proxy (proxy/cache-proxy.mjs). Port must match PORT in .env. */
export const PROXY_ORIGIN = 'http://localhost:8787';

/** true = bypass the proxy and use VITE_GOOGLE_MAPS_KEY directly (fallback only). */
export const TILES_DIRECT = import.meta.env.VITE_TILES_DIRECT === '1';

export const TILES_ROOT_URL = TILES_DIRECT
  ? 'https://tile.googleapis.com/v1/3dtiles/root.json'
  : `${PROXY_ORIGIN}/v1/3dtiles/root.json`;

/** OSM data written by scripts/fetch-osm.mjs. */
export const OSM_URL = '/osm.json';
