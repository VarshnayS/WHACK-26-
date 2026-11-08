/**
 * src/senses/caneTactile.ts: feeling tactile paving with the cane and the feet
 * Owner: TACTILE-SENSE
 *
 * While the cane is out (auto-sweep or manual sweep), the tip is checked against world.tactile every
 * frame. The feet are checked too, more softly. Only active while world.features.tactile is on.
 *
 * A trigger happens when the tip or feet ENTER a strip, at most once per strip every COOLDOWN_S:
 *  - world.ping(strip.center, range, 'tactile') (the yellow flash), plus a faint yellow afterglow
 *    of the strip's footprint for AFTERGLOW_S, so the player can locate it;
 *  - a textured sound at the contact point (blister = bumpy rattle, guidance = ribbed scrape);
 *  - a short buzz pattern on the controller, if there is one.
 *
 * Following a line: while the cane keeps touching guidance strips, a soft continuous scrape plays.
 *
 * Tactile contacts are never sent to world.audit: the report only shows collisions.
 *
 * Dev builds only: L, while no real strips exist, lays 10 fake strips ahead of the player, replaces
 * world.tactile.query and turns the feature on. Press L again to move them to where you are now.
 */
import * as THREE from 'three';
import { EYE_HEIGHT } from '../config';
import type { World } from '../world';
import type { TactileStrip } from '../shared/contracts';
import { playTactile, setTactileScrape } from '../audio/soundscape';
import { tactileTextureRumble } from '../player/haptics';
import { getCaneState, getCaneTip } from './cane';

/** Tip search radius (m). */
const TIP_RADIUS_M = 0.15;
/** Feet search radius (m). */
const FEET_RADIUS_M = 0.25;
/** The same strip can't trigger again for this long (s). Shared by the cane and the feet. */
const COOLDOWN_S = 1.5;
/** Yellow flash range (m): from the cane, and from the feet (softer). */
const PING_RANGE_M = 1.2;
const PING_RANGE_FEET_M = 0.8;

/** Afterglow length (s), peak opacity from the cane / from the feet, and how many can show at once. */
const AFTERGLOW_S = 2;
const AFTERGLOW_OPACITY = 0.3;
const AFTERGLOW_OPACITY_FEET = 0.18;
const AFTERGLOW_SLOTS = 8;
/** Lift above the strip's centre so the glow doesn't fight with the ground (m). */
const AFTERGLOW_LIFT_M = 0.04;
/** Accessibility yellow (AGENTS.md rule 9), the same colour as TACTILE_COLOR. */
const YELLOW = 0xffd400;

/** The scrape holds through a gap in guidance contact this short (s), e.g. the swing back across a line. */
const GUIDANCE_GRACE_S = 0.7;
/** The scrape starts after touching this many different guidance strips in a row... */
const GUIDANCE_MIN_STRIPS = 2;
/** ...or after this much total contact with one (s). */
const GUIDANCE_MIN_CONTACT_S = 0.3;

interface Glow {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  stripId: string | null;
  age: number;
  peak: number;
}

export function initCaneTactile(world: World): void {
  const feet = new THREE.Vector3();
  const lastFired = new Map<string, number>();
  let clock = 0;
  let tipOn: string | null = null;
  let feetOn: string | null = null;
  let guidanceGrace = 0;
  let guidanceContact = 0;
  let guidanceStrips = 0;
  let lastGuidanceId: string | null = null;
  let scraping = false;

  // --- afterglow: a small fixed pool of flat rectangles, 1 x 1 m, scaled to each strip -----------
  const glowGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const glowRoot = new THREE.Group();
  glowRoot.name = 'tactileAfterglow';
  const glows: Glow[] = [];
  for (let i = 0; i < AFTERGLOW_SLOTS; i++) {
    const mesh = new THREE.Mesh(
      glowGeometry,
      new THREE.MeshBasicMaterial({
        color: YELLOW,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    mesh.visible = false;
    glowRoot.add(mesh);
    glows.push({ mesh, stripId: null, age: 0, peak: 0 });
  }
  world.scene.add(glowRoot);

  function showGlow(strip: TactileStrip, peak: number): void {
    // the same strip again: restart its glow; otherwise a free slot, or the oldest one
    let slot = glows[0];
    for (const g of glows) {
      if (g.stripId === strip.id) {
        slot = g;
        break;
      }
      if (slot.stripId !== null && (g.stripId === null || g.age > slot.age)) slot = g;
    }
    slot.stripId = strip.id;
    slot.age = 0;
    slot.peak = peak;
    slot.mesh.position.set(strip.center.x, strip.center.y + AFTERGLOW_LIFT_M, strip.center.z);
    slot.mesh.rotation.y = strip.yaw;
    slot.mesh.scale.set(strip.width, 1, strip.depth);
    slot.mesh.material.opacity = peak;
    slot.mesh.visible = true;
  }

  function updateGlows(dt: number): void {
    for (const g of glows) {
      if (g.stripId === null) continue;
      g.age += dt;
      if (g.age >= AFTERGLOW_S) {
        g.stripId = null;
        g.mesh.visible = false;
      } else {
        g.mesh.material.opacity = g.peak * (1 - g.age / AFTERGLOW_S);
      }
    }
  }

  // --- triggers ----------------------------------------------------------------------------------

  function trigger(strip: TactileStrip, at: THREE.Vector3, soft: boolean): void {
    const last = lastFired.get(strip.id);
    if (last !== undefined && clock - last < COOLDOWN_S) return;
    lastFired.set(strip.id, clock);
    world.ping(strip.center, soft ? PING_RANGE_FEET_M : PING_RANGE_M, 'tactile');
    showGlow(strip, soft ? AFTERGLOW_OPACITY_FEET : AFTERGLOW_OPACITY);
    playTactile(strip.kind, at, soft);
    tactileTextureRumble(strip.kind, soft);
  }

  function setScrape(on: boolean, at: THREE.Vector3): void {
    if (on) setTactileScrape(true, at); // every frame while on: the sound follows the tip
    else if (scraping) setTactileScrape(false, at);
    scraping = on;
  }

  function resetGuidance(): void {
    guidanceGrace = 0;
    guidanceContact = 0;
    guidanceStrips = 0;
    lastGuidanceId = null;
  }

  function reset(): void {
    tipOn = null;
    feetOn = null;
    resetGuidance();
    setScrape(false, getCaneTip());
    lastFired.clear();
    for (const g of glows) {
      g.stripId = null;
      g.mesh.visible = false;
    }
  }

  world.on('featureChanged', () => {
    if (!world.features.tactile) reset();
  });

  // --- per frame ---------------------------------------------------------------------------------

  world.onUpdate((dt) => {
    if (!world.features.tactile) return;
    clock += dt;
    updateGlows(dt);

    const tip = getCaneTip();
    const cane = getCaneState();
    const tipStrip = cane.held || cane.auto ? world.tactile.query(tip, TIP_RADIUS_M) : null;
    if (tipStrip && tipStrip.id !== tipOn) trigger(tipStrip, tip, false);
    tipOn = tipStrip ? tipStrip.id : null;

    feet.copy(world.camera.position);
    feet.y -= EYE_HEIGHT;
    const feetStrip = world.tactile.query(feet, FEET_RADIUS_M);
    if (feetStrip && feetStrip.id !== feetOn) trigger(feetStrip, feet, true);
    feetOn = feetStrip ? feetStrip.id : null;

    if (tipStrip?.kind === 'guidance') {
      guidanceGrace = GUIDANCE_GRACE_S;
      guidanceContact += dt;
      if (tipStrip.id !== lastGuidanceId) {
        lastGuidanceId = tipStrip.id;
        guidanceStrips++;
      }
    } else if (guidanceGrace > 0) {
      guidanceGrace -= dt;
      if (guidanceGrace <= 0) resetGuidance();
    }
    setScrape(
      guidanceGrace > 0 && (guidanceStrips >= GUIDANCE_MIN_STRIPS || guidanceContact >= GUIDANCE_MIN_CONTACT_S),
      tip,
    );
  });

  if (import.meta.env.DEV) installFakeStrips(world);
}

/** Dev only: L lays fake strips ahead of the player while the real ones don't exist. */
function installFakeStrips(world: World): void {
  const COUNT_GUIDANCE = 6;
  const COUNT_BLISTER = 4;
  let installed = false;
  const local = new THREE.Vector3();

  function lay(): void {
    const cam = world.camera;
    const euler = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
    const yaw = euler.y;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const y = cam.position.y - EYE_HEIGHT;
    const strips = world.tactile.strips;
    strips.length = 0;
    const add = (kind: TactileStrip['kind'], i: number, ahead: number, side: number, width: number, depth: number): void => {
      strips.push({
        id: `fake-${kind}-${i}`,
        kind,
        center: new THREE.Vector3(cam.position.x + fx * ahead - fz * side, y, cam.position.z + fz * ahead + fx * side),
        yaw,
        width,
        depth,
      });
    };
    // a guidance line straight ahead, then a row of blister tiles across its end
    for (let i = 0; i < COUNT_GUIDANCE; i++) add('guidance', i, 1.4 + i * 0.8, 0, 0.4, 0.8);
    for (let i = 0; i < COUNT_BLISTER; i++) add('blister', i, 1.4 + COUNT_GUIDANCE * 0.8 + 0.2, (i - 1.5) * 0.8, 0.8, 0.8);
  }

  function fakeQuery(pos: THREE.Vector3, radius: number): TactileStrip | null {
    for (const s of world.tactile.strips) {
      local.set(pos.x - s.center.x, 0, pos.z - s.center.z).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -s.yaw);
      if (Math.abs(local.x) <= s.width / 2 + radius && Math.abs(local.z) <= s.depth / 2 + radius) return s;
    }
    return null;
  }

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyL' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (!installed && world.tactile.strips.length > 0) return; // real strips exist
    lay();
    if (!installed) {
      installed = true;
      world.tactile.query = fakeQuery;
      world.setFeature('tactile', true);
    }
    console.info(`[tactile] ${world.tactile.strips.length} fake strips laid (dev only)`);
  });
}
