/**
 * src/hud/hud.ts: FPS + attribution overlay (plain HTML over the black canvas)
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 * Branch: feat/mic-hud-audio
 *
 * STUB: signatures are final. The static attribution below is already live because it
 * must always stay visible (README "Attribution"); don't remove it.
 */

import { initStunVignette } from './stunVignette';
import { initStartScreen } from './startScreen';
import { initInputHud } from './inputHud';
import { world } from '../world';

let tileAttributionEl: HTMLElement | null = null;

/** Build the HUD inside #hud and register FPS updates with world.onUpdate(). */
export function initHud(): void {
  const root = document.getElementById('hud');
  if (!root) return;

  initStunVignette(root);
  initStartScreen(root);
  initVisionLabel(root);
  initInputHud(root);

  const attribution = document.createElement('div');
  // above the start screen too: attribution must always stay visible
  attribution.style.cssText = 'position:absolute;right:8px;bottom:8px;text-align:right;z-index:31;';

  // TODO(C): show the official Google Maps logo here as well.
  tileAttributionEl = document.createElement('div');
  tileAttributionEl.textContent = 'Google';
  const osm = document.createElement('div');
  osm.textContent = '© OpenStreetMap contributors';

  attribution.append(tileAttributionEl, osm);
  root.appendChild(attribution);

  // TODO(C): FPS counter.
}

/** Current vision mode in the top-right corner (O to change). */
function initVisionLabel(root: HTMLElement): void {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;right:8px;top:8px;opacity:0.8;font-size:12px;';
  root.appendChild(el);
  let shown = '';
  world.onUpdate(() => {
    const label = world.vision.label;
    if (label === shown) return;
    shown = label;
    el.textContent = `Vision: ${label}  (O)`;
  });
}

/** Called by src/world/tiles.ts with the tiles' current copyright text. */
export function setTileAttribution(text: string): void {
  if (tileAttributionEl) tileAttributionEl.textContent = text || 'Google';
}
