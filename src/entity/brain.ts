/**
 * src/entity/brain.ts: the entity's behaviour (state machine, hearing, movement)
 * Owner: entity (src/entity/)
 *
 * No rendering or world imports: src/entity/index.ts feeds it the player position, the
 * noises it could hear and a ground-height function, then copies its position to the mesh.
 *
 * States:
 *   dormant      waiting out START_DELAY (any heard noise wakes it)
 *   wander       slow roaming around the player's general area
 *   investigate  heads to where it heard a noise (aim is fuzzier the further away it was),
 *                then stands and listens for LINGER_TIME
 *   hunt         sensed the player close by: chases their real position until they get
 *                LOSE_RADIUS away, then investigates their last known position
 *   caught       game over; it stops until reset()
 */
import * as THREE from 'three';
import type { PathGraph } from '../world/osm';
import { ENTITY } from './config';
import { distXZ, findPath, nearestNode, nodesInRing } from './pathfind';

export type EntityState = 'dormant' | 'wander' | 'investigate' | 'hunt' | 'caught';

/** Something the entity might hear: a sonar ping, a collision bump, etc. */
export interface Noise {
  position: THREE.Vector3;
  /** Loudness expressed as a reach in metres (same unit as a ping's range). */
  range: number;
}

export interface BrainOptions {
  /** Walkable OSM graph. Empty or null = walk in straight lines. */
  graph?: PathGraph | null;
  /** Ground y under a position (src/player/collision.ts groundHeight). */
  groundHeight?: (p: THREE.Vector3) => number;
  /** Injectable RNG for tests. */
  random?: () => number;
}

export type BrainEvent = 'hunt-start' | 'hunt-lost' | 'caught' | 'heard';

export class EntityBrain {
  readonly position = new THREE.Vector3();
  /** Yaw in radians (0 = facing +z). */
  heading = 0;
  state: EntityState = 'dormant';
  /** 0..1: rises with each heard noise, decays over time. */
  agitation = 0;
  /** Where it is currently going (null when idle). */
  target: THREE.Vector3 | null = null;
  /** Last place it believes the player was. */
  lastKnown: THREE.Vector3 | null = null;
  /** Current speed in m/s (0 when standing). */
  speed = 0;

  graph: PathGraph | null;
  private readonly ground: (p: THREE.Vector3) => number;
  private readonly random: () => number;
  private waypoints: THREE.Vector3[] = [];
  private stateTime = 0;
  private arrivedAt = -1;
  private listeners = new Set<(e: BrainEvent, brain: EntityBrain) => void>();

  constructor(opts: BrainOptions = {}) {
    this.graph = opts.graph && opts.graph.positions.length > 0 ? opts.graph : null;
    this.ground = opts.groundHeight ?? (() => 0);
    this.random = opts.random ?? Math.random;
  }

  /** Subscribe to state events. Returns an unsubscribe function. */
  on(fn: (e: BrainEvent, brain: EntityBrain) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Place it SPAWN_MIN..SPAWN_MAX from the player, dormant. */
  spawn(playerPos: THREE.Vector3): void {
    const { SPAWN_MIN, SPAWN_MAX } = ENTITY;
    const candidates = this.graph ? nodesInRing(this.graph, playerPos, SPAWN_MIN, SPAWN_MAX) : [];
    if (candidates.length > 0) {
      const i = candidates[Math.floor(this.random() * candidates.length)];
      this.position.copy(this.graph!.positions[i]);
    } else {
      const a = this.random() * Math.PI * 2;
      const r = SPAWN_MIN + this.random() * (SPAWN_MAX - SPAWN_MIN);
      this.position.set(playerPos.x + Math.sin(a) * r, 0, playerPos.z + Math.cos(a) * r);
    }
    this.position.y = this.ground(this.position);
    this.heading = Math.atan2(playerPos.x - this.position.x, playerPos.z - this.position.z);
    this.agitation = 0;
    this.lastKnown = null;
    this.setState('dormant');
    this.waypoints = [];
    this.target = null;
  }

  /** Respawn far away and start over (after a game over). */
  reset(playerPos: THREE.Vector3): void {
    this.spawn(playerPos);
  }

  /**
   * Offer it a noise. Returns true if it heard it. Quiet or distant noises are ignored;
   * heard ones send it to investigate, with aim error growing with distance.
   */
  hear(noise: Noise): boolean {
    if (this.state === 'caught') return false;
    const d = distXZ(this.position, noise.position);
    const reach = noise.range * ENTITY.HEARING_FACTOR;
    if (d > reach || reach <= 0) return false;

    this.agitation = Math.min(1, this.agitation + ENTITY.AGITATION_PER_NOISE);
    this.lastKnown = noise.position.clone();
    this.emit('heard');

    // Already chasing the real player: the noise just confirms it.
    if (this.state === 'hunt') return true;

    const err = ENTITY.HEARING_ERROR * (d / reach) * (1 - 0.5 * this.agitation);
    const a = this.random() * Math.PI * 2;
    const r = Math.sqrt(this.random()) * err;
    const guess = noise.position.clone();
    guess.x += Math.sin(a) * r;
    guess.z += Math.cos(a) * r;
    this.goTo(guess, 'investigate');
    return true;
  }

  /**
   * Advance one frame.
   * @param playerSpeed horizontal player speed in m/s (standing still hides you from SENSE_RADIUS)
   */
  update(dt: number, playerPos: THREE.Vector3, playerSpeed: number): void {
    if (this.state === 'caught') {
      this.speed = 0;
      return;
    }
    this.stateTime += dt;
    this.agitation = Math.max(0, this.agitation - ENTITY.AGITATION_DECAY * dt);

    const dPlayer = distXZ(this.position, playerPos);

    // Direct senses (not while dormant).
    if (this.state !== 'dormant' && this.state !== 'hunt') {
      const moving = playerSpeed > ENTITY.MOVE_THRESHOLD;
      if ((moving && dPlayer < ENTITY.SENSE_RADIUS) || dPlayer < ENTITY.CLOSE_SENSE_RADIUS) {
        this.setState('hunt');
        this.emit('hunt-start');
      }
    }

    switch (this.state) {
      case 'dormant':
        if (this.stateTime >= ENTITY.START_DELAY) this.wander(playerPos);
        break;

      case 'wander':
        if (this.waypoints.length === 0) this.wander(playerPos);
        break;

      case 'investigate':
        if (this.waypoints.length === 0) {
          if (this.arrivedAt < 0) this.arrivedAt = this.stateTime;
          else if (this.stateTime - this.arrivedAt >= ENTITY.LINGER_TIME) this.wander(playerPos);
        }
        break;

      case 'hunt':
        this.lastKnown = playerPos.clone();
        if (dPlayer > ENTITY.LOSE_RADIUS) {
          this.emit('hunt-lost');
          this.goTo(this.lastKnown, 'investigate');
        } else {
          this.target = playerPos.clone();
          this.waypoints = [this.target];
        }
        break;
    }

    this.move(dt);

    if (distXZ(this.position, playerPos) < ENTITY.CATCH_RADIUS && this.state !== 'dormant') {
      this.setState('caught');
      this.waypoints = [];
      this.speed = 0;
      this.emit('caught');
    }
  }

  /** Remaining route (for debugging/visualising). */
  getWaypoints(): readonly THREE.Vector3[] {
    return this.waypoints;
  }

  // ---------------------------------------------------------------------------------------

  private setState(s: EntityState): void {
    this.state = s;
    this.stateTime = 0;
    this.arrivedAt = -1;
  }

  private emit(e: BrainEvent): void {
    for (const fn of this.listeners) fn(e, this);
  }

  private wander(playerPos: THREE.Vector3): void {
    const a = this.random() * Math.PI * 2;
    const r = ENTITY.WANDER_MIN + this.random() * (ENTITY.WANDER_MAX - ENTITY.WANDER_MIN);
    const p = new THREE.Vector3(playerPos.x + Math.sin(a) * r, 0, playerPos.z + Math.cos(a) * r);
    if (this.graph) p.copy(this.graph.positions[nearestNode(this.graph, p)]);
    this.goTo(p, 'wander');
  }

  private goTo(target: THREE.Vector3, state: EntityState): void {
    this.setState(state);
    this.target = target.clone();
    this.waypoints = this.plan(this.target);
  }

  /** Route to `target`: along the OSM graph when far, straight line when close or no graph. */
  private plan(target: THREE.Vector3): THREE.Vector3[] {
    const direct = [target.clone()];
    if (!this.graph || distXZ(this.position, target) < ENTITY.DIRECT_RADIUS) return direct;

    const start = nearestNode(this.graph, this.position);
    const goal = nearestNode(this.graph, target);
    const path = findPath(this.graph, start, goal);
    if (!path) return direct;

    const points = path.map((i) => this.graph!.positions[i].clone());
    // Drop the first node if it's behind us relative to the second (avoids a back-step).
    if (points.length >= 2) {
      const toFirst = distXZ(this.position, points[0]);
      const firstToSecond = distXZ(points[0], points[1]);
      if (distXZ(this.position, points[1]) < toFirst + firstToSecond * 0.5) points.shift();
    }
    points.push(target.clone());
    return points;
  }

  private currentSpeed(): number {
    const base =
      this.state === 'hunt'
        ? ENTITY.HUNT_SPEED
        : this.state === 'investigate'
          ? ENTITY.INVESTIGATE_SPEED
          : this.state === 'wander'
            ? ENTITY.WANDER_SPEED
            : 0;
    return base * (1 + ENTITY.AGITATION_SPEED_BONUS * this.agitation);
  }

  private move(dt: number): void {
    let budget = this.currentSpeed() * dt;
    this.speed = 0;
    if (budget <= 0) return;
    const start = this.position.clone();

    while (budget > 0 && this.waypoints.length > 0) {
      const wp = this.waypoints[0];
      const dx = wp.x - this.position.x;
      const dz = wp.z - this.position.z;
      const d = Math.hypot(dx, dz);
      const isLast = this.waypoints.length === 1;
      const reached = isLast && this.state === 'hunt' ? 0 : ENTITY.WAYPOINT_REACHED;

      if (d <= reached + 1e-6) {
        this.waypoints.shift();
        continue;
      }
      const step = Math.min(budget, d - reached * 0.5);
      if (step <= 0) {
        this.waypoints.shift();
        continue;
      }
      this.position.x += (dx / d) * step;
      this.position.z += (dz / d) * step;
      this.heading = Math.atan2(dx, dz);
      budget -= step;
      if (step >= d - reached) this.waypoints.shift();
    }

    this.position.y = this.ground(this.position);
    if (dt > 0) this.speed = distXZ(start, this.position) / dt;
  }
}
