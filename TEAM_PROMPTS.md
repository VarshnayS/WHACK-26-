# Team prompts: base demo (Tier 1)

Each person runs **their own prompt in Claude Code on their own laptop**, in their clone of the repo. Rules and file ownership are in `AGENTS.md`. Agents talk to each other only through the GitHub issue **"Agent coordination"**.

| Person | Agent | Branch | Job |
|---|---|---|---|
| Varshnay | (setup) | `chore/contracts` | Step 0: shared contract, runs first |
| Varshnay | SOUND | `feat/sound-sources` | Typed pings, ping budget, cars/pedestrians as sound sources |
| Varshnay | AUDIT | `feat/audit` | Collision log + hotspot map (key M) |
| Suleman | RENDER | `feat/sonar-render` | The sonar shader actually reveals the world from pings |
| Guneet | SENSES | `feat/mic-hud-audio` | Mic, footsteps, collision logging, wall bug, HUD + Google logo |
| Ayo | ENTITY | `feat/entity` | The hunter: hears pings, patrols, chases, catches |

**Base demo is done when:** it's pitch black; footsteps and voice reveal the street; cars pulse sonar; collisions stun and get logged; the entity hunts you by sound and can catch you; M shows a hotspot map; the Google logo and attribution are visible.

**Order:** Step 0 is merged → everyone pulls and starts at the same time → integration checkpoint about 90 min later, merging RENDER → SOUND → SENSES → ENTITY → AUDIT → play the whole demo → only then Tier 2.

**Everyone:** never open or paste `.env` into Claude Code. Use `/model opus` and `/effort high` for RENDER and ENTITY; Sonnet is fine for the rest.

---

## Step 0: Varshnay (run first, about 10 min)

**Where:** your main repo folder, on an up-to-date main, with the new `AGENTS.md` and this file in the repo root.

```
Create the shared contract so five agents can build in parallel without touching each other's files. Create branch chore/contracts from an up-to-date main. No feature logic: only types, no-op stubs, wiring and docs.

1. src/shared/contracts.ts:
   - type PingType = 'voice' | 'footstep' | 'cane' | 'car' | 'pedestrian' | 'impact'
   - interface PingStyle { speed: number; thickness: number; brightness: number; fade: number }
   - interface ActivePing { origin: Vector3; range: number; type: PingType; start: number; style: PingStyle }
   - const MAX_PINGS = 32
   - type HitKind = 'building' | 'low_obstacle' | 'street_furniture' | 'pedestrian' | 'car' | 'boundary' | 'entity'
   - interface AuditEvent { kind: 'collision' | 'detected' | 'hesitation' | 'caught'; hit?: HitKind; position: Vector3; impactSpeed?: number; normal?: Vector3; caneActive?: boolean }
   - interface VisionMode { id: string; label: string; visibleDistance: number; fovDeg: number; centralLossDeg: number; peripheralLimitDeg: number }
   - type EntityStateName = 'patrol' | 'investigate' | 'chase' | 'caught'
   - interface EntityState { state: EntityStateName; position: Vector3; velocity: Vector3 }

2. On the world object (src/world/index.ts, additive only), with safe no-op defaults:
   - world.ping(origin, range, type = 'voice'). Existing 2-argument calls must keep working.
   - world.activePings(): ActivePing[] (returns [] for now)
   - world.audit = { record(e: AuditEvent) {} }
   - world.vision (default: total blindness) and world.setVision(id)
   - world.entity: EntityState | null (null for now)
   - A tiny event bus: world.on(name, cb), world.off(name, cb), world.emit(name, payload). Events: 'caught', 'entityState', 'stunned'.

3. Stub entry points that do nothing yet, each called once from src/main.ts:
   - src/world/soundSources.ts → initSoundSources(world)
   - src/audit/index.ts → initAudit(world)
   - src/senses/index.ts → initSenses(world), which calls initVision(world) from src/senses/vision.ts (also a stub)
   - src/entity/index.ts → initEntity(world)

4. Empty config files so nobody shares one: src/world/soundConfig.ts, src/audit/config.ts, src/senses/config.ts, src/senses/visionConfig.ts, src/entity/config.ts.

5. Add AGENTS.md and TEAM_PROMPTS.md (already in the folder), and a CLAUDE.md containing only: @AGENTS.md
   Update .github/CODEOWNERS to match AGENTS.md section 1, using these GitHub usernames: Varshnay = [VARSHNAY_GH], Suleman = [SULEMAN_GH], Guneet = [GUNEET_GH], Ayo = [AYO_GH]; src/shared/ → everyone.

6. Create the GitHub issue: gh issue create --title "Agent coordination" --body "Coordination channel for parallel agents. See AGENTS.md section 4."

npm run build must pass. Confirm .env isn't staged. Commit, push, open a PR, and print the PR URL and the issue number.
```

Then: `gh pr merge <n> --squash --delete-branch` and post "Contract is on main" in Discord.

---

## Varshnay: SOUND

**Where:** your main repo folder.

```
git checkout main && git pull && git checkout -b feat/sound-sources
```

```
You are the SOUND agent. Follow AGENTS.md strictly. Communicate only through the "Agent coordination" GitHub issue, using its format. Post your plan as STATUS before starting. Tier 1 only: open a PR as soon as this works, and don't start anything else.

ONLY edit: src/world/soundSources.ts, src/world/pings.ts, src/world/agents.ts, src/world/soundConfig.ts.

1. TYPED PINGS (pings.ts)
   - Implement world.ping(origin, range, type) and world.activePings() using src/shared/contracts.ts.
   - Per-type PingStyle in soundConfig.ts (white on black): voice is big and bright; footstep is faint, ~2–5 m; cane is tiny and sharp; car is a medium periodic pulse; pedestrian is faint; impact is sharp and bright.
   - PING BUDGET: pool to MAX_PINGS. Prioritise by audibility at the player (loudness ÷ distance), with the player's own types (voice/footstep/cane/impact) always highest. Drop the least audible when full. activePings() returns them in priority order.

2. AGENT SOUND SOURCES (soundSources.ts + agents.ts)
   - Cars emit periodic 'car' pings (engine); interval and range scale with speed, ~15 m at full speed.
   - Pedestrians emit faint 'pedestrian' footstep pings in time with their walk cycle.
   - Only agents within ~40 m of the player emit.
   - On every player-vs-agent collision: world.audit.record({ kind: 'collision', hit: 'car' | 'pedestrian', position, impactSpeed }) and an 'impact' ping.

3. Also handle these REQUESTs, which are in shared world files you own: remove the old Space test ping from src/world/debugKeys.ts (Guneet's mic replaces it), and act on any REQUESTs on the coordination issue that touch src/world/index.ts, src/main.ts or src/config.ts.

VERIFY: build passes, no new dependencies, activePings() never exceeds MAX_PINGS (log it in debug), 60 fps. Small commits, push, open a PR, post DONE with the link.
```

---

## Varshnay: AUDIT (in parallel with SOUND, in a second folder)

**Where:** a separate worktree, so it doesn't clash with SOUND:

```
git worktree add ../whack-audit -b feat/audit
cd ../whack-audit && npm install && npm run setup:draco && cp ../WHACK-26-/.env .env
```

Open a second Claude Code session in `../whack-audit`:

```
You are the AUDIT agent. Follow AGENTS.md strictly. Communicate only through the "Agent coordination" GitHub issue, using its format. Post your plan as STATUS before starting. Tier 1 only: open a PR as soon as this works, and don't start anything else. Another agent is running on this laptop, so if you start a dev server, use PORT=8788 for the proxy and vite --port 5174.

ONLY edit files in src/audit/.

1. LOG (log.ts): initAudit(world) replaces world.audit with a real implementation.
   - Each event stores: run id, timestamp, local position, lat/lon (convert from local metres using ORIGIN_LAT/LON and the axis notes in src/config.ts), kind, hit, impactSpeed, normal, caneActive, and world.vision.id.
   - If an event has no `hit`, classify it: a high vertical surface is 'building'; below ~0.5 m is 'low_obstacle'.
   - Listen for world.on('caught') and log a 'caught' event at the player's position.
   - Store runs in IndexedDB, with a localStorage fallback. No server.

2. SIMPLE REPORT (report.ts), toggled with key M:
   - A full-screen white-on-black top-down view of the corridor, drawn from the OSM paths/roads in src/world/osm.ts (read-only).
   - Collision hotspots as rings sized by count, clustered into ~2 m cells, aggregated across all stored runs. Show built-environment hits (building, low_obstacle, street_furniture) separately from agent and entity hits.
   - A list of the top 5 hotspots: location, hit types, count.
   - An "Export JSON" button and a "Clear data" button.
   - Keep the Google and OSM attribution visible.

3. DEV TEST: key J injects 20 fake events, so this can be tested before the other branches land.

VERIFY: build passes, no new dependencies, J then M shows hotspots, data survives a reload, the JSON export is valid. Small commits, push, open a PR, post DONE with the link.
```

---

## Suleman: RENDER

**Where:** Suleman's laptop, in their clone of the repo.

```
git checkout main && git pull && git checkout -b feat/sonar-render
npm install && npm run setup:draco
```

```
You are the RENDER agent. Follow AGENTS.md strictly. Communicate only through the "Agent coordination" GitHub issue, using its format. Post your plan as STATUS before starting. Tier 1 only: open a PR as soon as this works, and don't start anything else.

ONLY edit files in src/render/ (and src/senses/vision*.ts only if needed for the default mode).

GOAL: the shared sonar material actually reveals the world from pings. This is the most important visual in the demo; nothing is visible without it.

1. Read pings from world.activePings() every frame (up to MAX_PINGS from src/shared/contracts.ts) and pass them to the shader as uniform arrays: origin, start time, range, and the style fields (speed, thickness, brightness, fade).
2. Shader: an expanding ring + a fading trail behind it for each ping, clipped to its range, with per-type look from its style. White grid lines on black only.
3. Grid fixes from PR #1's notes: only draw lines along the two axes tangent to each surface (weight by the normal), so flat faces on a grid line aren't solid white; and fade lines out when fwidth nears the grid size, to remove the distant moiré.
4. An always-visible arm's-reach glow around the player (~0.4 m).
5. setRevealAll() works, so R shows the full grid using your material (then the world module's debug grid swap can be removed; post a REQUEST to SOUND/Varshnay for that).
6. The entity (Ayo) and agents use the shared material too, so make sure moving objects can use an object-space grid option so lines don't slide over them.
7. Until SOUND's PR lands, activePings() returns []. Test with a local dev-only fake: a key in your own module pushes fake pings of each type. Guard it behind import.meta.env.DEV.

VERIFY: black by default; a fake ping shows an expanding ring that reveals buildings and the ground, then fades; different types look different; R reveals everything; no colour; 60 fps; build passes. Small commits, push, open a PR, post DONE with the link.
```

---

## Guneet: SENSES

**Where:** Guneet's laptop, on the existing branch, updated to the new main.

```
git checkout feat/mic-hud-audio && git fetch origin && git rebase origin/main
npm install && npm run setup:draco
```

```
You are the SENSES agent. Follow AGENTS.md strictly. Communicate only through the "Agent coordination" GitHub issue, using its format. Post your plan as STATUS before starting. Tier 1 only: open a PR as soon as this works, and don't start anything else.

ONLY edit: src/player/, src/audio/, src/hud/, src/senses/index.ts, src/senses/footsteps.ts, src/senses/config.ts.

1. MIC (src/audio/mic.ts): Web Audio getUserMedia + AnalyserNode. Calibrate ambient noise over the first 3 s. Above baseline + ~15 dB, call world.ping(playerPos, rangeFromDb, 'voice'), with a ~400 ms cooldown: whisper ~3 m, shout ~40 m. Expose the current dB and dominant frequency for the HUD. Also bind Space to a medium 'voice' ping as a keyboard fallback (SOUND is removing the old test ping).

2. FOOTSTEPS (src/senses/footsteps.ts): on each step, world.ping(feetPos, range, 'footstep'): ~2 m walking, ~5 m running, none when still. Step interval scales with speed from the controller.

3. COLLISIONS → AUDIT: on every wall collision or stun, call world.audit.record({ kind: 'collision', position, impactSpeed, normal }), world.ping(contactPoint, 6, 'impact') and world.emit('stunned', ...).

4. WALL TUNNELLING BUG (from PR #4): at one spot the player passes ~4.3 m through a wall with no stun. Fix checkCollision: make the ray length cover the full movement step at the current speed (or sub-step the movement), and check for gaps in the tile mesh at that spot.

5. HUD: add the Google Maps logo (required by the terms), plus a dB meter, dominant Hz and a collision count. White on black.

6. GAME OVER: on world.on('caught'), show a white-on-black "Caught" screen with run stats (time, collisions) and "Press Enter to restart" / "Press M for the architect report".

VERIFY: speaking or shouting fires pings of matching size; walking fires small footstep pings; walking into walls always stuns and is never tunnelled; the logo is visible; game over works with a fake world.emit('caught'); 60 fps; build passes. Small commits, push, open a PR, post DONE with the link.
```

---

## Ayo: ENTITY

**Where:** Ayo's laptop. First get his existing entity work onto the new main (after Step 0 is merged):

```
git checkout <ayo's current branch>
git fetch origin && git merge origin/main
```

```
You are the ENTITY agent. Follow AGENTS.md strictly. Communicate only through the "Agent coordination" GitHub issue, using its format. Post your plan as STATUS before starting. Tier 1 only: open a PR as soon as this works, and don't start anything else.

FIRST, INTEGRATE MY EXISTING WORK:
- I've just merged origin/main (which now has the shared contract) into my entity branch. Resolve any conflicts:
  - For files I don't own (anything outside src/entity/), keep main's version. If my branch had changes there that the entity needs, re-create them inside src/entity/ or post a REQUEST to Varshnay (SOUND) for anything in src/world/index.ts, src/main.ts or src/config.ts.
  - For src/entity/index.ts, keep my implementation but export initEntity(world), which main.ts already calls.
- Move all entity code into src/entity/. Put tuning values in src/entity/config.ts.
- npm run build must pass before continuing.

BEHAVIOUR (state machine)
- PATROL: wander the OSM path graph (src/world/osm.ts, read-only) inside the corridor at ~1.0 m/s.
- INVESTIGATE: on hearing a sound, path to it at ~1.8 m/s, then search nearby for ~5 s.
- CHASE: if it hears the player within ~15 m, move straight at them at ~2.2 m/s (faster than walking, so going quiet is the only escape).
- LOSE INTEREST: after ~8 s with no new sound, return to PATROL.
- CATCH: within ~1 m of the player, call world.emit('caught', { position }) and world.audit.record({ kind: 'caught', hit: 'entity', position }).
- Always stay inside the corridor (world.isInsidePlayArea / clampToPlayArea).

HEARING (from the contract only)
- Every frame, read world.activePings(). Each ping is a sound at its origin, with loudness from its range and type: voice and impact are loud; footstep is quiet; car and pedestrian are background (mostly ignored unless very close).
- It hears a ping if the distance to it is under loudness × MAX_HEARING (~60 m in config).
- It doesn't react to its own sounds.

FOR OTHER MODULES
- Set world.entity = { state, position, velocity } every frame and emit world.emit('entityState', ...) on state changes.
- Render it with the shared sonar material (object-space grid option): a tall, thin, slightly wrong-proportioned figure, so it only appears when pinged.
- Its own footsteps: occasional faint world.ping(pos, 2, 'pedestrian'), so a careful player can hear it coming.

DEBUG: T toggles an overlay (state, hearing ring, current path; visible with R on). N fires a test 'voice' ping at the camera.

VERIFY: build passes, no new dependencies, no console errors. With R on: it patrols; N makes it investigate; repeated N nearby makes it chase; silence makes it lose interest; reaching the player fires 'caught'. 60 fps. Small commits, push, open a PR, post DONE with the link.
```

---

## Integration checkpoint (about 90 min in)

Varshnay merges whatever is ready, in this order: **RENDER → SOUND → SENSES → ENTITY → AUDIT**. After each merge, everyone runs `git fetch origin && git rebase origin/main`. Then play the full demo together and fix only what's broken before starting Tier 2 (vision modes, cane, more traffic, full architect report).
