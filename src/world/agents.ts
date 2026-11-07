/**
 * src/world/agents.ts: pedestrians and cars on OSM paths/roads, and what happens when they meet the player
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-polish
 *
 * PEDESTRIANS (PEDESTRIAN_COUNT in src/config.ts): procedural humanoids (src/world/humanoid.ts, one
 * InstancedMesh per body part) that walk footway/pedestrian/path/steps at 1.1 to 1.6 m/s with a sine-wave
 * walk cycle. Some walk in groups of 2 to 3 (followers keep a formation around the leader), some loiter,
 * everyone sometimes stops for a few seconds, and some occasionally cross University Road. They lightly
 * avoid each other. When the player runs into one, the pedestrian is knocked back along the contact
 * normal, stumbles for ~1.5 s, then walks back to the nearest point on its path and carries on.
 *
 * CARS (CAR_COUNT): 4.4 x 1.5 x 1.8 m, drive residential/service/tertiary/unclassified roads at ~8 m/s,
 * offset to the left of the centreline (UK), facing their direction of travel. A car never changes course,
 * slows down or reacts to anything; hitting one flings the player away and stuns them.
 *
 * PLAYER CONTACTS (every frame, no raycasts): the player is a vertical capsule (0.3 m radius), pedestrians
 * are capsules and cars are oriented boxes (src/world/agentContacts.ts). The contact normal and the impact
 * speed (closing speed along it) drive player.applyImpulse() and the existing onStunned mechanic.
 *
 * GROUND: agents never raycast. Their height comes from the precomputed grid in src/world/heightField.ts.
 * Paths are clipped to the play corridor, so each ends in a dead end on a boundary wall where agents turn
 * round; positions are clamped inside the walls too (also for knocked pedestrians).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world, type Agent, type AgentType, type World } from './index';
import { buildPathGraph, loadOsm, type PathGraph } from './osm';
import { clampToPlayArea, isInsidePlayArea } from './playArea';
import { CAR_GRID_SIZE, PERSON_GRID_SIZE, createAgentMaterial } from './agentMaterial';
import { HumanoidCrowd, strideLength } from './humanoid';
import { createContact, verticalCapsuleOverlap, verticalCapsuleVsBox, type Contact } from './agentContacts';
import { pedestrianFootstep, playerAgentCollision } from './soundSources';
import { groundGeneration, initGroundField, sampleGround } from './heightField';
import { isDebugCameraActive } from './debugCamera';
import { getPlayerController } from '../player/controller';
import { PLAYER_HEIGHT } from '../player/collision';
import { CAR_COUNT, PEDESTRIAN_COUNT } from '../config';
import type { AuditApi } from './audit/log';

const PEDESTRIAN_HIGHWAYS = ['footway', 'pedestrian', 'path', 'steps'] as const;
/** Only spawn on connected path networks at least this long (clipping leaves short isolated stubs). */
const MIN_NETWORK_LENGTH = 40;
const CAR_HIGHWAYS = ['residential', 'service', 'tertiary', 'unclassified'] as const;

// --- tuning ------------------------------------------------------------------------------------

const PED_SPEED_MIN = 1.1;
const PED_SPEED_MAX = 1.6;
const PED_HEIGHT_MIN = 1.6;
const PED_HEIGHT_MAX = 1.9;
const PED_BUILD_MIN = 0.85;
const PED_BUILD_MAX = 1.2;
const PED_LOUDNESS = 0.15;
/** Fraction of pedestrians that spawn inside a group of 2 to 3 (as a share of the spawn loop). */
const GROUP_CHANCE = 0.3;
/** Chance that a lone pedestrian is a loiterer (mostly standing around). */
const LOITERER_CHANCE = 0.18;
/** Chance that a lone pedestrian is willing to cross University Road now and then. */
const CROSSER_CHANCE = 0.4;
/** Chance to stop for a moment each time a walker passes a path node. */
const REST_CHANCE = 0.12;
const LOITERER_REST_CHANCE = 0.7;
/** Pedestrians stop being avoided/pushed this close (extra personal space between strangers, m). */
const PERSONAL_SPACE = 0.25;
const AVOID_STRENGTH = 0.6; // fraction of the overlap resolved per frame
const MAX_AVOID_OFFSET = 1.2; // m a pedestrian may be nudged off its path by others
const OFFSET_PULL_SPEED = 0.8; // m/s the nudge relaxes back to the path while walking
/** A pedestrian is within this distance of University Road to consider crossing it (m). */
const CROSS_MAX_ROAD_DISTANCE = 12;
const CROSS_CAR_CLEARANCE = 20; // don't step out with a car this close to the crossing point (m)

const STUMBLE_DURATION = 1.5; // s a knocked pedestrian is stunned
const STUMBLE_FRICTION = 4; // m/s^2 the knock slide dies off
const STUMBLE_MIN_CLOSING = 0.5; // m/s closing speed below which a touch is just a nudge
const PED_CONTACT_COOLDOWN = 0.5; // s before the same pedestrian can hit the player again
const PED_PUSH_RESTITUTION = 0.75; // each body gets this share of the closing speed (equal and opposite)
const PED_PUSH_MIN = 1.2; // m/s minimum push so even a slow bump is visible
const PED_PUSH_MAX = 6;

const CAR_LENGTH = 4.4;
const CAR_HEIGHT = 1.5;
const CAR_WIDTH = 1.8;
const CAR_SPEED = 8;
const CAR_SPEED_JITTER = 1;
const CAR_LOUDNESS = 0.6;
const CAR_LANE_OFFSET = 1.5; // metres left of the centreline
const CAR_MIN_SPACING = 15; // spawn gap between cars (m)
const CAR_CONTACT_COOLDOWN = 0.8;
const CAR_FLING_NORMAL_GAIN = 0.9; // flung along the normal at this x (car speed + player speed)
const CAR_FLING_CARRY = 0.5; // plus this share of the car's own velocity
const CAR_FLING_MAX = 10; // m/s cap on the impulse (the controller caps the resulting speed too)

const NOISE_CAR = 0.9;
const NOISE_PEDESTRIAN = 0.5;

const PLAYER_RADIUS = 0.3;
const PLAYER_BODY_HEIGHT = PLAYER_HEIGHT + 0.1; // eye height + the top of the head
const MAX_SEPARATION = 0.5; // m of overlap pushed out per frame at most

// --- shared state ------------------------------------------------------------------------------

type PedMode = 'walk' | 'idle' | 'stumble' | 'return' | 'cross' | 'follow';

/** Position on a path graph: on the edge from -> to, `along` metres from `from`. */
interface PathState {
  graph: PathGraph;
  from: number;
  to: number;
  along: number;
  edgeLength: number;
}

interface Walker {
  agent: Agent;
  index: number; // slot in the crowd's instance buffers
  path: PathState | null; // null for group followers
  leader: Walker | null;
  /** Formation spot relative to the leader: x towards the leader's left, z ahead (negative = behind). */
  formX: number;
  formZ: number;
  mode: PedMode;
  timer: number;
  height: number;
  radius: number;
  speed: number; // preferred walking speed (m/s)
  moveSpeed: number; // current speed along the path, ramps up/down
  loiterer: boolean;
  crosser: boolean;
  crossTimer: number;
  crossTarget: THREE.Vector3;
  /** Where the pedestrian is on its path (ground plane; y unused) and how far it has been nudged from it. */
  base: THREE.Vector3;
  offset: THREE.Vector3;
  knock: THREE.Vector3;
  yaw: number;
  phase: number;
  curSpeed: number;
  lastX: number;
  lastZ: number;
  stumbleTime: number;
  leanPitch: number;
  leanRoll: number;
  seed: number;
  y: number;
  cooldown: number;
}

interface Car {
  agent: Agent;
  path: PathState;
  mesh: THREE.Mesh;
  speed: number;
  yaw: number;
  lane: THREE.Vector3; // smoothed unit vector to the car's left
  cooldown: number;
  y: number;
}

const walkers: Walker[] = [];
const cars: Car[] = [];
let crowd: HumanoidCrowd | null = null;
let pedestrianGraph: PathGraph | null = null;
let carGraph: PathGraph | null = null;
let initialised = false;
let seenGeneration = -1;
let clock = 0;

const personMaterial = createAgentMaterial('agentPerson', PERSON_GRID_SIZE);
const carMaterial = createAgentMaterial('agentCar', CAR_GRID_SIZE);

// scratch
const dir = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const contact: Contact = createContact();

// --- small helpers -----------------------------------------------------------------------------

function randomInt(n: number): number {
  return Math.floor(Math.random() * n);
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

function turnTowards(current: number, target: number, rate: number, dt: number): number {
  return current + wrapAngle(target - current) * Math.min(1, rate * dt);
}

function emitAgentNoise(position: THREE.Vector3, loudness: number): void {
  // The entity hears collisions through their 'impact' pings (world.activePings()). If a world.emitNoise
  // is ever added to the contract, this starts calling it too.
  const w = world as World & { emitNoise?: (position: THREE.Vector3, loudness: number) => void };
  w.emitNoise?.(position, loudness);
}

// --- audit -------------------------------------------------------------------------------------

type WorldWithAudit = World & {
  audit?: Pick<AuditApi, 'log'>;
};

/**
 * Record a collision between the player and an agent.
 *
 * hit: 'car' or 'pedestrian'
 * impactSpeed: relative closing speed along the contact normal
 * normal: direction from the agent towards the player
 * position: player's position at the moment of impact
 */
function logAgentCollision(
  hit: 'car' | 'pedestrian',
  impactSpeed: number,
  normal: THREE.Vector3,
  position: THREE.Vector3,
): void {
  const audit = (world as WorldWithAudit).audit;

  if (!audit) return;

  audit.log({
    hit,
    position,
    impactSpeed: Math.max(0, impactSpeed),
    normal,
  });
}

// --- paths -------------------------------------------------------------------------------------

/** Choose the next node after arriving at `node` from `cameFrom`. */
function nextNode(graph: PathGraph, node: number, cameFrom: number): number {
  const options = graph.neighbours[node];
  if (options.length === 0) return cameFrom;
  if (options.length === 1) return options[0]; // dead end: turn round
  const forward = options.filter((n) => n !== cameFrom);
  return forward[randomInt(forward.length)];
}

function makePath(graph: PathGraph, from: number, to: number, along: number): PathState {
  const edgeLength = Math.max(1e-3, graph.positions[from].distanceTo(graph.positions[to]));
  return { graph, from, to, along, edgeLength };
}

/** Move `dist` metres along the path, through as many edges as that covers. Returns the nodes passed. */
function advancePath(p: PathState, dist: number): number {
  p.along += dist;
  let passed = 0;
  while (p.along >= p.edgeLength && passed < 16) {
    p.along -= p.edgeLength;
    const next = nextNode(p.graph, p.to, p.from);
    p.from = p.to;
    p.to = next;
    p.edgeLength = Math.max(1e-3, p.graph.positions[p.from].distanceTo(p.graph.positions[p.to]));
    passed++;
  }
  return passed;
}

/** Unit direction (ground plane) of the path's current edge. */
function pathDirection(p: PathState, out: THREE.Vector3): THREE.Vector3 {
  out.subVectors(p.graph.positions[p.to], p.graph.positions[p.from]);
  out.y = 0;
  const len = out.length();
  if (len > 1e-6) out.divideScalar(len);
  else out.set(0, 0, 1);
  return out;
}

/** Point on the path's current edge (y = 0). */
function pathPoint(p: PathState, out: THREE.Vector3): THREE.Vector3 {
  return out.lerpVectors(p.graph.positions[p.from], p.graph.positions[p.to], p.along / p.edgeLength);
}

/**
 * Put `path` on the edge of its graph that is closest to (x, z), pointing roughly along (hx, hz).
 * Returns the squared distance to that point.
 */
function snapToGraph(path: PathState, x: number, z: number, hx: number, hz: number): number {
  const { positions, edges } = path.graph;
  let best = Infinity;
  for (const e of edges) {
    const a = positions[e.a];
    const b = positions[e.b];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 1e-9 ? THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1) : 0;
    const dx = a.x + abx * t - x;
    const dz = a.z + abz * t - z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= best) continue;
    best = d2;
    const len = Math.sqrt(len2);
    if (abx * hx + abz * hz >= 0) {
      path.from = e.a;
      path.to = e.b;
      path.along = t * len;
    } else {
      path.from = e.b;
      path.to = e.a;
      path.along = (1 - t) * len;
    }
    path.edgeLength = Math.max(1e-3, len);
  }
  return best;
}

/** Edges of `graph` that belong to connected networks with total length >= minLength (all if none do). */
function spawnableEdges(graph: PathGraph, minLength: number): PathGraph['edges'] {
  const component = new Int32Array(graph.positions.length).fill(-1);
  const lengths: number[] = [];
  for (let start = 0; start < graph.positions.length; start++) {
    if (component[start] !== -1) continue;
    const id = lengths.length;
    lengths.push(0);
    const stack = [start];
    component[start] = id;
    while (stack.length) {
      const n = stack.pop()!;
      for (const m of graph.neighbours[n]) {
        if (component[m] === -1) {
          component[m] = id;
          stack.push(m);
        }
      }
    }
  }
  for (const e of graph.edges) lengths[component[e.a]] += e.length;
  const good = graph.edges.filter((e) => lengths[component[e.a]] >= minLength);
  return good.length > 0 ? good : graph.edges;
}

const spawnCache = new WeakMap<PathGraph, PathGraph['edges']>();

/** A random spawn point on a path graph: returns a path state at a random spot on a random edge. */
function randomPath(graph: PathGraph): PathState | null {
  if (graph.edges.length === 0) return null;
  let candidates = spawnCache.get(graph);
  if (!candidates) {
    candidates = spawnableEdges(graph, MIN_NETWORK_LENGTH);
    spawnCache.set(graph, candidates);
  }
  const edge = candidates[randomInt(candidates.length)];
  const reverse = Math.random() < 0.5;
  return makePath(graph, reverse ? edge.b : edge.a, reverse ? edge.a : edge.b, Math.random() * edge.length);
}

// --- cars --------------------------------------------------------------------------------------

function createCarGeometry(): THREE.BufferGeometry {
  // body + cabin; the whole thing fits the 4.4 x 1.5 x 1.8 m box used for collisions. Length along +Z.
  const body = new THREE.BoxGeometry(CAR_WIDTH, 0.75, CAR_LENGTH);
  body.translate(0, 0.15 + 0.375, 0);
  const cabin = new THREE.BoxGeometry(CAR_WIDTH * 0.88, 0.6, CAR_LENGTH * 0.52);
  cabin.translate(0, 0.9 + 0.3, -0.25);
  const merged = mergeGeometries([body, cabin], false);
  body.dispose();
  cabin.dispose();
  return merged;
}

let carGeometry: THREE.BufferGeometry | null = null;

function spawnCar(graph: PathGraph, others: Car[]): Car | null {
  let path: PathState | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = randomPath(graph);
    if (!candidate) return null;
    pathPoint(candidate, tmpA);
    const clear = others.every((c) => Math.hypot(c.agent.position.x - tmpA.x, c.agent.position.z - tmpA.z) > CAR_MIN_SPACING);
    path = candidate;
    if (clear) break;
  }
  if (!path) return null;

  carGeometry ??= createCarGeometry();
  const mesh = new THREE.Mesh(carGeometry, carMaterial);
  mesh.name = 'car';
  mesh.rotation.order = 'YXZ';
  mesh.frustumCulled = false;
  world.agentsGroup.add(mesh);

  const agent: Agent = {
    type: 'car',
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    loudness: CAR_LOUDNESS,
    object: mesh,
  };
  pathDirection(path, dir);
  const car: Car = {
    agent,
    path,
    mesh,
    speed: CAR_SPEED + (Math.random() * 2 - 1) * CAR_SPEED_JITTER,
    yaw: Math.atan2(dir.x, dir.z),
    lane: new THREE.Vector3(dir.z, 0, -dir.x),
    cooldown: 0,
    y: 0,
  };
  updateCar(car, 0);
  cars.push(car);
  world.agents.push(agent);
  return car;
}

function updateCar(car: Car, dt: number): void {
  const { path, agent } = car;
  advancePath(path, car.speed * dt);
  pathDirection(path, dir);

  // The lane offset (left of the centreline) swings round corners instead of jumping.
  tmpA.set(dir.z, 0, -dir.x); // left of the direction of travel
  const k = dt > 0 ? 1 - Math.exp(-7 * dt) : 1;
  car.lane.lerp(tmpA, k);
  if (car.lane.lengthSq() < 1e-4) car.lane.copy(tmpA);
  car.lane.normalize();

  pathPoint(path, agent.position);
  agent.position.addScaledVector(car.lane, CAR_LANE_OFFSET);
  if (!isInsidePlayArea(agent.position, -CAR_WIDTH / 2)) clampToPlayArea(agent.position, CAR_WIDTH / 2, agent.position);

  car.yaw = dt > 0 ? turnTowards(car.yaw, Math.atan2(dir.x, dir.z), 6, dt) : car.yaw;
  agent.velocity.copy(dir).multiplyScalar(car.speed);
  agent.velocity.y = 0;

  // sit on the ground grid, pitched along the slope (front and rear axles)
  const fx = Math.sin(car.yaw);
  const fz = Math.cos(car.yaw);
  const front = sampleGround(agent.position.x + fx * 1.7, agent.position.z + fz * 1.7);
  const rear = sampleGround(agent.position.x - fx * 1.7, agent.position.z - fz * 1.7);
  car.y = (front + rear) / 2;
  agent.position.y = car.y;

  car.mesh.position.copy(agent.position);
  car.mesh.rotation.y = car.yaw;
  car.mesh.rotation.x = -Math.atan2(front - rear, 3.4);
}

// --- pedestrians -------------------------------------------------------------------------------

function newWalker(index: number, path: PathState | null, leader: Walker | null): Walker {
  const object = new THREE.Object3D(); // anchor for PositionalAudio etc.; the body is drawn by the crowd
  object.name = 'pedestrian';
  world.agentsGroup.add(object);
  const agent: Agent = {
    type: 'pedestrian',
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    loudness: PED_LOUDNESS,
    object,
  };
  const height = randomRange(PED_HEIGHT_MIN, PED_HEIGHT_MAX);
  const build = randomRange(PED_BUILD_MIN, PED_BUILD_MAX);
  crowd!.setShape(index, { height, build });
  return {
    agent,
    index,
    path,
    leader,
    formX: 0,
    formZ: 0,
    mode: leader ? 'follow' : 'walk',
    timer: 0,
    height,
    radius: 0.22 + 0.06 * ((build - PED_BUILD_MIN) / (PED_BUILD_MAX - PED_BUILD_MIN)),
    speed: leader ? leader.speed * randomRange(0.97, 1.03) : randomRange(PED_SPEED_MIN, PED_SPEED_MAX),
    moveSpeed: 0,
    loiterer: false,
    crosser: false,
    crossTimer: randomRange(3, 9),
    crossTarget: new THREE.Vector3(),
    base: new THREE.Vector3(),
    offset: new THREE.Vector3(),
    knock: new THREE.Vector3(),
    yaw: Math.random() * Math.PI * 2,
    phase: Math.random() * Math.PI * 2,
    curSpeed: 0,
    lastX: 0,
    lastZ: 0,
    stumbleTime: 0,
    leanPitch: 0,
    leanRoll: 0,
    seed: Math.random() * 100,
    y: NaN,
    cooldown: 0,
  };
}

/** Add `w` to the world and give it its first position. */
function registerWalker(w: Walker): void {
  if (w.path) {
    pathPoint(w.path, w.base);
    pathDirection(w.path, dir);
    w.yaw = Math.atan2(dir.x, dir.z);
    w.moveSpeed = w.speed;
  }
  w.agent.position.set(w.base.x, 0, w.base.z);
  w.lastX = w.base.x;
  w.lastZ = w.base.z;
  walkers.push(w);
  world.agents.push(w.agent);
}

function tooCloseToOthers(x: number, z: number, minDist: number): boolean {
  for (const o of walkers) {
    if (Math.hypot(o.agent.position.x - x, o.agent.position.z - z) < minDist) return true;
  }
  return false;
}

/** A lone pedestrian on a random spot of the footway network. */
function spawnLoner(graph: PathGraph): Walker | null {
  for (let attempt = 0; attempt < 10; attempt++) {
    const path = randomPath(graph);
    if (!path) return null;
    pathPoint(path, tmpA);
    if (attempt < 9 && tooCloseToOthers(tmpA.x, tmpA.z, 1)) continue;
    const w = newWalker(walkers.length, path, null);
    w.loiterer = Math.random() < LOITERER_CHANCE;
    w.crosser = !w.loiterer && Math.random() < CROSSER_CHANCE;
    registerWalker(w);
    if (w.loiterer && Math.random() < 0.7) startIdle(w);
    return w;
  }
  return null;
}

/** A leader plus 1 to 2 followers walking together. */
function spawnGroup(graph: PathGraph, size: number): Walker[] {
  const leader = spawnLoner(graph);
  if (!leader) return [];
  leader.loiterer = false;
  const members = [leader];
  const spots =
    size === 2
      ? [[0.8, -0.1]]
      : [
          [0.75, -0.25],
          [-0.75, -0.25],
        ];
  for (const [fx, fz] of spots) {
    const f = newWalker(walkers.length, null, leader);
    f.formX = fx + randomRange(-0.1, 0.1);
    f.formZ = fz + randomRange(-0.1, 0.1);
    f.base.copy(leader.base);
    f.yaw = leader.yaw;
    followerTarget(f, tmpA);
    f.base.copy(tmpA);
    f.moveSpeed = f.speed;
    registerWalker(f);
    members.push(f);
  }
  return members;
}

/** Where a follower wants to stand: its formation spot in the leader's frame. */
function followerTarget(f: Walker, out: THREE.Vector3): THREE.Vector3 {
  const l = f.leader!;
  const cos = Math.cos(l.yaw);
  const sin = Math.sin(l.yaw);
  // leader-local (+x left, +z ahead) -> world
  const lx = f.formX * cos + f.formZ * sin;
  const lz = -f.formX * sin + f.formZ * cos;
  return out.set(l.agent.position.x + lx, 0, l.agent.position.z + lz);
}

function startIdle(w: Walker): void {
  w.mode = 'idle';
  w.timer = w.loiterer ? randomRange(6, 18) : randomRange(2, 7);
}

/** Cars' road edge closest to (x, z): returns squared distance and writes the closest point. */
function nearestRoadPoint(x: number, z: number, out: THREE.Vector3): number {
  if (!carGraph) return Infinity;
  const { positions, edges } = carGraph;
  let best = Infinity;
  for (const e of edges) {
    const a = positions[e.a];
    const b = positions[e.b];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 1e-9 ? THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1) : 0;
    const qx = a.x + abx * t;
    const qz = a.z + abz * t;
    const d2 = (qx - x) ** 2 + (qz - z) ** 2;
    if (d2 < best) {
      best = d2;
      out.set(qx, 0, qz);
    }
  }
  return best;
}

/** Try to start crossing the nearest road straight across. Returns true if the pedestrian set off. */
function tryStartCrossing(w: Walker): boolean {
  if (!w.path || !pedestrianGraph) return false;
  const px = w.agent.position.x;
  const pz = w.agent.position.z;
  const d2 = nearestRoadPoint(px, pz, tmpA);
  const d = Math.sqrt(d2);
  if (d < 1 || d > CROSS_MAX_ROAD_DISTANCE) return false;
  // straight across: through the nearest road point to the same distance on the far side, plus a little
  tmpB.set(tmpA.x - px, 0, tmpA.z - pz).divideScalar(d);
  const reach = 2 * d + 1.5;
  const tx = px + tmpB.x * reach;
  const tz = pz + tmpB.z * reach;
  if (!isInsidePlayArea(tmpB.set(tx, 0, tz), -2)) return false;
  // there should be a path on the far side to walk back onto
  const probe = makePath(pedestrianGraph, w.path.from, w.path.to, 0);
  if (snapToGraph(probe, tx, tz, 0, 1) > 15 * 15) return false;
  // don't step out in front of a car
  for (const c of cars) {
    if (Math.hypot(c.agent.position.x - tmpA.x, c.agent.position.z - tmpA.z) < CROSS_CAR_CLEARANCE) return false;
  }
  w.crossTarget.set(tx, 0, tz);
  w.mode = 'cross';
  return true;
}

/** Re-attach a knocked or crossing pedestrian to the nearest point on its path and walk back to it. */
function rejoinPath(w: Walker): void {
  if (!w.path) {
    w.mode = 'follow';
    return;
  }
  const px = w.agent.position.x;
  const pz = w.agent.position.z;
  snapToGraph(w.path, px, pz, Math.sin(w.yaw), Math.cos(w.yaw));
  pathPoint(w.path, w.base);
  w.offset.set(px - w.base.x, 0, pz - w.base.z);
  w.mode = 'return';
}

/** Move a vector in the ground plane towards zero by at most `step` metres. */
function pullToZero(v: THREE.Vector3, step: number): void {
  const len = Math.hypot(v.x, v.z);
  if (len <= Math.max(step, 1e-9)) v.set(0, 0, 0);
  else {
    const s = (len - step) / len;
    v.x *= s;
    v.z *= s;
  }
}

function updateWalker(w: Walker, dt: number): void {
  w.cooldown = Math.max(0, w.cooldown - dt);

  switch (w.mode) {
    case 'walk':
    case 'idle': {
      const path = w.path!;
      const target = w.mode === 'walk' ? w.speed : 0;
      w.moveSpeed += (target - w.moveSpeed) * Math.min(1, 5 * dt);
      const passed = advancePath(path, w.moveSpeed * dt);
      pathPoint(path, w.base);
      pullToZero(w.offset, OFFSET_PULL_SPEED * dt);
      if (w.mode === 'idle') {
        w.timer -= dt;
        if (w.timer <= 0) w.mode = 'walk';
      } else if (passed > 0 && Math.random() < (w.loiterer ? LOITERER_REST_CHANCE : REST_CHANCE)) {
        startIdle(w);
      } else if (w.crosser) {
        w.crossTimer -= dt;
        if (w.crossTimer <= 0) {
          w.crossTimer = randomRange(5, 14);
          if (Math.random() < 0.5) tryStartCrossing(w);
        }
      }
      break;
    }
    case 'cross': {
      tmpA.subVectors(w.crossTarget, w.base);
      tmpA.y = 0;
      const dist = tmpA.length();
      w.moveSpeed += (w.speed * 1.15 - w.moveSpeed) * Math.min(1, 5 * dt);
      if (dist < 0.3) {
        w.moveSpeed = w.speed;
        w.offset.set(0, 0, 0);
        w.agent.position.set(w.base.x, 0, w.base.z);
        rejoinPath(w);
      } else {
        w.base.addScaledVector(tmpA, Math.min(dist, w.moveSpeed * dt) / dist);
      }
      pullToZero(w.offset, OFFSET_PULL_SPEED * dt);
      break;
    }
    case 'follow': {
      const leader = w.leader!;
      followerTarget(w, tmpA);
      tmpA.sub(w.base);
      tmpA.y = 0;
      const dist = tmpA.length();
      const desired = dist < 0.06 ? 0 : Math.min(dist * 2.2, w.speed * 1.35 + 0.3);
      w.moveSpeed += (desired - w.moveSpeed) * Math.min(1, 8 * dt);
      if (dist > 1e-6) w.base.addScaledVector(tmpA, Math.min(dist, w.moveSpeed * dt) / dist);
      pullToZero(w.offset, OFFSET_PULL_SPEED * dt);
      if (w.moveSpeed < 0.15) w.yaw = turnTowards(w.yaw, leader.yaw, 2, dt); // stand facing the same way
      break;
    }
    case 'stumble': {
      w.moveSpeed = 0;
      w.timer -= dt;
      w.stumbleTime += dt;
      const speed = Math.hypot(w.knock.x, w.knock.z);
      if (speed > 0) {
        const s = Math.max(0, speed - STUMBLE_FRICTION * dt) / speed;
        w.knock.x *= s;
        w.knock.z *= s;
      }
      w.offset.x += w.knock.x * dt;
      w.offset.z += w.knock.z * dt;
      if (w.timer <= 0) {
        w.knock.set(0, 0, 0);
        w.stumbleTime = 0;
        rejoinPath(w);
      }
      break;
    }
    case 'return': {
      // walk back to the nearest point of the path (the path itself is paused meanwhile)
      pullToZero(w.offset, w.speed * dt);
      if (Math.hypot(w.offset.x, w.offset.z) < 1e-3) {
        w.mode = w.path ? 'walk' : 'follow';
      }
      break;
    }
  }
}

/** Light separation between pedestrians: nudges them apart (off their paths) so they never overlap. */
function avoidOthers(): void {
  const n = walkers.length;
  for (let i = 0; i < n; i++) {
    const a = walkers[i];
    if (a.mode === 'stumble') continue;
    for (let j = i + 1; j < n; j++) {
      const b = walkers[j];
      if (b.mode === 'stumble') continue;
      const dx = b.agent.position.x - a.agent.position.x;
      const dz = b.agent.position.z - a.agent.position.z;
      const together = a.leader === b || b.leader === a || (a.leader !== null && a.leader === b.leader);
      const wanted = a.radius + b.radius + (together ? 0 : PERSONAL_SPACE);
      if (dx > wanted || dx < -wanted || dz > wanted || dz < -wanted) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 >= wanted * wanted) continue;
      const d = Math.sqrt(d2);
      let nx: number;
      let nz: number;
      if (d > 1e-4) {
        nx = dx / d;
        nz = dz / d;
      } else {
        const angle = (i * 2.399 + j) % (Math.PI * 2);
        nx = Math.cos(angle);
        nz = Math.sin(angle);
      }
      const push = (wanted - d) * 0.5 * AVOID_STRENGTH;
      nudge(a, -nx * push, -nz * push);
      nudge(b, nx * push, nz * push);
    }
  }
}

function nudge(w: Walker, x: number, z: number): void {
  w.offset.x += x;
  w.offset.z += z;
  const len = Math.hypot(w.offset.x, w.offset.z);
  if (len > MAX_AVOID_OFFSET && w.mode !== 'return') {
    const s = MAX_AVOID_OFFSET / len;
    w.offset.x *= s;
    w.offset.z *= s;
  }
}

/** Final position, facing and ground height for a pedestrian this frame. */
function placeWalker(w: Walker, dt: number): void {
  const { agent } = w;
  agent.position.x = w.base.x + w.offset.x;
  agent.position.z = w.base.z + w.offset.z;
  // never let a body poke through the boundary walls (also covers knocked pedestrians)
  if (!isInsidePlayArea(agent.position, -w.radius)) {
    clampToPlayArea(agent.position, w.radius, agent.position);
    w.offset.x = agent.position.x - w.base.x;
    w.offset.z = agent.position.z - w.base.z;
  }

  // measured velocity -> walk-cycle speed and facing
  let vx = 0;
  let vz = 0;
  if (dt > 0) {
    vx = (agent.position.x - w.lastX) / dt;
    vz = (agent.position.z - w.lastZ) / dt;
  }
  w.lastX = agent.position.x;
  w.lastZ = agent.position.z;
  agent.velocity.set(vx, 0, vz);
  const speed = Math.hypot(vx, vz);
  w.curSpeed += (speed - w.curSpeed) * Math.min(1, 10 * dt);
  if (w.mode !== 'stumble' && speed > 0.2 && dt > 0) w.yaw = turnTowards(w.yaw, Math.atan2(vx, vz), 8, dt);
  if (w.mode !== 'stumble') {
    // one gait cycle (2π) = two steps: a footstep each time the phase crosses a multiple of π
    const step = Math.floor(w.phase / Math.PI);
    w.phase += (Math.PI * 2 * w.curSpeed * dt) / strideLength(w.height);
    if (Math.floor(w.phase / Math.PI) !== step) pedestrianFootstep(agent, w.curSpeed);
  }

  const ground = sampleGround(agent.position.x, agent.position.z);
  w.y = Number.isNaN(w.y) ? ground : w.y + (ground - w.y) * Math.min(1, 12 * dt);
  agent.position.y = w.y;

  agent.object.position.copy(agent.position);
  agent.object.rotation.y = w.yaw;
}

/** 0..1 stumble pose weight over the stun: quick ramp in, hold, ease out for the last stretch. */
function stumbleAmount(w: Walker): number {
  if (w.mode !== 'stumble') return 0;
  const t = w.stumbleTime;
  const rampIn = Math.min(1, t / 0.12);
  const rampOut = Math.min(1, Math.max(0, w.timer) / 0.45);
  return Math.min(rampIn, rampOut);
}

function poseWalkers(): void {
  const c = crowd!;
  for (const w of walkers) {
    const stumble = stumbleAmount(w);
    c.setPose(w.index, {
      x: w.agent.position.x,
      y: w.agent.position.y,
      z: w.agent.position.z,
      yaw: w.yaw,
      phase: w.phase,
      speed: w.mode === 'stumble' ? 0 : w.curSpeed,
      stumble,
      stumbleTime: w.stumbleTime,
      leanPitch: w.leanPitch,
      leanRoll: w.leanRoll,
      time: clock,
      seed: w.seed,
    });
  }
  c.commit();
}

// --- player contacts ---------------------------------------------------------------------------

const playerVel = new THREE.Vector3();
const impulse = new THREE.Vector3();
const contactPoint = new THREE.Vector3();

/** Approximate contact point: the player's surface along the normal, ~1 m above the agent's base. */
function contactPointFor(pos: THREE.Vector3, n: THREE.Vector3, agentBaseY: number): THREE.Vector3 {
  return contactPoint.set(pos.x - n.x * PLAYER_RADIUS, agentBaseY + 1, pos.z - n.z * PLAYER_RADIUS);
}

/** Push the player (the camera is the player position) out of an overlap, at most MAX_SEPARATION per frame. */
function separatePlayer(nx: number, nz: number, depth: number): void {
  const d = Math.min(MAX_SEPARATION, depth);
  world.camera.position.x += nx * d;
  world.camera.position.z += nz * d;
}

function knockWalker(w: Walker, nx: number, nz: number, push: number): void {
  // pushed away from the player: opposite to the contact normal (which points agent -> player)
  w.knock.set(-nx * push, 0, -nz * push);
  w.mode = 'stumble';
  w.timer = STUMBLE_DURATION;
  w.stumbleTime = 0;
  w.moveSpeed = 0;
  w.curSpeed = 0;
  // lean the way the shove sends the body, relative to where they face
  const fx = Math.sin(w.yaw);
  const fz = Math.cos(w.yaw);
  const lx = Math.cos(w.yaw);
  const lz = -Math.sin(w.yaw);
  const px = -nx;
  const pz = -nz;
  w.leanPitch = THREE.MathUtils.clamp((px * fx + pz * fz) * 0.55, -0.55, 0.55);
  w.leanRoll = THREE.MathUtils.clamp((px * lx + pz * lz) * 0.45, -0.45, 0.45);
}

function updatePlayerContacts(dt: number): void {
  const controller = getPlayerController();
  if (!controller || isDebugCameraActive()) return;
  const pos = world.camera.position;
  const feet = pos.y - PLAYER_HEIGHT;
  controller.getVelocity(playerVel);
  const pvx = playerVel.x;
  const pvz = playerVel.z;
  const pSpeed = Math.hypot(pvx, pvz);

  for (const car of cars) {
    car.cooldown = Math.max(0, car.cooldown - dt);
    const a = car.agent;
    const dx = pos.x - a.position.x;
    const dz = pos.z - a.position.z;
    if (dx * dx + dz * dz > 36) continue; // beyond any possible contact (box half-diagonal is ~2.4 m)
    if (
      !verticalCapsuleVsBox(
        pos.x, pos.z, feet, PLAYER_BODY_HEIGHT, PLAYER_RADIUS,
        a.position.x, a.position.z, car.yaw, CAR_WIDTH / 2, CAR_LENGTH / 2, a.position.y, CAR_HEIGHT, contact,
      )
    ) {
      continue;
    }
    const n = contact.normal;
    // The car does not care: only the player moves, out of the box and away.
    separatePlayer(n.x, n.z, contact.penetration);
    if (car.cooldown > 0) continue;
    car.cooldown = CAR_CONTACT_COOLDOWN;

    const carSpeed = Math.hypot(a.velocity.x, a.velocity.z);
    const total = carSpeed + pSpeed; // impulse scales with both speeds, so even a standing player is flung
    // Actual relative closing speed along the collision normal.
    // Used for audit; total remains the gameplay fling strength.
    const carClosingSpeed = Math.max(0, (a.velocity.x - pvx) * n.x + (a.velocity.z - pvz) * n.z);
    impulse.set(0, 0, 0).addScaledVector(n, CAR_FLING_NORMAL_GAIN * total).addScaledVector(a.velocity, CAR_FLING_CARRY);
    impulse.y = 0;
    if (impulse.length() > CAR_FLING_MAX) impulse.setLength(CAR_FLING_MAX);
    controller.applyImpulse(impulse, { impactSpeed: total, forceStun: true });
    // Record the car collision.
    logAgentCollision('car',carClosingSpeed,n,pos);
    emitAgentNoise(a.position, NOISE_CAR);
  }

  for (const w of walkers) {
    const a = w.agent;
    const dx = pos.x - a.position.x;
    const dz = pos.z - a.position.z;
    if (dx * dx + dz * dz > 4) continue;
    if (
      !verticalCapsuleOverlap(
        pos.x, pos.z, feet, PLAYER_BODY_HEIGHT, PLAYER_RADIUS,
        a.position.x, a.position.z, a.position.y, w.height, w.radius, contact,
        Math.sin(w.yaw), Math.cos(w.yaw),
      )
    ) {
      continue;
    }
    const n = contact.normal;
    // closing speed along the normal (normal points pedestrian -> player)
    const closing = (a.velocity.x - pvx) * n.x + (a.velocity.z - pvz) * n.z;

    // shared separation: each body gives way by half the overlap
    const half = contact.penetration / 2;
    separatePlayer(n.x, n.z, half);
    w.offset.x -= n.x * half;
    w.offset.z -= n.z * half;

    if (w.cooldown > 0 || closing < STUMBLE_MIN_CLOSING) continue;
    w.cooldown = PED_CONTACT_COOLDOWN;

    // equal and opposite impulse along the normal
    const push = THREE.MathUtils.clamp(PED_PUSH_RESTITUTION * closing, PED_PUSH_MIN, PED_PUSH_MAX);
    impulse.set(n.x * push, 0, n.z * push);
    controller.applyImpulse(impulse, { impactSpeed: closing });
    // Record the pedestrian collision.
    logAgentCollision('pedestrian',closing,n,pos);
    knockWalker(w, n.x, n.z, push);
    emitAgentNoise(a.position, NOISE_PEDESTRIAN);
  }
}

// --- frame update ------------------------------------------------------------------------------

function updateAgents(dtRaw: number): void {
  // the first frame's timestamp can be slightly before the loop's start time: never go backwards
  const dt = Math.max(0, Math.min(dtRaw, 0.05));
  clock += dt;

  if (groundGeneration() !== seenGeneration) {
    // a new ground grid arrived: snap everyone onto it instead of easing from y = 0
    seenGeneration = groundGeneration();
    for (const w of walkers) w.y = NaN;
  }

  // leaders first so followers see this frame's leader position
  for (const w of walkers) if (!w.leader) updateWalker(w, dt);
  for (const w of walkers) if (w.leader) updateWalker(w, dt);
  avoidOthers();
  for (const w of walkers) placeWalker(w, dt);
  for (const c of cars) updateCar(c, dt);
  poseWalkers();
  updatePlayerContacts(dt);
}

// --- init --------------------------------------------------------------------------------------

/**
 * Load OSM, build path graphs, spawn agents into world.agentsGroup / world.agents,
 * and register their movement with world.onUpdate().
 */
export async function initAgents(): Promise<void> {
  if (initialised) return;
  initialised = true;

  initGroundField(); // agents stand on the precomputed height grid (needs initTiles() to have run)

  const osm = await loadOsm();
  performance.mark('agents:osm-loaded');
  pedestrianGraph = buildPathGraph(osm, 'footway', { highways: PEDESTRIAN_HIGHWAYS });
  carGraph = buildPathGraph(osm, 'road', { highways: CAR_HIGHWAYS });

  crowd = new HumanoidCrowd(PEDESTRIAN_COUNT, personMaterial);
  world.agentsGroup.add(crowd.group);

  let groups = 0;
  if (pedestrianGraph.edges.length > 0) {
    while (walkers.length < PEDESTRIAN_COUNT) {
      const left = PEDESTRIAN_COUNT - walkers.length;
      let spawned: Walker[];
      if (left >= 2 && Math.random() < GROUP_CHANCE) {
        const size = left >= 3 && Math.random() < 0.4 ? 3 : 2;
        spawned = spawnGroup(pedestrianGraph, size);
        if (spawned.length > 1) groups++;
      } else {
        const w = spawnLoner(pedestrianGraph);
        spawned = w ? [w] : [];
      }
      if (spawned.length === 0) break; // nowhere to spawn
    }
  }
  crowd.setActive(walkers.length); // fewer than PEDESTRIAN_COUNT if the network was too small

  for (let i = 0; i < CAR_COUNT; i++) spawnCar(carGraph, cars);

  if (osm.ways.length > 0) {
    console.info(
      `[agents] ${walkers.length} pedestrians in ${groups} groups ` +
        `(${walkers.filter((w) => w.loiterer).length} loiterers, ${walkers.filter((w) => w.crosser).length} crossers; ` +
        `${pedestrianGraph.edges.length} path edges), ${cars.length} cars (${carGraph.edges.length} road edges)`,
    );
  }

  world.onUpdate(updateAgents);
  performance.mark('agents:ready');
}

// --- debug / tests -----------------------------------------------------------------------------

export interface AgentDebugInfo {
  type: AgentType;
  mode: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
}

/** Light read-only view of every agent's state, for the console and tests. */
export function getAgentDebugInfo(): AgentDebugInfo[] {
  return [
    ...walkers.map((w) => ({ type: 'pedestrian' as const, mode: w.mode, position: w.agent.position, velocity: w.agent.velocity })),
    ...cars.map((c) => ({ type: 'car' as const, mode: 'drive', position: c.agent.position, velocity: c.agent.velocity })),
  ];
}
