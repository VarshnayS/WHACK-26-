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
import { addPing, now, type Ping } from '../render/pings';
import { MAX_PINGS } from '../render/sonarMaterial';
import { CAMERA_FAR, CAMERA_NEAR, EYE_HEIGHT, WAVE_SPEED } from '../config';
import { isInsidePlayArea } from './playArea';

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
   * Pings fired in the last few seconds, oldest first (at most MAX_PINGS). Kept here as well as
   * in src/render/pings.ts so other modules (e.g. entity AI: "last noise position") can read them.
   */
  readonly pings: Ping[];
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
  /** Fire a sonar wave from `origin` that travels up to `range` metres. */
  ping(origin: THREE.Vector3, range: number): void;
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

const pings: Ping[] = [];

export const world: World = {
  scene,
  camera,
  renderer: new THREE.WebGLRenderer({ antialias: true }),
  tilesGroup,
  agentsGroup,
  agents: [],
  pings,
  attributions: [],
  isInsidePlayArea,
  ping(origin, range) {
    pings.push({ origin: origin.clone(), range, start: now() });
    if (pings.length > MAX_PINGS) pings.shift();
    addPing(origin, range); // src/render/pings.ts feeds the sonar material uniforms
  },
  onUpdate(fn) {
    updateFns.add(fn);
    return () => updateFns.delete(fn);
  },
};

/** Drop pings whose wave has finished travelling (plus a short fade). */
function expirePings(): void {
  const t = now();
  while (pings.length > 0) {
    const p = pings[0];
    if (t - p.start <= p.range / WAVE_SPEED + 2) break;
    pings.shift();
  }
}

/** Runs every registered onUpdate callback. Called only by the main loop in src/main.ts. */
export function runUpdates(dt: number): void {
  expirePings();
  for (const fn of updateFns) fn(dt);
}
