/**
 * Forced sign-out (OSP-70, design D4).
 *
 * A forced sign-out happens when the backend rejects the session for good (revoked device,
 * disabled account, session that cannot be re-bound, expired session, non-web role). It:
 *  1. stores the reason in sessionStorage so /login can show it (read once, then cleared),
 *  2. signs out locally (`scope: 'local'`, see design D2),
 *  3. navigates to /login.
 *
 * The reason is written BEFORE signing out: the SIGNED_OUT event makes the route guard redirect,
 * and the login page may mount before this function returns.
 *
 * This path never calls POST /auth/logout: the token has already been rejected by the backend.
 */

export type ForcedSignOutReason =
  | 'DEVICE_REVOKED'
  | 'ACCOUNT_DISABLED'
  | 'SESSION_NOT_BOUND'
  | 'ROLE_NOT_ALLOWED'
  | 'SESSION_EXPIRED';

export const SIGNOUT_REASON_KEY = 'connect.signout_reason';

const REASONS: ReadonlySet<string> = new Set<ForcedSignOutReason>([
  'DEVICE_REVOKED',
  'ACCOUNT_DISABLED',
  'SESSION_NOT_BOUND',
  'ROLE_NOT_ALLOWED',
  'SESSION_EXPIRED',
]);

export function isForcedSignOutReason(value: unknown): value is ForcedSignOutReason {
  return typeof value === 'string' && REASONS.has(value);
}

type ReasonListener = (reason: ForcedSignOutReason) => void;
const reasonListeners = new Set<ReasonListener>();

/** Lets an already-mounted login page show a reason that arrives after it mounted. */
export function subscribeSignOutReason(listener: ReasonListener): () => void {
  reasonListeners.add(listener);
  return () => {
    reasonListeners.delete(listener);
  };
}

export function storeSignOutReason(storage: Storage, reason: ForcedSignOutReason): void {
  try {
    storage.setItem(SIGNOUT_REASON_KEY, reason);
  } catch {
    // Storage may be unavailable (private mode, quota). The sign-out itself must still happen.
  }
  reasonListeners.forEach((listener) => listener(reason));
}

/** Reads the stored reason without removing it (safe to call twice under StrictMode). */
export function peekSignOutReason(storage: Storage): ForcedSignOutReason | null {
  try {
    const value = storage.getItem(SIGNOUT_REASON_KEY);
    return isForcedSignOutReason(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearSignOutReason(storage: Storage): void {
  try {
    storage.removeItem(SIGNOUT_REASON_KEY);
  } catch {
    // ignore
  }
}

export interface ForcedSignOutDeps {
  /** Must sign out with `scope: 'local'` and must not throw. */
  signOut(): Promise<void>;
  navigateToLogin(): void;
  storage(): Storage;
}

export type ForceSignOut = (reason: ForcedSignOutReason, accessToken: string | null) => Promise<void>;

/**
 * Returns a single-flight forced sign-out.
 *
 * - Concurrent calls share one sign-out: one navigation, one message (the first reason wins).
 * - A late call for a token that was already signed out (a response that arrived after the
 *   sign-out finished) is ignored, so it cannot overwrite the message or navigate again.
 * - The in-flight latch is reset afterwards: the SPA does not reload between logins, so a later
 *   session must still be able to be signed out.
 */
export function createForcedSignOut(deps: ForcedSignOutDeps): ForceSignOut {
  let inFlight: Promise<void> | null = null;
  const handledTokens = new Set<string>();

  return function forceSignOut(reason, accessToken) {
    if (inFlight) return inFlight;
    if (accessToken !== null && handledTokens.has(accessToken)) return Promise.resolve();
    if (accessToken !== null) {
      if (handledTokens.size >= 20) handledTokens.clear();
      handledTokens.add(accessToken);
    }

    inFlight = (async () => {
      try {
        storeSignOutReason(deps.storage(), reason);
        try {
          await deps.signOut();
        } catch {
          // signOut({ scope: 'local' }) removes the local session first; keep going regardless.
        }
        deps.navigateToLogin();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
