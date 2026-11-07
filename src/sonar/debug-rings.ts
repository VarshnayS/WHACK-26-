/**
 * src/sonar/debug-rings.ts: TEMPORARY visualiser, one expanding ring per active pulse
 * Owner: @USERNAME_C (mic/HUD/audio)
 *
 * Only exists until the sonar shader reads getActivePulses(). Enabled by
 * DETECTOR_CONFIG.debugRings. To remove: delete this file and its one use in src/audio/index.ts.
 *
 * Rings are drawn flat on the ground (origin.y - groundDrop for player pulses), always on top,
 * coloured by brightness (blue = dull, red = bright), opacity = fade * strength.
 */
import * as THREE from 'three';
import { getActivePulses, MAX_ACTIVE_PULSES } from './pulses';

const SEGMENTS = 96;

export interface DebugRings {
  update(now: number): void;
  dispose(): void;
}

export function createDebugRings(scene: THREE.Scene, playerGroundDrop: number): DebugRings {
  // Unit circle in the XZ plane, scaled per pulse.
  const pts = new Float32Array(SEGMENTS * 3);
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    pts[i * 3] = Math.cos(a);
    pts[i * 3 + 2] = Math.sin(a);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3));

  const group = new THREE.Group();
  group.name = 'debug-sonar-rings';
  const rings: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
  for (let i = 0; i < MAX_ACTIVE_PULSES; i++) {
    const mat = new THREE.LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    const ring = new THREE.LineLoop(geometry, mat);
    ring.frustumCulled = false;
    ring.renderOrder = 999;
    ring.visible = false;
    rings.push(ring);
    group.add(ring);
  }
  scene.add(group);

  return {
    update(now: number): void {
      const active = getActivePulses(now);
      for (let i = 0; i < rings.length; i++) {
        const ring = rings[i];
        const p = active[i];
        if (!p || p.radius <= 0) {
          ring.visible = false;
          continue;
        }
        ring.visible = true;
        const drop = p.source === 'player' ? playerGroundDrop : 0;
        ring.position.set(p.origin.x, p.origin.y - drop, p.origin.z);
        ring.scale.setScalar(p.radius);
        // 0.66 (blue) for dull sounds -> 0 (red) for bright ones; sustained pulses are paler.
        ring.material.color.setHSL(0.66 * (1 - p.brightness), 1, p.kind === 'sustained' ? 0.75 : 0.55);
        ring.material.opacity = Math.max(0.15, p.fade) * (0.4 + 0.6 * p.strength);
      }
    },
    dispose(): void {
      scene.remove(group);
      for (const r of rings) r.material.dispose();
      geometry.dispose();
    },
  };
}
