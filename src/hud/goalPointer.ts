/**
 * src/hud/goalPointer.ts: a big, pulsing chevron pointing towards the goal
 * Owner: SENSES (HUD). Edited by ENTITY (Ayo) on request: bigger, always on, pulsing, goal green.
 *
 * During a run with a goal (src/player/route.ts), a green chevron sits on a ring around the centre
 * of the screen, pointing at the goal, and pulses (CSS @keyframes goal-pointer-pulse). Top of the
 * ring = straight ahead, bottom = behind you. It tracks your turning. Green matches the goal beacon
 * (src/player/goalBeacon.ts), the same deliberate exception to AGENTS.md rule 9. Plain HTML over the
 * canvas, so it works in every vision mode. Tune with the constants below.
 */
import * as THREE from 'three';
import { world } from '../world';
import { getRoute, isRunActive } from '../player/route';
import { GOAL_COLOR } from '../player/goalBeacon';

/** Radius of the ring around the screen centre (px). */
const RING_PX = 120;
/** Chevron size (px): about 3x the old discreet one. */
const SIZE_PX = 54;
/** Fade in when a run begins (s). */
const FADE_IN_S = 0.6;
/** One pulse (grow + glow) every this many seconds. */
const PULSE_S = 1.1;

const STYLE_ID = 'goal-pointer-style';
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

/** The pulse animation (once per page). */
function addStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  const c = '#' + GOAL_COLOR.toString(16).padStart(6, '0');
  style.textContent = `
@keyframes goal-pointer-pulse {
  0%   { transform: scale(1);    opacity: 0.85; filter: drop-shadow(0 0 2px ${c}) drop-shadow(0 0 4px ${c}); }
  50%  { transform: scale(1.35); opacity: 1;    filter: drop-shadow(0 0 8px ${c}) drop-shadow(0 0 18px ${c}); }
  100% { transform: scale(1);    opacity: 0.85; filter: drop-shadow(0 0 2px ${c}) drop-shadow(0 0 4px ${c}); }
}
.goal-pointer-inner { width: 100%; height: 100%; animation: goal-pointer-pulse ${PULSE_S}s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .goal-pointer-inner { animation: none; } }`;
  document.head.appendChild(style);
}

export function initGoalPointer(hud: HTMLElement): void {
  addStyles();
  const c = '#' + GOAL_COLOR.toString(16).padStart(6, '0');
  const el = document.createElement('div');
  el.style.cssText =
    `position:absolute;left:50%;top:50%;width:${SIZE_PX}px;height:${SIZE_PX}px;` +
    `margin:-${SIZE_PX / 2}px 0 0 -${SIZE_PX / 2}px;display:none;pointer-events:none;`;
  el.setAttribute('aria-hidden', 'true');
  // Black outline under the green stroke keeps it readable over bright red/white sonar lines.
  el.innerHTML =
    '<div class="goal-pointer-inner"><svg viewBox="0 0 18 18" width="100%" height="100%" fill="none" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 12 L9 5 L15 12" stroke="#000" stroke-width="4"/>' +
    `<path d="M3 12 L9 5 L15 12" stroke="${c}" stroke-width="2.4"/></svg></div>`;
  hud.appendChild(el);

  let shownFor = 0; // seconds into the current run (for the fade in)
  let shown = false;

  function hide(): void {
    shownFor = 0;
    if (!shown) return;
    shown = false;
    el.style.display = 'none';
  }

  // Caught: the simulation freezes (no more updates), so hide it now for the jumpscare and fade.
  world.on('caught', () => hide());

  world.onUpdate((dt) => {
    const goal = getRoute().goal;
    if (!goal || !isRunActive()) {
      hide();
      return;
    }
    shownFor += dt;

    // yaw only, so looking up or down doesn't swing the pointer
    euler.setFromQuaternion(world.camera.quaternion);
    const fx = -Math.sin(euler.y);
    const fz = -Math.cos(euler.y);
    const dx = goal.x - world.camera.position.x;
    const dz = goal.z - world.camera.position.z;
    const angle = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz); // 0 = ahead, + = to the right

    el.style.opacity = Math.min(1, shownFor / FADE_IN_S).toFixed(3);
    el.style.transform =
      `translate(${(Math.sin(angle) * RING_PX).toFixed(1)}px,${(-Math.cos(angle) * RING_PX).toFixed(1)}px) ` +
      `rotate(${angle.toFixed(3)}rad)`;
    if (!shown) {
      shown = true;
      el.style.display = 'block';
    }
  });
}
