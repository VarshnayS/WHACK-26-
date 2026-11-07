# Contributing

Three people work in parallel, each in their own module. These rules keep `main` working and merges conflict-free.

## Who owns what

| Owner | Module | Files | Branch |
|---|---|---|---|
| A | World, tiles, agents | `src/world/` (except `index.ts`), `proxy/`, `scripts/` | `feat/world-foundation` |
| B | Sonar material | `src/render/` | `feat/sonar-material` |
| C | Mic, HUD, audio, movement | `src/audio/`, `src/hud/`, `src/player/` | `feat/mic-hud-audio`, then `feat/collision` |
| Everyone | Shared contracts | `src/world/index.ts`, `README.md`, `src/main.ts`, `src/config.ts`, `package.json`, configs | small dedicated PRs |

Usernames are in [`.github/CODEOWNERS`](.github/CODEOWNERS). GitHub requests the owner's review automatically.

Modules talk to each other only through the `world` object (`src/world/index.ts`) and the exported functions in each stub. `src/main.ts` already calls every module's `init*()` once, so add per-frame logic with `world.onUpdate()` instead of editing `main.ts`.

## Workflow

1. **One feature branch per module.** Branch from the latest `main`:
   ```bash
   git switch main && git pull
   git switch -c feat/<module>-<thing>     # or use your existing module branch
   ```
2. **Never push directly to `main`.** Everything goes through a pull request (`main` is protected).
3. **Keep PRs small.** One feature per PR. Merge little and often instead of one huge PR at the end.
4. **Rebase on `main` before opening a PR** (and again if `main` moved):
   ```bash
   git fetch origin
   git rebase origin/main
   npm run build
   git push --force-with-lease
   ```
   Force-pushing your own feature branch is fine; never force-push `main`.
5. **Squash merge** into `main`, then delete the branch or rebase it onto the new `main` before continuing.
6. Fill in the PR template (what changed, module, how to test, screenshot/GIF, checklist).

## Rules

- **Don't edit another module's files without telling its owner first.** If you need something from another module, ask for an exported function or a new optional field on `world`.
- **Changes to `src/world/index.ts` (the shared contract)** go in their own small PR that everyone has seen. Adding an optional field is fine; renaming or removing one breaks other people's code.
- **No new dependencies** without discussing it first. See README "Dependencies": we use `three`, `3d-tiles-renderer` and Node/Web built-ins only.
- **Never commit `.env`, the API key or `tile-cache/`.** Check `git status` before every commit. Share the key by DM only. If a key is ever committed, tell the team immediately and rotate it in Google Cloud. Deleting the commit is not enough.
- **Attribution must stay visible** (Google Maps logo / tile copyright and "© OpenStreetMap contributors").
- `npm run build` must pass before you open a PR.

## First-time setup

```bash
git pull
nvm use                 # Node 20 (needs 20.19+; see .nvmrc)
npm ci
npm run setup:draco
cp .env.example .env    # then paste the key a teammate DMs you
npm run dev:all
```
