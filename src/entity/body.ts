/**
 * src/entity/body.ts: the entity's figure
 *
 * Tall, thin and slightly wrong: legs too long, a short narrow torso, arms hanging past the knees,
 * a small head on a long neck that sits off-centre and twitches. Every part uses the object-space
 * grid sonar material, so it's pitch black until a ping (or R) reveals it.
 *
 * Model faces +Z, feet at y = 0. Limbs hang from pivot groups at the hips and shoulders.
 */
import * as THREE from 'three';
import { createAgentMaterial } from '../world/agentMaterial';
import { BODY_GRID_SIZE, BODY_HEIGHT, STRIDE_LENGTH } from './config';

export interface EntityBody {
  root: THREE.Group;
  /** Pose it for this frame. */
  update(dt: number, position: THREE.Vector3, heading: number, speed: number): void;
}

export function createEntityBody(): EntityBody {
  // TODO(RENDER): switch to createSonarMaterial({ objectSpace: true, gridSize }) once it's on main.
  const material = createAgentMaterial('entity', BODY_GRID_SIZE);
  const h = BODY_HEIGHT;
  const legLen = h * 0.52;
  const torsoLen = h * 0.22;
  const armLen = h * 0.5;
  const hipY = legLen;
  const shoulderY = hipY + torsoLen;

  const root = new THREE.Group();
  root.name = 'entity';

  const part = (geo: THREE.BufferGeometry, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.frustumCulled = false;
    parent.add(m);
    return m;
  };
  /** A limb hanging down from a pivot. */
  const limb = (radius: number, length: number, x: number, y: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    root.add(pivot);
    part(new THREE.CapsuleGeometry(radius, length - radius * 2, 3, 6), pivot, 0, -length / 2, 0);
    return pivot;
  };

  const legL = limb(0.055, legLen, 0.1, hipY);
  const legR = limb(0.055, legLen, -0.1, hipY);

  const torso = new THREE.Group();
  torso.position.y = hipY;
  torso.rotation.x = 0.18; // hunched forward
  root.add(torso);
  part(new THREE.CapsuleGeometry(0.13, torsoLen - 0.1, 3, 8), torso, 0, torsoLen / 2, 0);

  const armL = limb(0.035, armLen, 0.21, shoulderY);
  const armR = limb(0.035, armLen, -0.21, shoulderY);
  armR.scale.y = 1.08; // one arm a little longer than the other

  const neck = new THREE.Group();
  neck.position.set(0.03, shoulderY, 0.07);
  root.add(neck);
  part(new THREE.CylinderGeometry(0.03, 0.035, h * 0.12, 6), neck, 0, h * 0.06, 0);
  const head = new THREE.Group();
  head.position.y = h * 0.12;
  neck.add(head);
  const skull = part(new THREE.SphereGeometry(0.09, 10, 8), head, 0, 0.07, 0.02);
  skull.scale.set(0.85, 1.25, 1); // narrow and long

  let phase = 0;
  let twitchTimer = 2;
  let twitchTarget = 0;
  let headTilt = 0;
  let yaw = 0;

  return {
    root,
    update(dt, position, heading, speed) {
      root.position.copy(position);
      let diff = heading - yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      yaw += diff * Math.min(1, dt * 6);
      root.rotation.y = yaw;

      const moving = Math.min(1, speed / 1.0);
      phase += ((speed * dt) / STRIDE_LENGTH) * Math.PI * 2;
      const swing = Math.sin(phase) * 0.45 * moving;
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
      // Arms swing late and stiff, hanging a little forward.
      armL.rotation.x = 0.15 - Math.sin(phase - 0.6) * 0.25 * moving;
      armR.rotation.x = 0.15 + Math.sin(phase - 0.6) * 0.25 * moving;
      torso.rotation.z = Math.sin(phase) * 0.04 * moving;

      // The head snaps to a new tilt every few seconds, then holds it.
      twitchTimer -= dt;
      if (twitchTimer <= 0) {
        twitchTimer = 1.5 + Math.random() * 3;
        twitchTarget = (Math.random() - 0.5) * 0.9;
      }
      headTilt += (twitchTarget - headTilt) * Math.min(1, dt * 18);
      head.rotation.z = headTilt;
      neck.rotation.x = 0.35 + Math.sin(phase * 0.5) * 0.05;
    },
  };
}
