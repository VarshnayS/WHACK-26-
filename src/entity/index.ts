/**
 * src/entity/index.ts: the entity that hunts the player
 * Owner: ENTITY (Ayo). Called once from src/main.ts as initEntity(world).
 *
 * Uses only the shared world object plus read-only world helpers:
 *   - hears pings from world.activePings() (falls back to world.pings, typed 'voice', until the
 *     SOUND branch fills activePings in); ignores the pings it fires itself
 *   - patrols the footway graph (getPathGraph, src/world/osm.ts), stays inside the corridor
 *     (clampToPlayArea, src/world/playArea.ts), stands on sampleGround (src/world/heightField.ts)
 *
 * What other modules get:
 *   world.entity                       { state, position, velocity }, updated every frame
 *   world.on('entityState', cb)        payload { state, previous, position } on every state change
 *   world.on('caught', cb)             payload { position } when it reaches the player
 *   world.audit.record(...)            { kind: 'caught', hit: 'entity', position } on a catch
 *   faint world.ping(pos, 2, 'pedestrian') footsteps as it walks
 *
 * Debug: T overlay, N test voice ping (src/entity/debug.ts). In dev, window.__entity.
 */
import * as THREE from 'three';
import type { World } from '../world';
import type { EntityState, PingType } from '../shared/contracts';
import { getPathGraph } from '../world/osm';
import { clampToPlayArea } from '../world/playArea';
import { sampleGround } from '../world/heightField';
import { EntityBrain, type Sound } from './brain';
import { createEntityBody } from './body';
import { initEntityDebug } from './debug';
import { initEntityAudio } from './audio';
import { AUDIO_ENABLED, FOOTSTEP_PING_EVERY, FOOTSTEP_PING_RANGE } from './config';

/** A ping as the entity sees it, whichever list it came from. */
interface HeardPing {
  origin: THREE.Vector3;
  range: number;
  start: number;
  type: PingType;
}

/** Pings it fired itself, so it can ignore them. */
const ownPings: { origin: THREE.Vector3; time: number }[] = [];
/** Pings already processed (key -> time it was seen), so each is heard once. */
const seen = new Map<string, number>();

let brain: EntityBrain | null = null;
let resetFn: (() => void) | null = null;

function nowSeconds(): number {
  return performance.now() / 1000;
}

function pingKey(p: HeardPing): string {
  return `${p.start.toFixed(3)}|${p.origin.x.toFixed(2)}|${p.origin.z.toFixed(2)}`;
}

function isOwn(p: HeardPing): boolean {
  return ownPings.some((o) => Math.abs(o.time - p.start) < 0.25 && o.origin.distanceToSquared(p.origin) < 0.01);
}

/** Pings currently travelling, from the contract (or the untyped legacy list until SOUND lands). */
function readPings(world: World): HeardPing[] {
  const active = world.activePings();
  if (active.length > 0) return active;
  const legacy = (world as Partial<Pick<World, 'pings'>>).pings ?? [];
  return legacy.map((p) => ({ origin: p.origin, range: p.range, start: p.start, type: 'voice' as PingType }));
}

export function initEntity(world: World): void {
  const b = new EntityBrain({
    graph: () => getPathGraph('footway'),
    ground: sampleGround,
    clamp: (p, inset) => clampToPlayArea(p, inset, new THREE.Vector3()),
  });
  brain = b;

  const body = createEntityBody();
  world.scene.add(body.root);

  const player = world.camera.position;
  b.spawn(player);

  const state: EntityState = { state: b.state, position: b.position.clone(), velocity: new THREE.Vector3() };
  world.entity = state;

  b.on((e) => {
    if (e.type === 'state') {
      world.emit('entityState', { state: e.state, previous: e.previous, position: b.position.clone() });
    } else if (e.type === 'caught') {
      const position = b.position.clone();
      world.emit('caught', { position });
      world.audit.record({ kind: 'caught', hit: 'entity', position });
    }
  });

  const firePing = (origin: THREE.Vector3, range: number, type: PingType) => {
    ownPings.push({ origin: origin.clone(), time: nowSeconds() });
    world.ping(origin, range, type);
  };

  const debug = initEntityDebug(world, b);
  const audio = AUDIO_ENABLED ? initEntityAudio(b, body.root, world.camera) : null;

  let walked = 0;
  const last = b.position.clone();

  world.onUpdate((dt) => {
    const t = nowSeconds();

    // Forget old bookkeeping.
    while (ownPings.length > 0 && t - ownPings[0].time > 10) ownPings.shift();
    for (const [k, seenAt] of seen) if (t - seenAt > 15) seen.delete(k);

    // Hearing: each new ping once, never its own.
    for (const p of readPings(world)) {
      const key = pingKey(p);
      if (seen.has(key)) continue;
      seen.set(key, t);
      if (isOwn(p)) continue;
      const sound: Sound = { position: p.origin, range: p.range, type: p.type };
      b.hear(sound);
    }

    b.update(dt, player);

    // Faint footstep pings so a careful player can hear it coming.
    const moved = Math.hypot(b.position.x - last.x, b.position.z - last.z);
    last.copy(b.position);
    walked += moved > 5 ? 0 : moved;
    if (walked >= FOOTSTEP_PING_EVERY * (0.8 + Math.random() * 0.4)) {
      walked = 0;
      firePing(b.position.clone().setY(b.position.y + 0.05), FOOTSTEP_PING_RANGE, 'pedestrian');
    }

    body.update(dt, b.position, b.heading, b.speed);

    state.state = b.state;
    state.position.copy(b.position);
    state.velocity.copy(b.velocity);
    world.entity = state;

    debug(dt);
    audio?.(dt);
  });

  resetFn = () => {
    b.reset(player);
    last.copy(b.position);
    walked = 0;
  };

  if (import.meta.env.DEV) {
    (window as unknown as { __entity: unknown }).__entity = { brain: b, body: body.root, reset: resetEntity };
  }
  console.info(`[entity] spawned ${b.position.distanceTo(player).toFixed(0)} m away`);
}

/** Respawn far from the player and patrol again (e.g. after a game over). */
export function resetEntity(): void {
  resetFn?.();
}

/** The brain, for tests and tools. Null before initEntity(). */
export function getEntityBrain(): EntityBrain | null {
  return brain;
}
