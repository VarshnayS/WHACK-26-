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
 * With OMNISCIENT on (the default) it always knows where the player is and walks the shortest
 * route to them, so there is constant time pressure:
 *   investigate  stalking: shortest path to the player at STALK_SPEED, ramping up the longer you last
 *   chase        heard you (voice/impact/footstep/cane within hearing range): surges at
 *                CHASE_BOOST_SPEED for BOOST_TIME
 * With OMNISCIENT off it uses the hearing-only behaviour below.
 *
 *   caught       (event) within CATCH_RADIUS of the player: fires 'caught', then locks on and keeps
 *                chasing the player's real position (at most one catch per CATCH_COOLDOWN). It still
 *                gives up after LOSE_INTEREST_TIME with no new sound.
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
  /** Seconds since it started hunting (drives the speed ramp in OMNISCIENT mode). */
  huntTime = 0;
  /** OMNISCIENT: false until the player first moves or makes a sound (see ENGAGE_ON_PLAYER). */
  engaged = !C.ENGAGE_ON_PLAYER;
  /** Smoothed player velocity (m/s), used to lead the player. */
  readonly playerVelocity = new THREE.Vector3();
  private replanIn = 0;
  private goalNode = -1;
  private engageFrom: THREE.Vector3 | null = null;
  private lastPlayerPos: THREE.Vector3 | null = null;

  private waypoints: THREE.Vector3[] = [];
  private searchTime = 0;
  private arrived = false;
  /** After a catch it tracks the player's real position, not just where it heard them. */
  private lockedOn = false;
  /** Seconds until another catch can fire. */
  private catchCooldown = 0;
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
  spawn(playerPos: THREE.Vector3, minDist = C.SPAWN_MIN_DIST, maxDist = C.SPAWN_MAX_DIST): void {
    this.position.copy(this.pickSpawn(playerPos, minDist, maxDist));
    this.position.y = this.env.ground(this.position.x, this.position.z);
    this.velocity.set(0, 0, 0);
    this.timeSinceSound = Infinity;
    this.lockedOn = false;
    this.catchCooldown = 0;
    this.huntTime = 0;
    this.replanIn = 0;
    this.goalNode = -1;
    this.engaged = !C.ENGAGE_ON_PLAYER;
    this.engageFrom = null;
    this.lastPlayerPos = null;
    this.playerVelocity.set(0, 0, 0);
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
    // Any player sound means the game is on: lock on even if it's out of earshot.
    if (C.OMNISCIENT && C.ENGAGE_SOUND_TYPES.includes(sound.type)) this.engaged = true;
    const d = distXZ(this.position, sound.position);
    if (d >= hearingDistance(sound.type, sound.range)) return false;

    const isPlayer = C.PLAYER_TYPES.includes(sound.type);
    if (C.OMNISCIENT) {
      // It already knows where you are; hearing you just makes it surge.
      if (!isPlayer) return false;
      this.emit({ type: 'heard', sound });
      this.timeSinceSound = 0;
      return true;
    }
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
    this.catchCooldown = Math.max(0, this.catchCooldown - dt);

    this.trackPlayer(dt, playerPos);
    if (C.OMNISCIENT) this.pursue(dt, playerPos);
    else switch (this.state) {
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
        else if (this.lockedOn) {
          // It has found you: follow your real position.
          this.target = playerPos.clone();
          this.waypoints = [this.target.clone()];
        } else if (this.waypoints.length === 0) {
          this.arrived = true;
          this.searchStep(); // reached where it last heard you: prowl around it
        }
        break;
    }

    this.move(dt);

    if (distXZ(this.position, playerPos) < C.CATCH_RADIUS && this.catchCooldown <= 0) {
      this.catchCooldown = C.CATCH_COOLDOWN;
      this.emit({ type: 'caught' });
      // Keep hunting: lock on to the player instead of stopping.
      this.lockedOn = true;
      this.timeSinceSound = 0;
      if (this.state !== 'chase') this.setState('chase');
    }
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * A random spawn point inside the play area, never closer than `minDist` to the player:
   *  1. a random footway node inside the play area between minDist and maxDist
   *  2. else any footway node inside the play area at least minDist away
   *  3. else a random point inside the play area at least minDist away
   *  4. else the furthest of those tries (the play area may be too small for minDist)
   */
  private pickSpawn(playerPos: THREE.Vector3, minDist: number, maxDist: number): THREE.Vector3 {
    const inside = (p: THREE.Vector3) => distXZ(this.env.clamp(p.clone(), C.WALL_INSET), p) < 0.01;
    const pick = <T>(list: T[]): T => list[Math.floor(this.random() * list.length)];

    const graph = this.env.graph();
    if (graph && graph.positions.length > 0) {
      const ok = graph.positions.filter((p) => inside(p) && distXZ(p, playerPos) >= minDist);
      const inRing = ok.filter((p) => distXZ(p, playerPos) <= maxDist);
      if (inRing.length > 0) return pick(inRing).clone();
      if (ok.length > 0) return pick(ok).clone();
    }

    let best = playerPos.clone();
    let bestD = -1;
    for (let i = 0; i < 64; i++) {
      const a = this.random() * Math.PI * 2;
      const r = minDist + this.random() * (maxDist - minDist);
      const p = this.env.clamp(new THREE.Vector3(playerPos.x + Math.sin(a) * r, 0, playerPos.z + Math.cos(a) * r), C.WALL_INSET);
      const d = distXZ(p, playerPos);
      if (d >= minDist) return p;
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** Smoothed player velocity from frame-to-frame movement (teleports ignored). */
  private trackPlayer(dt: number, playerPos: THREE.Vector3): void {
    if (this.lastPlayerPos && dt > 0) {
      const vx = (playerPos.x - this.lastPlayerPos.x) / dt;
      const vz = (playerPos.z - this.lastPlayerPos.z) / dt;
      if (Math.hypot(vx, vz) < 15) {
        const k = Math.min(1, C.PLAYER_VEL_SMOOTHING * dt);
        this.playerVelocity.x += (vx - this.playerVelocity.x) * k;
        this.playerVelocity.z += (vz - this.playerVelocity.z) * k;
      } else {
        this.playerVelocity.set(0, 0, 0);
      }
    }
    this.lastPlayerPos = (this.lastPlayerPos ?? new THREE.Vector3()).copy(playerPos);
  }

  /**
   * OMNISCIENT mode: lock on to the player and take the shortest route.
   *  - waits until the player first moves or makes a sound (ENGAGE_ON_PLAYER)
   *  - far away: A* along the footway graph, re-planned every REPLAN_INTERVAL or as soon as the
   *    player's nearest graph node changes
   *  - within DIRECT_RADIUS: straight at where the player will be (leads by up to LEAD_MAX_TIME)
   */
  private pursue(dt: number, playerPos: THREE.Vector3): void {
    if (!this.engaged) {
      this.engageFrom ??= playerPos.clone();
      if (distXZ(playerPos, this.engageFrom) < C.ENGAGE_MOVE) {
        this.waypoints = [];
        this.target = null;
        return;
      }
      this.engaged = true;
    }
    this.huntTime += dt;
    const want: EntityStateName = this.timeSinceSound < C.BOOST_TIME ? 'chase' : 'investigate';
    if (this.state !== want) this.setState(want);

    const player = this.env.clamp(playerPos.clone(), C.WALL_INSET);
    const d = distXZ(this.position, player);
    const graph = this.env.graph();
    const direct = !graph || graph.positions.length === 0 || d < C.DIRECT_RADIUS;

    if (direct) {
      // Intercept: aim where the player will be when it gets there.
      const goal = player.clone();
      const pv = this.playerVelocity;
      if (Math.hypot(pv.x, pv.z) > 0.2) {
        const t = Math.min(C.LEAD_MAX_TIME, d / Math.max(this.currentSpeed(), 0.5));
        goal.x += pv.x * t;
        goal.z += pv.z * t;
        goal.copy(this.env.clamp(goal, C.WALL_INSET));
      }
      this.target = goal;
      this.waypoints = [goal.clone()];
      this.goalNode = -1;
      return;
    }

    const node = nearestNode(graph!, player);
    this.replanIn -= dt;
    if (this.replanIn <= 0 || this.waypoints.length === 0 || node !== this.goalNode) {
      this.replanIn = C.REPLAN_INTERVAL;
      this.goalNode = node;
      this.target = player;
      this.waypoints = this.plan(player);
    } else {
      // Between re-plans keep the last waypoint on the player.
      this.target = player;
      this.waypoints[this.waypoints.length - 1].copy(player);
    }
  }

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
    this.lockedOn = false;
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
    // Drop the last node if the target is already between it and the node before (no overshoot).
    const n = points.length;
    if (n >= 2 && distXZ(points[n - 2], target) < distXZ(points[n - 2], points[n - 1])) points.pop();
    points.push(target.clone());
    return points;
  }

  private currentSpeed(): number {
    if (C.OMNISCIENT) {
      if (this.state === 'chase') return C.CHASE_BOOST_SPEED;
      return Math.min(C.STALK_MAX_SPEED, C.STALK_SPEED + C.STALK_RAMP * this.huntTime);
    }
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
      // Locked on: the final waypoint is the player, so close the whole distance instead of "arriving".
      const homing = C.OMNISCIENT && this.engaged && this.waypoints.length === 1;
      if (homing) {
        if (d < 1e-4) break;
        const step = Math.min(budget, d);
        this.position.x += (dx / d) * step;
        this.position.z += (dz / d) * step;
        this.heading = Math.atan2(dx, dz);
        budget -= step;
        break;
      }
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