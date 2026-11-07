/**
 * src/world/tiles.ts: loads Google 3D Tiles, strips textures, applies the shared material
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * STUB: signatures are final, bodies are placeholders.
 */
import type * as THREE from 'three';
import type { TilesRenderer } from '3d-tiles-renderer/three';

let tiles: TilesRenderer | null = null;

/**
 * Create the TilesRenderer and add its group to world.tilesGroup.
 *
 * TODO(A):
 *  - new TilesRenderer(TILES_ROOT_URL) from src/config.ts (proxy by default)
 *  - plugins from '3d-tiles-renderer/three/plugins': GLTFExtensionsPlugin (Draco, decoder at /draco/),
 *    ReorientationPlugin (centre on ORIGIN_LAT/LON), GoogleCloudAuthPlugin (only if TILES_DIRECT)
 *  - in the 'load-model' event (not a one-off pass) call applySonarMaterial(scene)
 *  - world.onUpdate(() => { tiles.setCamera / setResolutionFromRenderer / update() })
 *  - pass the tiles' copyright text to setTileAttribution() in src/hud/hud.ts
 */
export function initTiles(): void {
  // placeholder
}

/**
 * Dispose every original material + texture under `root` and replace it with
 * the shared sonarMaterial from src/render/sonarMaterial.ts.
 */
export function applySonarMaterial(root: THREE.Object3D): void {
  void root; // placeholder
}

/** The live TilesRenderer, or null before initTiles() has run. */
export function getTiles(): TilesRenderer | null {
  return tiles;
}
