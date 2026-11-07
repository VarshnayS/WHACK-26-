/**
 * src/senses/footsteps.ts: the player's footsteps reveal what's around them
 * Owner: SENSES
 *
 * Every step fires world.ping(feet, range, 'footstep'): ~3 m walking, ~6 m running, timed to the
 * step rate (one step per STEP_LENGTH_* metres travelled). Standing still, a faint ~1.5 m pulse
 * (breathing, shuffling) fires every ~4 s so the ground under you never disappears completely.
 * The soundscape (src/audio/soundscape.ts) hears these pings and plays the matching footstep sound.
 * getStepProgress() exposes the step count and how far through the current step the player is, so
 * the cane's auto-sweep (src/senses/cane.ts) can touch down in rhythm with the feet.
 * Tuning: src/senses/config.ts.
 */
import * as THREE from 'three';
import type { World } from '../world';
import { EYE_HEIGHT } from '../config';
import { getPlayerController } from '../player/controller';
import {
  IDLE_PULSE_INTERVAL,
  IDLE_PULSE_RANGE,
  STEP_LENGTH_RUN,
  STEP_LENGTH_WALK,
  STEP_MIN_SPEED,
  STEP_PING_HEIGHT,
  STEP_RANGE_RUN,
  STEP_RANGE_WALK,
  STEP_RUN_SPEED,
  STEP_WALK_SPEED,
} from './config';

const feet = new THREE.Vector3();
let initialised = false;

/** Where the player is in their stride. Read-only outside this file. */
export interface StepProgress {
  /** Steps taken so far. Even = right foot, odd = left foot. */
  count: number;
  /** 0..1 through the current step (0 = the foot just landed). Frozen while standing still. */
  phase: number;
  /** True while walking (above STEP_MIN_SPEED and not stunned). */
  moving: boolean;
}
const progress: StepProgress = { count: 0, phase: 0, moving: false };

export function getStepProgress(): Readonly<StepProgress> {
  return progress;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function initFootsteps(world: World): void {
  if (initialised) return;
  initialised = true;

  /** Distance walked since the last step (m). Starts half a step in so the first step comes quickly. */
  let stride = STEP_LENGTH_WALK * 0.5;
  /** Time standing still since the last ping (s). */
  let idle = IDLE_PULSE_INTERVAL * 0.75;

  function fire(range: number): void {
    feet.copy(world.camera.position);
    feet.y -= EYE_HEIGHT - STEP_PING_HEIGHT;
    world.ping(feet, range, 'footstep');
  }

  world.onUpdate((dt) => {
    const controller = getPlayerController();
    if (!controller) return;
    const speed = controller.getSpeed();

    if (speed < STEP_MIN_SPEED || controller.isStunned()) {
      progress.moving = false;
      idle += dt;
      if (idle >= IDLE_PULSE_INTERVAL) {
        idle = 0;
        fire(IDLE_PULSE_RANGE);
      }
      return;
    }

    idle = 0;
    const run = clamp01((speed - STEP_WALK_SPEED) / (STEP_RUN_SPEED - STEP_WALK_SPEED));
    stride += speed * dt;
    const stepLength = STEP_LENGTH_WALK + (STEP_LENGTH_RUN - STEP_LENGTH_WALK) * run;
    if (stride >= stepLength) {
      stride = 0;
      progress.count++;
      fire(STEP_RANGE_WALK + (STEP_RANGE_RUN - STEP_RANGE_WALK) * run);
    }
    progress.moving = true;
    progress.phase = Math.min(1, stride / stepLength);
  });
}
