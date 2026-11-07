/**
 * src/world/heightField.ts: precomputed ground height grid for agents
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-polish
 *
 * Agents must sit on the real ground without raycasting every frame. After the tiles have loaded,
 * a regular grid over the play corridor (every GROUND_CELL metres, in corridor coordinates so it
 * follows the road bearing) is filled by calling groundHeight() once per node, a little each frame
 * so there is no hitch. sampleGround(x, z) then bilinearly interpolates it for every agent, including
 * pedestrians that have been knocked off their paths.
 *
 *   - Nodes are probed breadth-first from the middle of the corridor. Each ray starts one player
 *     height above the ground found for the neighbouring node, so it lands on the walking surface
 *     rather than a roof or tree canopy (the same kind of hit the player's own ground-follow gets).
 *   - A node with no hit (a gap in the tiles) inherits its neighbour's height.
 *   - The grid is rebuilt (in the background, old grid stays in use) whenever tiles finish loading
 *     again, e.g. after AUTO_GROUND re-levelled the tiles or finer tiles arrived.
 *   - Until the first grid is ready sampleGround() returns 0.
 */
import * as THREE from 'three';
import { groundHeightOrNull, PLAYER_HEIGHT } from '../player/collision';
import { CORRIDOR_HALF_WIDTH } from '../config';
import { CORRIDOR_ACROSS, CORRIDOR_ALONG, CORRIDOR_HALF_LENGTH, toCorridor } from './playArea';
import { world } from './index';
import { getTiles } from './tiles';

/** Grid spacing in metres. */
export const GROUND_CELL = 2;
/** The grid extends this far beyond the walls so clamped agents never sample outside it. */
const GRID_PAD = 2;
/** CPU time per frame spent probing nodes while a grid is being built (ms), during play. */
const BUILD_BUDGET_MS = 3;
/** Current per-frame budget: the start screen raises it while nobody is playing (setGroundBuildBudget). */
let buildBudgetMs = BUILD_BUDGET_MS;

/**
 * Loading mode (start screen up): a big per-frame budget and a short settle wait, so the grid is
 * ready ~seconds sooner. Off = the in-game defaults (no hitches while playing).
 */
export function setGroundLoading(on: boolean): void {
  buildBudgetMs = on ? LOADING_BUDGET_MS : BUILD_BUDGET_MS;
  settleMs = on ? LOADING_SETTLE_MS : SETTLE_MS;
}
/** Wait this long after the last tiles-load-end before (re)building, so loading has settled (ms). */
const SETTLE_MS = 1500;
/** Same, while the start screen is up (setGroundLoading): nobody is moving, so tiles settle fast. */
const LOADING_SETTLE_MS = 400;
/** Probing budget per frame while the start screen is up (ms): nobody is playing, frame rate doesn't matter. */
const LOADING_BUDGET_MS = 24;
let settleMs = SETTLE_MS;

/** (x, z, y of the previous neighbour's ground) -> ground height, or null when there is none. */
export type GroundProbe = (x: number, z: number, guessY: number) => number | null;

/** Regular grid of heights over the corridor (plus GRID_PAD), with bilinear sampling. */
export class HeightGrid {
  readonly nAlong: number;
  readonly nAcross: number;
  readonly minAlong: number;
  readonly minAcross: number;
  readonly data: Float32Array;

  constructor(
    readonly cell = GROUND_CELL,
    halfLength = CORRIDOR_HALF_LENGTH,
    halfWidth = CORRIDOR_HALF_WIDTH,
    pad = GRID_PAD,
  ) {
    this.minAlong = -halfLength - pad;
    this.minAcross = -halfWidth - pad;
    this.nAlong = Math.ceil((2 * (halfLength + pad)) / cell) + 1;
    this.nAcross = Math.ceil((2 * (halfWidth + pad)) / cell) + 1;
    this.data = new Float32Array(this.nAlong * this.nAcross);
  }

  index(i: number, j: number): number {
    return j * this.nAlong + i;
  }

  /** World x/z of node (i, j) (corridor coordinates -> local frame). */
  nodeToWorld(i: number, j: number, out = new THREE.Vector3()): THREE.Vector3 {
    const along = this.minAlong + i * this.cell;
    const across = this.minAcross + j * this.cell;
    return out.set(0, 0, 0).addScaledVector(CORRIDOR_ALONG, along).addScaledVector(CORRIDOR_ACROSS, across);
  }

  /** Bilinear height at a position given in corridor coordinates (clamped to the grid). */
  sampleCorridor(along: number, across: number): number {
    const fi = THREE.MathUtils.clamp((along - this.minAlong) / this.cell, 0, this.nAlong - 1);
    const fj = THREE.MathUtils.clamp((across - this.minAcross) / this.cell, 0, this.nAcross - 1);
    const i0 = Math.min(Math.floor(fi), this.nAlong - 2);
    const j0 = Math.min(Math.floor(fj), this.nAcross - 2);
    const ti = fi - i0;
    const tj = fj - j0;
    const d = this.data;
    const a = this.index(i0, j0);
    const b = a + this.nAlong;
    const lower = d[a] + (d[a + 1] - d[a]) * ti;
    const upper = d[b] + (d[b + 1] - d[b]) * ti;
    return lower + (upper - lower) * tj;
  }

  /** Bilinear height at a local-frame position. */
  sample(x: number, z: number): number {
    const along = x * CORRIDOR_ALONG.x + z * CORRIDOR_ALONG.z;
    const across = x * CORRIDOR_ACROSS.x + z * CORRIDOR_ACROSS.z;
    return this.sampleCorridor(along, across);
  }
}

/** Fills a HeightGrid breadth-first from its centre, a time budget at a time. */
export class HeightGridBuilder {
  readonly grid: HeightGrid;
  /** Nodes where the probe found nothing (they copied a neighbour). */
  holes = 0;
  /** Nodes probed so far. */
  done = 0;

  private readonly queue: Int32Array;
  private readonly guess: Float32Array;
  private readonly seen: Uint8Array;
  private head = 0;
  private tail = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly probe: GroundProbe,
    grid = new HeightGrid(),
  ) {
    this.grid = grid;
    const n = grid.data.length;
    this.queue = new Int32Array(n);
    this.guess = new Float32Array(n);
    this.seen = new Uint8Array(n);
    const centre = grid.index(Math.floor(grid.nAlong / 2), Math.floor(grid.nAcross / 2));
    this.push(centre, 0); // AUTO_GROUND puts the ground at the origin at y = 0
  }

  get total(): number {
    return this.grid.data.length;
  }

  get finished(): boolean {
    return this.head >= this.tail;
  }

  private push(index: number, guessY: number): void {
    if (this.seen[index]) return;
    this.seen[index] = 1;
    this.guess[index] = guessY;
    this.queue[this.tail++] = index;
  }

  /** Probe nodes until `budgetMs` has elapsed (at least one node). Returns true when the grid is complete. */
  step(budgetMs: number): boolean {
    const { grid } = this;
    const start = performance.now();
    do {
      if (this.finished) break;
      const index = this.queue[this.head++];
      const i = index % grid.nAlong;
      const j = (index - i) / grid.nAlong;
      grid.nodeToWorld(i, j, this.tmp);
      const guessY = this.guess[index];
      let y = this.probe(this.tmp.x, this.tmp.z, guessY);
      if (y === null) {
        y = guessY;
        this.holes++;
      }
      grid.data[index] = y;
      this.done++;
      if (i > 0) this.push(index - 1, y);
      if (i < grid.nAlong - 1) this.push(index + 1, y);
      if (j > 0) this.push(index - grid.nAlong, y);
      if (j < grid.nAcross - 1) this.push(index + grid.nAlong, y);
    } while (performance.now() - start < budgetMs);
    return this.finished;
  }
}

// --- live grid ---------------------------------------------------------------------------------

let current: HeightGrid | null = null;
let building: HeightGridBuilder | null = null;
let buildStarted = 0;
let dirtyAt = -1;
let initialised = false;
const probePos = new THREE.Vector3();

/** Real probe: groundHeight() (raycast against world.tilesGroup) from one player height above `guessY`. */
const tileProbe: GroundProbe = (x, z, guessY) => {
  probePos.set(x, guessY + PLAYER_HEIGHT, z);
  return groundHeightOrNull(probePos);
};

/** Ground height under (x, z) from the precomputed grid (0 until the first grid is ready). No raycasts. */
export function sampleGround(x: number, z: number): number {
  return current ? current.sample(x, z) : 0;
}

/** True once the first height grid has been built from the loaded tiles. */
export function isGroundReady(): boolean {
  return current !== null;
}

/**
 * For the loading screen: `settled` = a grid exists, no rebuild is pending or running (so it was built
 * from the tiles as they are now). `progress` 0..1 of the build in progress (1 when settled).
 */
export function groundStatus(): { ready: boolean; settled: boolean; progress: number; pending: boolean } {
  const ready = current !== null;
  const pending = dirtyAt >= 0;
  const progress = building ? building.done / building.total : ready ? 1 : 0;
  return { ready, settled: ready && !pending && !building, progress, pending };
}

/** Number of ground-grid builds finished so far (agents re-snap when this changes). */
let generation = 0;
export function groundGeneration(): number {
  return generation;
}

/** Start (or restart) building a grid from the tiles as they are now. */
export function rebuildGroundField(): void {
  building = new HeightGridBuilder(tileProbe);
  buildStarted = performance.now();
  performance.mark('ground:build-start');
}

/**
 * Hook the grid up to tile loading: rebuild after tiles finish loading, a little each frame.
 * Call once after initTiles().
 */
export function initGroundField(): void {
  if (initialised) return;
  initialised = true;

  const tiles = getTiles();
  if (!tiles) {
    console.warn('[ground] no tiles renderer: agents will stay at y = 0');
    return;
  }
  tiles.addEventListener('tiles-load-end', () => {
    dirtyAt = performance.now();
  });

  world.onUpdate(() => {
    if (dirtyAt >= 0 && performance.now() - dirtyAt >= settleMs) {
      dirtyAt = -1;
      rebuildGroundField();
    }
    if (!building) return;
    if (building.step(buildBudgetMs)) {
      current = building.grid;
      generation++;
      performance.mark('ground:ready');
      console.info(
        `[ground] height grid ready: ${current.nAlong}x${current.nAcross} nodes every ${GROUND_CELL} m, ` +
          `${building.holes} without ground, ${(performance.now() - buildStarted).toFixed(0)} ms`,
      );
      building = null;
    }
  });
}

/** Ground grid position of a point in corridor coordinates, for debugging. */
export function debugGroundAt(pos: THREE.Vector3): { along: number; across: number; y: number } {
  return { ...toCorridor(pos), y: sampleGround(pos.x, pos.z) };
}
