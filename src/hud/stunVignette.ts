/**
 * src/hud/stunVignette.ts: red screen-edge vignette while the player is stunned
 * Owner: SENSES (HUD)
 *
 * Listens to world 'stunned' (payload: StunnedPayload from src/player/controller.ts). Flashes in
 * fast, then fades out over the stun duration with a slow throb. Plain HTML over the canvas, so it
 * works on the pitch-black default, in reveal-all (R) and in every vision mode.
 * Red is allowed only for stuns and danger (AGENTS.md rule 9).
 */
import { world } from '../world';
import type { StunnedPayload } from '../player/controller';

/** Seconds to reach full strength. */
const ATTACK = 0.07;
/** Peak opacity at intensity 0 / 1. */
const PEAK_MIN = 0.55;
const PEAK_MAX = 1;
/** Throb rate (Hz) and depth (0..1) while it fades. */
const THROB_HZ = 1.6;
const THROB_DEPTH = 0.18;

let el: HTMLDivElement | null = null;
let elapsed = 0;
let duration = 0;
let peak = 0;
let active = false;

function onStunned(payload?: unknown): void {
  const p = payload as Partial<StunnedPayload> | undefined;
  const d = Math.max(0.3, p?.duration ?? 1);
  const intensity = Math.min(1, Math.max(0, p?.intensity ?? 1));
  const newPeak = PEAK_MIN + (PEAK_MAX - PEAK_MIN) * intensity;
  // a weaker hit during a stronger one only extends it
  if (active && newPeak < peak * (1 - elapsed / duration)) {
    duration = Math.max(duration, elapsed + d);
    return;
  }
  peak = newPeak;
  duration = d;
  elapsed = 0;
  active = true;
}

function update(dt: number): void {
  if (!el || !active) return;
  elapsed += dt;
  if (elapsed >= duration) {
    active = false;
    el.style.opacity = '0';
    return;
  }
  const attack = Math.min(1, elapsed / ATTACK);
  const remaining = 1 - elapsed / duration;
  const throb = 1 - THROB_DEPTH * (0.5 - 0.5 * Math.cos(elapsed * Math.PI * 2 * THROB_HZ));
  el.style.opacity = (peak * attack * Math.pow(remaining, 0.8) * throb).toFixed(3);
}

/** Create the vignette inside `root` (the #hud element). Called once from initHud(). */
export function initStunVignette(root: HTMLElement): void {
  if (el) return;
  el = document.createElement('div');
  el.style.cssText =
    'position:absolute;inset:0;pointer-events:none;opacity:0;' +
    'background:radial-gradient(ellipse at center, rgba(255,16,8,0) 42%, rgba(255,16,8,0.35) 68%, rgba(255,16,8,0.95) 100%);' +
    'box-shadow:inset 0 0 120px 30px rgba(255,16,8,0.7);';
  root.prepend(el); // under the attribution text
  world.on('stunned', onStunned);
  world.onUpdate(update);
}
