/**
 * src/entity/debug.ts: entity debug tools
 *
 *   T  toggle the overlay: state readout (bottom-left), hearing rings and current path.
 *      Rings: inner = CHASE_RADIUS, outer = how far a full voice ping is heard (MAX_HEARING).
 *      Best viewed with R (reveal all) on, so you can see the street around it.
 *   N  fire a test 'voice' ping at the camera (counts as the player making a noise).
 *
 * Debug only: plain white lines, not part of the game look.
 */
import * as THREE from 'three';
import type { World } from '../world';
import type { EntityBrain } from './brain';
import { CHASE_RADIUS, MAX_HEARING, TEST_PING_RANGE } from './config';
import { distXZ } from './pathfind';

const RING_SEGMENTS = 96;
const MAX_PATH_POINTS = 256;

function ring(radius: number): THREE.LineLoop {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.sin(a) * radius, 0, Math.cos(a) * radius));
  }
  const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff }));
  loop.frustumCulled = false;
  return loop;
}

export function initEntityDebug(world: World, brain: EntityBrain): (dt: number) => void {
  let on = false;

  const group = new THREE.Group();
  group.name = 'entityDebug';
  group.visible = false;
  world.scene.add(group);

  const rings = new THREE.Group();
  rings.add(ring(CHASE_RADIUS), ring(MAX_HEARING));
  group.add(rings);

  const pathGeo = new THREE.BufferGeometry();
  pathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PATH_POINTS * 3), 3));
  const pathLine = new THREE.Line(pathGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
  pathLine.frustumCulled = false;
  group.add(pathLine);

  const label = document.createElement('div');
  label.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:10;pointer-events:none;color:#fff;display:none;' +
    'font:12px/1.4 ui-monospace,monospace;white-space:pre;background:rgba(0,0,0,.6);padding:4px 6px;';
  document.body.appendChild(label);

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (e.code === 'KeyT') {
      on = !on;
      group.visible = on;
      label.style.display = on ? 'block' : 'none';
      console.info(`[entity] debug overlay ${on ? 'ON' : 'OFF'}`);
    } else if (e.code === 'KeyN') {
      world.ping(world.camera.position.clone(), TEST_PING_RANGE, 'voice');
      console.info('[entity] test voice ping');
    }
  });

  let labelTimer = 0;
  return (dt) => {
    if (!on) return;
    const y = brain.position.y + 0.05;
    rings.position.set(brain.position.x, y, brain.position.z);

    const pos = pathGeo.attributes.position as THREE.BufferAttribute;
    const points = [brain.position, ...brain.getWaypoints()].slice(0, MAX_PATH_POINTS);
    points.forEach((p, i) => pos.setXYZ(i, p.x, y, p.z));
    pos.needsUpdate = true;
    pathGeo.setDrawRange(0, points.length);

    labelTimer -= dt;
    if (labelTimer > 0) return;
    labelTimer = 0.15;
    const silence = Number.isFinite(brain.timeSinceSound) ? `${brain.timeSinceSound.toFixed(1)} s` : 'never';
    label.textContent =
      `ENTITY  ${brain.state.toUpperCase()}${brain.engaged ? '' : ' (waiting for player to move)'}   ${brain.speed.toFixed(1)} m/s\n` +
      `to player ${distXZ(brain.position, world.camera.position).toFixed(1)} m   last sound ${silence} ago\n` +
      `target ${brain.target ? `${distXZ(brain.position, brain.target).toFixed(1)} m away` : 'none'}   ` +
      `waypoints ${brain.getWaypoints().length}\n` +
      `T overlay  N test voice ping`;
  };
}