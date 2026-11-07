/**
 * src/render/pingColors.ts: optional ping colour (the one exception to white-on-black)
 * Owner: RENDER
 *
 * Rendering rule (AGENTS.md rule 9): white lines on black; red is allowed only for stuns and danger.
 * So a ping is white unless its type is listed here, or its style carries an explicit `color`.
 *
 * `color` is a render-side extension of the contract's PingStyle (PROPOSAL on the coordination issue
 * to add `color?: [r, g, b]` to PingStyle in src/shared/contracts.ts). Until then, a module can still
 * pass a style object with a `color` field and src/render/pings.ts will honour it.
 */
import type { PingStyle, PingType } from '../shared/contracts';

/** Linear RGB, 0..1. */
export type PingColor = readonly [number, number, number];

/** Stuns and danger only. Slightly orange-shifted so it stays readable on black. */
export const DANGER_RED: PingColor = [1, 0.1, 0.06];

/** Per-type colour. Types not listed are white. */
export const PING_COLORS: Partial<Record<PingType, PingColor>> = {
  /** The player hit something (wall, pedestrian, car): the stun ring is red. */
  impact: DANGER_RED,
};

/** A PingStyle that may carry its own colour (render-side extension). */
export type ColoredPingStyle = PingStyle & { color?: PingColor };

/** The colour to draw a ping with, or null for plain white. */
export function pingColor(type: PingType, style: PingStyle): PingColor | null {
  return (style as ColoredPingStyle).color ?? PING_COLORS[type] ?? null;
}
