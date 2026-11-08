/**
 * src/player/route.ts: the run's start and goal points
 * Owner: SENSES (player)
 *
 * The start screen's route picker (src/hud/routePicker.ts) sets them on a top-down map. On
 * "Click to begin", applyRouteStart() puts the player on the start point facing the goal. While
 * playing, reaching the goal (within GOAL_RADIUS_M) calls the onGoalReached listeners once per run.
 *
 * Points are local X/Z metres (Y up, +X west, +Z north), always inside the corridor walls.
 * The last route is remembered in localStorage (per browser only).
 */
import * as THREE from 'three';
import { world } from '../world';
import { clampToPlayArea } from '../world/playArea';
import { getPlayerController } from './controller';

/** Reaching this distance (m, horizontal) from the goal counts as arriving. */
export const GOAL_RADIUS_M = 2.5;
/** Points are kept this far inside the corridor walls (m). */
export const ROUTE_WALL_INSET_M = 1;

const STORAGE_KEY = 'blind-sim.route.v1';

export interface RoutePoint {
  x: number;
  z: number;
}

export interface Route {
  /** Where the player starts. Default: the corridor centre (the old fixed spawn). */
  start: RoutePoint;
  /** Where the player is heading, or null for free roaming. */
  goal: RoutePoint | null;
}

export interface GoalReachedInfo {
  goal: RoutePoint;
  /** Seconds from begin to arriving. */
  seconds: number;
}

const route: Route = { start: { x: 0, z: 0 }, goal: null };
const changeListeners = new Set<(r: Readonly<Route>) => void>();
const goalListeners = new Set<(info: GoalReachedInfo) => void>();
const runListeners = new Set<() => void>();

let runStartedAt = -1;
let goalDone = false;
let watching = false;

const tmp = new THREE.Vector3();
const tmpOut = new THREE.Vector3();

function inside(p: RoutePoint): RoutePoint {
  tmp.set(p.x, 0, p.z);
  clampToPlayArea(tmp, ROUTE_WALL_INSET_M, tmpOut);
  return { x: tmpOut.x, z: tmpOut.z };
}

function isPoint(v: unknown): v is RoutePoint {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.x === 'number' && Number.isFinite(o.x) && typeof o.z === 'number' && Number.isFinite(o.z);
}

function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return;
    const o = parsed as Record<string, unknown>;
    if (isPoint(o.start)) route.start = inside(o.start);
    route.goal = isPoint(o.goal) ? inside(o.goal) : null;
  } catch {
    /* storage blocked or corrupt: keep the defaults */
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(route));
  } catch {
    /* storage blocked: the route still works for this session */
  }
}

function changed(): void {
  save();
  for (const fn of changeListeners) fn(route);
}

load();

/** True from begin until the goal is reached (also true for a run with no goal). */
export function isRunActive(): boolean {
  return runStartedAt >= 0 && !goalDone;
}

/** Current route (read-only view; change it with the setters). */
export function getRoute(): Readonly<Route> {
  return route;
}

/** Move the start point (clamped inside the corridor). */
export function setRouteStart(p: RoutePoint): void {
  route.start = inside(p);
  changed();
}

/** Move the goal point (clamped inside the corridor), or null to remove it. */
export function setRouteGoal(p: RoutePoint | null): void {
  route.goal = p ? inside(p) : null;
  changed();
}

/** Back to the defaults: start at the corridor centre, no goal. */
export function resetRoute(): void {
  route.start = { x: 0, z: 0 };
  route.goal = null;
  changed();
}

/** Called whenever the route changes. Returns unsubscribe. */
export function onRouteChange(fn: (r: Readonly<Route>) => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/** Called when a run starts, its goal is reached, or it ends (isRunActive() has the new state). Returns unsubscribe. */
export function onRunChange(fn: () => void): () => void {
  runListeners.add(fn);
  return () => runListeners.delete(fn);
}

/** Called once per run when the player reaches the goal. Returns unsubscribe. */
export function onGoalReached(fn: (info: GoalReachedInfo) => void): () => void {
  goalListeners.add(fn);
  return () => goalListeners.delete(fn);
}

/**
 * Start a run: place the player on the start point, facing the goal (if any), and start watching
 * for arrival. Called by the start screen on "Click to begin".
 */
export function applyRouteStart(): void {
  const c = getPlayerController();
  tmp.set(route.start.x, 0, route.start.z);
  if (c) {
    c.placeAt(tmp, route.goal ? tmpOut.set(route.goal.x, 0, route.goal.z) : undefined);
  } else {
    world.camera.position.x = tmp.x;
    world.camera.position.z = tmp.z;
  }
  runStartedAt = performance.now();
  goalDone = false;
  if (!watching) {
    watching = true;
    world.onUpdate(checkGoal);
  }
  for (const fn of runListeners) fn();
}

/** The run is over and the menu is back (Quit to Menu, or after being caught). */
export function endRun(): void {
  runStartedAt = -1;
  goalDone = false;
  for (const fn of runListeners) fn();
}

function checkGoal(): void {
  const goal = route.goal;
  if (goalDone || !goal || runStartedAt < 0) return;
  const p = world.camera.position;
  const dx = p.x - goal.x;
  const dz = p.z - goal.z;
  if (dx * dx + dz * dz > GOAL_RADIUS_M * GOAL_RADIUS_M) return;
  goalDone = true;
  const info: GoalReachedInfo = { goal: { x: goal.x, z: goal.z }, seconds: (performance.now() - runStartedAt) / 1000 };
  console.info(`[route] goal reached in ${info.seconds.toFixed(1)} s`);
  for (const fn of goalListeners) fn(info);
  for (const fn of runListeners) fn();
}
