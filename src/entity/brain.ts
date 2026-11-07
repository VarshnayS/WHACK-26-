/**
 * src/entity/brain.ts: the entity's behaviour (state machine, hearing, movement)
 *
 * No world imports: src/entity/index.ts feeds it the sounds it might hear, the player position, the
 * path graph and the corridor clamp, then publishes its state to the world.
 *
 *   patrol       wanders the footway graph at PATROL_SPEED
 *   investigate  heard a sound: paths to it at INVESTIGATE_SPEED, then searches around it for
 *                SEARCH_TIME, then goes back to patrol
 *   chase        heard a player sound within CHASE_RADIUS: walks straight at where it heard it at
 *                CHASE_SPEED, re-aiming at every new player sound; after LOSE_INTEREST_TIME with no
 *                new sound, back to patrol
 *   caught       within CATCH_RADIUS of the player; stops until reset()
 */
import * as THREE from 'three';
import type { EntityStateName, PingType } from '../shared/contracts';
import type { PathGraph } from '../world/osm';
import * as C from './config';
import { distXZ, findPath, nearestNode, nodesInRing } from './pathfind';

/** Something it might hear (a ping). */
export interface Sound {
  position: THREE.Vector3;
  /** Ping range in metres. */
  range: number;
  type: PingType;
}

export interface BrainEnv {
  /** Footway graph inside the corridor, or null (then it walks straight lines). */
  graph: () => PathGraph | null;
  /** Ground y under (x, z). */
  ground: (x: number, z: number) => number;
  /** Nearest point inside the corridor, kept `inset` metres off the walls. */
  clamp: (p: THREE.Vector3, inset: number) => THREE.Vector3;
  random?: () => number;
}

export type BrainEvent =
  | { type: 'state'; state: EntityStateName; previous: EntityStateName }
  | { type: 'heard'; sound: Sound }
  | { type: 'caught' };

/** How loud a ping is to the entity (1 = full voice ping). */
export function loudness(type: PingType, range: number): number {
  const f = THREE.MathUtils.clamp(range / C.REFERENCE_RANGE, C.RANGE_FACTOR_MIN, C.RANGE_FACTOR_MAX);
  return (C.TYPE_LOUDNESS[type] ?? 0) * f;
}

/** Distance at which a ping of this type and range can be heard. */
export function hearingDistance(type: PingType, range: number): number {
  return loudness(type, range) * C.MAX_HEARING;
}

export class EntityBrain {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Yaw in radians (0 faces +Z). */
  heading = 0;
  state: EntityStateName = 'patrol';
  /** Where it is heading (the sound for investigate/chase, the patrol node otherwise). */
  target: THREE.Vector3 | null = null;
  /** Seconds since it last heard something it reacted to. */
  timeSinceSound = Infinity;
  /** Horizontal speed this frame (m/s). */
  speed = 0;

  private waypoints: THREE.Vector3[] = [];
  private searchTime = 0;
  private arrived = false;
  private readonly env: BrainEnv;
  private readonly random: () => number;
  private readonly listeners = new Set<(e: BrainEvent) => void>();

  constructor(env: BrainEnv) {
    this.env = env;
    this.random = env.random ?? Math.random;
  }

  on(fn: (e: BrainEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Remaining route, for the debug overlay. */
  getWaypoints(): readonly THREE.Vector3[] {
    return this.waypoints;
  }

  /** Place it on a graph node far from the player (or a random corridor point) and start patrolling. */
  spawn(playerPos: THREE.Vector3, minDist = 40, maxDist = 90): void {
    const graph = this.env.graph();
    const nodes = graph ? nodesInRing(graph, playerPos, minDist, maxDist) : [];
    if (graph && nodes.length > 0) {
      this.position.copy(graph.positions[nodes[Math.floor(this.random() * nodes.length)]]);
    } else {
      const a = this.random() * Math.PI * 2;
      const r = minDist + this.random() * (maxDist - minDist);
      this.position.set(playerPos.x + Math.sin(a) * r, 0, playerPos.z + Math.cos(a) * r);
    }
    this.position.copy(this.env.clamp(this.position, C.WALL_INSET));
    this.position.y = this.env.ground(this.position.x, this.position.z);
    this.velocity.set(0, 0, 0);
    this.timeSinceSound = Infinity;
    this.waypoints = [];
    this.target = null;
    this.setState('patrol');
  }

  reset(playerPos: THREE.Vector3): void {
    this.spawn(playerPos);
  }

  /**
   * Offer it a sound. Returns true if it heard it and reacted. Its own sounds must be filtered out
   * by the caller (index.ts knows which pings it fired).
   */
  hear(sound: Sound): boolean {
    if (this.state === 'caught') return false;
    const d = distXZ(this.position, sound.position);
    if (d >= hearingDistance(sound.type, sound.range)) return false;

    const isPlayer = C.PLAYER_TYPES.includes(sound.type);
    this.emit({ type: 'heard', sound });

    if (isPlayer && (d <= C.CHASE_RADIUS || this.state === 'chase')) {
      // Chase: straight at where the player made the sound.
      this.timeSinceSound = 0;
      this.target = sound.position.clone();
      this.waypoints = [this.target.clone()];
      this.arrived = false;
      this.searchTime = 0;
      if (this.state !== 'chase') this.setState('chase');
      return true;
    }

    // While chasing, background noise doesn't distract it.
    if (this.state === 'chase') return false;

    this.timeSinceSound = 0;
    this.goTo(sound.position, 'investigate');
    return true;
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    if (this.state === 'caught' || dt <= 0) {
      this.velocity.set(0, 0, 0);
      this.speed = 0;
      return;
    }
    this.timeSinceSound += dt;

    switch (this.state) {
      case 'patrol':
        if (this.waypoints.length === 0) this.pickPatrolTarget();
        break;
      case 'investigate':
        if (!this.arrived && this.waypoints.length === 0) this.arrived = true;
        if (this.arrived) {
          this.searchTime += dt;
          if (this.searchTime >= C.SEARCH_TIME) this.backToPatrol();
          else if (this.waypoints.length === 0) this.searchStep();
        }
        break;
      case 'chase':
        if (this.timeSinceSound >= C.LOSE_INTEREST_TIME) this.backToPatrol();
        else if (this.waypoints.length === 0) {
          this.arrived = true;
          this.searchStep(); // reached where it last heard you: prowl around it
        }
        break;
    }

    this.move(dt);

    if (distXZ(this.position, playerPos) < C.CATCH_RADIUS) {
      this.waypoints = [];
      this.velocity.set(0, 0, 0);
      this.speed = 0;
      this.setState('caught');
      this.emit({ type: 'caught' });
    }
  }

  // ---------------------------------------------------------------------------------------------

  private setState(s: EntityStateName): void {
    if (s === this.state) return;
    const previous = this.state;
    this.state = s;
    this.searchTime = 0;
    this.arrived = false;
    this.emit({ type: 'state', state: s, previous });
  }

  private emit(e: BrainEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  private backToPatrol(): void {
    this.waypoints = [];
    this.target = null;
    this.setState('patrol');
  }

  private goTo(target: THREE.Vector3, state: EntityStateName): void {
    this.target = this.env.clamp(target.clone(), C.WALL_INSET);
    this.waypoints = this.plan(this.target);
    this.arrived = false;
    this.searchTime = 0;
    this.setState(state);
  }

  private pickPatrolTarget(): void {
    const graph = this.env.graph();
    const nodes = graph ? nodesInRing(graph, this.position, C.PATROL_MIN_HOP, C.PATROL_MAX_HOP) : [];
    let p: THREE.Vector3;
    if (graph && nodes.length > 0) {
      p = graph.positions[nodes[Math.floor(this.random() * nodes.length)]].clone();
    } else {
      const a = this.random() * Math.PI * 2;
      const r = C.PATROL_MIN_HOP + this.random() * (C.PATROL_MAX_HOP - C.PATROL_MIN_HOP);
      p = new THREE.Vector3(this.position.x + Math.sin(a) * r, 0, this.position.z + Math.cos(a) * r);
    }
    this.target = this.env.clamp(p, C.WALL_INSET);
    this.waypoints = this.plan(this.target);
  }

  /** Small random hop around the target while searching. */
  private searchStep(): void {
    const centre = this.target ?? this.position;
    const a = this.random() * Math.PI * 2;
    const r = 1 + this.random() * (C.SEARCH_RADIUS - 1);
    const p = new THREE.Vector3(centre.x + Math.sin(a) * r, 0, centre.z + Math.cos(a) * r);
    this.waypoints = [this.env.clamp(p, C.WALL_INSET)];
  }

  /** Route: along the footway graph when far, straight when close or when there's no graph. */
  private plan(target: THREE.Vector3): THREE.Vector3[] {
    const direct = [target.clone()];
    const graph = this.env.graph();
    if (!graph || graph.positions.length === 0 || distXZ(this.position, target) < C.DIRECT_RADIUS) return direct;

    const path = findPath(graph, nearestNode(graph, this.position), nearestNode(graph, target));
    if (!path) return direct;
    const points = path.map((i) => graph.positions[i].clone());
    // Skip the first node if it's behind us.
    if (points.length >= 2 && distXZ(this.position, points[1]) < distXZ(points[0], points[1])) points.shift();
    points.push(target.clone());
    return points;
  }

  private currentSpeed(): number {
    if (this.state === 'chase') return C.CHASE_SPEED;
    if (this.state === 'investigate') return this.arrived ? C.PATROL_SPEED : C.INVESTIGATE_SPEED;
    if (this.state === 'patrol') return C.PATROL_SPEED;
    return 0;
  }

  private move(dt: number): void {
    const start = this.position.clone();
    let budget = this.currentSpeed() * dt;

    while (budget > 0 && this.waypoints.length > 0) {
      const wp = this.waypoints[0];
      const dx = wp.x - this.position.x;
      const dz = wp.z - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d <= C.WAYPOINT_REACHED) {
        this.waypoints.shift();
        continue;
      }
      const step = Math.min(budget, d);
      this.position.x += (dx / d) * step;
      this.position.z += (dz / d) * step;
      this.heading = Math.atan2(dx, dz);
      budget -= step;
      if (step >= d - C.WAYPOINT_REACHED) this.waypoints.shift();
    }

    this.position.copy(this.env.clamp(this.position, C.WALL_INSET));
    this.position.y = this.env.ground(this.position.x, this.position.z);
    this.velocity.subVectors(this.position, start).divideScalar(dt);
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
  }
}
