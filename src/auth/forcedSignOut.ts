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
import { withDeadline } from '../lib/deadline';
import { storageGet, storageRemove, storageSet } from '../lib/storage';

export type ForcedSignOutReason =
  | 'DEVICE_REVOKED'
  | 'ACCOUNT_DISABLED'
  | 'SESSION_NOT_BOUND'
  | 'ROLE_NOT_ALLOWED'
  | 'SESSION_EXPIRED';

/** Outer guard; the app's signOut (signOutLocal) is itself bounded to 3 s. */
const SIGN_OUT_GUARD_MS = 3_500;

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

export function storeSignOutReason(storage: Storage | null, reason: ForcedSignOutReason): void {
  // Storage may be unavailable (blocked, quota). The sign-out itself must still happen; an
  // already-mounted login page still gets the reason through the subscription below.
  storageSet(storage, SIGNOUT_REASON_KEY, reason);
  reasonListeners.forEach((listener) => listener(reason));
}

/** Reads the stored reason without removing it (safe to call twice under StrictMode). */
export function peekSignOutReason(storage: Storage | null): ForcedSignOutReason | null {
  const value = storageGet(storage, SIGNOUT_REASON_KEY);
  return isForcedSignOutReason(value) ? value : null;
}

export function clearSignOutReason(storage: Storage | null): void {
  storageRemove(storage, SIGNOUT_REASON_KEY);
}

export interface ForcedSignOutDeps {
  /** Must sign out with `scope: 'local'`; expected to be bounded (signOutLocal is). */
  signOut(): Promise<void>;
  navigateToLogin(): void;
  /** sessionStorage, or null when storage is blocked. */
  storage(): Storage | null;
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
        // Bounded like the logout (review R1): navigate even if signOut hangs or throws.
        await withDeadline(
          deps.signOut().catch(() => undefined),
          SIGN_OUT_GUARD_MS,
        );
        deps.navigateToLogin();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
