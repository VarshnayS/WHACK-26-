/**
 * src/player/goalBeacon.ts: the bright green goal object in the world
 * Owner: SENSES (player)
 *
 * A green beam with a slowly turning diamond and a ring on the ground marking the arrival radius.
 * It is unlit and doesn't need a ping, so it shows in every vision mode. The beam is tall enough to
 * rise over the rooftops, and it never gets thinner than a few pixels however far away it is.
 *
 * For the first START_PULSE_S of a run it throbs, sends expanding rings out from its base and is drawn
 * through buildings, so the player can see where to go. After that the buildings hide it as normal
 * (the top of the beam still shows above them). Only exists on screen during a run with a goal.
 *
 * Green is a deliberate exception to AGENTS.md rule 9, requested by Guneet. Tune with the constants.
 */
import * as THREE from 'three';
import { world } from '../world';
import { sampleGround } from '../world/heightField';
import { GOAL_RADIUS_M, getRoute, isRunActive, onRunChange } from './route';

export const GOAL_COLOR = 0x00ff55;
/** How long the opening pulse lasts (s) and the time between pulses (s). */
export const START_PULSE_S = 6;
const PULSE_PERIOD_S = 1.2;
/** Beam height (m): above the buildings along the corridor. */
const BEAM_HEIGHT_M = 45;
/** Beam radius up close (m), and how fast it widens with distance so it stays visible (m per m). */
const BEAM_RADIUS_M = 0.3;
const BEAM_RADIUS_PER_M = 0.004;
/** Beam opacity after the opening pulse. */
const BEAM_OPACITY = 0.6;
/** Beam gets this many times wider at the peak of a pulse. */
const PULSE_WIDEN = 2.5;
/** Diamond: height of its centre above the ground (m), radius (m), growth with distance, turn speed (rad/s). */
const GEM_HEIGHT_M = 2.6;
const GEM_RADIUS_M = 0.7;
const GEM_RADIUS_PER_M = 0.008;
const GEM_TURN = 1.2;
/** Expanding pulse ring: how far it reaches (m). */
const PULSE_RING_REACH_M = 18;
/** Ring heights above the ground, so they don't z-fight with it (m). */
const RING_LIFT_M = 0.08;

function material(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: GOAL_COLOR, transparent: true, depthWrite: false, side: THREE.DoubleSide });
}

export function initGoalBeacon(): void {
  const beamMat = material();
  const gemMat = material();
  const ringMat = material();
  const pulseMat = material();
  const mats = [beamMat, gemMat, ringMat, pulseMat];

  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0), beamMat);
  beam.scale.y = BEAM_HEIGHT_M;
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(1), gemMat);
  gem.position.y = GEM_HEIGHT_M;
  // flat rings with outer radius 1, scaled to size
  const ringGeometry = new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeometry, ringMat);
  ring.position.y = RING_LIFT_M;
  ring.scale.setScalar(GOAL_RADIUS_M);
  const pulseRing = new THREE.Mesh(ringGeometry, pulseMat);
  pulseRing.position.y = RING_LIFT_M;

  const root = new THREE.Group();
  root.name = 'goalBeacon';
  root.visible = false;
  root.add(beam, gem, ring, pulseRing);
  for (const child of root.children) child.renderOrder = 10;
  world.scene.add(root);

  let elapsed = 0;

  onRunChange(() => {
    root.visible = isRunActive() && getRoute().goal !== null;
    elapsed = 0;
  });

  world.onUpdate((dt) => {
    const goal = getRoute().goal;
    if (!root.visible || !goal) return;
    elapsed += dt;

    root.position.set(goal.x, sampleGround(goal.x, goal.z), goal.z);
    const cam = world.camera.position;
    const dist = Math.hypot(cam.x - goal.x, cam.z - goal.z);

    const pulsing = elapsed < START_PULSE_S;
    for (const m of mats) m.depthTest = !pulsing; // through buildings only during the opening pulse

    // 0..1 within each pulse: sharp rise, then a decay
    const phase = pulsing ? (elapsed % PULSE_PERIOD_S) / PULSE_PERIOD_S : 0;
    const throb = pulsing ? Math.pow(1 - phase, 2) : 0;

    const beamRadius = Math.max(BEAM_RADIUS_M, dist * BEAM_RADIUS_PER_M) * (1 + (PULSE_WIDEN - 1) * throb);
    beam.scale.x = beam.scale.z = beamRadius;
    beamMat.opacity = pulsing ? BEAM_OPACITY + (1 - BEAM_OPACITY) * throb : BEAM_OPACITY;

    gem.scale.setScalar(Math.max(GEM_RADIUS_M, dist * GEM_RADIUS_PER_M) * (1 + 0.5 * throb));
    gem.rotation.y = elapsed * GEM_TURN;
    gemMat.opacity = 1;

    ringMat.opacity = 0.9;
    pulseRing.visible = pulsing;
    if (pulsing) {
      pulseRing.scale.setScalar(GOAL_RADIUS_M + phase * PULSE_RING_REACH_M);
      pulseMat.opacity = 1 - phase;
    }
  });
}
