# AGENTS.md: coordination for parallel coding agents

Several coding agents (Claude Code sessions run by different teammates on their own laptops) work on this repo **at the same time**, each on its own branch. Humans review and merge. This file is how the agents stay out of each other's way and talk to each other.

**Read this file, README.md and `src/shared/contracts.ts` before doing anything.**

---

## 1. The agents

| Agent | Person | Branch | Owns (may edit) |
|---|---|---|---|
| **SOUND** | Varshnay | `feat/sound-sources` | `src/world/soundSources.ts`, `src/world/pings.ts`, `src/world/agents.ts`, `src/world/soundConfig.ts` |
| **AUDIT** | Varshnay | `feat/audit` | everything in `src/audit/` |
| **RENDER** | Suleman | `feat/sonar-render` | everything in `src/render/`, `src/senses/vision.ts`, `src/senses/visionPicker.ts`, `src/senses/visionConfig.ts` |
| **SENSES** | Guneet | `feat/mic-hud-audio` | everything in `src/player/`, `src/audio/`, `src/hud/`, plus `src/senses/index.ts`, `src/senses/footsteps.ts`, `src/senses/cane.ts`, `src/senses/config.ts` |
| **ENTITY** | Ayo | `feat/entity` (or Ayo's existing branch) | everything in `src/entity/` |

Varshnay also owns the shared world files (`src/world/index.ts`, `src/main.ts`, `src/config.ts`, `src/shared/contracts.ts`). Changes to those go to him as a `REQUEST`.

**Everything else is read-only for every agent**, including `src/shared/contracts.ts`, `src/main.ts`, `src/world/index.ts` and other `src/world/` files not listed, `src/config.ts`, `README.md`, `index.html`, `package.json` and this file. Changes to these go through A (the world owner) as a `REQUEST`.

If you are not sure whether you own a file, you don't. Ask first (see section 4).

If one person runs two agents at once (e.g. SOUND and AUDIT), each must run in its **own git worktree folder** (see section 6), never in the same folder.

## 2. Hard rules

1. **Stay in your files.** Never edit, format, rename or "tidy" a file you don't own, even a one-line fix. Request it instead.
2. **Code against the contract, not each other.** Only use the APIs in `src/shared/contracts.ts` and on the `world` object. Never import from another agent's files.
3. **Don't change the contract.** If you need a new field or function, propose it (section 4) and keep working with what exists. Humans decide.
4. **No new dependencies.** Use `three`, `3d-tiles-renderer`, Web Audio and built-ins only.
5. **Stay on your branch.** Never `git checkout` another agent's branch in your folder.
6. **No history rewriting.** No force-push, no `reset --hard` on shared branches, no rebasing someone else's branch.
7. **Don't merge PRs.** Open your PR; a human merges it.
8. **Secrets.** Never print, log, commit or paste the API key or `.env` contents, including in coordination messages. Don't open `.env` in a way that shares it as context.
9. **Rendering style.** White lines on black; red is allowed only for stuns and danger. No other colour and no textures anywhere.
10. **Performance.** Keep 60 fps at eye height in the corridor on a real GPU. Report FPS in your PR.
11. **Tier discipline.** Only do the tier and sections you were given. Open a PR as soon as they work. Don't start extras.

## 3. Shared contract (summary)

Full types live in `src/shared/contracts.ts`.

| API | Implemented by | Called by |
|---|---|---|
| `world.ping(origin, range, type)` | SOUND | everyone (mic, footsteps, cane, agents) |
| `world.activePings(): ActivePing[]` (max `MAX_PINGS`, priority order) | SOUND | RENDER (shader) |
| `world.audit.record(event: AuditEvent)` | AUDIT | SOUND (agent collisions), SENSES (wall collisions, cane contacts) |
| `world.vision`, `world.setVision(id)` | RENDER | AUDIT (tags each event with the vision mode), SENSES |
| `world.entity: EntityState` (`state`, `position`, `velocity`) | ENTITY | SENSES (spatial audio, HUD), AUDIT |
| `world.on('caught' \| 'entityState', cb)` / `world.emit(...)` | ENTITY emits; event bus stub on `world` | SENSES (game over screen), AUDIT (logs the catch position) |

Until the implementer's PR is merged, these are safe no-op stubs on main. Code as if they work, and test with your own fakes where you need data (e.g. RENDER can push fake pings locally to test the shader).

## 4. Communication protocol

Agents can't talk to each other directly. All agent-to-agent communication goes through **one GitHub issue titled "Agent coordination"** (`gh issue list --search "Agent coordination"` to find its number).

**Post a comment with `gh issue comment <n> --body "..."`** using exactly this format:

```
[AGENT: SOUND|AUDIT|RENDER|SENSES|ENTITY] [TYPE: STATUS|REQUEST|PROPOSAL|BLOCKER|DONE]
To: <agent or HUMAN>
Summary: <one line>
Details: <what, which file/API, why>
```

| Type | When | What happens next |
|---|---|---|
| `STATUS` | after each milestone (roughly each commit group) | nothing; it's for visibility |
| `REQUEST` | you need a change in a file you don't own | the owner or a human picks it up; **don't wait**, carry on with a workaround or TODO |
| `PROPOSAL` | you want a contract change | a human approves or rejects it; keep using the current contract meanwhile |
| `BLOCKER` | you truly can't continue | stop that part, work on something else, tag HUMAN |
| `DONE` | your PR is open | include the PR link and the API other agents now get |

**Read the issue** (`gh issue view <n> --comments`) before you start, before each major step, and before opening your PR. Act on any `REQUEST` addressed to you if it's inside your files.

Keep messages short. No code dumps; link to the commit or file instead.

## 5. Workflow for each agent

1. Confirm you're in the right folder and branch (`git branch --show-current`).
2. Read README.md, this file, `src/shared/contracts.ts` and the coordination issue.
3. Post a `STATUS` comment with your plan (3–5 bullets).
4. Work in small commits: `feat(sound): ...`, `feat(audit): ...`, `feat(render): ...`, `feat(senses): ...`, `feat(entity): ...`.
5. Before each push: `npm run build` passes, there are no console errors, and `git status` shows only your files changed.
6. `git fetch origin && git rebase origin/main` before opening the PR. Your branch only, never anyone else's.
7. Open a PR into main using the template. List: what's done, the APIs you implemented or call, FPS, and any open `REQUEST`s.
8. Post `DONE` with the PR link.

## 6. Setup

**Each teammate, once, in their own clone:**

```bash
git checkout main && git pull
npm install && npm run setup:draco
# make sure .env exists with the shared key (DM'd, never committed)
git checkout -b <your branch>        # or: git checkout <existing branch> && git rebase origin/main
```

**Only if one person runs two agents at once** (e.g. SOUND + AUDIT):

```bash
git worktree add ../whack-audit -b feat/audit
cd ../whack-audit && npm install && npm run setup:draco && cp ../WHACK-26-/.env .env
```

Then run the second Claude Code session in that folder.

**Dev servers:** if two agents run on the same laptop, give the second one different ports (`PORT=8788` for the proxy, `vite --port 5174`), and don't kill processes you didn't start.

**Tile cache:** copy a warmed `tile-cache/` from another folder rather than re-downloading.
