/**
 * src/world/osm.ts: OSM loading + lat/lon to local metres
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * STUB: signatures are final, bodies are placeholders.
 * The OsmData shape must match what scripts/fetch-osm.mjs writes to public/osm.json.
 */
import * as THREE from 'three';

export type OsmWayKind = 'footway' | 'road';

export interface OsmNode {
  id: number;
  lat: number;
  lon: number;
}

export interface OsmWay {
  id: number;
  kind: OsmWayKind;
  /** Ordered node ids along the way. */
  nodeIds: number[];
  tags: Record<string, string>;
}

export interface OsmData {
  nodes: OsmNode[];
  ways: OsmWay[];
}

/** Path graph in local metres, used by agents and the entity AI for pathfinding. */
export interface PathGraph {
  /** Node positions in world space (y = 0 until groundHeight() is implemented). */
  positions: THREE.Vector3[];
  /** neighbours[i] = indices of nodes connected to node i. */
  neighbours: number[][];
}

/**
 * Convert lat/lon to local metres around ORIGIN_LAT/LON (x = east, z = south, y = 0),
 * applying YAW_OFFSET and XZ_OFFSET from src/config.ts.
 */
export function latLonToLocal(lat: number, lon: number, out = new THREE.Vector3()): THREE.Vector3 {
  void lat;
  void lon;
  return out.set(0, 0, 0); // placeholder
}

/** Load public/osm.json (OSM_URL in src/config.ts). */
export async function loadOsm(url?: string): Promise<OsmData> {
  void url;
  return { nodes: [], ways: [] }; // placeholder
}

/** Build a walkable (footway) or drivable (road) graph from loaded OSM data. */
export function buildPathGraph(data: OsmData, kind: OsmWayKind): PathGraph {
  void data;
  void kind;
  return { positions: [], neighbours: [] }; // placeholder
}
