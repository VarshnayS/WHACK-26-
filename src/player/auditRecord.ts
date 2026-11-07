/**
 * src/player/auditRecord.ts: world.audit.record() that never throws
 * Owner: SENSES
 *
 * The contract API is world.audit.record(event). AUDIT's current initAudit (src/world/audit/log.ts)
 * installs an object with log() but no record(), so calling record() throws and aborts the rest of
 * the frame's updates. Until that's fixed, fall back to log() (same fields) and never throw.
 * Wall collisions are skipped in the fallback: src/player/collision.ts already sends those to log().
 */
import type { World } from '../world';
import type { AuditEvent } from '../shared/contracts';

type Recorder = { record?: (e: AuditEvent) => void; log?: (e: AuditEvent) => void };
let warned = false;

export function recordAudit(world: World, event: AuditEvent): void {
  const a = world.audit as unknown as Recorder | undefined;
  try {
    if (typeof a?.record === 'function') a.record(event);
    else if (typeof a?.log === 'function' && event.kind !== 'collision') a.log(event);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[senses] audit record failed:', err);
    }
  }
}
