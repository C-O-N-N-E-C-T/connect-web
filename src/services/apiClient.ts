/**
 * Backend API client with the unified 401/403 handling of OSP-70 (design D4).
 *
 * Every request carries `Authorization: Bearer <supabase access_token>`. Error bodies follow the
 * backend contract `{ error_code, message }`.
 *
 * | Response                | Action                                                            |
 * |-------------------------|-------------------------------------------------------------------|
 * | 401                     | single-flight token refresh, retry ONCE. Refresh definitively     |
 * |                         | rejected or retry still 401 -> forced sign-out (SESSION_EXPIRED)  |
 * | 403 DEVICE_REVOKED      | forced sign-out with that reason                                  |
 * | 403 ACCOUNT_DISABLED    | forced sign-out with that reason                                  |
 * | 403 SESSION_NOT_BOUND   | single-flight re-bind (POST /auth/session), retry ONCE. Re-bind   |
 * |                         | DEVICE_REVOKED / ACCOUNT_DISABLED / 401, or retry still           |
 * |                         | SESSION_NOT_BOUND -> forced sign-out                              |
 * | 403 ROLE_FORBIDDEN      | typed error, NO sign-out                                          |
 * | 429/5xx/network/timeout | typed error, NO sign-out                                          |
 *
 * D4a: sign out ONLY on a definitive rejection. A transient failure DURING refresh or re-bind
 * (network, 5xx, 429, timeout) returns a typed error without sign-out and without a further retry;
 * the next request simply tries again (no failure is cached). Scenario: the crisis centre's
 * internet drops for 2 s exactly when the token is refreshed -> the coordinator stays signed in.
 *
 * At most one retry per request; after the retry no further refresh or re-bind is attempted.
 *
 * `recovery: false` (used by POST /auth/logout) disables refresh, re-bind, retry AND forced
 * sign-out: every outcome is returned as a typed error. The same applies to every request while a
 * logout is pending, so an in-flight request cannot re-bind a session the user is logging out of.
 *
 * Dependencies are injected so the client can be unit-tested without Supabase or fetch; the app
 * wiring lives in `src/auth/authRuntime.ts`.
 */
import type { ForcedSignOutReason } from '../auth/forcedSignOut';
import type { RegisterSessionResult } from './authSessionClient';
import { TIMED_OUT, withDeadline } from '../lib/deadline';

export const DEFAULT_TIMEOUT_MS = 15_000;

/** UI text for ROLE_FORBIDDEN; callers show it next to the action that was refused. */
export const ROLE_FORBIDDEN_MESSAGE = 'Bu işlem için yetkiniz yok.';

export type ApiErrorKind =
  /** The session was rejected and the user was signed out (see `reason`). */
  | 'SIGNED_OUT'
  /** 403 ROLE_FORBIDDEN. The user stays signed in. */
  | 'ROLE_FORBIDDEN'
  /** 401, only returned when recovery is disabled, or when there is no session at all. */
  | 'UNAUTHENTICATED'
  /** Any other 403 (unknown code, or a known code while recovery is disabled). */
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  /** Any other non-2xx status. */
  | 'HTTP_ERROR'
  /** 2xx with a body that is not JSON. */
  | 'INVALID_RESPONSE';

export interface ApiError {
  kind: ApiErrorKind;
  status?: number;
  errorCode?: string;
  reason?: ForcedSignOutReason;
}

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; error: ApiError };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRequestOptions {
  method?: HttpMethod;
  /** Serialized as JSON. */
  body?: unknown;
  /**
   * Total time budget of the request in ms (default DEFAULT_TIMEOUT_MS), covering token lookup,
   * the request, any refresh / re-bind and the retry. When it runs out the result is TIMEOUT.
   */
  timeoutMs?: number;
  /** Default true. false = no refresh, no re-bind, no retry, no forced sign-out. */
  recovery?: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Transient failure kinds of a refresh / re-bind (D4a): never a reason to sign out. */
export type TransientKind = 'NETWORK_ERROR' | 'SERVER_ERROR' | 'RATE_LIMITED';

/**
 * Outcome of a Supabase session refresh. `definitive` = the refresh token was rejected (4xx auth
 * error) or there is no session to refresh; anything else is transient.
 */
export type RefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; definitive: true }
  | { ok: false; definitive: false; kind: TransientKind; status?: number };

export interface ApiClientDeps {
  baseUrl: string;
  fetchImpl: FetchLike;
  /** Current access token from the Supabase session, or null when signed out. */
  getAccessToken(): Promise<string | null>;
  /** Refreshes the Supabase session and classifies a failure (see RefreshResult). */
  refreshAccessToken(): Promise<RefreshResult>;
  /** POST /api/v1/auth/session for this browser (existing OSP-60 client). */
  rebindSession(accessToken: string): Promise<RegisterSessionResult>;
  forceSignOut(reason: ForcedSignOutReason, accessToken: string | null): Promise<void>;
  isLogoutPending(): boolean;
}

export interface ApiClient {
  request<T>(path: string, options?: ApiRequestOptions): Promise<ApiResult<T>>;
}

type Attempt =
  | { type: 'response'; status: number; errorCode?: string; data?: unknown; invalidBody?: boolean }
  | { type: 'network' }
  | { type: 'timeout' };

type RebindOutcome =
  | { ok: true }
  | { ok: false; signOut: ForcedSignOutReason }
  | { ok: false; error: ApiError };

const TRANSIENT_NETWORK: RefreshResult = { ok: false, definitive: false, kind: 'NETWORK_ERROR' };

export function createApiClient(deps: ApiClientDeps): ApiClient {
  // Single-flight: concurrent callers share one attempt. The slot is cleared when the attempt
  // settles, so a (transient) failure is never cached and the next request tries again.
  let refreshInFlight: Promise<RefreshResult> | null = null;
  let rebindInFlight: Promise<RebindOutcome> | null = null;

  function refreshOnce(): Promise<RefreshResult> {
    if (!refreshInFlight) {
      refreshInFlight = deps
        .refreshAccessToken()
        .catch(() => TRANSIENT_NETWORK)
        .finally(() => {
          refreshInFlight = null;
        });
    }
    return refreshInFlight;
  }

  /**
   * A token that differs from the one we sent means another request (or the SDK's auto-refresh)
   * already refreshed the session; use it instead of refreshing again.
   */
  async function freshTokenAfter401(usedToken: string): Promise<RefreshResult> {
    const current = await deps.getAccessToken().catch(() => null);
    if (current && current !== usedToken) return { ok: true, accessToken: current };
    return refreshOnce();
  }

  function rebindOnce(): Promise<RebindOutcome> {
    if (!rebindInFlight) {
      rebindInFlight = (async (): Promise<RebindOutcome> => {
        const token = await deps.getAccessToken().catch(() => null);
        if (!token) return { ok: false, signOut: 'SESSION_EXPIRED' }; // no session to bind
        let result: RegisterSessionResult;
        try {
          result = await deps.rebindSession(token);
        } catch {
          return { ok: false, error: { kind: 'NETWORK_ERROR' } };
        }
        return classifyRebind(result);
      })().finally(() => {
        rebindInFlight = null;
      });
    }
    return rebindInFlight;
  }

  async function send(
    path: string,
    token: string,
    options: ApiRequestOptions,
    timeoutMs: number,
  ): Promise<Attempt> {
    if (timeoutMs <= 0) return { type: 'timeout' };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    try {
      const response = await deps.fetchImpl(`${deps.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      return await readResponse(response);
    } catch {
      return timedOut ? { type: 'timeout' } : { type: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function forced(
    reason: ForcedSignOutReason,
    usedToken: string,
    attempt: Attempt,
  ): Promise<ApiResult<never>> {
    // A logout may have started while this request was in flight: never sign out "for" it.
    if (deps.isLogoutPending()) return toResult(attempt) as ApiResult<never>;
    await deps.forceSignOut(reason, usedToken);
    return { ok: false, error: { kind: 'SIGNED_OUT', reason, ...statusOf(attempt) } };
  }

  async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResult<T>> {
    // Only relative API paths: the bearer token must never be sent to another origin.
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new Error(`apiClient: path must start with a single "/": ${path}`);
    }
    const recoveryAllowed = () => options.recovery !== false && !deps.isLogoutPending();
    // One deadline for the whole request: getSession() / refreshSession() can themselves hang
    // (offline with an expired token, contended auth lock), and the logout must never get stuck.
    const deadlineAt = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const remaining = () => deadlineAt - Date.now();
    const TIMEOUT: ApiResult<never> = { ok: false, error: { kind: 'TIMEOUT' } };

    const token = await withDeadline(deps.getAccessToken().catch(() => null), remaining());
    if (token === TIMED_OUT) return TIMEOUT;
    if (!token) return { ok: false, error: { kind: 'UNAUTHENTICATED' } };

    const first = await send(path, token, options, remaining());
    if (first.type !== 'response' || !recoveryAllowed()) return toResult<T>(first);

    let retryToken: string;
    if (first.status === 401) {
      const fresh = await withDeadline(freshTokenAfter401(token), remaining());
      if (fresh === TIMED_OUT) return TIMEOUT;
      if (!recoveryAllowed()) return toResult<T>(first);
      if (!fresh.ok) {
        if (fresh.definitive) return forced('SESSION_EXPIRED', token, first);
        // D4a: transient refresh failure -> typed error, stay signed in, no retry.
        return { ok: false, error: transientError(fresh.kind, fresh.status) };
      }
      retryToken = fresh.accessToken;
    } else if (first.status === 403 && first.errorCode === 'SESSION_NOT_BOUND') {
      const rebind = await withDeadline(rebindOnce(), remaining());
      if (rebind === TIMED_OUT) return TIMEOUT;
      if (!recoveryAllowed()) return toResult<T>(first);
      if (!rebind.ok) {
        if ('signOut' in rebind) return forced(rebind.signOut, token, first);
        // D4a: transient re-bind failure -> typed error, stay signed in, no retry.
        return { ok: false, error: rebind.error };
      }
      const current = await withDeadline(deps.getAccessToken().catch(() => null), remaining());
      if (current === TIMED_OUT) return TIMEOUT;
      retryToken = current ?? token;
    } else {
      const terminal = terminalReason(first);
      if (terminal) return forced(terminal, token, first);
      return toResult<T>(first);
    }

    // The single retry. Whatever happens now, no further refresh / re-bind.
    const second = await send(path, retryToken, options, remaining());
    if (second.type !== 'response' || !recoveryAllowed()) return toResult<T>(second);
    if (second.status === 401) return forced('SESSION_EXPIRED', retryToken, second);
    if (second.status === 403 && second.errorCode === 'SESSION_NOT_BOUND') {
      return forced('SESSION_NOT_BOUND', retryToken, second);
    }
    const terminal = terminalReason(second);
    if (terminal) return forced(terminal, retryToken, second);
    return toResult<T>(second);
  }

  return { request };
}

function transientError(kind: TransientKind, status?: number): ApiError {
  return status !== undefined ? { kind, status } : { kind };
}

/**
 * Re-bind (POST /auth/session) outcome per D4/D4a. Definitive: DEVICE_REVOKED / ACCOUNT_DISABLED
 * (sign out with that reason) and 401 (SESSION_EXPIRED). Everything else is a typed error.
 */
function classifyRebind(result: RegisterSessionResult): RebindOutcome {
  if (result.ok) return { ok: true };
  const { code, status } = result;
  if (code === 'DEVICE_REVOKED' || code === 'ACCOUNT_DISABLED') return { ok: false, signOut: code };
  if (status === 401) return { ok: false, signOut: 'SESSION_EXPIRED' };
  if (code === 'NETWORK_ERROR') return { ok: false, error: { kind: 'NETWORK_ERROR' } };
  if (code === 'RATE_LIMITED' || status === 429) {
    return { ok: false, error: { kind: 'RATE_LIMITED', status: 429 } };
  }
  if (status !== undefined && status >= 500) return { ok: false, error: { kind: 'SERVER_ERROR', status } };
  const kind: ApiErrorKind = status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR';
  const error: ApiError = { kind, errorCode: code };
  if (status !== undefined) error.status = status;
  return { ok: false, error };
}


function terminalReason(attempt: Attempt): ForcedSignOutReason | null {
  if (attempt.type !== 'response' || attempt.status !== 403) return null;
  if (attempt.errorCode === 'DEVICE_REVOKED' || attempt.errorCode === 'ACCOUNT_DISABLED') {
    return attempt.errorCode;
  }
  return null;
}

function statusOf(attempt: Attempt): Pick<ApiError, 'status' | 'errorCode'> {
  if (attempt.type !== 'response') return {};
  return attempt.errorCode !== undefined
    ? { status: attempt.status, errorCode: attempt.errorCode }
    : { status: attempt.status };
}

async function readResponse(response: Response): Promise<Attempt> {
  const status = response.status;
  if (response.ok) {
    if (status === 204 || status === 205) return { type: 'response', status };
    const text = await response.text();
    if (text.length === 0) return { type: 'response', status };
    try {
      return { type: 'response', status, data: JSON.parse(text) as unknown };
    } catch {
      return { type: 'response', status, invalidBody: true };
    }
  }
  let errorCode: string | undefined;
  try {
    const body = (await response.json()) as { error_code?: unknown };
    if (typeof body.error_code === 'string') errorCode = body.error_code;
  } catch {
    errorCode = undefined;
  }
  return { type: 'response', status, errorCode };
}

function toResult<T>(attempt: Attempt): ApiResult<T> {
  if (attempt.type === 'network') return { ok: false, error: { kind: 'NETWORK_ERROR' } };
  if (attempt.type === 'timeout') return { ok: false, error: { kind: 'TIMEOUT' } };

  const { status } = attempt;
  if (status >= 200 && status < 300) {
    if (attempt.invalidBody) return { ok: false, error: { kind: 'INVALID_RESPONSE', status } };
    return { ok: true, status, data: attempt.data as T };
  }

  const meta = statusOf(attempt);
  if (status === 401) return { ok: false, error: { kind: 'UNAUTHENTICATED', ...meta } };
  if (status === 403) {
    const kind = attempt.errorCode === 'ROLE_FORBIDDEN' ? 'ROLE_FORBIDDEN' : 'FORBIDDEN';
    return { ok: false, error: { kind, ...meta } };
  }
  if (status === 429) return { ok: false, error: { kind: 'RATE_LIMITED', ...meta } };
  if (status >= 500) return { ok: false, error: { kind: 'SERVER_ERROR', ...meta } };
  return { ok: false, error: { kind: 'HTTP_ERROR', ...meta } };
}
