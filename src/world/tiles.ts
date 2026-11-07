/**
 * src/world/tiles.ts: loads Google 3D Tiles, strips textures, applies the shared material
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * - Default: tiles come through the caching proxy (TILES_ROOT_URL, key added server-side).
 *   VITE_TILES_DIRECT=1: straight from Google with GoogleCloudAuthPlugin + VITE_GOOGLE_MAPS_KEY.
 * - GLTFExtensionsPlugin decodes Draco (decoder in public/draco/). A tiny GLTFLoader plugin skips
 *   texture decoding entirely, so tile textures are never created.
 * - ReorientationPlugin puts ORIGIN_LAT/LON at (0, 0, 0): Y up, metres, +X west, +Z north.
 * - LoadRegionPlugin masks loading to the play corridor (+ CORRIDOR_TILE_MARGIN), and each loaded
 *   tile's triangles are trimmed to that same box, so no geometry outside it is kept or drawn.
 * - Every 'load-model' event: original materials/textures are disposed, uv/colour attributes are
 *   dropped, and the mesh gets the shared sonarMaterial (or the debug grid while R is on).
 * - Copyright strings of visible tiles are kept in world.attributions and sent to the HUD.
 */
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { GLTFLoaderPlugin } from 'three/addons/loaders/GLTFLoader.js';
import { OBB, TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer/three';
import { GLTFExtensionsPlugin, LoadRegionPlugin, OBBRegion, ReorientationPlugin } from '3d-tiles-renderer/three/plugins';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { world } from './index';
import { assignWorldMaterial, debugMaterial, getWorldMaterial, onRevealAllChange } from './debugMaterial';
import { initWorldDebug } from './debugKeys';
import { CORRIDOR_BASIS, CORRIDOR_HALF_LENGTH, isInsidePlayArea } from './playArea';
import { setTileAttribution } from '../hud/hud';
import { sonarMaterial } from '../render/sonarMaterial';
import {
  AUTO_GROUND,
  CORRIDOR_HALF_WIDTH,
  CORRIDOR_MIN_DETAIL,
  CORRIDOR_TILE_MARGIN,
  DRACO_PATH,
  ORIGIN_HEIGHT,
  ORIGIN_LAT,
  ORIGIN_LON,
  TILES_DIRECT,
  TILES_ERROR_TARGET,
  TILES_ROOT_URL,
} from '../config';

/** How long after the first tiles arrive the ground is re-levelled (s). After that it stays put. */
const AUTO_GROUND_WINDOW = 60;
/** Vertex attributes the grid shader never needs (texture coordinates, vertex colours). */
const DROPPED_ATTRIBUTES = ['uv', 'uv1', 'uv2', 'uv3', 'color', 'color_0'];

let tiles: TilesRenderer | null = null;
/** world.tilesGroup > groundGroup > tiles.group; groundGroup.position.y levels the ground to y = 0. */
const groundGroup = new THREE.Group();
groundGroup.name = 'tilesGroundOffset';
let firstLoadTime = -1;

/** GLTFLoader plugin: never decode tile textures (they'd be thrown away anyway). */
const skipTexturesPlugin = (): GLTFLoaderPlugin => ({
  name: 'BLIND_SKIP_TEXTURES',
  loadTexture: () => Promise.resolve(null) as unknown as Promise<THREE.Texture>,
});

// --- attribution -----------------------------------------------------------------------------

/** Same counting as GoogleAttributionsManager: each visible tile adds its ';'-separated credits. */
const creditCounts = new Map<string, number>();
let lastAttribution = '';

function adjustCredits(copyright: string, delta: 1 | -1): void {
  for (const raw of copyright.split(';')) {
    const credit = raw.trim();
    if (!credit) continue;
    const count = (creditCounts.get(credit) ?? 0) + delta;
    if (count <= 0) creditCounts.delete(credit);
    else creditCounts.set(credit, count);
  }
}

function publishAttributions(): void {
  const sorted = [...creditCounts.entries()].sort((a, b) => b[1] - a[1]).map(([credit]) => credit);
  const text = sorted.join('; ');
  if (text === lastAttribution) return;
  lastAttribution = text;
  world.attributions.splice(0, world.attributions.length, ...sorted);
  setTileAttribution(text); // the HUD falls back to 'Google' when empty
}

// --- material stripping ----------------------------------------------------------------------

function disposeMaterial(material: THREE.Material): void {
  if (material === sonarMaterial || material === debugMaterial) return;
  for (const value of Object.values(material)) {
    if (value && (value as THREE.Texture).isTexture) {
      const texture = value as THREE.Texture;
      const image = texture.image as unknown;
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
      texture.dispose();
    }
  }
  material.dispose();
}

/**
 * Dispose every original material + texture under `root` and replace it with the shared
 * sonarMaterial (or the debug grid while reveal-all is on). Also drops uv/colour attributes.
 */
export function applySonarMaterial(root: THREE.Object3D): void {
  const material = getWorldMaterial();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of originals) if (m) disposeMaterial(m);
    for (const name of DROPPED_ATTRIBUTES) {
      if (mesh.geometry.hasAttribute(name)) mesh.geometry.deleteAttribute(name);
    }
    mesh.material = material;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  });
}

// --- corridor trimming -----------------------------------------------------------------------

const trimStats = { kept: 0, removed: 0 };
const toGroup = new THREE.Matrix4();
const vertex = new THREE.Vector3();

/**
 * Keep a triangle only if it lies wholly inside the corridor + CORRIDOR_TILE_MARGIN (plan view), or
 * if it touches the walkable corridor itself (so there are never holes inside the walls; only such
 * oversized triangles can reach past the margin). Vertex buffers are compacted afterwards, so
 * geometry outside the play area is never drawn or kept.
 * `groupMatrix` maps the tiles group's space (where the tile scenes live) into the local frame.
 */
function trimToCorridor(scene: THREE.Object3D, groupMatrix: THREE.Matrix4): void {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return;

    // mesh space -> tiles group space -> local frame
    toGroup.identity();
    for (let o: THREE.Object3D | null = mesh; o; o = o === scene ? null : o.parent) {
      o.updateMatrix();
      toGroup.premultiply(o.matrix);
    }
    toGroup.premultiply(groupMatrix);

    const vertexCount = position.count;
    // bit 1: within corridor + margin; bit 2: inside the walls
    const flags = new Uint8Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(toGroup);
      flags[i] = (isInsidePlayArea(vertex, CORRIDOR_TILE_MARGIN) ? 1 : 0) | (isInsidePlayArea(vertex) ? 2 : 0);
    }

    const index = geometry.getIndex();
    const triangleCount = index ? index.count / 3 : vertexCount / 3;
    const kept: number[] = [];
    for (let t = 0; t < triangleCount; t++) {
      const a = index ? index.getX(3 * t) : 3 * t;
      const b = index ? index.getX(3 * t + 1) : 3 * t + 1;
      const c = index ? index.getX(3 * t + 2) : 3 * t + 2;
      const allNearCorridor = (flags[a] & flags[b] & flags[c] & 1) !== 0;
      const touchesPlayArea = ((flags[a] | flags[b] | flags[c]) & 2) !== 0;
      if (allNearCorridor || touchesPlayArea) kept.push(a, b, c);
    }
    trimStats.kept += kept.length / 3;
    trimStats.removed += triangleCount - kept.length / 3;
    if (kept.length / 3 === triangleCount) return; // tile wholly inside

    if (kept.length === 0) {
      mesh.visible = false;
      geometry.setIndex([]);
      return;
    }

    // Compact: keep only referenced vertices (plain attributes only; otherwise just re-index).
    const attributes = Object.values(geometry.attributes);
    const compactable = attributes.every((attr) => (attr as THREE.BufferAttribute).isBufferAttribute);
    if (!compactable) {
      geometry.setIndex(kept);
      return;
    }
    const remap = new Int32Array(vertexCount).fill(-1);
    let next = 0;
    const newIndex = kept.map((v) => (remap[v] === -1 ? (remap[v] = next++) : remap[v]));
    for (const [name, attr] of Object.entries(geometry.attributes) as [string, THREE.BufferAttribute][]) {
      const size = attr.itemSize;
      const Ctor = attr.array.constructor as new (n: number) => THREE.TypedArray;
      const array = new Ctor(next * size);
      for (let v = 0; v < vertexCount; v++) {
        const to = remap[v];
        if (to < 0) continue;
        for (let k = 0; k < size; k++) array[to * size + k] = attr.array[v * size + k];
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(array, size, attr.normalized));
    }
    geometry.setIndex(newIndex);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  });
}

// --- ground levelling ------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);
const SAMPLE_OFFSETS: ReadonlyArray<[number, number]> = [
  [0, 0],
  [4, 0],
  [-4, 0],
  [0, 4],
  [0, -4],
];

/**
 * Height (y) of the lowest tile surface under (x, z) in the local frame, i.e. the ground rather than
 * tree canopy or a roof; null if no tile is loaded there. Debug/tools helper (one raycast per call).
 */
export function raycastGround(x: number, z: number): number | null {
  if (!tiles) return null;
  raycaster.set(new THREE.Vector3(x, 1000, z), DOWN);
  raycaster.far = 3000;
  const hits = raycaster.intersectObject(tiles.group, true);
  return hits.length > 0 ? hits[hits.length - 1].point.y : null;
}

/** Raycast straight down near the origin and shift the tiles so the ground there is y = 0. */
function levelGround(): void {
  if (!tiles) return;
  const heights: number[] = [];
  for (const [x, z] of SAMPLE_OFFSETS) {
    const y = raycastGround(x, z);
    if (y !== null) heights.push(y);
  }
  if (heights.length === 0) return;
  heights.sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  if (Math.abs(median) < 0.05) return;
  groundGroup.position.y -= median;
  groundGroup.updateMatrixWorld(true);
  console.info(`[tiles] ground levelled: offset ${groundGroup.position.y.toFixed(2)} m (ORIGIN_HEIGHT ${ORIGIN_HEIGHT})`);
}

/** Current vertical shift applied to the tiles by AUTO_GROUND, in metres. */
export function getGroundOffset(): number {
  return groundGroup.position.y;
}

// --- setup -----------------------------------------------------------------------------------

/**
 * Create the TilesRenderer, add its group to world.tilesGroup and update it every frame.
 * Also installs the world debug keys (R / F / Space), see debugKeys.ts.
 */
export function initTiles(): void {
  if (tiles) return;
  initWorldDebug(); // registered first, so the debug camera moves before tiles update each frame

  const lat = THREE.MathUtils.degToRad(ORIGIN_LAT);
  const lon = THREE.MathUtils.degToRad(ORIGIN_LON);

  if (TILES_DIRECT) {
    const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;
    if (!key) {
      console.warn('[tiles] VITE_TILES_DIRECT=1 but VITE_GOOGLE_MAPS_KEY is empty; no tiles will load.');
      return;
    }
    tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true, useRecommendedSettings: false }));
  } else {
    tiles = new TilesRenderer(TILES_ROOT_URL);
  }
  const t = tiles;

  const dracoLoader = new DRACOLoader().setDecoderPath(DRACO_PATH);
  t.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader, plugins: [skipTexturesPlugin] }));
  t.registerPlugin(new ReorientationPlugin({ lat, lon, height: ORIGIN_HEIGHT, recenter: true }));

  // Only load tiles that touch the corridor + margin. The OBB lives in the tileset's own frame
  // (ECEF): local frame -> ECEF is the same ellipsoid frame ReorientationPlugin inverts.
  // Region errorTarget = CORRIDOR_MIN_DETAIL: tiles in the corridor refine until geometricError <=
  // CORRIDOR_MIN_DETAIL even when off-screen (in-view tiles still use the camera error if larger).
  const localToEcef = WGS84_ELLIPSOID.getObjectFrame(lat, lon, ORIGIN_HEIGHT, 0, 0, 0, new THREE.Matrix4());
  const halfAcross = CORRIDOR_HALF_WIDTH + CORRIDOR_TILE_MARGIN;
  const halfAlong = CORRIDOR_HALF_LENGTH + CORRIDOR_TILE_MARGIN;
  const corridorBox = new THREE.Box3(new THREE.Vector3(-halfAcross, -100, -halfAlong), new THREE.Vector3(halfAcross, 300, halfAlong));
  const regions = new LoadRegionPlugin();
  regions.addRegion(
    new OBBRegion({
      obb: new OBB(corridorBox, localToEcef.multiply(CORRIDOR_BASIS)),
      mask: true,
      errorTarget: CORRIDOR_MIN_DETAIL,
    }),
  );
  t.registerPlugin(regions);

  t.errorTarget = TILES_ERROR_TARGET;
  t.setCamera(world.camera);
  t.setResolutionFromRenderer(world.camera, world.renderer);

  groundGroup.add(t.group);
  world.tilesGroup.add(groundGroup);

  t.addEventListener('load-model', ({ scene }) => {
    t.group.updateWorldMatrix(true, false);
    trimToCorridor(scene, t.group.matrixWorld);
    applySonarMaterial(scene);
    if (firstLoadTime < 0) firstLoadTime = performance.now();
  });

  t.addEventListener('tile-visibility-change', ({ tile, visible }) => {
    // engineData isn't in the Tile typings; metadata is the parsed glTF (asset.copyright per tile)
    const engineData = (tile as unknown as { engineData?: { metadata?: { asset?: { copyright?: string } } | null } })
      .engineData;
    const copyright = engineData?.metadata?.asset?.copyright ?? '';
    if (!copyright) return;
    adjustCredits(copyright, visible ? 1 : -1);
    publishAttributions();
  });

  t.addEventListener('tiles-load-end', () => {
    if (AUTO_GROUND && firstLoadTime >= 0 && performance.now() - firstLoadTime < AUTO_GROUND_WINDOW * 1000) {
      levelGround();
    }
  });

  t.addEventListener('load-error', ({ url, error }) => {
    console.warn(`[tiles] failed to load ${String(url).split('?')[0]}: ${error?.message ?? error}`);
  });

  // R toggles between the shared material and the debug grid on every loaded tile
  // (including ones currently hidden, which forEachLoadedModel also visits).
  onRevealAllChange(() => t.forEachLoadedModel((scene) => assignWorldMaterial(scene)));

  world.onUpdate(() => {
    world.camera.updateMatrixWorld();
    t.setResolutionFromRenderer(world.camera, world.renderer);
    t.update();
  });
}

/** The live TilesRenderer, or null before initTiles() has run. */
export function getTiles(): TilesRenderer | null {
  return tiles;
}

/** Small summary for the debug readout. */
export function getTileStats(): { visible: number; loading: boolean; trianglesKept: number; trianglesTrimmed: number } {
  const trim = { trianglesKept: trimStats.kept, trianglesTrimmed: trimStats.removed };
  if (!tiles) return { visible: 0, loading: false, ...trim };
  const loading = (tiles as unknown as { loadProgress?: number }).loadProgress;
  return { visible: tiles.visibleTiles.size, loading: loading !== undefined && loading < 1, ...trim };
}
