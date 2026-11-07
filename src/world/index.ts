/**
 * src/world/index.ts: the shared `world` object (the contract between all modules)
 * Owner: EVERYONE (CODEOWNERS: @USERNAME_A @USERNAME_B @USERNAME_C)
 * Branch: change only in a small, dedicated PR that the whole team has seen
 *
 * Every module plugs in through this object (see README "Plugging in").
 * Changing a field or signature here breaks other people's code, so discuss it first.
 * Adding a new optional field is fine; renaming or removing one is not.
 */
import * as THREE from 'three';
import { addPing } from '../render/pings';

export type AgentType = 'pedestrian' | 'car';

export interface Agent {
  type: AgentType;
  /** World-space position in metres (local frame centred on ORIGIN_LAT/LON). */
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
  /** Fire a sonar wave from `origin` that travels up to `range` metres. */
  ping(origin: THREE.Vector3, range: number): void;
  /** Register a per-frame callback. Returns a function that unregisters it. */
  onUpdate(fn: UpdateFn): () => void;
}

const updateFns = new Set<UpdateFn>();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 5000);

const tilesGroup = new THREE.Group();
tilesGroup.name = 'tiles';
const agentsGroup = new THREE.Group();
agentsGroup.name = 'agents';
scene.add(tilesGroup, agentsGroup);

export const world: World = {
  scene,
  camera,
  renderer: new THREE.WebGLRenderer({ antialias: true }),
  tilesGroup,
  agentsGroup,
  agents: [],
  ping(origin, range) {
    addPing(origin, range);
  },
  onUpdate(fn) {
    updateFns.add(fn);
    return () => updateFns.delete(fn);
  },
};

/** Runs every registered onUpdate callback. Called only by the main loop in src/main.ts. */
export function runUpdates(dt: number): void {
  for (const fn of updateFns) fn(dt);
}
