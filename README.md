# WHACK-26-
# Blind Simulator

A horror game played as a blind person on a real street. The screen is **pitch black**. You can only feel half an arm's reach around you. Make noise into your mic to fire a sonar wave that briefly reveals the street as a glowing grid mesh, but the louder you are, the further the entity hunting you can hear you. Colliding with things stuns you, costs score and gives the entity a better chance of catching you.

The demo is set on the University of Warwick campus using the geometry of Google Photorealistic 3D Tiles. Pedestrians and cars are our own objects moving along OpenStreetMap paths and roads.

---

## Rendering style (read this first)

- **White lines on black; red is allowed only for stuns and danger.** No other colour, no textures, no lighting. The background is black and every surface is black.
- The only things ever drawn are **grid lines and edges, lit by sonar** (or by the chosen vision mode, see "Vision modes"). Everything outside a sonar wave, the vision cone or the player's arm's-reach radius is invisible.
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
| Click to begin | On the start screen: starts the audio engine and the mic (browser permission prompt, then ~1.5 s calibration: stay quiet) and locks the mouse |
| Mouse | Look around (click the scene to re-lock after Esc) |
| WASD | Walk (speed builds up the longer you hold a key) |
| Speak / clap / shout | Voice sonar: a whisper reveals ~2 m, a shout ~20 m |
| Space / Shift+Space | Medium / max-strength voice ping (works with no mic) |
| C or hold right mouse | Hold to sweep the white cane; it taps on contact (small ping + sound) |
| V (cane held) | Hard cane tap: a bigger 4 m ping |
| O | Vision picker (blindness scale); O again or Resume to go back |
| U | Mute / unmute the soundscape |
| , / . | Sound volume down / up (saved per browser) |
| M | Mute / unmute the mic (note: M is earmarked for AUDIT's report; the mic mute moves when that lands) |
| Shift+C | Recalibrate the mic noise floor |
| [ / ] | Mic sensitivity down / up (pulse size; saved per browser) |
| - / = | Mic trigger level down / up (dB above room noise; saved per browser) |
| 0 | Reset mic tuning to the defaults |
| ` (backtick) | Audio debug meter |
| R | Debug: reveal everything (full grid on the real material; pings and red still draw on top) |
| F | Debug: free-fly camera (E/Q up/down, Shift fast, G back to eye height) |
| P / Shift+P | Dev builds only: fake ping of the next type / one of each type ahead |
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
  config.ts                location, corridor, detail, grid, arm reach, REVEAL TUNING
  render/sonarMaterial.ts  THE shared material: grid lines x (pings + vision + arm's reach), reveal-all
  render/pings.ts          active pings + world.vision -> shader uniforms
  render/pingColors.ts     per-type ping colour (red impacts) and trail level
  render/devPings.ts       dev-only fake pings (P)
  world/index.ts           exports the shared `world` object
  world/tiles.ts           loads tiles, strips textures, applies shared material
  world/osm.ts             OSM loading + lat/lon to local metres
  world/agents.ts          pedestrians + cars: paths, groups, crossings, player contacts
  world/humanoid.ts        procedural walking people, one InstancedMesh per body part
  world/agentMaterial.ts   agents' variant of the shared material (object-space grid, instancing)
  world/soundSources.ts    car engine pings, pedestrian step echo pings, impact pings
  world/pings.ts           ping pool + priority behind world.ping / world.activePings
  world/agentContacts.ts   capsule / oriented-box contact tests (no raycasts)
  world/heightField.ts     precomputed ground height grid agents stand on
  world/playArea.ts        play corridor: isInsidePlayArea, clampToPlayArea
  world/debug*.ts          R reveal-all key, F free-fly camera, debug readout
  player/controller.ts     first-person movement, stuns (world 'stunned' event)
  player/collision.ts      raycast wall + ground collision against world.tilesGroup
  senses/footsteps.ts      the player's footstep pings
  senses/cane.ts           white cane (sweep, contact taps)
  senses/vision*.ts        vision modes, presets, picker
  audio/                   mic -> voice pings; soundscape.ts spatial audio; synth.ts procedural sounds
  hud/                     attribution, start screen, stun vignette, cane gauge, vision label
```

## How the sonar material works

All visible output comes from one fragment shader (`src/render/sonarMaterial.ts`), used by tiles and agents alike:

- **Grid:** lines along the axes tangent to each surface, a coarse grid where the fine one gets too dense.
- **Reveal:** the maximum of the arm's reach glow, every active ping (an expanding ring with a fading trail, clipped to its range, styled per type) and the vision mode (always-visible surfaces within `visibleDistance` inside the gaze cone, minus the central blind spot).
- **Colour:** white, except pings with a colour (`src/render/pingColors.ts`: `impact` = red), which tint what they reveal and override white, including in reveal-all.

To fire a ping from anywhere: `world.ping(origin, range, type)`.

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
| **Mic** | Done: see "Audio sonar" below. Mic needs `localhost` or HTTPS. |
| **Collision** | Done: `src/player/collision.ts` raycasts only against `world.tilesGroup`; the controller also keeps the player inside the corridor. `getPlayerController().applyImpulse(vec, { impactSpeed, forceStun })` pushes the player through the normal momentum/friction/wall-sliding and stuns with the same thresholds as wall hits. Add `three-mesh-bvh` only if FPS drops. |
| **Spatial audio** | Done: `src/audio/soundscape.ts` (see "Soundscape"). It reads world state and never pings. |
| **Entity AI** | Use the OSM path graph from `src/world/osm.ts` for pathfinding; hear the player through `world.activePings()` (voice, footsteps, cane, impacts). Render it with `createSonarMaterial({ gridSpace: 'object' })`. |
| **Stuns** | `world.on('stunned', p)`: `{ duration, impactSpeed, intensity, position, source: 'wall' \| 'impulse' }` from `src/player/controller.ts`. |

## Audio sonar (mic → voice pings)

`src/audio/` turns mic noise into `world.ping(playerPos, range, 'voice')`, the same pings everything else uses (the shader draws them, the entity hears them).

```
mic.ts (getUserMedia, AGC/NS/EC off) → AnalyserNode (fft 2048, no smoothing, not connected to speakers)
  → detector.ts FeatureExtractor: RMS dBFS, peak, spectral centroid, spectral flux
  → detector.ts OnsetDetector.step(features, nowMs): adaptive noise floor, onset + classification
  → index.ts: world.ping(camera position, range, 'voice'), range = whisper..shout (REVEAL TUNING)
```

- `transient` (clap, click) and `sustained` (shout, hum held > 300 ms) both become voice pings; a held sound repeats at half strength every 400 ms.
- The mic and the soundscape only start from the start screen's click (`startAudio()`), as browsers require.

### Tuning for your mic and room

Every mic and room is different, so the detector adapts in real time at both ends:

- **Room noise (low end):** Shift+C runs a 1.5 s silent calibration, then the noise floor keeps following the room whenever you're quiet (fan on, window open…).
- **Mic loudness (high end), auto-range:** the loudest recent sound (+3 dB) counts as a full-size pulse. Louder sounds raise it instantly; each quieter sound pulls it down 30 %, and it also relaxes 0.5 dB/s, so a quiet or low-gain mic reaches full-size pulses after a few sounds. It's capped by the mic's headroom. Shift+C also resets it (new mic = press Shift+C).

**In game:** `[` `]` change sensitivity and `-` `=` change the trigger level. Changes show in the HUD, are saved per browser (localStorage) so each teammate keeps settings for their own mic, and `0` resets them.

**In code:** the QUICK TUNING block at the top of `src/audio/detector.ts`:

| Constant | Default | Meaning |
|---|---|---|
| `SENSITIVITY` | 1.0 | Pulse size multiplier. Pulses feel weak → 1.3–1.5 |
| `TRIGGER_DB` | 12 | dB above room noise needed to fire. Quiet sounds missed → 10–12; typing triggers → 20+ |
| `AUTO_RANGE` | true | Learn the mic's loudness. `false` = fixed scale of `FIXED_RANGE_DB` |
| `FIXED_RANGE_DB` | 40 | Only without auto-range: dB above the trigger that counts as full size |
| `STRENGTH_CURVE` | 0.7 | < 1 boosts quiet/medium sounds, 1 = linear |
| `MIN_RADIUS_M`, `MAX_RADIUS_M` | 2, 20 | Smallest / largest voice ping (set by `VOICE_RANGE_WHISPER` / `VOICE_RANGE_SHOUT` in `src/config.ts`) |

Open the meter with backtick: green bar = RMS, white line = noise floor, red line = trigger threshold, blue line = learned full-strength level, flash = detection. The blue line text (`full @ +NN dB`) shows how far above the room noise a sound must be to make a full-size pulse.

### All knobs (`DETECTOR_CONFIG` in `src/audio/detector.ts`)

| Knob | Default | Turn it… |
|---|---|---|
| `thresholdDb` | 12 | up if typing / background noise triggers; down if claps are missed |
| `refractoryMs` | 250 | up if one clap gives two pulses |
| `fluxMin` | 0.35 | up if slow swells trigger; down if soft onsets are missed |
| `transientDropDb`, `sustainMs` | 12 dB, 300 ms | control transient vs sustained; raise `sustainMs` if claps in a reverberant room read as sustained |
| `sustainRepeatMs`, `sustainRepeatScale` | 400 ms, 0.5 | rate and size of pulses while a sound is held |
| `autoRangeStartDb`, `autoRangeHeadroomDb`, `autoRangeLearnRate`, `autoRangeDecayDbPerS` | 45 dB, 3 dB, 0.3, 0.5 dB/s | auto-range: starting full-strength level, how it learns up/down |
| `autoRangeMinSpanDb`, `ceilingDb` | 12 dB, -6 dBFS | auto-range limits: tiny sounds can't max out; mic headroom cap |
| `minRadius`, `maxRadius` | 2, 20 m | voice ping range at strength 0 / 1 |
| `transientSpeed`, `sustainedSpeed` | 45, 25 m/s | wave speed per kind |
| `floorRiseTauS`, `floorFallTauS` | 4, 0.6 s | how fast the noise floor adapts while quiet |
| `calibrationMs` | 1500 | silent calibration length (Shift+C reruns it) |
| `keyboardStrength` | 0.5 | SPACE strength (Shift+SPACE is always 1) |

Clap pulses fire when the clap's energy dies away (about 80 ms), so loudness is measured over the whole clap. `dispose()` from `src/audio` stops the mic tracks, closes the AudioContext and removes the overlay and listeners.

## Agents (pedestrians and cars)

- `PEDESTRIAN_COUNT` / `CAR_COUNT` in `src/config.ts`. Pedestrians are procedural low-poly humanoids (1.6 to 1.9 m, 1.1 to 1.6 m/s) drawn with one `InstancedMesh` per body part and a sine-wave walk cycle; some walk in groups of 2 to 3, some loiter, some cross University Road, and they lightly avoid each other.
- **Player contact** is checked every frame with shapes, not raycasts: the player is a 0.3 m capsule, pedestrians are capsules, cars are 4.4 x 1.5 x 1.8 m oriented boxes.
  - Pedestrian: player and pedestrian get an equal and opposite push along the contact normal; the pedestrian stumbles for 1.5 s, then walks back to the nearest point on its path. The player is stunned if the closing speed passes the wall-hit threshold.
  - Car: never reacts and keeps driving. The player is flung along the normal plus part of the car's velocity, scaled by car speed + player speed, and always stunned.
- Agents stand on a ground height grid (every 2 m) built from `groundHeight()` after the tiles load, so there is no per-agent raycast.
- Sound: cars ping periodically (range capped at `CAR_PING_RANGE_MAX`). Pedestrians' steps are heard by the soundscape at once (`onPedestrianStep` in `src/world/soundSources.ts`); within `PED_PING_RADIUS` they also make a faint ping 0.3–0.5 s later, like an echo. Collisions fire a red `impact` ping (the entity hears it through `world.activePings()`).

## Reveal tuning

One labelled block in `src/config.ts` sets how much each sound reveals:

| Constant | Default | Meaning |
|---|---|---|
| `PED_PING_RADIUS` | 10 m | pedestrians only ping this close to you (you hear them further away) |
| `PED_PING_RANGE`, `PED_PING_BRIGHTNESS` | 1.5 m, 0.2 | size and faintness of a pedestrian step ping |
| `PED_PING_ECHO_DELAY_MIN/MAX` | 0.3, 0.5 s | delay from a step's sound to its ping |
| `VOICE_RANGE_WHISPER`, `VOICE_RANGE_SHOUT` | 2, 20 m | voice ping range for the quietest / loudest sound |
| `VOICE_FADE`, `VOICE_TRAIL_LEVEL` | 2.2 /s, 0.18 | how fast and how bright the voice trail is (a shout shows the street briefly) |
| `CAR_PING_RANGE_MAX` | 12 m | cap on car engine pings |

Footstep and cane ranges live in `src/senses/config.ts`; ping looks per type in `src/world/soundConfig.ts`.

## Start screen and startup

`src/hud/startScreen.ts` shows a white-on-black start screen (title, one line of controls, the vision picker) that hides the load. "Click to begin" lights up once OSM agents are spawned, the tiles have loaded and the ground height grid has been built from them; it then starts the audio engine (inside the click, as browsers require) and locks the mouse. If loading stalls, begin is allowed anyway after 30 s.

While the start screen is up the ground grid builds in loading mode (24 ms per frame and a 400 ms settle wait instead of 3 ms and 1.5 s), because nobody is playing yet. The console prints one `[startup]` line with the timings. Measured on an M3 from the tile cache: tiles loaded at 1.4 s, ground grid ready at 2.7 s, start screen ready at 3.1 s. The old lag was mostly the ground grid: at the in-game budget it takes ~6.6 s after a 1.5 s settle wait, and agents stand at y = 0 until it's done. A cold first load also spends ~0.8 s evaluating modules (dev server, unbundled).

## Vision modes

`world.setVision(id)` / `world.vision` (`src/senses/vision.ts`). Presets (`src/senses/visionConfig.ts`): **total blindness** (default), **light perception only**, **severe tunnel vision** (< 10° of field), **central field loss** (30° blind spot, blurry periphery), **low acuity** (full field, very blurred), plus a **0–100 severity** slider (`severity:N`) from low acuity to total blindness. Pick on the start screen or with O; the current mode is shown top right and saved per browser. Pings always reveal on top.

## Soundscape

`src/audio/soundscape.ts`: Web Audio with HRTF panners; the listener follows the camera. Car engines (pitch and level follow speed, exaggerated Doppler), pedestrian footsteps and murmured conversations in groups, your own steps / cane taps / stun thud, the entity's uneven steps, and a quiet ambient bed. About 10 spatial voices at once, faded in and out. All sounds are procedural; list CC0 files in `SFX_FILES` (`src/audio/soundscapeConfig.ts`, files in `public/sfx/`) to replace any of them.

## White cane

Hold C or right mouse to sweep the cane (1.2 m, 60°), drawn as a thin white line (look down to see it) with a gauge at the bottom of the screen. Contacts with walls, curbs or posts give a 1.5 m `cane` ping, a tap sound and an audit record; V gives a hard 4 m tap.

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
| Agents float or sit underground | Agents use the height grid from `src/world/heightField.ts`, built a few seconds after the tiles finish loading (the console prints `[ground] height grid ready`); until then they sit at y = 0 |
| OSM roads don't line up with tiles | Adjust `YAW_OFFSET` / `XZ_OFFSET` in `src/config.ts` with F + R |
| Mic doesn't work | Must be served from `localhost` or HTTPS; check browser permissions |