/**
 * Backend API client with the unified 401/403 handling of OSP-70 (design D4).
 *
 * Every request carries `Authorization: Bearer <supabase access_token>`. Error bodies follow the
 * backend contract `{ error_code, message }`.
 *
 * | Response                | Action                                                            |
 * |-------------------------|-------------------------------------------------------------------|
 * | 401                     | single-flight token refresh, then retry. Refresh definitively     |
 * |                         | rejected (or no session to refresh) -> forced sign-out            |
 * |                         | (SESSION_EXPIRED)                                                 |
 * | 403 DEVICE_REVOKED      | forced sign-out with that reason                                  |
 * | 403 ACCOUNT_DISABLED    | forced sign-out with that reason                                  |
 * | 403 SESSION_NOT_BOUND   | single-flight re-bind (POST /auth/session), then retry. Re-bind   |
 * |                         | DEVICE_REVOKED / ACCOUNT_DISABLED -> sign-out with that reason;   |
 * |                         | re-bind 401 -> sign-out (SESSION_EXPIRED)                         |
 * | 403 ROLE_FORBIDDEN      | typed error, NO sign-out                                          |
 * | 429/5xx/network/timeout | typed error, NO sign-out                                          |
 *
 * R9: each recovery KIND at most once per request (one refresh, one re-bind; at most two retries,
 * no loops). A second 401 -> SESSION_EXPIRED, a second SESSION_NOT_BOUND -> SESSION_NOT_BOUND.
 *
 * D4a: sign out ONLY on a definitive rejection. A transient failure DURING refresh or re-bind
 * (network, 5xx, 429, timeout) returns a typed error without sign-out and without a further retry.
 * Scenario: the crisis centre's internet drops for 2 s exactly when the token is refreshed -> the
 * coordinator stays signed in. (supabase-js itself then serves the same refresh failure for up to
 * 60 s, so requests may keep failing that long; nobody is signed out. See README, review R3.)
 *
 * R2: recovery and forced sign-out are bound to the session that SENT the request (JWT
 * `session_id`). If that session ended in this tab (logout) or another session is current (a new
 * sign-in), nothing is refreshed, re-bound or signed out: the result is SESSION_CHANGED.
 * R7: after a failed refresh, a newer token of the same session in storage (rotated by another
 * tab) is used instead. R8: each refresh / re-bind attempt is bounded by RECOVERY_TIMEOUT_MS.
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
import { readSessionKey } from '../lib/jwt';

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
  | 'INVALID_RESPONSE'
  /**
   * The session that sent the request ended or was replaced meanwhile (logout, another sign-in):
   * nothing was refreshed, re-bound or signed out (review R2).
   */
  | 'SESSION_CHANGED';

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
export type TransientKind = 'NETWORK_ERROR' | 'SERVER_ERROR' | 'RATE_LIMITED' | 'TIMEOUT';

/**
 * Outcome of a Supabase session refresh. `definitive` = the refresh token was rejected (4xx auth
 * error) or there is no session to refresh; anything else is transient.
 */
export type RefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; definitive: true }
  | { ok: false; definitive: false; kind: TransientKind; status?: number };

/**
 * Current access token. `accessToken: null` = signed out. `ok: false` = the session could not be
 * read for a transient reason (e.g. supabase-js had to refresh an expiring token while offline);
 * that is NOT "signed out" (review R10).
 */
export type TokenLookup =
  | { ok: true; accessToken: string | null }
  | { ok: false; kind: TransientKind; status?: number };

export interface ApiClientDeps {
  baseUrl: string;
  fetchImpl: FetchLike;
  getAccessToken(): Promise<TokenLookup>;
  /** Refreshes the Supabase session and classifies a failure (see RefreshResult). */
  refreshAccessToken(): Promise<RefreshResult>;
  /** POST /api/v1/auth/session for this browser (existing OSP-60 client), abortable. */
  rebindSession(accessToken: string, signal: AbortSignal): Promise<RegisterSessionResult>;
  forceSignOut(reason: ForcedSignOutReason, accessToken: string | null): Promise<void>;
  /** True while a logout of the session with this identity is pending (R6: flag is per session). */
  isLogoutPending(sessionKey: string): boolean;
  /** Identity of the session a token belongs to. Default: JWT `session_id`, else `sub`, else token. */
  sessionKeyOf?(token: string): string;
  /** True if this tab ended that session on purpose (logout or forced sign-out). Default: never. */
  isSessionEnded?(sessionKey: string): boolean;
}

export interface ApiClient {
  request<T>(path: string, options?: ApiRequestOptions): Promise<ApiResult<T>>;
}

type Attempt =
  | { type: 'response'; status: number; errorCode?: string; data?: unknown; invalidBody?: boolean }
  | { type: 'network' }
  | { type: 'timeout' };

/** Result of a refresh or re-bind, already checked against the session that sent the request. */
type Recovery =
  | { ok: true; accessToken: string }
  | { ok: false; stale: true }
  | { ok: false; signOut: ForcedSignOutReason }
  | { ok: false; error: ApiError };

type RebindOutcome =
  | { ok: true }
  | { ok: false; signOut: ForcedSignOutReason }
  | { ok: false; error: ApiError };

/** What the current session is, relative to the session that sent a request. */
type Current =
  | { state: 'same'; token: string }
  | { state: 'none' }
  | { state: 'other' }
  | { state: 'unknown'; error: ApiError };

const TRANSIENT_NETWORK: RefreshResult = { ok: false, definitive: false, kind: 'NETWORK_ERROR' };
const STALE: Recovery = { ok: false, stale: true };
const sessionChanged = (): ApiResult<never> => ({ ok: false, error: { kind: 'SESSION_CHANGED' } });

/** Upper bound of one refresh / re-bind attempt, so a hung one cannot hold the shared slot (R8). */
export const RECOVERY_TIMEOUT_MS = 10_000;

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const keyOf = deps.sessionKeyOf ?? ((token: string) => readSessionKey(token) ?? token);
  const isEnded = deps.isSessionEnded ?? (() => false);

  // Single-flight per session: concurrent callers of the SAME session share one attempt. The slot
  // is cleared when the attempt settles; every attempt is bounded by RECOVERY_TIMEOUT_MS (R8), so
  // a hung one cannot keep it. A failure is never cached by this client (see README for the SDK's
  // own 60 s refresh-failure cooldown, R3).
  let refreshFlight: { owner: string; promise: Promise<Recovery> } | null = null;
  let rebindFlight: { owner: string; promise: Promise<RebindOutcome> } | null = null;

  async function currentFor(owner: string): Promise<Current> {
    const lookup = await deps.getAccessToken().catch((error: unknown): TokenLookup => {
      reportUnexpected('getAccessToken', error);
      return { ok: false, kind: 'NETWORK_ERROR' };
    });
    if (!lookup.ok) return { state: 'unknown', error: transientError(lookup.kind, lookup.status) };
    if (!lookup.accessToken) return { state: 'none' };
    return keyOf(lookup.accessToken) === owner
      ? { state: 'same', token: lookup.accessToken }
      : { state: 'other' };
  }

  async function boundedCurrent(owner: string, ms: number): Promise<Current> {
    const current = await withDeadline(currentFor(owner), ms);
    return current === TIMED_OUT ? { state: 'unknown', error: { kind: 'TIMEOUT' } } : current;
  }

  function refreshFor(owner: string, sentToken: string): Promise<Recovery> {
    if (refreshFlight && refreshFlight.owner === owner) return refreshFlight.promise;
    const promise = (async (): Promise<Recovery> => {
      const result = await withDeadline(
        deps.refreshAccessToken().catch((error: unknown) => {
          reportUnexpected('refreshAccessToken', error);
          return TRANSIENT_NETWORK;
        }),
        RECOVERY_TIMEOUT_MS,
      );
      if (result !== TIMED_OUT && result.ok) {
        return keyOf(result.accessToken) === owner ? result : STALE;
      }
      // R7: another tab may have rotated the session meanwhile (refresh_token_already_used, or a
      // refresh discarded because storage changed). If storage now holds a newer token of the
      // same session, use it instead of failing or signing out.
      const current = await boundedCurrent(owner, RECOVERY_TIMEOUT_MS);
      if (current.state === 'same' && current.token !== sentToken) {
        return { ok: true, accessToken: current.token };
      }
      if (current.state === 'other') return STALE;
      if (result === TIMED_OUT) return { ok: false, error: { kind: 'TIMEOUT' } };
      if (result.definitive) return { ok: false, signOut: 'SESSION_EXPIRED' };
      // D4a: transient -> typed error, stay signed in.
      return { ok: false, error: transientError(result.kind, result.status) };
    })();
    const flight = { owner, promise };
    refreshFlight = flight;
    void promise.finally(() => {
      if (refreshFlight === flight) refreshFlight = null;
    });
    return promise;
  }

  function rebindFor(owner: string, token: string): Promise<RebindOutcome> {
    if (rebindFlight && rebindFlight.owner === owner) return rebindFlight.promise;
    const promise = (async (): Promise<RebindOutcome> => {
      const controller = new AbortController();
      const result = await withDeadline(
        deps.rebindSession(token, controller.signal).catch((error: unknown) => {
          reportUnexpected('rebindSession', error);
          return { ok: false, code: 'NETWORK_ERROR' } as RegisterSessionResult;
        }),
        RECOVERY_TIMEOUT_MS,
      );
      if (result === TIMED_OUT) {
        controller.abort();
        return { ok: false, error: { kind: 'TIMEOUT' } };
      }
      return classifyRebind(result);
    })();
    const flight = { owner, promise };
    rebindFlight = flight;
    void promise.finally(() => {
      if (rebindFlight === flight) rebindFlight = null;
    });
    return promise;
  }

  /** 401: use a newer token of the same session, else refresh (shared per session). */
  async function recoverFrom401(owner: string, sentToken: string, ms: number): Promise<Recovery> {
    const current = await boundedCurrent(owner, ms);
    if (current.state === 'unknown') return { ok: false, error: current.error };
    if (current.state === 'other') return STALE;
    // No session at all: ended on purpose in this tab -> stale; otherwise "no session to
    // refresh", which D4a counts as definitive.
    if (current.state === 'none') return isEnded(owner) ? STALE : { ok: false, signOut: 'SESSION_EXPIRED' };
    if (current.token !== sentToken) return { ok: true, accessToken: current.token };
    return refreshFor(owner, sentToken);
  }

  /** 403 SESSION_NOT_BOUND: re-bind the SAME session (shared per session), then use its token. */
  async function recoverFromNotBound(owner: string, ms: number): Promise<Recovery> {
    const current = await boundedCurrent(owner, ms);
    if (current.state === 'unknown') return { ok: false, error: current.error };
    if (current.state === 'other') return STALE;
    if (current.state === 'none') return isEnded(owner) ? STALE : { ok: false, signOut: 'SESSION_EXPIRED' };
    const outcome = await rebindFor(owner, current.token);
    if (!outcome.ok) return outcome;
    const after = await boundedCurrent(owner, ms);
    if (after.state === 'other' || after.state === 'none') return STALE;
    return { ok: true, accessToken: after.state === 'same' ? after.token : current.token };
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

  async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResult<T>> {
    // Only relative API paths: the bearer token must never be sent to another origin.
    // A backslash is rejected too: URL parsing treats "/\\host" like "//host" (review R15).
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
      throw new Error(`apiClient: path must start with a single "/" and contain no "\\": ${path}`);
    }
    // One deadline for the whole request: getSession() / refreshSession() can themselves hang
    // (offline with an expired token), and the logout must never get stuck.
    const deadlineAt = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const remaining = () => deadlineAt - Date.now();
    const TIMEOUT: ApiResult<never> = { ok: false, error: { kind: 'TIMEOUT' } };

    const lookup = await withDeadline(
      deps.getAccessToken().catch((error: unknown): TokenLookup => {
        reportUnexpected('getAccessToken', error);
        return { ok: false, kind: 'NETWORK_ERROR' };
      }),
      remaining(),
    );
    if (lookup === TIMED_OUT) return TIMEOUT;
    if (!lookup.ok) return { ok: false, error: transientError(lookup.kind, lookup.status) };
    if (!lookup.accessToken) return { ok: false, error: { kind: 'UNAUTHENTICATED' } };

    // R2: every recovery step and every forced sign-out is bound to the session that SENT the
    // request. A stale response (after a logout, or while another user signs in) does nothing.
    const owner = keyOf(lookup.accessToken);
    const recoveryAllowed = () => options.recovery !== false && !deps.isLogoutPending(owner);

    /** Forced sign-out, unless the request's session is no longer the one to sign out. */
    async function forced(reason: ForcedSignOutReason, token: string, attempt: Attempt): Promise<ApiResult<T>> {
      if (!recoveryAllowed()) return toResult<T>(attempt);
      if (isEnded(owner)) return sessionChanged();
      const current = await boundedCurrent(owner, Math.max(remaining(), 1_000));
      if (current.state === 'other') return sessionChanged();
      // 'none' (session already gone, not by this tab's logout) and 'unknown' still sign out: the
      // backend's verdict is definitive and no other session is affected.
      if (!recoveryAllowed() || isEnded(owner)) return sessionChanged();
      await deps.forceSignOut(reason, token);
      return { ok: false, error: { kind: 'SIGNED_OUT', reason, ...statusOf(attempt) } };
    }

    function fromRecovery(recovery: Exclude<Recovery, { ok: true }>, token: string, attempt: Attempt) {
      if ('stale' in recovery) return Promise.resolve(sessionChanged() as ApiResult<T>);
      if ('signOut' in recovery) return forced(recovery.signOut, token, attempt);
      // D4a: transient failure during refresh / re-bind -> typed error, no sign-out, no retry.
      return Promise.resolve({ ok: false, error: recovery.error } as ApiResult<T>);
    }

    let token = lookup.accessToken;
    let refreshed = false;
    let rebound = false;
    let attempt = await send(path, token, options, remaining());

    // R9: each recovery KIND at most once per request (one refresh, one re-bind), so at most two
    // retries in total and no loops. A second 401 / second SESSION_NOT_BOUND is definitive.
    for (;;) {
      if (attempt.type !== 'response' || !recoveryAllowed()) return toResult<T>(attempt);

      let recovery: Recovery | typeof TIMED_OUT;
      if (attempt.status === 401) {
        if (refreshed) return forced('SESSION_EXPIRED', token, attempt);
        refreshed = true;
        recovery = await withDeadline(recoverFrom401(owner, token, remaining()), remaining());
      } else if (attempt.status === 403 && attempt.errorCode === 'SESSION_NOT_BOUND') {
        if (rebound) return forced('SESSION_NOT_BOUND', token, attempt);
        rebound = true;
        recovery = await withDeadline(recoverFromNotBound(owner, remaining()), remaining());
      } else {
        const terminal = terminalReason(attempt);
        if (terminal) return forced(terminal, token, attempt);
        return toResult<T>(attempt);
      }

      if (recovery === TIMED_OUT) return TIMEOUT;
      if (!recoveryAllowed()) return toResult<T>(attempt);
      if (!recovery.ok) return fromRecovery(recovery, token, attempt);
      token = recovery.accessToken;
      attempt = await send(path, token, options, remaining());
    }
  }

  return { request };
}

/**
 * Dev-only trace of an unexpected exception that is mapped to a typed error (review R16). Only the
 * error name and status are logged, never messages, tokens or URLs.
 */
function reportUnexpected(where: string, error: unknown): void {
  if (!import.meta.env.DEV) return;
  const name = error instanceof Error ? error.name : typeof error;
  const status = (error as { status?: unknown } | null)?.status;
  console.warn(`[apiClient] ${where} failed unexpectedly`, { name, status });
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
