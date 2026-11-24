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

export function isSessionEnded(sessionKey: string): boolean {
  return ended.includes(sessionKey);
}

/** Tests only. */
export function resetEndedSessions(): void {
  ended.length = 0;
}
