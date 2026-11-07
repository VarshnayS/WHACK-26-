/**
 * proxy/cache-proxy.mjs: tile cache proxy for Google Photorealistic 3D Tiles
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * - Adds the API key server-side (the browser never sees it).
 * - Caches every tile by URL path in tile-cache/ (query strings such as `session` are ignored,
 *   so tiles cached in one session keep working in the next).
 * - Online (OFFLINE=0): root.json is ALWAYS fetched fresh from Google (new session token) and the
 *   cached copy is updated. Other files are served from cache, or fetched and cached on a miss.
 * - Offline (OFFLINE=1): everything, including root.json, is served from cache only.
 *   Each miss is logged as `[offline miss] <path>`.
 *
 * Run: node --env-file=.env proxy/cache-proxy.mjs   (or npm run proxy / npm run dev:all)
 * Env: GOOGLE_MAPS_KEY, PORT (default 8787), OFFLINE (0/1)
 *
 * NEVER log the key or put it in a response. Log paths only, never full upstream URLs.
 */
import http from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT_DIR, 'tile-cache');
const UPSTREAM = 'https://tile.googleapis.com';
const ROOT_PATH = '/v1/3dtiles/root.json';
const ALLOWED_PREFIX = '/v1/3dtiles/';
const UPSTREAM_TIMEOUT_MS = 30_000;

const KEY = (process.env.GOOGLE_MAPS_KEY ?? '').trim();
const PORT = Number(process.env.PORT) || 8787;
const OFFLINE = process.env.OFFLINE === '1';

/** Latest session token from a fresh root.json; added to tile requests that don't carry one. */
let currentSession = null;
/** De-duplicates concurrent upstream fetches of the same path. */
const inFlight = new Map();
const stats = { served: 0, hits: 0, fetched: 0, misses: 0, errors: 0 };
let statsDirty = false;

const CONTENT_TYPES = {
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

/** Remove the key from any text before it is logged or sent to the browser. */
function redact(text) {
  return KEY ? String(text).split(KEY).join('***') : String(text);
}

/** Map a URL path to a file inside tile-cache/, or null if the path is not allowed. */
function cacheFileFor(urlPath) {
  const normalised = path.posix.normalize(urlPath);
  if (!normalised.startsWith(ALLOWED_PREFIX) || normalised.includes('..') || normalised.endsWith('/')) return null;
  const file = path.join(CACHE_DIR, ...normalised.split('/').filter(Boolean));
  return file.startsWith(CACHE_DIR + path.sep) ? file : null;
}

function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

async function readCache(file) {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

async function writeCache(file, body) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, file); // atomic: never leaves a half-written tile in the cache
}

/** Pull the session token out of root.json (it's embedded in the child URIs). */
function extractSession(text) {
  const match = /[?&]session=([^&"\\]+)/.exec(text);
  return match ? match[1] : null;
}

/**
 * Fetch a path from Google with the key (and session) added.
 * Returns { status, body: Buffer, type }.
 */
async function fetchUpstream(urlPath, search) {
  const url = new URL(urlPath, UPSTREAM);
  for (const [name, value] of new URLSearchParams(search)) {
    if (name !== 'key') url.searchParams.set(name, value);
  }
  if (urlPath === ROOT_PATH) {
    url.searchParams.delete('session'); // always start a fresh session
  } else if (!url.searchParams.has('session') && currentSession) {
    url.searchParams.set('session', currentSession);
  }
  url.searchParams.set('key', KEY);

  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, type: res.headers.get('content-type') ?? 'application/octet-stream' };
}

/** Fetch + cache a path, sharing one upstream request between concurrent callers. */
function fetchAndCache(urlPath, search, file) {
  const existing = inFlight.get(urlPath);
  if (existing) return existing;

  const job = (async () => {
    const result = await fetchUpstream(urlPath, search);
    if (result.status === 200) {
      if (urlPath === ROOT_PATH) {
        const session = extractSession(result.body.toString('utf8'));
        if (session) currentSession = session;
      }
      await writeCache(file, result.body);
      stats.fetched++;
    } else {
      stats.errors++;
      let reason = '';
      try {
        reason = JSON.parse(result.body.toString('utf8'))?.error?.message ?? '';
      } catch {
        /* not JSON */
      }
      console.warn(`[upstream ${result.status}] ${urlPath}${reason ? ` (${redact(reason)})` : ''}`);
    }
    return result;
  })().finally(() => inFlight.delete(urlPath));

  inFlight.set(urlPath, job);
  return job;
}

function send(req, res, status, body, type, extraHeaders = {}) {
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': type, 'Content-Length': body.length, ...extraHeaders });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendText(req, res, status, text) {
  send(req, res, status, Buffer.from(redact(text) + '\n'), 'text/plain; charset=utf-8');
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(req, res, 405, 'Method not allowed');
    return;
  }

  const { pathname, search } = new URL(req.url ?? '/', 'http://localhost');
  const file = cacheFileFor(pathname);
  if (!file) {
    sendText(req, res, 404, `Not a 3D Tiles path. Try ${ROOT_PATH}`);
    return;
  }
  const isRoot = pathname === ROOT_PATH;
  stats.served++;
  statsDirty = true;

  // Online: root.json is never served from cache, so the session token is always fresh.
  if (!OFFLINE && !isRoot) {
    const cached = await readCache(file);
    if (cached) {
      stats.hits++;
      send(req, res, 200, cached, contentTypeFor(file));
      return;
    }
  }

  if (OFFLINE) {
    const cached = await readCache(file);
    if (cached) {
      stats.hits++;
      send(req, res, 200, cached, contentTypeFor(file), isRoot ? { 'Cache-Control': 'no-store' } : {});
    } else {
      stats.misses++;
      console.warn(`[offline miss] ${pathname}`);
      sendText(req, res, 404, `Offline and not cached: ${pathname}`);
    }
    return;
  }

  if (!KEY) {
    stats.errors++;
    sendText(req, res, 500, 'GOOGLE_MAPS_KEY is not set in .env (or run with OFFLINE=1)');
    return;
  }

  // Before the first root.json of this proxy run there is no session; get one first.
  if (!isRoot && !currentSession && !new URLSearchParams(search).has('session')) {
    await fetchAndCache(ROOT_PATH, '', cacheFileFor(ROOT_PATH)).catch(() => undefined);
  }

  const result = await fetchAndCache(pathname, search, file);
  if (result.status === 200) {
    send(req, res, 200, result.body, result.type, isRoot ? { 'Cache-Control': 'no-store' } : {});
  } else {
    send(req, res, result.status, Buffer.from(redact(result.body.toString('utf8'))), result.type);
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    stats.errors++;
    const message = err?.name === 'TimeoutError' ? 'upstream timeout' : redact(err?.message ?? err);
    console.warn(`[proxy error] ${req.url?.split('?')[0]}: ${message}`);
    if (!res.headersSent) sendText(req, res, 502, `Proxy error: ${message}`);
    else res.destroy();
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[cache-proxy] Port ${PORT} is already in use. Is another proxy running?`);
  } else {
    console.error(`[cache-proxy] ${redact(err.message)}`);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(
    `[cache-proxy] http://localhost:${PORT}${ROOT_PATH}  mode: ${OFFLINE ? 'OFFLINE (cache only)' : 'online'}  cache: tile-cache/`,
  );
  if (!OFFLINE && !KEY) console.warn('[cache-proxy] GOOGLE_MAPS_KEY is empty: online requests will fail.');
});

// Progress summary every 10 s while requests are coming in (useful while warming the cache).
setInterval(() => {
  if (!statsDirty) return;
  statsDirty = false;
  const { served, hits, fetched, misses, errors } = stats;
  console.log(`[stats] served ${served}  cache hits ${hits}  fetched ${fetched}  offline misses ${misses}  errors ${errors}`);
}, 10_000).unref();
