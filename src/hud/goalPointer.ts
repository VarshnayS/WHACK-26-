/**
 * src/hud/goalPointer.ts: a small, occasional chevron pointing towards the goal
 * Owner: SENSES (HUD)
 *
 * During a run with a goal (src/player/route.ts), a thin white chevron fades in on a ring around
 * the centre of the screen every GOAL_POINTER_INTERVAL_S and fades out again. Top of the ring =
 * straight ahead, bottom = behind you. It tracks your turning while it is showing. Plain HTML over
 * the canvas, so it works in every vision mode. Tune with the constants below.
 */
import * as THREE from 'three';
import { world } from '../world';
import { getRoute, isRunActive } from '../player/route';

/** Seconds from the start of one showing to the start of the next. */
export const GOAL_POINTER_INTERVAL_S = 5;
/** How long each showing lasts, including the fades (s). */
const SHOW_S = 1.2;
/** Fade in / fade out time (s). */
const FADE_S = 0.3;
/** Peak opacity: keep it low to stay discreet. */
const PEAK_OPACITY = 0.6;
/** Radius of the ring around the screen centre (px). */
const RING_PX = 70;
/** Chevron size (px). */
const SIZE_PX = 18;
/** First showing comes this long after the run begins (s). */
const FIRST_SHOW_S = 1;

const euler = new THREE.Euler(0, 0, 0, 'YXZ');

export function initGoalPointer(hud: HTMLElement): void {
  const el = document.createElement('div');
  el.style.cssText =
    `position:absolute;left:50%;top:50%;width:${SIZE_PX}px;height:${SIZE_PX}px;` +
    `margin:-${SIZE_PX / 2}px 0 0 -${SIZE_PX / 2}px;display:none;pointer-events:none;`;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML =
    '<svg viewBox="0 0 18 18" width="100%" height="100%" fill="none" stroke="#fff" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 L9 5 L15 12"/></svg>';
  hud.appendChild(el);

  let clock = GOAL_POINTER_INTERVAL_S - FIRST_SHOW_S; // restarted whenever no run is active
  let shown = false;

  function hide(): void {
    if (!shown) return;
    shown = false;
    el.style.display = 'none';
  }

  world.onUpdate((dt) => {
    const goal = getRoute().goal;
    if (!goal || !isRunActive()) {
      clock = GOAL_POINTER_INTERVAL_S - FIRST_SHOW_S;
      hide();
      return;
    }

    clock += dt;
    if (clock >= GOAL_POINTER_INTERVAL_S) clock -= GOAL_POINTER_INTERVAL_S;
    // the showing occupies the first SHOW_S of each cycle, once the clock has wrapped
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

    const opacity = PEAK_OPACITY * Math.min(1, clock / FADE_S, (SHOW_S - clock) / FADE_S);
    el.style.opacity = opacity.toFixed(3);
    el.style.transform =
      `translate(${(Math.sin(angle) * RING_PX).toFixed(1)}px,${(-Math.cos(angle) * RING_PX).toFixed(1)}px) ` +
      `rotate(${angle.toFixed(3)}rad)`;
    if (!shown) {
      shown = true;
      el.style.display = 'block';
    }
  });
}
