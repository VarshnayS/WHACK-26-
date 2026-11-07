/**
 * proxy/cache-proxy.mjs: tile cache proxy (adds the API key server-side, caches to tile-cache/)
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * STUB: placeholder so `npm run proxy` / `npm run dev:all` start cleanly.
 * Replace this file with the real proxy. It reads GOOGLE_MAPS_KEY, PORT and OFFLINE from .env
 * via `node --env-file=.env`. Never log the key or include it in responses.
 */
import http from 'node:http';

const port = Number(process.env.PORT) || 8787;

http
  .createServer((req, res) => {
    res.writeHead(501, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    });
    res.end('cache-proxy stub: not implemented yet\n');
  })
  .listen(port, () => {
    console.log(`[cache-proxy] STUB listening on http://localhost:${port} (every request returns 501)`);
  });
