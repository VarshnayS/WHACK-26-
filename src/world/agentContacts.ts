/**
 * src/world/agentContacts.ts: cheap contact tests between the player and agents (no raycasts)
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-polish
 *
 * Everything here is a vertical shape, so each test is a 2D test in the ground plane plus a vertical
 * overlap check:
 *   - verticalCapsuleOverlap(): player/pedestrian capsule vs capsule
 *   - verticalCapsuleVsBox():   capsule vs an oriented box (cars)
 * Both write a horizontal unit contact normal pointing from the agent towards the player, and the
 * penetration depth along it. Pure functions on numbers, so they are easy to test.
 */
import * as THREE from 'three';

export interface Contact {
  /** Horizontal unit normal, pointing from the agent towards the player (y = 0). */
  normal: THREE.Vector3;
  /** How far the shapes overlap along `normal`, in metres (> 0 when touching). */
  penetration: number;
}

export function createContact(): Contact {
  return { normal: new THREE.Vector3(1, 0, 0), penetration: 0 };
}

/**
 * Vertical capsule A (the player) against vertical capsule B (an agent). Each capsule is given by its
 * axis position (x, z), the height of its lowest point, its total height and its radius.
 * `fallback` is the normal used when the axes coincide (defaults to +x).
 */
export function verticalCapsuleOverlap(
  ax: number,
  az: number,
  aBottom: number,
  aHeight: number,
  aRadius: number,
  bx: number,
  bz: number,
  bBottom: number,
  bHeight: number,
  bRadius: number,
  out: Contact,
  fallbackX = 1,
  fallbackZ = 0,
): boolean {
  const dx = ax - bx;
  const dz = az - bz;
  const radii = aRadius + bRadius;
  // vertical gap between the two core segments (0 when their heights overlap)
  const a0 = aBottom + aRadius;
  const a1 = aBottom + aHeight - aRadius;
  const b0 = bBottom + bRadius;
  const b1 = bBottom + bHeight - bRadius;
  const gap = Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

  const horizontal2 = dx * dx + dz * dz;
  if (horizontal2 + gap * gap >= radii * radii) return false;

  const horizontal = Math.sqrt(horizontal2);
  if (horizontal > 1e-5) out.normal.set(dx / horizontal, 0, dz / horizontal);
  else out.normal.set(fallbackX, 0, fallbackZ).normalize();
  out.penetration = Math.sqrt(radii * radii - gap * gap) - horizontal;
  return true;
}

/**
 * Vertical capsule (the player) against an oriented box standing on the ground (a car).
 * The box is centred at (cx, cz), rotated by `yaw` about +Y like THREE's rotation.y (local +Z points
 * along (sin yaw, cos yaw)), with half extents `halfX` (across) and `halfZ` (along).
 */
export function verticalCapsuleVsBox(
  px: number,
  pz: number,
  pBottom: number,
  pHeight: number,
  pRadius: number,
  cx: number,
  cz: number,
  yaw: number,
  halfX: number,
  halfZ: number,
  boxBottom: number,
  boxHeight: number,
  out: Contact,
): boolean {
  if (pBottom >= boxBottom + boxHeight || pBottom + pHeight <= boxBottom) return false;

  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const dx = px - cx;
  const dz = pz - cz;
  // world -> box-local (inverse of rotation.y)
  const lx = cos * dx - sin * dz;
  const lz = sin * dx + cos * dz;

  const qx = Math.max(-halfX, Math.min(halfX, lx));
  const qz = Math.max(-halfZ, Math.min(halfZ, lz));
  const ox = lx - qx;
  const oz = lz - qz;
  const dist2 = ox * ox + oz * oz;

  let nlx: number;
  let nlz: number;
  if (dist2 > 1e-10) {
    if (dist2 >= pRadius * pRadius) return false;
    const dist = Math.sqrt(dist2);
    nlx = ox / dist;
    nlz = oz / dist;
    out.penetration = pRadius - dist;
  } else {
    // player axis inside the box: leave through the nearest face
    const depthX = halfX - Math.abs(lx);
    const depthZ = halfZ - Math.abs(lz);
    if (depthX < depthZ) {
      nlx = lx >= 0 ? 1 : -1;
      nlz = 0;
      out.penetration = pRadius + depthX;
    } else {
      nlx = 0;
      nlz = lz >= 0 ? 1 : -1;
      out.penetration = pRadius + depthZ;
    }
  }
  // box-local -> world
  out.normal.set(cos * nlx + sin * nlz, 0, -sin * nlx + cos * nlz);
  return true;
}
