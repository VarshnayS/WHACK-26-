/**
 * scripts/dev-all.mjs: runs the tile proxy and Vite together (no extra deps)
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * Usage: npm run dev:all   (Ctrl+C stops both; if one exits, the other is stopped too)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(path.join(root, '.env'))) {
  console.error('[dev-all] Missing .env. Run `cp .env.example .env` and paste the key (ask a teammate by DM).');
  process.exit(1);
}

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
  console.error('[dev-all] Vite not found. Run `npm install` first.');
  process.exit(1);
}

let shuttingDown = false;

const children = [
  { name: 'proxy', args: ['--env-file=.env', 'proxy/cache-proxy.mjs'] },
  { name: 'vite', args: [viteBin] },
].map(({ name, args }) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev-all] ${name} exited (${signal ?? code}); stopping the rest.`);
    shutdown(code ?? 1);
  });
  return child;
});

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
