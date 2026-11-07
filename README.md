# WHACK-26-
# Blind Simulator

A horror game played as a blind person on a real street. The screen is **pitch black**. You can only feel half an arm's reach around you. Make noise into your mic to fire a sonar wave that briefly reveals the street as a glowing grid mesh, but the louder you are, the further the entity hunting you can hear you. Colliding with things stuns you, costs score and gives the entity a better chance of catching you.

The demo is set on the University of Warwick campus using the geometry of Google Photorealistic 3D Tiles. Pedestrians and cars are our own objects moving along OpenStreetMap paths and roads.

---

## Rendering style (read this first)

- **No colour, no textures, no lighting.** The background is black and every surface is black.
- The only things ever drawn are **grid lines and edges, lit by sonar**. Everything outside a sonar wave or the player's arm's-reach radius is invisible.
- Tiles and agents all share **one material**: `src/render/sonarMaterial.ts`. It draws a world-space grid on each surface and multiplies it by a sonar reveal mask. The sonar lives in this material, so there's no separate post-processing pass.
- Google tile textures can't be stripped server-side, so each tile still downloads with its textures. On load, `src/world/tiles.ts` **throws away every tile's original material and texture** (dispose + replace with the shared material) so nothing colour-related stays in GPU memory.
- Not used: lighting, shadows, tone mapping, environment maps, fade plugins, KTX2 textures, post-processing libraries.

## Dependencies (kept minimal)

| Package | Used for |
|---|---|
| `three` | Rendering, `PointerLockControls`, `Raycaster`, `PositionalAudio`, and the Draco decoder (copied from `three/examples/jsm/libs/draco`) |
| `3d-tiles-renderer` | Streaming Google tiles; plugins used: `GLTFExtensionsPlugin` (Draco), `ReorientationPlugin`, `GoogleCloudAuthPlugin` (direct fallback only) |
| `vite`, `typescript`, `@types/three` | Dev only |

Everything else uses built-ins: the proxy, OSM fetch and dev launcher are plain Node scripts (built-in `fetch`, `http`, `child_process`), and the mic is the Web Audio API. Don't add packages without checking these first.

---

## Requirements

- Node **20.6+** (`node -v` to check)
- A Google Cloud project with the **Map Tiles API** enabled and an API key restricted to that API
- Headphones and a mic for testing

## Setup

```bash
npm install
npm run setup:draco   # copies three's Draco decoder into public/draco/
cp .env.example .env  # then paste your key into .env
```

`.env`:

```
GOOGLE_MAPS_KEY=
PORT=8787
OFFLINE=0
VITE_TILES_DIRECT=0
VITE_GOOGLE_MAPS_KEY=
```

`.env` and `tile-cache/` must stay in `.gitignore`. Never commit the key. Share it with teammates by DM only.

## Run

```bash
npm run dev:all      # scripts/dev-all.mjs starts the tile proxy and Vite together
```

Or run them separately:

```bash
node --env-file=.env proxy/cache-proxy.mjs   # tile proxy on http://localhost:8787
npm run dev                                   # game on http://localhost:5173
```

Check the proxy works by opening http://localhost:8787/v1/3dtiles/root.json. You should see JSON.

### Controls

| Key | Action |
|---|---|
| Click | Lock the mouse (first-person look) |
| WASD | Walk |
| Space | Test sonar ping (until the mic is wired in) |
| F | Toggle the free-fly debug camera |
| R | Debug: reveal everything (full grid, no sonar mask), for checking alignment |
| Esc | Release the mouse |

## Map data

### Google 3D Tiles (geometry only)

Tiles stream through `proxy/cache-proxy.mjs`, which adds the API key server-side and saves every tile to `tile-cache/`.

Only tiles touching the play corridor (plus `CORRIDOR_TILE_MARGIN`) are loaded. Every tile inside the corridor loads at Google's finest level whichever way you look, so one visit warms the whole corridor.

**Sessions (why the proxy reuses one):** Google's tile file paths are different in every session, so cached tiles only match the session whose `root.json` points to them. The proxy therefore keeps **one session for 150 minutes** (`SESSION_MAX_AGE_MIN`; Google sessions last about 3 hours). Page reloads and proxy restarts within that window reuse the cached `root.json`, so tiles come from the cache. After that the proxy starts a new session and keeps the previous root as `tile-cache/v1/3dtiles/root.<timestamp>.json`. Watch for `[session] new Google session started` in the proxy log. `SESSION_MAX_AGE_MIN=0` starts a new session on every load.

**Warming the cache before the demo:**

1. Optionally clear `tile-cache/` so it only holds the session you're about to warm.
2. Run `npm run dev:all` online (`OFFLINE=0`), open the game and wait about 30 s until the proxy's `[stats]` line stops growing.
3. Optional check: press **R** then **F**, walk University Road at eye height (**G** drops you to 1.7 m) and wait for `loading no` in the debug readout.
4. Finish within 150 minutes of the `[session] new Google session started` line. If a new session started after you'd warmed, copy the newest `root.<timestamp>.json` over `tile-cache/v1/3dtiles/root.json`.
5. Restart with `OFFLINE=1 npm run dev:all` and reload. Each `[offline miss]` in the proxy log is a gap: go back online (within the same session) and load that spot.
6. Zip `tile-cache/` as a backup and run the demo with `OFFLINE=1`. If you change any `CORRIDOR_*` value, re-run `npm run fetch:osm` and warm again.

### OpenStreetMap (pedestrian and car paths)

```bash
npm run fetch:osm                             # saves public/osm.json
node scripts/road-bearing.mjs "University Road"   # measures CORRIDOR_BEARING from OSM
```

Run `fetch:osm` online whenever the origin or corridor changes; `public/osm.json` is committed, so agents work offline. The script reads the origin and corridor from `src/config.ts`, queries every highway way in the corridor's bounding box, and clips the ways to the corridor. Where a way crosses the boundary, a node is added on it. OSM is openly licensed (© OpenStreetMap contributors, ODbL), so storing it is fine.

### Setting the location and play area

Edit `src/config.ts`:

- `ORIGIN_LAT`, `ORIGIN_LON`: the street the game is centred on (currently 52.380282, -1.559057, outside the Oculus on University Road)
- `ORIGIN_HEIGHT`: ground height at the origin above the WGS84 ellipsoid, so the ground sits at y = 0 (132.9 m). `AUTO_GROUND` corrects small errors; re-measure if you move the origin.
- **Play corridor** (replaces the old circular `PLAY_RADIUS`): a straight rectangle centred on the origin. It limits tile loading, the OSM fetch, agents and the boundary walls (`world.isInsidePlayArea`).
  - `CORRIDOR_LENGTH`: metres along the road (200)
  - `CORRIDOR_HALF_WIDTH`: metres either side of the centre line (40)
  - `CORRIDOR_BEARING`: road direction in degrees clockwise from north (29.0, measured with `scripts/road-bearing.mjs`)
  - `CORRIDOR_TILE_MARGIN`: tiles also load this far beyond the walls so edges don't pop (15)
- `TILES_ERROR_TARGET`: screen-space error for what the camera sees; lower = more detail (2)
- `CORRIDOR_MIN_DETAIL`: every tile in the corridor refines to at most this geometric error even off-screen (2.1 = Google's finest here)
- `PLAY_RADIUS`: **deprecated**, kept only so old code compiles; it's now the radius of the circle around the corridor. `TILE_LOAD_RADIUS` has been **removed**.
- `YAW_OFFSET`, `XZ_OFFSET`: tweak until OSM roads line up with the tile grid (use F + R)
- `GRID_SIZE`: spacing of the world-space grid lines in metres (default 0.5)
- `ARM_REACH`: always-visible radius around the player in metres (default 0.4)

## Project structure

```
proxy/cache-proxy.mjs      tile cache proxy
scripts/fetch-osm.mjs      downloads OSM paths/roads in the corridor to public/osm.json
scripts/road-bearing.mjs   measures CORRIDOR_BEARING from a named OSM road
scripts/lib/               shared helpers for the OSM scripts
scripts/dev-all.mjs        runs proxy + vite together (no extra deps)
src/
  main.ts                  renderer (black clear colour) + main loop
  config.ts                location, corridor, detail, grid, arm reach
  render/sonarMaterial.ts  THE shared material: grid lines x sonar mask
  render/pings.ts          active pings -> shader uniforms
  world/index.ts           exports the shared `world` object
  world/tiles.ts           loads tiles, strips textures, applies shared material
  world/osm.ts             OSM loading + lat/lon to local metres
  world/agents.ts          pedestrians (capsules) and cars (boxes)
  world/playArea.ts        play corridor: isInsidePlayArea, clampToPlayArea
  world/debug*.ts          R reveal-all grid, F free-fly camera, debug readout
  player/controller.ts     first-person movement
  player/collision.ts      collision + ground stubs (to be implemented)
  hud/hud.ts               FPS + attribution overlay
```

## How the sonar material works

All visible output comes from one fragment shader:

```glsl
// world-space grid lines on every surface
vec3 g = abs(fract(vWorldPos / uGridSize - 0.5) - 0.5) / fwidth(vWorldPos / uGridSize);
float grid = 1.0 - min(min(g.x, g.y), g.z);

// reveal mask: arm's reach + every active ping
float reveal = 1.0 - smoothstep(uArmReach * 0.8, uArmReach, distance(vWorldPos, uPlayerPos));
for (int i = 0; i < MAX_PINGS; i++) {
  float d = distance(vWorldPos, uPingOrigin[i]);
  float age = uTime - uPingStart[i];
  float r = age * uWaveSpeed;
  float ring = 1.0 - smoothstep(0.0, 0.6, abs(d - r));
  float trail = step(d, r) * exp(-age * 1.5);
  reveal = max(reveal, max(ring, trail * 0.4) * step(d, uPingRange[i]));
}

gl_FragColor = vec4(vec3(grid * reveal), 1.0);   // white lines on black, nothing else
```

To fire a ping from anywhere: `world.ping(origin, range)`.

## Plugging in (for teammates)

Everything hooks into the shared `world` object from `src/world/index.ts`:

```ts
import { world } from './world';

world.scene          // THREE.Scene (black)
world.camera         // player camera
world.renderer       // THREE.WebGLRenderer
world.tilesGroup     // Google tile geometry
world.agentsGroup    // pedestrians + cars
world.agents         // [{ type, position, velocity, loudness }]
world.ping(origin, range)          // fire a sonar wave
world.isInsidePlayArea(pos)        // false beyond the corridor walls (player must not go there)
world.onUpdate((dt) => { /* runs every frame */ });
```

| Feature | Where to plug in |
|---|---|
| **Sonar look** | Tune `src/render/sonarMaterial.ts` (wave speed, ring width, fade, grid density). Don't add per-object materials. |
| **Mic** | `src/audio/mic.ts`: Web Audio `getUserMedia` + `AnalyserNode`. Calibrate ambient noise on start; above baseline + ~15 dB, call `world.ping(playerPos, rangeFromDb)`. Mic needs `localhost` or HTTPS. |
| **Collision** | Fill in `checkCollision(pos, dir)` and `groundHeight(pos)` in `src/player/collision.ts` (raycasts against `world.tilesGroup`, which works on geometry with no textures). The corridor walls are `world.isInsidePlayArea(pos)`; `clampToPlayArea()` in `src/world/playArea.ts` pushes a position back inside. Add `three-mesh-bvh` only if FPS drops. |
| **Spatial audio** | Attach `THREE.PositionalAudio` to each entry in `world.agents` (footsteps, engines). |
| **Entity AI** | Use the OSM path graph from `src/world/osm.ts` for pathfinding; move towards the player's last noise position. Render it with the shared material too. |

## Attribution (must stay visible)

- The Google Maps logo and the tiles' copyright text, shown in the HUD corner in white
- "© OpenStreetMap contributors"

The HUD is a normal HTML overlay, so it stays visible even though the 3D scene is black.

## Costs and safety

- Billing is per root tile request (roughly per scene load). Normal hackathon use stays within the free monthly allowance.
- Keep the key restricted to the Map Tiles API and a £5 budget alert set in Google Cloud.

## Troubleshooting

| Problem | Fix |
|---|---|
| Totally black, even with R | Check the proxy log. `[upstream 403]` means the Map Tiles API isn't enabled, billing isn't attached, or the key is restricted to the wrong API |
| Tiles show colour | A tile loaded before the material swap ran: make sure the swap is in the tiles `load-model` event, not a one-off pass |
| Tiles stop loading in new areas | Areas outside the corridor never load: change `CORRIDOR_*` in `src/config.ts`. Inside it, check the proxy log for `[upstream 4xx]` (expired session: the proxy starts a new one after 150 min) |
| `[offline miss]` for tiles you'd warmed | The cached `root.json` is from a newer session. Copy the warmed session's `tile-cache/v1/3dtiles/root.<timestamp>.json` over `root.json` |
| `--env-file` not recognised | Upgrade Node to 20.6+ |
| Grid lines shimmer far away | Normal with dense meshes; shorten `CORRIDOR_LENGTH` or fade the grid with distance in the shader |
| Agents float or sit underground | Ground stub returns 0 until collision is implemented; adjust height in config for now |
| OSM roads don't line up with tiles | Adjust `YAW_OFFSET` / `XZ_OFFSET` in `src/config.ts` with F + R |
| Mic doesn't work | Must be served from `localhost` or HTTPS; check browser permissions |