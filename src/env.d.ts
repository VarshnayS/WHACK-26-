/**
 * src/env.d.ts: types for the VITE_* variables read from .env
 * Owner: shared (tell the team before editing)
 */
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" = load tiles straight from Google with VITE_GOOGLE_MAPS_KEY (fallback only). Default "0" = via proxy. */
  readonly VITE_TILES_DIRECT?: string;
  /** Only used when VITE_TILES_DIRECT=1. Ends up in the browser bundle, so never use it for a deployed build. */
  readonly VITE_GOOGLE_MAPS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
