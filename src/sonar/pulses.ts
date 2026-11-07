/**
 * src/sonar/pulses.ts: the sonar pulse bus (CONTRACT with the sonar shader; keep it stable)
 * Owner: @USERNAME_C (mic/HUD/audio)
 *
 * Any module may emit pulses (mic, car engines, footsteps, enemy AI, debug keys).
 * The shader reads getActivePulses(now) once per frame. See README "Audio sonar".
 *
 * Also hosts the noise-event bus for the enemy AI (onNoise), since every noise the player
 * makes is the same event the AI wants to hear.
 */
import * as THREE from 'three';

export type PulseSource = 'player' | 'agent' | 'enemy' | 'debug';
export type PulseKind = 'transient' | 'sustained';

export interface Pulse {
  id: number;
  /** World-space origin. The bus stores its own copy, so callers can reuse their vector. */
  origin: THREE.Vector3;
  /** Seconds, performance.now() / 1000. */
  startTime: number;
  /** m/s */
  speed: number;
  /** m. The pulse expires once its radius reaches this. */
  maxRadius: number;
  /** 0..1 */
  strength: number;
  /** 0..1, from spectral centroid (0 = dull/low, 1 = bright/high). */
  brightness: number;
  kind: PulseKind;
  source: PulseSource;
}

export type ActivePulse = Pulse & {
  /** m, = age * speed (always < maxRadius). */
  radius: number;
  /** s since startTime. */
  age: number;
  /** 1 at birth, falls linearly to 0 as radius reaches maxRadius. */
  fade: number;
};

/** Oldest pulses are dropped beyond this (the shader uses a fixed-size uniform array). */
export const MAX_ACTIVE_PULSES = 16;

/** Same clock as Pulse.startTime and getActivePulses(now). */
export function pulseNow(): number {
  return performance.now() / 1000;
}

let nextId = 1;
const pulses: Pulse[] = [];
const pulseListeners = new Set<(p: Pulse) => void>();

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Fire a sonar pulse. Returns the stored pulse (with id and startTime filled in). */
export function emitPulse(p: Omit<Pulse, 'id' | 'startTime'>): Pulse {
  const pulse: Pulse = {
    id: nextId++,
    origin: p.origin.clone(),
    startTime: pulseNow(),
    speed: p.speed > 0 ? p.speed : 1,
    maxRadius: p.maxRadius > 0 ? p.maxRadius : 0,
    strength: clamp01(p.strength),
    brightness: clamp01(p.brightness),
    kind: p.kind,
    source: p.source,
  };
  pulses.push(pulse);
  if (pulses.length > MAX_ACTIVE_PULSES) pulses.splice(0, pulses.length - MAX_ACTIVE_PULSES);
  for (const cb of pulseListeners) cb(pulse);
  return pulse;
}

/** Called for every new pulse from any source. Returns an unsubscribe function. */
export function onPulse(cb: (p: Pulse) => void): () => void {
  pulseListeners.add(cb);
  return () => {
    pulseListeners.delete(cb);
  };
}

// Reused output: no allocations per frame.
const views: ActivePulse[] = Array.from({ length: MAX_ACTIVE_PULSES }, () => ({
  id: 0,
  origin: new THREE.Vector3(), // replaced by the pulse's own origin before it is handed out
  startTime: 0,
  speed: 0,
  maxRadius: 0,
  strength: 0,
  brightness: 0,
  kind: 'transient' as PulseKind,
  source: 'debug' as PulseSource,
  radius: 0,
  age: 0,
  fade: 0,
}));
const activeOut: ActivePulse[] = [];

/**
 * Live pulses at time `now` (seconds, pulseNow() clock), oldest first, at most
 * MAX_ACTIVE_PULSES. Expired pulses (radius >= maxRadius) are removed as a side effect.
 *
 * The returned array and its objects are REUSED on every call: read them this frame,
 * don't keep references. `origin` is the bus's own vector; don't mutate it.
 */
export function getActivePulses(now: number): ActivePulse[] {
  // Compact in place, dropping expired pulses.
  let w = 0;
  for (let r = 0; r < pulses.length; r++) {
    const p = pulses[r];
    const age = now - p.startTime;
    if (age * p.speed < p.maxRadius) pulses[w++] = p;
  }
  pulses.length = w;

  activeOut.length = 0;
  for (let i = 0; i < pulses.length; i++) {
    const p = pulses[i];
    const v = views[i];
    const age = Math.max(0, now - p.startTime);
    v.id = p.id;
    v.origin = p.origin;
    v.startTime = p.startTime;
    v.speed = p.speed;
    v.maxRadius = p.maxRadius;
    v.strength = p.strength;
    v.brightness = p.brightness;
    v.kind = p.kind;
    v.source = p.source;
    v.age = age;
    v.radius = age * p.speed;
    v.fade = p.maxRadius > 0 ? 1 - v.radius / p.maxRadius : 0;
    activeOut.push(v);
  }
  return activeOut;
}

/** Remove every pulse (e.g. on level reset). */
export function clearPulses(): void {
  pulses.length = 0;
}

// ---------------------------------------------------------------------------------------------
// Noise events (for the enemy AI)
// ---------------------------------------------------------------------------------------------

export interface NoiseEvent {
  /** Where the noise happened (a copy; safe to keep). */
  position: THREE.Vector3;
  /** 0..1, same scale as Pulse.strength. */
  loudness: number;
  /** Seconds, pulseNow() clock. */
  time: number;
}

const noiseListeners = new Set<(e: NoiseEvent) => void>();

/** Fired on every player sound the mic detects (and on SPACE pulses). Returns unsubscribe. */
export function onNoise(cb: (e: NoiseEvent) => void): () => void {
  noiseListeners.add(cb);
  return () => {
    noiseListeners.delete(cb);
  };
}

/** Broadcast a noise event. Copies `position`. */
export function emitNoise(position: THREE.Vector3, loudness: number, time: number = pulseNow()): void {
  if (noiseListeners.size === 0) return;
  const e: NoiseEvent = { position: position.clone(), loudness: clamp01(loudness), time };
  for (const cb of noiseListeners) cb(e);
}
