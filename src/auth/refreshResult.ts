/**
 * Classifies the result of `supabase.auth.refreshSession()` for the API client (design D4a).
 *
 * Verified against auth-js 2.119.2 (`lib/fetch.js` handleError, `GoTrueClient._callRefreshToken`):
 * - Network failure / no response -> AuthRetryableFetchError, status 0.
 * - HTTP 500-504, 520-530 -> AuthRetryableFetchError with that status.
 * - Other HTTP errors -> AuthApiError with the HTTP status (400 for an invalid / revoked / already
 *   used refresh token, 429 when Supabase rate-limits the refresh).
 * - `session_not_found` or no refresh token -> AuthSessionMissingError (status 400).
 * - A refresh discarded because the stored session changed meanwhile (e.g. concurrent sign-out or
 *   another tab rotated the token) -> AuthRefreshDiscardedError (409).
 * refreshSession() returns these as `{ error }`; it throws only for non-auth errors (e.g. a lock
 * timeout).
 *
 * Definitive (sign out): a 4xx AuthApiError other than 429, a missing session, or success without
 * a session. Everything else is transient: the user stays signed in and the next request retries.
 */
import {
  isAuthApiError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  type Session,
} from '@supabase/supabase-js';
import type { RefreshResult } from '../services/apiClient';

export function classifyRefresh(result: {
  data: { session: Session | null } | null;
  error: unknown;
}): RefreshResult {
  const { data, error } = result;
  if (!error) {
    const token = data?.session?.access_token;
    return token ? { ok: true, accessToken: token } : { ok: false, definitive: true };
  }
  if (isAuthSessionMissingError(error)) return { ok: false, definitive: true };
  if (isAuthRetryableFetchError(error)) {
    const status = typeof error.status === 'number' ? error.status : 0;
    return status > 0
      ? { ok: false, definitive: false, kind: 'SERVER_ERROR', status }
      : { ok: false, definitive: false, kind: 'NETWORK_ERROR' };
  }
  if (isAuthApiError(error)) {
    const status = error.status;
    if (status === 429) return { ok: false, definitive: false, kind: 'RATE_LIMITED', status };
    if (typeof status === 'number' && status >= 400 && status < 500) return { ok: false, definitive: true };
    if (typeof status === 'number' && status >= 500) {
      return { ok: false, definitive: false, kind: 'SERVER_ERROR', status };
    }
  }
  // Unknown / discarded / unexpected: not proof that the session is dead.
  return { ok: false, definitive: false, kind: 'NETWORK_ERROR' };
}
