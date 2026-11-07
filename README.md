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

**Warming the cache before the demo:**

1. Run the proxy online (`OFFLINE=0`).
2. Press **R** (reveal all) and walk or fly the **whole playable route** at eye height (1.7 m), looking in every direction. Tile detail depends on camera distance, so anything you don't see up close won't be cached at full detail.
3. Restart the proxy with `OFFLINE=1` and replay the route. Each `[offline miss]` in the proxy log is a gap: go back online and cover that spot.

**Session gotcha:** `root.json` is cached too, and its session token expires after about 3 hours. Cached tiles keep working, but new areas will fail. Delete the cached `root.json` entry (or clear `tile-cache/`) before warming new areas.

### OpenStreetMap (pedestrian and car paths)

```bash
node scripts/fetch-osm.mjs   # saves public/osm.json
```

Run this once (online). The game reads `public/osm.json`, so agents work offline. OSM is openly licensed, so storing it is fine.

### Setting the location

Edit `src/config.ts`:

- `ORIGIN_LAT`, `ORIGIN_LON`: the street the game is centred on
- `YAW_OFFSET`, `XZ_OFFSET`: tweak until OSM roads line up with the tile grid (use F + R)
- `PLAY_RADIUS`: playable area in metres (default about 250 m)
- `GRID_SIZE`: spacing of the world-space grid lines in metres (default 0.5)
- `ARM_REACH`: always-visible radius around the player in metres (default 0.4)

## Project structure

```
proxy/cache-proxy.mjs      tile cache proxy
scripts/fetch-osm.mjs      downloads OSM paths/roads to public/osm.json
scripts/dev-all.mjs        runs proxy + vite together (no extra deps)
src/
  main.ts                  renderer (black clear colour) + main loop
  config.ts                location, offsets, radius, grid, arm reach
  render/sonarMaterial.ts  THE shared material: grid lines x sonar mask
  render/pings.ts          active pings -> shader uniforms
  world/index.ts           exports the shared `world` object
  world/tiles.ts           loads tiles, strips textures, applies shared material
  world/osm.ts             OSM loading + lat/lon to local metres
  world/agents.ts          pedestrians (capsules) and cars (boxes)
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
world.onUpdate((dt) => { /* runs every frame */ });
```

| Feature | Where to plug in |
|---|---|
| **Sonar look** | Tune `src/render/sonarMaterial.ts` (wave speed, ring width, fade, grid density). Don't add per-object materials. |
| **Mic** | `src/audio/mic.ts`: Web Audio `getUserMedia` + `AnalyserNode`. Calibrate ambient noise on start; above baseline + ~15 dB, call `world.ping(playerPos, rangeFromDb)`. Mic needs `localhost` or HTTPS. |
| **Collision** | Fill in `checkCollision(pos, dir)` and `groundHeight(pos)` in `src/player/collision.ts` (raycasts against `world.tilesGroup`, which works on geometry with no textures). Add `three-mesh-bvh` only if FPS drops. |
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
| Tiles stop loading in new areas | Session expired: clear the cached `root.json` and reload |
| `--env-file` not recognised | Upgrade Node to 20.6+ |
| Grid lines shimmer far away | Normal with dense meshes; reduce `PLAY_RADIUS` or fade the grid with distance in the shader |
| Agents float or sit underground | Ground stub returns 0 until collision is implemented; adjust height in config for now |
| OSM roads don't line up with tiles | Adjust `YAW_OFFSET` / `XZ_OFFSET` in `src/config.ts` with F + R |
| Mic doesn't work | Must be served from `localhost` or HTTPS; check browser permissions |