import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { decodeJwtClaims, readSessionKey, readUserRole } from '../lib/jwt';
import { isWebRole, type AppRole } from '../lib/roles';
import type { ApiResult } from '../services/apiClient';
import type { ForceSignOut } from './forcedSignOut';
import {
  ANY_SESSION,
  clearLogoutPending,
  isLogoutPending,
  LOGOUT_TIMEOUT_MS,
  pendingLogoutKey,
  performLogout,
  STARTUP_LOGOUT_TIMEOUT_MS,
} from './logout';

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  /** Server role from GET /auth/me when known, otherwise the JWT `user_role` claim. */
  role: AppRole | null;
  /**
   * True while the stored session cannot be read because Supabase is unreachable (review R4). The
   * status then stays `loading` (no panel, no /login) and the read is retried.
   */
  connectionProblem: boolean;
}

export interface AuthContextValue extends AuthState {
  /** Logout flow D1/D2. Never rejects. The caller navigates to /login afterwards. */
  logout(): Promise<void>;
  /** Re-reads the local session (used after a back/forward-cache restore). */
  revalidate(): Promise<void>;
}

export interface AuthMeBody {
  user_id: string;
  role: string;
  device_id: string;
}

/** Injected so the provider can be tested without Supabase or the network. */
export interface AuthProviderDeps {
  /**
   * The stored session, refreshed if needed; null = signed out. REJECTS when it cannot be
   * determined for a transient reason (offline / 5xx while refreshing an expiring token): that is
   * not "signed out" (review R4).
   */
  getSession(): Promise<Session | null>;
  /** Subscribes; returns the unsubscribe function. */
  onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): () => void;
  fetchMe(): Promise<ApiResult<AuthMeBody>>;
  /** POST /api/v1/auth/logout with API-client recovery disabled. */
  callLogoutEndpoint(timeoutMs: number): Promise<unknown>;
  /** `signOut({ scope: 'local' })`, never throws. */
  signOut(): Promise<void>;
  forceSignOut: ForceSignOut;
  /** Records that this tab ended a session on purpose (see endedSessions.ts). */
  markSessionEnded(sessionKey: string | null): void;
  /** A fresh sign-in makes that identity live again (see endedSessions.ts). */
  clearSessionEnded(sessionKey: string | null): void;
  /** Identity of the session persisted by supabase-js, read without any network call. */
  storedSessionKey(): string | null;
  setLoginNavigator(navigateToLogin: () => void): () => void;
  /** localStorage (holds the logout-pending flag), or null when storage is blocked. */
  storage(): Storage | null;
  /** VITE_AUTH_SESSION_MODE. In `mock` mode no backend call is made. */
  mode: string | undefined;
  now(): number;
}

/** A focus/visibility check is skipped if the previous one started less than this long ago. */
export const ME_CHECK_MIN_INTERVAL_MS = 10_000;

const AuthContext = createContext<AuthContextValue | null>(null);

/** Exposed for tests that render a panel without the full provider. */
export const AuthContextProvider = AuthContext.Provider;

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

function isAppRole(value: unknown): value is AppRole {
  return value === 'rescuer' || isWebRole(value);
}

function jwtRole(session: Session): AppRole | null {
  const role = readUserRole(session.access_token);
  return isAppRole(role) ? role : null;
}

function userIdOf(session: Session): string | null {
  if (session.user?.id) return session.user.id;
  try {
    const sub = decodeJwtClaims(session.access_token).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

/** Identity of a session (JWT session_id, else the user id). */
export function sessionKeyOf(session: Session): string | null {
  return readSessionKey(session.access_token) ?? userIdOf(session);
}

const LOADING: AuthState = { status: 'loading', session: null, role: null, connectionProblem: false };
const SIGNED_OUT: AuthState = { status: 'signedOut', session: null, role: null, connectionProblem: false };

/** Retry delays for reading the session while Supabase is unreachable (R4); the last one repeats. */
export const SESSION_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];

/**
 * Holds the Supabase session and the user's role for the whole app (OSP-70).
 *
 * - Startup: `getSession()` (the session lives in localStorage, so it survives a reload: AC1),
 *   then GET /auth/me to confirm the session and take the role from the server.
 * - `onAuthStateChange` keeps the state in sync (sign-in, token refresh, sign-out in this or
 *   another tab).
 * - If a logout was interrupted (flag `connect.logout_pending`), it is finished first and no
 *   protected UI is rendered meanwhile (design D2).
 * - When the tab becomes visible again, GET /auth/me runs once more so a revoked device or
 *   disabled account is noticed (AC-19, design D3).
 *
 * Must be rendered inside the router (it navigates to /login on a forced sign-out).
 */
export function AuthProvider({ deps, children }: { deps: AuthProviderDeps; children: ReactNode }) {
  const [state, setState] = useState<AuthState>(LOADING);
  const navigate = useNavigate();
  const location = useLocation();

  const depsRef = useRef(deps);
  depsRef.current = deps;
  /** Latest known session, updated synchronously (state updates are applied later). */
  const sessionRef = useRef<Session | null>(null);
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  /** Role confirmed by GET /auth/me, kept per user so token refreshes do not overwrite it. */
  const serverRoleRef = useRef<{ userId: string; role: AppRole } | null>(null);
  const meInFlightRef = useRef<Promise<void> | null>(null);
  const lastMeStartRef = useRef<number | null>(null);
  const logoutInFlightRef = useRef<Promise<void> | null>(null);

  const applySession = useCallback((session: Session | null) => {
    sessionRef.current = session;
    if (!session) {
      serverRoleRef.current = null;
      setState(SIGNED_OUT);
      return;
    }
    const userId = userIdOf(session);
    const server = serverRoleRef.current;
    const role = server && server.userId === userId ? server.role : jwtRole(session);
    setState({ status: 'signedIn', session, role, connectionProblem: false });
  }, []);

  /**
   * GET /api/v1/auth/me — the user's "option 2" decision (design D3): this lightweight endpoint
   * is the session check of the web dashboard, so AC-19 ("the very next API call signs the user
   * out") is observable even though the panels make no backend calls yet. We deliberately do NOT
   * ping GET /api/v1/victims or /api/v1/admin/users instead: GET /victims writes a victim-access
   * audit row on every call (OSP-65 / AC-28), which would pollute the audit log and download
   * sensitive data for nothing, and those endpoints belong to other stories.
   *
   * Errors are handled by the API client (401/403 -> refresh / re-bind / forced sign-out); here we
   * only apply the server role. Skipped in mock mode (no backend).
   */
  const checkMe = useCallback(async (): Promise<void> => {
    const d = depsRef.current;
    if (d.mode === 'mock') return;
    if (meInFlightRef.current) return meInFlightRef.current;
    lastMeStartRef.current = d.now();
    const startedFor = sessionRef.current ? sessionKeyOf(sessionRef.current) : null;

    const run = (async () => {
      let result: Awaited<ReturnType<AuthProviderDeps['fetchMe']>>;
      try {
        result = await d.fetchMe();
      } catch (error) {
        // Never an unhandled rejection from a fire-and-forget check (review R16).
        if (import.meta.env.DEV) {
          console.warn('[AuthProvider] /auth/me check failed unexpectedly', {
            name: error instanceof Error ? error.name : typeof error,
          });
        }
        return;
      }
      if (!result.ok) return;
      const body = result.data;
      if (!body || typeof body.role !== 'string' || typeof body.user_id !== 'string') return;

      // R2: apply the answer only to the session that asked, and only for the same user. A stale
      // answer (user A's, arriving while user B is signed in) must not sign B out.
      const session = sessionRef.current;
      if (!session || isLogoutPending(d.storage(), sessionKeyOf(session))) return;
      if (sessionKeyOf(session) !== startedFor || userIdOf(session) !== body.user_id) return;
      // Server role wins over the JWT claim. A non-web role must not use the dashboard.
      if (!isWebRole(body.role)) {
        await d.forceSignOut('ROLE_NOT_ALLOWED', session.access_token);
        return;
      }
      const role = body.role;
      serverRoleRef.current = { userId: body.user_id, role };
      setState((prev) =>
        prev.session && userIdOf(prev.session) === body.user_id ? { ...prev, role } : prev,
      );
    })();

    meInFlightRef.current = run.finally(() => {
      meInFlightRef.current = null;
    });
    return meInFlightRef.current;
  }, []);

  const runLogout = useCallback((timeoutMs: number, sessionKey: string | null): Promise<void> => {
    if (logoutInFlightRef.current) return logoutInFlightRef.current;
    const d = depsRef.current;
    // Late responses of this session must not refresh, re-bind or show a banner (review R2).
    if (sessionKey !== ANY_SESSION) d.markSessionEnded(sessionKey);
    const flow = performLogout(
      {
        sessionKey: sessionKey === ANY_SESSION ? null : sessionKey,
        storage: d.storage(),
        // Mock mode has no backend: skip POST /auth/logout like POST /auth/session is skipped.
        callLogoutEndpoint: d.mode === 'mock' ? async () => undefined : d.callLogoutEndpoint,
        signOut: d.signOut,
      },
      timeoutMs,
    ).then(() => {
      // A new sign-in may have happened meanwhile (R6): never "sign out" that session in the UI.
      const current = sessionRef.current;
      if (!current || sessionKey === ANY_SESSION || sessionKeyOf(current) === sessionKey) {
        applySession(null);
      }
    });
    logoutInFlightRef.current = flow.finally(() => {
      logoutInFlightRef.current = null;
    });
    return logoutInFlightRef.current;
  }, [applySession]);

  // Session bootstrap + subscription.
  useEffect(() => {
    const d = depsRef.current;
    let active = true;

    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    const unsubscribe = d.onAuthStateChange((event, session) => {
      // Synchronous state updates only. Never await a Supabase call inside this callback
      // (known supabase-js deadlock). If async work is ever needed here, defer it with
      // setTimeout(..., 0).
      if (!active) return;
      // The startup getSession() decides the initial state: a null INITIAL_SESSION is also what
      // supabase-js reports when it could not refresh an expiring token offline (R4).
      if (event === 'INITIAL_SESSION' && !session) return;
      if (!session) {
        applySession(null);
        return;
      }
      // While THIS session's logout is pending it must never turn into protected UI.
      const pending = pendingLogoutKey(d.storage());
      if (pending !== null) {
        if (pending === ANY_SESSION || pending === sessionKeyOf(session)) return;
        // A different session = a new sign-in: it ends the old pending logout (review R6), so a
        // later reload does not log the new session out.
        clearLogoutPending(d.storage());
      }
      // A real sign-in from the signed-out state (not a token refresh of a session being signed
      // out) is a live session, even if its identity was ended before (sub fallback, R2).
      if (event === 'SIGNED_IN' && !sessionRef.current) d.clearSessionEnded(sessionKeyOf(session));
      applySession(session);
    });

    const pending = pendingLogoutKey(d.storage());
    const stored = d.storedSessionKey();
    if (pending !== null && pending !== ANY_SESSION && stored !== null && stored !== pending) {
      // The flag belongs to an older session; the stored one is a newer sign-in (R6): keep it.
      clearLogoutPending(d.storage());
    }
    if (isLogoutPending(d.storage())) {
      // Interrupted logout (browser closed / reloaded during POST /auth/logout): finish it first.
      // Status stays "loading" until it is done, so no protected UI is rendered.
      void runLogout(STARTUP_LOGOUT_TIMEOUT_MS, pendingLogoutKey(d.storage()));
    } else {
      const load = () => {
        void d.getSession().then(
          (session) => {
            if (!active || (session && isLogoutPending(d.storage(), sessionKeyOf(session)))) return;
            applySession(session);
            // R12: not on /login, where a sign-in may be in progress.
            if (session && pathnameRef.current !== '/login') void checkMe();
          },
          () => {
            // R4: the session could not be read for a transient reason. It is still stored, so
            // this is NOT "signed out": stay loading and try again. A TOKEN_REFRESHED / SIGNED_IN
            // event from supabase-js (network back) ends this state too.
            if (!active || sessionRef.current) return;
            setState((prev) => (prev.status === 'loading' ? { ...prev, connectionProblem: true } : prev));
            const delay = SESSION_RETRY_DELAYS_MS[Math.min(retries, SESSION_RETRY_DELAYS_MS.length - 1)];
            retries += 1;
            retryTimer = setTimeout(() => {
              if (active && !sessionRef.current) load();
            }, delay);
          },
        );
      };
      load();
    }

    return () => {
      active = false;
      clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [applySession, checkMe, runLogout]);

  // Forced sign-outs navigate through the router.
  useEffect(
    () =>
      depsRef.current.setLoginNavigator(() => {
        if (pathnameRef.current !== '/login') navigate('/login', { replace: true });
      }),
    [navigate],
  );

  // Re-check with the server when the tab becomes visible again (no polling).
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState !== 'visible') return;
      const d = depsRef.current;
      if (!sessionRef.current) return;
      // On /login a sign-in may be in progress (POST /auth/session not done yet).
      if (pathnameRef.current === '/login') return;
      if (isLogoutPending(d.storage(), sessionKeyOf(sessionRef.current))) return;
      const last = lastMeStartRef.current;
      if (last !== null && d.now() - last < ME_CHECK_MIN_INTERVAL_MS) return;
      void checkMe();
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [checkMe]);

  const logout = useCallback(
    () =>
      runLogout(LOGOUT_TIMEOUT_MS, sessionRef.current ? sessionKeyOf(sessionRef.current) : ANY_SESSION),
    [runLogout],
  );

  const revalidate = useCallback(async () => {
    const d = depsRef.current;
    let session: Session | null;
    try {
      session = await d.getSession();
    } catch {
      return; // R4: unknown (transient) is not "signed out": keep the current state
    }
    if (session && isLogoutPending(d.storage(), sessionKeyOf(session))) return;
    applySession(session);
  }, [applySession]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, logout, revalidate }),
    [state, logout, revalidate],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
