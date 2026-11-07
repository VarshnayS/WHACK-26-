/**
 * src/audio/mic.ts: microphone -> sonar pings
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 * Branch: feat/mic-hud-audio
 *
 * STUB: signatures are final, bodies are placeholders.
 * Web Audio getUserMedia + AnalyserNode. Needs localhost or HTTPS.
 */

/**
 * Wait for a user gesture, open the mic, calibrate ambient noise, then register a
 * world.onUpdate() check: above baseline + ~15 dB, call
 * world.ping(world.camera.position, rangeFromDb(db)).
 */
export async function initMic(): Promise<void> {
  // placeholder
}

/** Current input level in dB (relative), or -Infinity before the mic starts. */
export function getMicLevelDb(): number {
  return -Infinity; // placeholder
}

/** Ambient noise baseline measured during calibration, in dB. */
export function getBaselineDb(): number {
  return -Infinity; // placeholder
}

/** Map a loudness in dB to a sonar range in metres (louder = further, also easier for the entity to hear). */
export function rangeFromDb(db: number): number {
  void db;
  return 0; // placeholder
}

/** Stop the mic stream and release the audio context. */
export function stopMic(): void {
  // placeholder
}
