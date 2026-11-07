/**
 * src/config.ts: location, offsets, radius, grid, arm reach
 * Owner: shared (values tuned by @USERNAME_A on feat/world-foundation; tell the team before editing)
 *
 * Plain constants only: no logic here, so edits never conflict with module code.
 */

/**
 * Street the game is centred on (University of Warwick campus), in degrees.
 * scripts/fetch-osm.mjs reads these two lines and the CORRIDOR_* values with a regex:
 * keep them as plain `export const NAME = <number>;`.
 */
export const ORIGIN_LAT = 52.380282;
export const ORIGIN_LON = -1.559057;

/**
 * Approximate ground height at the origin above the WGS84 ellipsoid, in metres
 * (measured with AUTO_GROUND at the origin outside the Oculus: ~85 m above sea level + ~48 m geoid offset). Tiles are placed so this height
 * sits at y = 0; AUTO_GROUND then fine-tunes it by raycasting the loaded tiles.
 */
export const ORIGIN_HEIGHT = 132.9;

/** Re-level the tiles so the ground at the origin is y = 0 (first minute after loading only). */
export const AUTO_GROUND = true;

/**
 * Local axes after reorientation (Y up, metres): +X = west, +Z = north, origin at ORIGIN_LAT/LON.
 * Tweak these until OSM roads line up with the tile grid (use F + R in game).
 * They move the OSM paths/agents, not the tiles.
 */
export const YAW_OFFSET = 0; // radians, rotation about +Y
export const XZ_OFFSET = { x: 0, z: 0 }; // metres

/**
 * Play area: a straight corridor along University Road, centred on the origin.
 * Used for tile loading, the OSM fetch/clip, agents, and the boundary walls (world.isInsidePlayArea).
 * scripts/fetch-osm.mjs and scripts/road-bearing.mjs read these with a regex: keep them plain numbers.
 */
export const CORRIDOR_LENGTH = 200; // metres along the road (100 m each way from the origin)
export const CORRIDOR_HALF_WIDTH = 40; // metres either side of the centre line
/** Compass bearing of the road, degrees clockwise from north. Measured: node scripts/road-bearing.mjs */
export const CORRIDOR_BEARING = 29.0;
/** Tiles also load this far beyond the corridor so its edges don't pop in and out. */
export const CORRIDOR_TILE_MARGIN = 15;

/** @deprecated Circular play area replaced by the corridor. Radius of the circle around the corridor. */
export const PLAY_RADIUS = Math.hypot(CORRIDOR_LENGTH / 2, CORRIDOR_HALF_WIDTH);

/**
 * 3d-tiles-renderer screen-space error target for what the camera sees: lower = more detail.
 * 2 = Google's finest tiles out to the far end of the corridor (16 only reached them within ~100 m).
 */
export const TILES_ERROR_TARGET = 2;

/**
 * Every tile inside the corridor is refined until its geometric error is at most this many metres,
 * whether or not the camera is looking at it, so geometry behind the player (sonar, collision) is as
 * detailed as in front. Google's finest tiles here are ~2 m, so 2.1 = finest everywhere in the corridor.
 * Raise it (e.g. 4.1) if memory or FPS suffers.
 */
export const CORRIDOR_MIN_DETAIL = 2.1;

/** Camera clipping planes in metres. */
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 3000;

/** Where `npm run setup:draco` copies three's Draco decoder (served by Vite from public/). */
export const DRACO_PATH = '/draco/';

/** Range in metres of the debug test ping fired with Space. */
export const TEST_PING_RANGE = 40;

/** Spacing of the world-space grid lines in metres. */
export const GRID_SIZE = 0.5;

/** Pedestrians walking the footways (src/world/agents.ts): some in groups, some idling, a few crossing the road. */
export const PEDESTRIAN_COUNT = 50;

/** Cars driving the roads (src/world/agents.ts). */
export const CAR_COUNT = 6;

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
