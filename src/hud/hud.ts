/**
 * src/hud/hud.ts: FPS + attribution overlay (plain HTML over the black canvas)
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 * Branch: feat/mic-hud-audio
 *
 * STUB: signatures are final. The static attribution below is already live because it
 * must always stay visible (README "Attribution"); don't remove it.
 */

let tileAttributionEl: HTMLElement | null = null;

/** Build the HUD inside #hud and register FPS updates with world.onUpdate(). */
export function initHud(): void {
  const root = document.getElementById('hud');
  if (!root) return;

  const attribution = document.createElement('div');
  attribution.style.cssText = 'position:absolute;right:8px;bottom:8px;text-align:right;';

  // TODO(C): show the official Google Maps logo here as well.
  tileAttributionEl = document.createElement('div');
  tileAttributionEl.textContent = 'Google';
  const osm = document.createElement('div');
  osm.textContent = '© OpenStreetMap contributors';

  attribution.append(tileAttributionEl, osm);
  root.appendChild(attribution);

  // TODO(C): FPS counter.
}

/** Called by src/world/tiles.ts with the tiles' current copyright text. */
export function setTileAttribution(text: string): void {
  if (tileAttributionEl) tileAttributionEl.textContent = text || 'Google';
}
