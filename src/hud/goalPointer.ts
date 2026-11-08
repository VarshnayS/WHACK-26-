/**
 * src/hud/goalPointer.ts: a big chevron pointing towards the goal, shown every few seconds
 * Owner: SENSES (HUD). Made bigger and goal green by ENTITY (Ayo) on request.
 *
 * During a run with a goal (src/player/route.ts), a green chevron fades in on a ring around the
 * centre of the screen every INTERVAL_S and fades out again, with no glow. Top of the ring =
 * straight ahead, bottom = behind you. It tracks your turning while showing. Green matches the goal beacon
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
/** Seconds from the start of one showing to the start of the next. */
const INTERVAL_S = 5;
/** How long each showing lasts, including the fades (s). */
const SHOW_S = 1.4;
/** Fade in / fade out time (s). */
const FADE_S = 0.3;
/** Peak opacity. */
const PEAK_OPACITY = 0.85;
/** First showing comes this long after the run begins (s). */
const FIRST_SHOW_S = 1;

const euler = new THREE.Euler(0, 0, 0, 'YXZ');

export function initGoalPointer(hud: HTMLElement): void {
  const c = '#' + GOAL_COLOR.toString(16).padStart(6, '0');
  const el = document.createElement('div');
  el.style.cssText =
    `position:absolute;left:50%;top:50%;width:${SIZE_PX}px;height:${SIZE_PX}px;` +
    `margin:-${SIZE_PX / 2}px 0 0 -${SIZE_PX / 2}px;display:none;pointer-events:none;`;
  el.setAttribute('aria-hidden', 'true');
  // Black outline under the green stroke keeps it readable over bright red/white sonar lines.
  el.innerHTML =
    '<svg viewBox="0 0 18 18" width="100%" height="100%" fill="none" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 12 L9 5 L15 12" stroke="#000" stroke-width="4"/>' +
    `<path d="M3 12 L9 5 L15 12" stroke="${c}" stroke-width="2.4"/></svg>`;
  hud.appendChild(el);

  let clock = INTERVAL_S - FIRST_SHOW_S; // restarted whenever no run is active
  let shown = false;

  function hide(): void {
    if (!shown) return;
    shown = false;
    el.style.display = 'none';
  }

  // Caught: the simulation freezes (no more updates), so hide it now for the jumpscare and fade.
  world.on('caught', () => hide());

  world.onUpdate((dt) => {
    const goal = getRoute().goal;
    if (!goal || !isRunActive()) {
      clock = INTERVAL_S - FIRST_SHOW_S;
      hide();
      return;
    }

    clock += dt;
    if (clock >= INTERVAL_S) clock -= INTERVAL_S;
    // the showing occupies the first SHOW_S of each cycle
    if (clock >= SHOW_S) {
      hide();
      return;
    }

    // yaw only, so looking up or down doesn't swing the pointer
    euler.setFromQuaternion(world.camera.quaternion);
    const fx = -Math.sin(euler.y);
    const fz = -Math.cos(euler.y);
    const dx = goal.x - world.camera.position.x;
    const dz = goal.z - world.camera.position.z;
    const angle = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz); // 0 = ahead, + = to the right

    el.style.opacity = (PEAK_OPACITY * Math.min(1, clock / FADE_S, (SHOW_S - clock) / FADE_S)).toFixed(3);
    el.style.transform =
      `translate(${(Math.sin(angle) * RING_PX).toFixed(1)}px,${(-Math.cos(angle) * RING_PX).toFixed(1)}px) ` +
      `rotate(${angle.toFixed(3)}rad)`;
    if (!shown) {
      shown = true;
      el.style.display = 'block';
    }
  });
}
