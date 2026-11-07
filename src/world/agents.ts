/**
 * src/world/agents.ts: pedestrians (capsules) and cars (boxes) on OSM paths/roads
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * Pedestrians walk footway/pedestrian/path/steps at ~1.4 m/s; cars drive residential/service/
 * tertiary/unclassified roads at ~8 m/s, offset to the left of the centreline (UK). At a junction
 * each agent picks a random next edge (not the one it came from, unless it's a dead end).
 * All meshes use the shared sonarMaterial (debug grid while R is on). Heights come from
 * groundHeight() in src/player/collision.ts.
 */
import * as THREE from 'three';
import { world, type Agent, type AgentType } from './index';
import { buildPathGraph, loadOsm, type PathGraph } from './osm';
import { assignWorldMaterial, getWorldMaterial, onRevealAllChange } from './debugMaterial';
import { groundHeight } from '../player/collision';

const PEDESTRIAN_COUNT = 15;
const CAR_COUNT = 6;
const PEDESTRIAN_HIGHWAYS = ['footway', 'pedestrian', 'path', 'steps'] as const;
const CAR_HIGHWAYS = ['residential', 'service', 'tertiary', 'unclassified'] as const;

const SPECS: Record<AgentType, { speed: number; speedJitter: number; loudness: number; laneOffset: number }> = {
  pedestrian: { speed: 1.4, speedJitter: 0.2, loudness: 0.15, laneOffset: 0 },
  car: { speed: 8, speedJitter: 1, loudness: 0.6, laneOffset: 1.5 }, // metres left of centreline
};

// One shared low-poly geometry per type; base at y = 0 so mesh.position = ground position.
const PEDESTRIAN_HEIGHT = 1.75;
const PEDESTRIAN_RADIUS = 0.25;
const pedestrianGeometry = new THREE.CapsuleGeometry(PEDESTRIAN_RADIUS, PEDESTRIAN_HEIGHT - 2 * PEDESTRIAN_RADIUS, 2, 6);
pedestrianGeometry.translate(0, PEDESTRIAN_HEIGHT / 2, 0);
const CAR_LENGTH = 4.4;
const CAR_HEIGHT = 1.5;
const CAR_WIDTH = 1.8;
const carGeometry = new THREE.BoxGeometry(CAR_WIDTH, CAR_HEIGHT, CAR_LENGTH); // length along local +Z
carGeometry.translate(0, CAR_HEIGHT / 2, 0);

interface Mover {
  agent: Agent;
  graph: PathGraph;
  from: number;
  to: number;
  /** Distance travelled along the current edge (m). */
  along: number;
  edgeLength: number;
  speed: number;
}

const movers: Mover[] = [];
const dir = new THREE.Vector3();
const left = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
let initialised = false;

function randomInt(n: number): number {
  return Math.floor(Math.random() * n);
}

/** Choose the next node after arriving at `node` from `cameFrom`. */
function nextNode(graph: PathGraph, node: number, cameFrom: number): number {
  const options = graph.neighbours[node];
  if (options.length === 0) return cameFrom;
  if (options.length === 1) return options[0]; // dead end: turn round
  const forward = options.filter((n) => n !== cameFrom);
  return forward[randomInt(forward.length)];
}

/** Place the agent's mesh/position for its current edge progress. */
function place(m: Mover): void {
  const a = m.graph.positions[m.from];
  const b = m.graph.positions[m.to];
  dir.subVectors(b, a);
  dir.y = 0;
  const len = dir.length();
  if (len > 1e-6) dir.divideScalar(len);
  else dir.set(0, 0, 1);

  const { agent } = m;
  agent.position.lerpVectors(a, b, m.edgeLength > 0 ? m.along / m.edgeLength : 0);
  const offset = SPECS[agent.type].laneOffset;
  if (offset !== 0) {
    left.crossVectors(UP, dir); // left of the direction of travel
    agent.position.addScaledVector(left, offset);
  }
  agent.position.y = groundHeight(agent.position);
  agent.velocity.copy(dir).multiplyScalar(m.speed);

  agent.object.position.copy(agent.position);
  agent.object.rotation.y = Math.atan2(dir.x, dir.z); // local +Z faces the direction of travel
}

/** Spawn one agent on a path graph and return it (already added to world.agents). */
export function spawnAgent(type: AgentType, graph: PathGraph): Agent | null {
  if (graph.edges.length === 0) return null;
  const edge = graph.edges[randomInt(graph.edges.length)];
  const reverse = Math.random() < 0.5;
  const spec = SPECS[type];

  const mesh = new THREE.Mesh(type === 'car' ? carGeometry : pedestrianGeometry, getWorldMaterial());
  mesh.name = type;
  world.agentsGroup.add(mesh);

  const agent: Agent = {
    type,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    loudness: spec.loudness,
    object: mesh,
  };
  const mover: Mover = {
    agent,
    graph,
    from: reverse ? edge.b : edge.a,
    to: reverse ? edge.a : edge.b,
    along: Math.random() * edge.length,
    edgeLength: edge.length,
    speed: spec.speed + (Math.random() * 2 - 1) * spec.speedJitter,
  };
  place(mover);
  movers.push(mover);
  world.agents.push(agent);
  return agent;
}

function updateAgents(dt: number): void {
  for (const m of movers) {
    m.along += m.speed * dt;
    // advance through as many edges as this frame covers (short edges at junctions)
    let guard = 0;
    while (m.along >= m.edgeLength && guard++ < 16) {
      m.along -= m.edgeLength;
      const next = nextNode(m.graph, m.to, m.from);
      m.from = m.to;
      m.to = next;
      m.edgeLength = m.graph.positions[m.from].distanceTo(m.graph.positions[m.to]);
      if (m.edgeLength < 1e-3) m.edgeLength = 1e-3;
    }
    place(m);
  }
}

/**
 * Load OSM, build path graphs, spawn agents into world.agentsGroup / world.agents,
 * and register their movement with world.onUpdate().
 */
export async function initAgents(): Promise<void> {
  if (initialised) return;
  initialised = true;

  const osm = await loadOsm();
  const pedestrianGraph = buildPathGraph(osm, 'footway', { highways: PEDESTRIAN_HIGHWAYS });
  const carGraph = buildPathGraph(osm, 'road', { highways: CAR_HIGHWAYS });

  for (let i = 0; i < PEDESTRIAN_COUNT; i++) spawnAgent('pedestrian', pedestrianGraph);
  for (let i = 0; i < CAR_COUNT; i++) spawnAgent('car', carGraph);

  if (osm.ways.length > 0) {
    console.info(
      `[agents] ${movers.filter((m) => m.agent.type === 'pedestrian').length} pedestrians ` +
        `(${pedestrianGraph.edges.length} path edges), ${movers.filter((m) => m.agent.type === 'car').length} cars ` +
        `(${carGraph.edges.length} road edges)`,
    );
  }

  onRevealAllChange(() => assignWorldMaterial(world.agentsGroup));
  world.onUpdate(updateAgents);
}
