/**
 * Logout flow (OSP-70, design D1 + D2 option "B").
 *
 *  1. Write `localStorage['connect.logout_pending']` BEFORE any network call.
 *  2. POST /api/v1/auth/logout with a timeout and API-client recovery disabled (no refresh, no
 *     re-bind, no retry). Any outcome (network error, 5xx, 401, 403, 429, timeout) -> continue.
 *  3. `signOut({ scope: 'local' })`.
 *  4. Remove the flag.
 * The caller then navigates to /login.
 *
 * If the browser is closed or reloaded during step 2, the flag survives and AuthProvider finishes
 * the logout on the next start before rendering any protected UI.
 *
 * Security note (agreed with the user): the flag is NOT a security control. A user controls their
 * own browser (can drop the request, delete the flag, copy the token) but only keeps THEIR OWN
 * session, which they could also do by not pressing logout. Enforcement is server-side: the OSP-61
 * guard on every request (DEVICE_REVOKED / ACCOUNT_DISABLED), access-token expiry and refresh-token
 * revocation. Known limits: the LOGOUT audit row is client-initiated and can be suppressed, and a
 * copied access token stays usable until it expires if /auth/logout did not succeed.
 */

export const LOGOUT_PENDING_KEY = 'connect.logout_pending';

/** Timeout of the logout button's POST /auth/logout. */
export const LOGOUT_TIMEOUT_MS = 5_000;
/** Shorter best-effort timeout when finishing an interrupted logout at app start. */
export const STARTUP_LOGOUT_TIMEOUT_MS = 3_000;

export interface LogoutDeps {
  storage: Storage;
  /** POST /api/v1/auth/logout with recovery disabled. May reject; the result is ignored. */
  callLogoutEndpoint(timeoutMs: number): Promise<unknown>;
  /** `signOut({ scope: 'local' })`. */
  signOut(): Promise<void>;
}

export function isLogoutPending(storage: Storage = window.localStorage): boolean {
  try {
    return storage.getItem(LOGOUT_PENDING_KEY) !== null;
  } catch {
    return false;
  }
}

export async function performLogout(deps: LogoutDeps, timeoutMs: number): Promise<void> {
  try {
    deps.storage.setItem(LOGOUT_PENDING_KEY, '1');
  } catch {
    // Storage unavailable: the logout itself must still go on.
  }
  try {
    await deps.callLogoutEndpoint(timeoutMs);
  } catch {
    // D2: whatever the outcome, continue.
  }
  try {
    await deps.signOut();
  } catch {
    // signOut({ scope: 'local' }) removes the local session before any network call.
  }
  try {
    deps.storage.removeItem(LOGOUT_PENDING_KEY);
  } catch {
    // ignore
  }
}
