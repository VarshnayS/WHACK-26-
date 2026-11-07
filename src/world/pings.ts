/**
 * src/world/pings.ts: ping storage, budget and priority (behind world.ping / world.activePings)
 * Owner: SOUND (feat/sound-sources)
 *
 * A fixed pool of MAX_PINGS slots (src/shared/contracts.ts); nothing is allocated per ping or per frame.
 *
 * PRIORITY = audibility at the player = range ÷ distance(player, origin), with the player's own types
 * (voice / footstep / cane / impact) always above world types (car / pedestrian). When the pool is
 * full, the least audible ping is dropped (possibly the new one). activePings() returns the live pings
 * in priority order, so a renderer with fewer slots can just take the first N.
 *
 * No imports from the rest of the world: src/world/index.ts wires these into the `world` object.
 */
import * as THREE from 'three';
import { MAX_PINGS, type ActivePing, type PingType } from '../shared/contracts';
import { AUDIBILITY_MIN_DISTANCE, PING_LINGER_FADES, PING_STYLES, PLAYER_PING_TYPES } from './soundConfig';

/** Added to a player ping's audibility so it always outranks any world ping. */
const PLAYER_PRIORITY = 1e6;

interface Slot extends ActivePing {
  used: boolean;
  /** Time (s) after which the ping is gone. */
  end: number;
  /** Fire order, for the chronological list. */
  seq: number;
  /** Last computed priority (higher = keep). */
  priority: number;
}

const slots: Slot[] = Array.from({ length: MAX_PINGS }, () => ({
  origin: new THREE.Vector3(),
  range: 0,
  type: 'voice' as PingType,
  start: 0,
  style: PING_STYLES.voice,
  used: false,
  end: 0,
  seq: 0,
  priority: 0,
}));

let seq = 0;
const ordered: ActivePing[] = [];

/**
 * Every live ping, oldest first (exposed as world.pings for e.g. the entity's "last noise
 * position"). Updated in place: read it, don't keep or mutate it.
 */
export const pingLog: ActivePing[] = [];

// debug counters (also handy in the console via getPingStats())
let peakActive = 0;
let dropped = 0;
let budgetFullLogged = false;

/** Ping clock in seconds (contract: performance.now() / 1000). */
export function pingNow(): number {
  return performance.now() / 1000;
}

function isPlayerType(type: PingType): boolean {
  return PLAYER_PING_TYPES.includes(type);
}

function priorityOf(type: PingType, origin: THREE.Vector3, range: number, listener: THREE.Vector3): number {
  const audibility = range / Math.max(AUDIBILITY_MIN_DISTANCE, origin.distanceTo(listener));
  return isPlayerType(type) ? PLAYER_PRIORITY + audibility : audibility;
}

function rebuildLog(): void {
  pingLog.length = 0;
  for (const s of slots) if (s.used) pingLog.push(s);
  // insertion sort by fire order (≤ 32 items, already nearly sorted)
  for (let i = 1; i < pingLog.length; i++) {
    const p = pingLog[i] as Slot;
    let j = i - 1;
    while (j >= 0 && (pingLog[j] as Slot).seq > p.seq) {
      pingLog[j + 1] = pingLog[j];
      j--;
    }
    pingLog[j + 1] = p;
  }
}

/** Free the slots of pings that have finished. Called every frame (runUpdates) and before use. */
export function expirePings(now: number = pingNow()): void {
  let changed = false;
  for (const s of slots) {
    if (s.used && now >= s.end) {
      s.used = false;
      changed = true;
    }
  }
  if (changed) rebuildLog();
}

/**
 * Fire a ping. `origin` is copied. `listener` is the player position used to rank it.
 * Returns false if the pool was full and this ping was the least audible (so it was dropped).
 */
export function addPing(
  origin: THREE.Vector3,
  range: number,
  type: PingType,
  listener: THREE.Vector3,
  now: number = pingNow(),
): boolean {
  if (!(range > 0) || !Number.isFinite(origin.x + origin.y + origin.z)) return false;
  expirePings(now);

  let slot: Slot | null = null;
  for (const s of slots) {
    if (!s.used) {
      slot = s;
      break;
    }
  }

  if (!slot) {
    // Budget full: drop whichever is least audible, the new ping included.
    let weakest: Slot = slots[0];
    for (const s of slots) {
      s.priority = priorityOf(s.type, s.origin, s.range, listener);
      if (s.priority < weakest.priority) weakest = s;
    }
    dropped++;
    if (import.meta.env.DEV && !budgetFullLogged) {
      budgetFullLogged = true;
      console.info(`[pings] budget full (${MAX_PINGS}): dropping the least audible ping from now on`);
    }
    if (priorityOf(type, origin, range, listener) <= weakest.priority) return false;
    slot = weakest;
  }

  const style = PING_STYLES[type];
  slot.used = true;
  slot.origin.copy(origin);
  slot.range = range;
  slot.type = type;
  slot.start = now;
  slot.style = style;
  slot.end = now + range / style.speed + PING_LINGER_FADES / style.fade;
  slot.seq = seq++;
  rebuildLog();
  return true;
}

/**
 * Live pings in priority order (most audible first, player pings first), at most MAX_PINGS.
 * The array and its objects are reused: read them this frame, don't keep or mutate them.
 */
export function activePings(listener: THREE.Vector3, now: number = pingNow()): ActivePing[] {
  expirePings(now);
  ordered.length = 0;
  for (const s of slots) {
    if (!s.used) continue;
    s.priority = priorityOf(s.type, s.origin, s.range, listener);
    // insertion sort, descending priority
    let j = ordered.length - 1;
    ordered.push(s);
    while (j >= 0 && (ordered[j] as Slot).priority < s.priority) {
      ordered[j + 1] = ordered[j];
      j--;
    }
    ordered[j + 1] = s;
  }

  if (ordered.length > peakActive) {
    peakActive = ordered.length;
    if (import.meta.env.DEV) console.info(`[pings] peak active pings: ${peakActive} / ${MAX_PINGS}`);
  }
  if (ordered.length > MAX_PINGS) console.error(`[pings] BUG: ${ordered.length} active pings > MAX_PINGS`);
  return ordered;
}

/** Debug: { active, peak, dropped, max }. */
export function getPingStats(): { active: number; peak: number; dropped: number; max: number } {
  return { active: pingLog.length, peak: peakActive, dropped, max: MAX_PINGS };
}
