/**
 * src/world/soundSources.ts: sound sources in the world (car engines, pedestrian footsteps, impacts)
 * Owner: SOUND (feat/sound-sources). initSoundSources() is called once from src/main.ts.
 *
 *  - Cars: periodic 'car' pings; interval and range scale with speed (~15 m at full speed).
 *  - Pedestrians: faint 'pedestrian' pings on each footstep of their walk cycle (agents.ts calls
 *    pedestrianFootstep() from the walk cycle).
 *  - Only agents within AGENT_SOUND_RADIUS of the player make pings.
 *  - Player vs agent collisions (agents.ts calls playerAgentCollision()): an audit record plus an
 *    'impact' ping.
 * Tuning: src/world/soundConfig.ts. Pings are pooled and ranked in src/world/pings.ts.
 */
import * as THREE from 'three';
import type { Agent, World } from './index';
import {
  AGENT_SOUND_RADIUS,
  CAR_ENGINE_HEIGHT,
  CAR_FULL_SPEED,
  CAR_INTERVAL_FULL,
  CAR_INTERVAL_IDLE,
  CAR_RANGE_FULL,
  CAR_RANGE_IDLE,
  IMPACT_RANGE_BASE,
  IMPACT_RANGE_MAX,
  IMPACT_RANGE_PER_MPS,
  PEDESTRIAN_STEP_FULL_SPEED,
  PEDESTRIAN_STEP_MIN_SPEED,
  PEDESTRIAN_STEP_RANGE_MAX,
  PEDESTRIAN_STEP_RANGE_MIN,
} from './soundConfig';

let world: World | null = null;
/** Next engine ping time (s) per car. */
const nextEngine = new WeakMap<Agent, number>();
const tmp = new THREE.Vector3();
const RADIUS_SQ = AGENT_SOUND_RADIUS * AGENT_SOUND_RADIUS;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function nearPlayer(w: World, p: THREE.Vector3): boolean {
  return p.distanceToSquared(w.camera.position) <= RADIUS_SQ;
}

function updateEngines(): void {
  const w = world;
  if (!w) return;
  const now = performance.now() / 1000;
  for (const a of w.agents) {
    if (a.type !== 'car' || !nearPlayer(w, a.position)) continue;
    const s = clamp01(Math.hypot(a.velocity.x, a.velocity.z) / CAR_FULL_SPEED);
    const interval = lerp(CAR_INTERVAL_IDLE, CAR_INTERVAL_FULL, s);
    const next = nextEngine.get(a);
    if (next === undefined) {
      // random first beat so cars entering range together don't pulse in sync
      nextEngine.set(a, now + Math.random() * interval);
      continue;
    }
    if (now < next) continue;
    tmp.copy(a.position);
    tmp.y += CAR_ENGINE_HEIGHT;
    w.ping(tmp, lerp(CAR_RANGE_IDLE, CAR_RANGE_FULL, s), 'car');
    nextEngine.set(a, now + interval);
  }
}

/** Called by agents.ts on every footstep of a walking pedestrian (twice per gait cycle). */
export function pedestrianFootstep(agent: Agent, speed: number): void {
  const w = world;
  if (!w || speed < PEDESTRIAN_STEP_MIN_SPEED || !nearPlayer(w, agent.position)) return;
  const t = clamp01((speed - PEDESTRIAN_STEP_MIN_SPEED) / (PEDESTRIAN_STEP_FULL_SPEED - PEDESTRIAN_STEP_MIN_SPEED));
  w.ping(agent.position, lerp(PEDESTRIAN_STEP_RANGE_MIN, PEDESTRIAN_STEP_RANGE_MAX, t), 'pedestrian');
}

/**
 * Called by agents.ts once per real player-vs-agent collision (after its contact cooldown).
 * `position` = approximate contact point, `normal` = horizontal unit normal from the agent towards
 * the player, `impactSpeed` in m/s (the same value the player controller gets). Both vectors are copied.
 */
export function playerAgentCollision(
  hit: 'car' | 'pedestrian',
  position: THREE.Vector3,
  impactSpeed: number,
  normal: THREE.Vector3,
): void {
  const w = world;
  if (!w) return;
  w.audit.record({ kind: 'collision', hit, position: position.clone(), impactSpeed, normal: normal.clone() });
  const range = Math.min(IMPACT_RANGE_MAX, IMPACT_RANGE_BASE + IMPACT_RANGE_PER_MPS * Math.max(0, impactSpeed));
  w.ping(position, range, 'impact');
}

export function initSoundSources(w: World): void {
  if (world) return;
  world = w;
  w.onUpdate(updateEngines);
}
