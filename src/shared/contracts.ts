/**
 * src/shared/contracts.ts: types and constants shared by every module (the contract)
 * Owner: EVERYONE. Change only in a small, dedicated PR that all agents have seen.
 *
 * Types and constants only: no logic, no imports of other project modules. Adding a field or a
 * union member is fine; renaming or removing one breaks other people's code.
 * These are exposed through the shared `world` object (src/world/index.ts).
 */
import type { Vector3 } from 'three';

// --- sonar pings ---------------------------------------------------------------------------------

/** What made a ping. The sonar look (speed, thickness, colour) can differ per type. */
<<<<<<< HEAD
export type PingType = 'voice' | 'footstep' | 'cane' | 'car' | 'pedestrian' | 'impact' | 'tactile' | 'entity';
=======
export type PingType = 'voice' | 'footstep' | 'cane' | 'car' | 'pedestrian' | 'impact' | 'tactile';
>>>>>>> origin/main

/** How a ping is drawn. */
export interface PingStyle {
  /** Wave speed in m/s. */
  speed: number;
  /** Ring thickness in metres. */
  thickness: number;
  /** 0..1 */
  brightness: number;
  /** How quickly the ring fades after it passes, in 1/s. */
  fade: number;
}

/** A ping that is currently travelling. */
export interface ActivePing {
  origin: Vector3;
  /** Maximum distance in metres the wave reveals. */
  range: number;
  type: PingType;
  /** Start time in seconds (performance.now() / 1000). */
  start: number;
  style: PingStyle;
}

/** Size of the ping arrays on the GPU and in world.activePings(). */
export const MAX_PINGS = 32;

// --- collisions and audit ------------------------------------------------------------------------

/** What the player hit. */
export type HitKind = 'building' | 'low_obstacle' | 'street_furniture' | 'pedestrian' | 'car' | 'boundary' | 'entity';

/** One thing worth recording about how the player is doing (scoring, accessibility audit). */
export interface AuditEvent {
  kind: 'collision' | 'detected' | 'hesitation' | 'caught';
  hit?: HitKind;
  position: Vector3;
  /** m/s along the contact normal. */
  impactSpeed?: number;
  /** Horizontal unit normal of the contact. */
  normal?: Vector3;
  caneActive?: boolean;
}

// --- senses --------------------------------------------------------------------------------------

/** A way of seeing (total blindness, tunnel vision, ...). */
export interface VisionMode {
  id: string;
  label: string;
  /** How far the player can see, in metres (0 = nothing). */
  visibleDistance: number;
  /** Horizontal field of view in degrees. */
  fovDeg: number;
  /** Width in degrees of the blind spot in the middle of the view. */
  centralLossDeg: number;
  /** Angle in degrees beyond which nothing is seen. */
  peripheralLimitDeg: number;
}

// --- entity --------------------------------------------------------------------------------------

export type EntityStateName = 'patrol' | 'investigate' | 'chase' | 'caught';

export interface EntityState {
  state: EntityStateName;
  position: Vector3;
  velocity: Vector3;
}

// --- tactile paving ------------------------------------------------------------------------------

/** Blister = crossing / hazard warning (dome studs); guidance = directional strip (raised bars). */
export type TactileKind = 'blister' | 'guidance';

/** One rectangular patch of tactile paving on the ground. */
export interface TactileStrip {
  id: string;
  kind: TactileKind;
  /** Centre of the patch on the ground, world space (metres). */
  center: Vector3;
  /** Rotation about +Y in radians; 0 = `depth` runs along +Z. */
  yaw: number;
  /** Size across the walking direction (m). */
  width: number;
  /** Size along the walking direction (m). */
  depth: number;
}

// --- features ------------------------------------------------------------------------------------

/** Optional features that can be switched on and off (world.features / world.setFeature). */
export type FeatureName = 'tactile';

/** Payload of the 'featureChanged' event. */
export interface FeatureChangedPayload {
  name: FeatureName;
  on: boolean;
}

// --- events --------------------------------------------------------------------------------------

/** Names accepted by world.on / world.off / world.emit. */
export type WorldEventName = 'caught' | 'entityState' | 'stunned' | 'featureChanged';

/** Event callback. The payload shape is up to the module that emits the event. */
export type WorldEventCallback = (payload?: unknown) => void;
