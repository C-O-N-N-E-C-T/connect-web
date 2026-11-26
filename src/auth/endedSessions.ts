/**
 * Sessions this tab ended on purpose (logout button, interrupted logout, forced sign-out), by
 * session identity (`readSessionKey`). A late response of such a session must not refresh,
 * re-bind, sign out again or replace the login banner (review R2).
 */
const ended: string[] = [];
const MAX = 50;

export function markSessionEnded(sessionKey: string | null): void {
  if (!sessionKey || ended.includes(sessionKey)) return;
  ended.push(sessionKey);
  if (ended.length > MAX) ended.shift();
}

/**
 * A fresh sign-in with an identity that was ended before (only possible when tokens carry no
 * `session_id` and the identity falls back to `sub`): it is a live session again.
 */
export function clearSessionEnded(sessionKey: string | null): void {
  if (!sessionKey) return;
  const index = ended.indexOf(sessionKey);
  if (index !== -1) ended.splice(index, 1);
}

export function isSessionEnded(sessionKey: string): boolean {
  return ended.includes(sessionKey);
}

/** Tests only. */
export function resetEndedSessions(): void {
  ended.length = 0;
}
