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
import { createSonarMaterial } from '../render/sonarMaterial';
import { BODY_BULK, BODY_GRID_SIZE, BODY_HEIGHT, BODY_SCALE, BODY_TINT, STRIDE_LENGTH } from './config';

export interface EntityBody {
  root: THREE.Group;
  /** Pose it for this frame. */
  update(dt: number, position: THREE.Vector3, heading: number, speed: number): void;
}

/** The sonar shader's final output: `gl_FragColor = vec4(<colour expr>, 1.0);` */
const SONAR_OUTPUT = /gl_FragColor\s*=\s*vec4\(([\s\S]+?),\s*1\.0\s*\);/;

/**
 * Tint this material's sonar lines (only the entity's copy; tiles and agents stay white).
 * Wraps whatever colour the sonar shader outputs, so red stun pings etc. still work on top.
 */
function tint(material: THREE.ShaderMaterial): THREE.ShaderMaterial {
  const [r, g, b] = BODY_TINT;
  if (r === 1 && g === 1 && b === 1) return material;
  if (!SONAR_OUTPUT.test(material.fragmentShader)) {
    console.warn('[entity] sonar shader output not found; body stays white');
    return material;
  }
  const colour = `vec3(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)})`;
  material.fragmentShader = material.fragmentShader.replace(
    SONAR_OUTPUT,
    (_m, expr: string) => `gl_FragColor = vec4(${colour} * (${expr}), 1.0);`,
  );
  return material;
}

export function createEntityBody(): EntityBody {
  // Shared sonar material with the grid fixed to the body, so lines don't slide as it moves.
  const material = tint(createSonarMaterial({ name: 'entity', gridSpace: 'object', gridSize: BODY_GRID_SIZE }));
  const h = BODY_HEIGHT;
  const b = BODY_BULK;
  // Squat proportions: short thick legs, a long heavy torso, arms hanging past the knees.
  const legLen = h * 0.42;
  const torsoLen = h * 0.3;
  const armLen = h * 0.5;
  const neckLen = h * 0.07;
  const hipY = legLen;
  const shoulderY = hipY + torsoLen;

  const root = new THREE.Group();
  root.name = 'entity';
  root.scale.setScalar(BODY_SCALE);

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

  const legL = limb(0.055 * b, legLen, 0.1 * b, hipY);
  const legR = limb(0.055 * b, legLen, -0.1 * b, hipY);

  const torso = new THREE.Group();
  torso.position.y = hipY;
  torso.rotation.x = 0.18; // hunched forward
  root.add(torso);
  const torsoR = 0.13 * b;
  const chest = part(new THREE.CapsuleGeometry(torsoR, Math.max(0.05, torsoLen - torsoR), 3, 10), torso, 0, torsoLen / 2, 0);
  chest.scale.z = 0.8; // broad shoulders, flatter front to back

  const armX = torsoR + 0.04 * b;
  const armL = limb(0.035 * b, armLen, armX, shoulderY);
  const armR = limb(0.035 * b, armLen, -armX, shoulderY);
  armR.scale.y = 1.08; // one arm a little longer than the other

  const neck = new THREE.Group();
  neck.position.set(0.03, shoulderY, 0.07);
  root.add(neck);
  part(new THREE.CylinderGeometry(0.03 * b, 0.035 * b, neckLen, 6), neck, 0, neckLen / 2, 0);
  const head = new THREE.Group();
  head.position.y = neckLen;
  neck.add(head);
  const skull = part(new THREE.SphereGeometry(0.09 * Math.sqrt(b), 10, 8), head, 0, 0.07, 0.02);
  skull.scale.set(1.05, 0.95, 1); // small for the body, slightly wide

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
      phase += ((speed * dt) / (STRIDE_LENGTH * BODY_SCALE * (0.42 / 0.52))) * Math.PI * 2; // shorter legs, shorter stride
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