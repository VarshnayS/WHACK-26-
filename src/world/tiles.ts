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
 * - LoadRegionPlugin masks loading to TILE_LOAD_RADIUS around the origin.
 * - Every 'load-model' event: original materials/textures are disposed, uv/colour attributes are
 *   dropped, and the mesh gets the shared sonarMaterial (or the debug grid while R is on).
 * - Copyright strings of visible tiles are kept in world.attributions and sent to the HUD.
 */
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { GLTFLoaderPlugin } from 'three/addons/loaders/GLTFLoader.js';
import { TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer/three';
import { GLTFExtensionsPlugin, LoadRegionPlugin, ReorientationPlugin, SphereRegion } from '3d-tiles-renderer/three/plugins';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { world } from './index';
import { assignWorldMaterial, debugMaterial, getWorldMaterial, onRevealAllChange } from './debugMaterial';
import { initWorldDebug } from './debugKeys';
import { setTileAttribution } from '../hud/hud';
import { sonarMaterial } from '../render/sonarMaterial';
import {
  AUTO_GROUND,
  DRACO_PATH,
  ORIGIN_HEIGHT,
  ORIGIN_LAT,
  ORIGIN_LON,
  TILE_LOAD_RADIUS,
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

/** Raycast straight down near the origin and shift the tiles so the ground there is y = 0. */
function levelGround(): void {
  if (!tiles) return;
  const heights: number[] = [];
  for (const [x, z] of SAMPLE_OFFSETS) {
    raycaster.set(new THREE.Vector3(x, 1000, z), DOWN);
    raycaster.far = 3000;
    const hits = raycaster.intersectObject(tiles.group, true);
    // lowest surface under the point = ground (not tree canopy or a roof)
    if (hits.length > 0) heights.push(hits[hits.length - 1].point.y);
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

  // Only load tiles inside TILE_LOAD_RADIUS. The sphere lives in the tileset's own frame (ECEF).
  // errorTarget Infinity: the region only masks, it never forces extra detail.
  const centre = WGS84_ELLIPSOID.getCartographicToPosition(lat, lon, ORIGIN_HEIGHT, new THREE.Vector3());
  const regions = new LoadRegionPlugin();
  regions.addRegion(new SphereRegion({ sphere: new THREE.Sphere(centre, TILE_LOAD_RADIUS), mask: true, errorTarget: Infinity }));
  t.registerPlugin(regions);

  t.errorTarget = TILES_ERROR_TARGET;
  t.setCamera(world.camera);
  t.setResolutionFromRenderer(world.camera, world.renderer);

  groundGroup.add(t.group);
  world.tilesGroup.add(groundGroup);

  t.addEventListener('load-model', ({ scene }) => {
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
export function getTileStats(): { visible: number; loading: boolean } {
  if (!tiles) return { visible: 0, loading: false };
  const loading = (tiles as unknown as { loadProgress?: number }).loadProgress;
  return { visible: tiles.visibleTiles.size, loading: loading !== undefined && loading < 1 };
}
