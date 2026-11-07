/**
 * src/entity/index.ts: the entity that hunts the player
<<<<<<< HEAD
 * Owner: entity (src/entity/)
 *
 * Plugs in through the shared `world` object only:
 *  - hears sonar pings via getActivePings() (louder ping = heard from further away)
 *  - walks the OSM footway graph (straight lines until src/world/osm.ts is implemented)
 *  - rendered with the shared sonarMaterial, so it's only visible when sonar or R reveals it
 *  - makes positional sound: footsteps, breathing, gasp/growl/shriek (src/entity/audio.ts)
 *  - stands on groundHeight() from src/player/collision.ts (flat 0 until implemented)
 *
 * Other modules can use:
 *   alertEntity(position, range)   a noise that isn't a ping (e.g. bumping into something)
 *   onEntityEvent(fn)              'caught' | 'hunt-start' | 'hunt-lost' | 'heard'
 *   getEntityObject()              its mesh (attach extra PositionalAudio here)
 *   getEntityDistance(), getEntityState(), getEntityAgitation()   for HUD/heartbeat audio
 *   resetEntity()                  respawn far away after a game over
 *   setEntityVolume(0..1)          overall volume of its sounds (src/entity/audio.ts)
 */
import * as THREE from 'three';
import { world } from '../world';
import { buildPathGraph, loadOsm } from '../world/osm';
import { OSM_URL } from '../config';
import { getActivePings, type Ping } from '../render/pings';
import { sonarMaterial } from '../render/sonarMaterial';
import { groundHeight } from '../player/collision';
import { EntityBrain, type BrainEvent, type EntityState } from './brain';
import { ENTITY } from './config';
import { distXZ } from './pathfind';
import { initEntityAudio } from './audio';

export { setEntityVolume } from './audio';

export type { EntityState, BrainEvent } from './brain';

let brain: EntityBrain | null = null;
let body: THREE.Group | null = null;
const heardPings = new WeakSet<Ping>();
const lastPlayerPos = new THREE.Vector3();
let playerSpeed = 0;
let updateAudio: ((dt: number) => void) | null = null;

/** Load the path graph, build the mesh, spawn far from the player and start thinking. */
export async function initEntity(): Promise<void> {
  let graph = null;
  try {
    graph = buildPathGraph(await loadOsm(OSM_URL), 'footway');
  } catch (err) {
    console.warn('[entity] no OSM graph, walking in straight lines', err);
  }

  brain = new EntityBrain({ graph, groundHeight });
  body = buildBody();
  world.scene.add(body);

  const player = world.camera.position;
  lastPlayerPos.copy(player);
  brain.spawn(player);
  syncBody();
  updateAudio = initEntityAudio(brain, body, world.camera);

  // It gives itself away with a short sonar burst when it locks on, and a big one when it catches you.
  brain.on((e, b) => {
    if (e === 'hunt-start') world.ping(b.position.clone().setY(b.position.y + 1.2), ENTITY.HUNT_REVEAL_RANGE);
    if (e === 'caught') world.ping(b.position.clone().setY(b.position.y + 1.2), ENTITY.CATCH_REVEAL_RANGE);
  });

  world.onUpdate(update);

  if (import.meta.env.DEV) {
    (window as unknown as { __entity: unknown }).__entity = {
      brain,
      body,
      alert: alertEntity,
      reset: resetEntity,
    };
  }
  console.info(`[entity] spawned ${distXZ(brain.position, player).toFixed(0)} m away (graph: ${graph ? graph.positions.length : 0} nodes)`);
}

function update(dt: number): void {
  if (!brain || dt <= 0) return;
  const player = world.camera.position;

  // Smoothed horizontal player speed (standing still hides you from close-range sensing).
  const instant = distXZ(player, lastPlayerPos) / dt;
  playerSpeed += (instant - playerSpeed) * Math.min(1, dt * 10);
  lastPlayerPos.copy(player);

  for (const ping of getActivePings()) {
    if (heardPings.has(ping)) continue;
    heardPings.add(ping);
    brain.hear({ position: ping.origin, range: ping.range });
  }

  brain.update(dt, player, playerSpeed);
  syncBody();
  updateAudio?.(dt);
}

function syncBody(): void {
  if (!brain || !body) return;
  body.position.copy(brain.position);
  // Smooth turning so it doesn't snap between path segments.
  let diff = brain.heading - body.rotation.y;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  body.rotation.y += diff * 0.2;
  // Slight sway while moving, stiller when listening.
  const t = performance.now() / 1000;
  body.rotation.z = Math.sin(t * 3.1) * 0.04 * Math.min(1, brain.speed);
}

/** A tall, stooped figure with long arms. Every part uses the shared sonar material. */
function buildBody(): THREE.Group {
  const h = ENTITY.HEIGHT;
  const group = new THREE.Group();
  group.name = 'entity';
  const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, sonarMaterial);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    group.add(m);
  };
  const leg = new THREE.CapsuleGeometry(0.07, h * 0.38, 4, 8);
  add(leg, -0.13, h * 0.22, 0);
  add(leg, 0.13, h * 0.22, 0);
  // Torso leans forward.
  add(new THREE.CapsuleGeometry(0.2, h * 0.3, 4, 10), 0, h * 0.62, 0.08, 0.25);
  // Head hangs low and forward.
  add(new THREE.SphereGeometry(0.17, 12, 10), 0, h * 0.86, 0.3);
  // Arms hang down past the knees.
  const arm = new THREE.CapsuleGeometry(0.05, h * 0.55, 4, 8);
  add(arm, -0.3, h * 0.46, 0.18, 0.15, 0.08);
  add(arm, 0.3, h * 0.46, 0.18, 0.15, -0.08);
  return group;
}

/** A noise that isn't a sonar ping (e.g. walking into a wall). `range` uses ping units (metres). */
export function alertEntity(position: THREE.Vector3, range: number): boolean {
  return brain ? brain.hear({ position: position.clone(), range }) : false;
}

/** Subscribe to entity events. Returns an unsubscribe function. */
export function onEntityEvent(fn: (e: BrainEvent) => void): () => void {
  if (!brain) {
    console.warn('[entity] onEntityEvent called before initEntity()');
    return () => {};
  }
  return brain.on((e) => fn(e));
}

/** Respawn far from the player in the dormant state. */
export function resetEntity(): void {
  brain?.reset(world.camera.position);
  syncBody();
}

export function getEntityState(): EntityState | null {
  return brain?.state ?? null;
}

export function getEntityPosition(): THREE.Vector3 | null {
  return brain?.position ?? null;
}

/** Horizontal distance from the player, or Infinity before init. */
export function getEntityDistance(): number {
  return brain ? distXZ(brain.position, world.camera.position) : Infinity;
}

/** 0..1, how worked up it is (good for heartbeat volume/tempo). */
export function getEntityAgitation(): number {
  return brain?.agitation ?? 0;
}

/** The entity's mesh group (attach PositionalAudio here). */
export function getEntityObject(): THREE.Object3D | null {
  return body;
}
=======
 // Stub entry point: does nothing yet. Called once from src/main.ts.
 */
import type { World } from '../world';

export function initEntity(world: World): void {
  void world; // TODO: set world.entity, emit 'entityState' and 'caught'
}
>>>>>>> origin/main
