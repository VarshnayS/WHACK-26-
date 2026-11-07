/**
 * src/hud/inputHud.ts: input feedback in the HUD
 * Owner: SENSES (HUD)
 *
 *  - a one-line message under the audio message (controller connected, haptics test, vision cycling);
 *  - "Cane: auto-sweep on/off (X)" in the top-right corner, under the vision label.
 * White on black, plain HTML over the canvas.
 */
import { getCaneState, onAutoSweepChange } from '../senses/cane';

let root: HTMLElement | null = null;
let msgEl: HTMLDivElement | null = null;
let msgTimer: number | null = null;
let initialised = false;

function hudRoot(): HTMLElement {
  return root ?? document.getElementById('hud') ?? document.body;
}

/** Show `text` for `ms` milliseconds (replaces the current message). */
export function showInputMessage(text: string, ms = 2000): void {
  if (!msgEl) {
    msgEl = document.createElement('div');
    msgEl.style.cssText =
      'position:absolute;left:50%;top:44px;transform:translateX(-50%);padding:4px 10px;z-index:32;' +
      'background:rgba(0,0,0,0.7);border:1px solid rgba(255,255,255,0.25);border-radius:4px;' +
      'color:#fff;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;display:none;pointer-events:none;';
    hudRoot().appendChild(msgEl);
  }
  msgEl.textContent = text;
  msgEl.style.display = 'block';
  if (msgTimer !== null) window.clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => {
    msgTimer = null;
    if (msgEl) msgEl.style.display = 'none';
  }, ms);
}

/** Build the auto-sweep corner label. Called once from initHud(). */
export function initInputHud(hud: HTMLElement): void {
  if (initialised) return;
  initialised = true;
  root = hud;
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;right:8px;top:26px;opacity:0.8;font-size:12px;';
  hud.appendChild(el);
  const render = (on: boolean) => {
    el.textContent = `Cane: auto-sweep ${on ? 'on' : 'off'}  (X)`;
  };
  render(getCaneState().auto);
  onAutoSweepChange((on) => {
    render(on);
    showInputMessage(`Cane auto-sweep ${on ? 'on' : 'off'}`, 1200);
  });
}
