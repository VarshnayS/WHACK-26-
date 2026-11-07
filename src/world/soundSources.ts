/**
 * src/world/soundSources.ts: sound sources in the world (car engines, pedestrian footsteps, impacts)
 * Owner: SOUND (feat/sound-sources). initSoundSources() is called once from src/main.ts.
 *
 *  - Cars: periodic 'car' pings; interval and range scale with speed (~15 m at full speed).
 *  - Pedestrians: agents.ts calls pedestrianFootstep() on each footstep of the walk cycle. Listeners
 *    (onPedestrianStep: the soundscape) hear the step at once; pedestrians within PED_PING_RADIUS
 *    (src/config.ts) also make a faint 'pedestrian' ping 0.3–0.5 s later, like an echo.
 *  - Only cars within AGENT_SOUND_RADIUS of the player make pings; their range is capped at
 *    CAR_PING_RANGE_MAX.
 *  - Player vs agent collisions (agents.ts calls playerAgentCollision()): an audit record plus an
 *    'impact' ping.
 * Tuning: src/world/soundConfig.ts. Pings are pooled and ranked in src/world/pings.ts.
 */
import * as THREE from 'three';
import type { Agent, World } from './index';
import { CAR_PING_RANGE_MAX, PED_PING_ECHO_DELAY_MAX, PED_PING_ECHO_DELAY_MIN } from '../config';
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
  PEDESTRIAN_PING_RADIUS,
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
const PED_RADIUS_SQ = PEDESTRIAN_PING_RADIUS * PEDESTRIAN_PING_RADIUS;

/** Pedestrian echo pings waiting to fire (fixed pool, no allocation per step). */
interface PendingPing {
  used: boolean;
  at: number;
  origin: THREE.Vector3;
  range: number;
}
const pending: PendingPing[] = Array.from({ length: 24 }, () => ({ used: false, at: 0, origin: new THREE.Vector3(), range: 0 }));

/** Called on every pedestrian footstep, at the moment of the step (before its delayed ping). */
export type PedestrianStepListener = (agent: Agent, speed: number) => void;
const stepListeners = new Set<PedestrianStepListener>();

/** Hear every pedestrian footstep as it happens (the soundscape plays the step sound). Returns unsubscribe. */
export function onPedestrianStep(cb: PedestrianStepListener): () => void {
  stepListeners.add(cb);
  return () => stepListeners.delete(cb);
}

function firePending(): void {
  const w = world;
  if (!w) return;
  const now = performance.now() / 1000;
  for (const p of pending) {
    if (!p.used || now < p.at) continue;
    p.used = false;
    w.ping(p.origin, p.range, 'pedestrian');
  }
}

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
    w.ping(tmp, Math.min(CAR_PING_RANGE_MAX, lerp(CAR_RANGE_IDLE, CAR_RANGE_FULL, s)), 'car');
    nextEngine.set(a, now + interval);
  }
}

/** Called by agents.ts on every footstep of a walking pedestrian (twice per gait cycle). */
export function pedestrianFootstep(agent: Agent, speed: number): void {
  const w = world;
  if (!w || speed < PEDESTRIAN_STEP_MIN_SPEED) return;
  for (const cb of stepListeners) cb(agent, speed);
  if (agent.position.distanceToSquared(w.camera.position) > PED_RADIUS_SQ) return;
  const slot = pending.find((p) => !p.used);
  if (!slot) return; // more than 24 steps in flight: skip this echo
  const t = clamp01((speed - PEDESTRIAN_STEP_MIN_SPEED) / (PEDESTRIAN_STEP_FULL_SPEED - PEDESTRIAN_STEP_MIN_SPEED));
  slot.used = true;
  slot.at = performance.now() / 1000 + lerp(PED_PING_ECHO_DELAY_MIN, PED_PING_ECHO_DELAY_MAX, Math.random());
  slot.origin.copy(agent.position);
  slot.range = lerp(PEDESTRIAN_STEP_RANGE_MIN, PEDESTRIAN_STEP_RANGE_MAX, t);
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
  w.onUpdate(firePending);
}
