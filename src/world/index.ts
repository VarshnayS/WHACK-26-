/**
 * src/world/index.ts: the shared `world` object (the contract between all modules)
 * Owner: EVERYONE (CODEOWNERS: @USERNAME_A @USERNAME_B @USERNAME_C)
 * Branch: change only in a small, dedicated PR that the whole team has seen
 *
 * Every module plugs in through this object (see README "Plugging in").
 * Changing a field or signature here breaks other people's code, so discuss it first.
 * Adding a new optional field is fine; renaming or removing one is not.
 *
 * Coordinates: Y up, metres, +X = west, +Z = north, origin at ORIGIN_LAT/LON, ground ≈ y 0.
 */
import * as THREE from 'three';
import { CAMERA_FAR, CAMERA_NEAR, EYE_HEIGHT } from '../config';
import { activePings as rankedPings, addPing, expirePings, pingLog } from './pings';
import { isInsidePlayArea } from './playArea';
import type {
  ActivePing,
  AuditEvent,
  EntityState,
  PingType,
  VisionMode,
  WorldEventCallback,
  WorldEventName,
} from '../shared/contracts';

export type AgentType = 'pedestrian' | 'car';

export interface Agent {
  type: AgentType;
  /** World-space position of the agent's base (on the ground), in metres. */
  position: THREE.Vector3;
  /** Metres per second. */
  velocity: THREE.Vector3;
  /** 0..1, how much noise this agent makes (spatial audio, entity hearing). */
  loudness: number;
  /** The mesh in world.agentsGroup; attach THREE.PositionalAudio here. */
  object: THREE.Object3D;
}

/** Called once per frame with the frame time in seconds. */
export type UpdateFn = (dt: number) => void;

export interface World {
  /** Black scene. Nothing in it is lit; everything uses the shared sonar material. */
  readonly scene: THREE.Scene;
  /** Player camera; its position is the player position. */
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Google tile geometry (filled by src/world/tiles.ts). */
  readonly tilesGroup: THREE.Group;
  /** Pedestrian and car meshes (filled by src/world/agents.ts). */
  readonly agentsGroup: THREE.Group;
  /** Live agent list (filled by src/world/agents.ts). */
  readonly agents: Agent[];
  /**
   * Live pings, oldest first (at most MAX_PINGS), e.g. for the entity AI's "last noise position".
   * Same pings as activePings(), in firing order. Owned by src/world/pings.ts; read-only.
   */
  readonly pings: ActivePing[];
  /**
   * Copyright strings of the Google tiles currently on screen, most common first
   * (updated in place by src/world/tiles.ts). The HUD must show these with the Google logo.
   */
  readonly attributions: string[];
  /**
   * Boundary walls of the play corridor along University Road (height ignored). The player must
   * not move to a position where this is false. `margin` > 0 grows the area, < 0 shrinks it.
   * src/world/playArea.ts also exports clampToPlayArea() to push a position back inside.
   */
  isInsidePlayArea(pos: THREE.Vector3, margin?: number): boolean;
  /** Fire a sonar wave from `origin` that travels up to `range` metres. `type` defaults to 'voice'. */
  ping(origin: THREE.Vector3, range: number, type?: PingType): void;
  /**
   * Pings currently travelling, most audible at the player first (player pings always first), at most
   * MAX_PINGS (src/world/pings.ts). The array is reused every call: read it, don't keep it.
   */
  activePings(): ActivePing[];
  /** Record scoring/accessibility events. No-op until src/audit/ fills it in. */
  audit: { record(e: AuditEvent): void };
  /** Current way of seeing. Default: total blindness. src/senses/ changes it through setVision(). */
  vision: VisionMode;
  /** Switch to the vision mode with this id. No-op until src/senses/ fills it in. */
  setVision(id: string): void;
  /** The entity hunting the player, or null while none exists. src/entity/ sets it. */
  entity: EntityState | null;
  /** Tiny event bus. Events: 'caught', 'entityState', 'stunned'. */
  on(name: WorldEventName, cb: WorldEventCallback): void;
  off(name: WorldEventName, cb: WorldEventCallback): void;
  emit(name: WorldEventName, payload?: unknown): void;
  /** Register a per-frame callback. Returns a function that unregisters it. */
  onUpdate(fn: UpdateFn): () => void;
}

const updateFns = new Set<UpdateFn>();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR);
camera.position.set(0, EYE_HEIGHT, 0);

const tilesGroup = new THREE.Group();
tilesGroup.name = 'tiles';
const agentsGroup = new THREE.Group();
agentsGroup.name = 'agents';
scene.add(tilesGroup, agentsGroup, camera);

const listeners = new Map<WorldEventName, Set<WorldEventCallback>>();

/** Default vision: total blindness. */
const BLIND: VisionMode = {
  id: 'blind',
  label: 'Total blindness',
  visibleDistance: 0,
  fovDeg: 0,
  centralLossDeg: 0,
  peripheralLimitDeg: 0,
};

export const world: World = {
  scene,
  camera,
  renderer: new THREE.WebGLRenderer({ antialias: true }),
  tilesGroup,
  agentsGroup,
  agents: [],
  pings: pingLog,
  attributions: [],
  isInsidePlayArea,
  ping(origin, range, type = 'voice') {
    // pooled + prioritised by audibility at the player (src/world/pings.ts)
    addPing(origin, range, type, camera.position);
  },
  onUpdate(fn) {
    updateFns.add(fn);
    return () => updateFns.delete(fn);
  },
  activePings: () => rankedPings(camera.position),
  audit: { record() {} },
  vision: BLIND,
  setVision() {},
  entity: null,
  on(name, cb) {
    let set = listeners.get(name);
    if (!set) listeners.set(name, (set = new Set()));
    set.add(cb);
  },
  off(name, cb) {
    listeners.get(name)?.delete(cb);
  },
  emit(name, payload) {
    // copy first so a callback may call off() on itself
    for (const cb of [...(listeners.get(name) ?? [])]) cb(payload);
  },
};

/** Runs every registered onUpdate callback. Called only by the main loop in src/main.ts. */
export function runUpdates(dt: number): void {
  expirePings();
  for (const fn of updateFns) fn(dt);
}
