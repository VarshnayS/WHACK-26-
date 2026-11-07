/**
 * src/world/osm.ts: OSM loading + lat/lon to local metres + path graphs
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * The OsmData shape matches what scripts/fetch-osm.mjs writes to public/osm.json.
 * latLonToLocal() uses the same WGS84 frame as ReorientationPlugin in tiles.ts, so OSM and
 * tiles share one coordinate system: Y up, metres, +X = west, +Z = north, origin at ORIGIN_LAT/LON.
 *
 * For the entity AI: getPathGraph('footway' | 'road') returns the graph clipped to the play corridor
 * once initAgents() has loaded the data; nearestNode() finds where to start a path search.
 * scripts/fetch-osm.mjs already clips ways to the corridor (boundary nodes sit on the walls); the
 * graph is clipped again here in case osm.json was fetched with different corridor settings.
 */
import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer/three';
import { ORIGIN_HEIGHT, ORIGIN_LAT, ORIGIN_LON, OSM_URL, XZ_OFFSET, YAW_OFFSET } from '../config';
import { isInsidePlayArea } from './playArea';

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
  /** "© OpenStreetMap contributors" (must stay visible in the HUD). */
  attribution?: string;
}

/** One undirected edge of a PathGraph. */
export interface PathEdge {
  /** Node indices into PathGraph.positions. */
  a: number;
  b: number;
  /** Length in metres. */
  length: number;
  kind: OsmWayKind;
  /** OSM highway tag, e.g. 'footway', 'steps', 'residential', 'service'. */
  highway: string;
  wayId: number;
}

/** Path graph in local metres, used by agents and the entity AI for pathfinding. */
export interface PathGraph {
  /** Node positions in world space (y = 0; use groundHeight() for the surface). */
  positions: THREE.Vector3[];
  /** neighbours[i] = indices of nodes connected to node i. */
  neighbours: number[][];
  /** OSM node id of each node (same index as positions). */
  osmIds: number[];
  /** Every edge once (neighbours lists both directions). */
  edges: PathEdge[];
}

export interface PathGraphOptions {
  /** Only include ways whose highway tag is in this list (default: every way of the kind). */
  highways?: readonly string[];
  /**
   * Only include edges with both ends inside the play corridor grown by this many metres
   * (default 0.5, so nodes the fetch script put exactly on the boundary are kept).
   */
  corridorMargin?: number;
}

/** Paths people walk on; must match FOOTWAY_HIGHWAYS in scripts/fetch-osm.mjs. */
const FOOTWAY_HIGHWAYS = new Set(['footway', 'pedestrian', 'path', 'steps', 'cycleway', 'bridleway', 'track', 'corridor']);

/** Classify an OSM highway tag as footway or road. */
export function classifyHighway(highway: string): OsmWayKind {
  return FOOTWAY_HIGHWAYS.has(highway) ? 'footway' : 'road';
}

// Inverse of the frame ReorientationPlugin puts at the origin: ECEF -> local metres.
const ecefToLocal = new THREE.Matrix4();
WGS84_ELLIPSOID.getObjectFrame(
  THREE.MathUtils.degToRad(ORIGIN_LAT),
  THREE.MathUtils.degToRad(ORIGIN_LON),
  ORIGIN_HEIGHT,
  0,
  0,
  0,
  ecefToLocal,
).invert();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Convert lat/lon (degrees) to local metres around ORIGIN_LAT/LON (+X = west, +Z = north, y = 0),
 * then apply YAW_OFFSET and XZ_OFFSET from src/config.ts.
 */
export function latLonToLocal(lat: number, lon: number, out = new THREE.Vector3()): THREE.Vector3 {
  WGS84_ELLIPSOID.getCartographicToPosition(
    THREE.MathUtils.degToRad(lat),
    THREE.MathUtils.degToRad(lon),
    ORIGIN_HEIGHT,
    out,
  ).applyMatrix4(ecefToLocal);
  out.y = 0;
  if (YAW_OFFSET !== 0) out.applyAxisAngle(UP, YAW_OFFSET);
  out.x += XZ_OFFSET.x;
  out.z += XZ_OFFSET.z;
  return out;
}

let loaded: OsmData | null = null;
const graphs: Partial<Record<OsmWayKind, PathGraph>> = {};

/**
 * Load public/osm.json (OSM_URL in src/config.ts). Resolves to empty data, with a warning,
 * if the file is missing or invalid, so the game still runs without agents.
 */
export async function loadOsm(url: string = OSM_URL): Promise<OsmData> {
  const empty: OsmData = { nodes: [], ways: [] };
  try {
    const res = await fetch(url);
    // Vite answers unknown paths with index.html (200), so also check the content type.
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) {
      console.warn(`[osm] ${url} not found. Run \`npm run fetch:osm\` (online) to create public/osm.json.`);
      return empty;
    }
    const json = (await res.json()) as Partial<OsmData>;
    if (!Array.isArray(json.nodes) || !Array.isArray(json.ways)) {
      console.warn(`[osm] ${url} has no nodes/ways. Re-run \`npm run fetch:osm\`.`);
      return empty;
    }
    for (const way of json.ways) way.kind ??= classifyHighway(way.tags?.highway ?? '');
    loaded = json as OsmData;
    graphs.footway = buildPathGraph(loaded, 'footway');
    graphs.road = buildPathGraph(loaded, 'road');
    return loaded;
  } catch (err) {
    console.warn(`[osm] failed to load ${url}:`, err);
    return empty;
  }
}

/** Data from the last successful loadOsm(), or null. */
export function getOsmData(): OsmData | null {
  return loaded;
}

/** Full footway or road graph inside the play corridor (null until loadOsm() has run). For the entity AI. */
export function getPathGraph(kind: OsmWayKind): PathGraph | null {
  return graphs[kind] ?? null;
}

/** Build a walkable (footway) or drivable (road) graph from loaded OSM data. */
export function buildPathGraph(data: OsmData, kind: OsmWayKind, options: PathGraphOptions = {}): PathGraph {
  const margin = options.corridorMargin ?? 0.5;
  const allowed = options.highways ? new Set(options.highways) : null;

  const nodeById = new Map<number, OsmNode>();
  for (const node of data.nodes) nodeById.set(node.id, node);

  const graph: PathGraph = { positions: [], neighbours: [], osmIds: [], edges: [] };
  const indexById = new Map<number, number>();
  const localById = new Map<number, THREE.Vector3>();
  const seen = new Set<string>();

  const local = (id: number): THREE.Vector3 | null => {
    let v = localById.get(id);
    if (!v) {
      const node = nodeById.get(id);
      if (!node) return null;
      v = latLonToLocal(node.lat, node.lon);
      localById.set(id, v);
    }
    return v;
  };

  const indexOf = (id: number, pos: THREE.Vector3): number => {
    let i = indexById.get(id);
    if (i === undefined) {
      i = graph.positions.length;
      indexById.set(id, i);
      graph.positions.push(pos.clone());
      graph.neighbours.push([]);
      graph.osmIds.push(id);
    }
    return i;
  };

  for (const way of data.ways) {
    const highway = way.tags?.highway ?? '';
    if (way.kind !== kind || way.tags?.area === 'yes') continue;
    if (allowed && !allowed.has(highway)) continue;

    for (let k = 1; k < way.nodeIds.length; k++) {
      const idA = way.nodeIds[k - 1];
      const idB = way.nodeIds[k];
      if (idA === idB) continue;
      const pa = local(idA);
      const pb = local(idB);
      if (!pa || !pb) continue;
      if (!isInsidePlayArea(pa, margin) || !isInsidePlayArea(pb, margin)) continue;

      const key = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const a = indexOf(idA, pa);
      const b = indexOf(idB, pb);
      graph.neighbours[a].push(b);
      graph.neighbours[b].push(a);
      graph.edges.push({ a, b, length: pa.distanceTo(pb), kind, highway, wayId: way.id });
    }
  }
  return graph;
}

/** Index of the graph node closest to `pos` (XZ distance), or -1 for an empty graph. */
export function nearestNode(graph: PathGraph, pos: THREE.Vector3): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < graph.positions.length; i++) {
    const p = graph.positions[i];
    const d = (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
