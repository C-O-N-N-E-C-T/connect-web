/**
 * App wiring of the auth building blocks (Supabase client, forced sign-out, API client).
 * The building blocks themselves are dependency-injected and unit-tested in isolation.
 */
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { SUPABASE_AUTH_STORAGE_KEY, supabase } from '../lib/supabase';
import { decodeJwtClaims } from '../lib/jwt';
import { withDeadline } from '../lib/deadline';
import {
  safeLocalStorage,
  safeSessionStorage,
  storageGet,
  storageRemove,
} from '../lib/storage';
import { createApiClient } from '../services/apiClient';
import { registerBrowserSession } from '../services/authSessionClient';
import { getOrCreateDeviceId } from '../services/deviceId';
import { createForcedSignOut } from './forcedSignOut';
import { isSessionEnded, markSessionEnded } from './endedSessions';
import { isLogoutPending, SIGN_OUT_TIMEOUT_MS } from './logout';
import { classifyRefresh } from './refreshResult';
import type { AuthProviderDeps } from './AuthProvider';

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;
const localSignOutListeners = new Set<AuthListener>();

/** Identity (session_id, else sub) of the session persisted by supabase-js, or null. */
function storedSessionKey(storage: Storage | null): string | null {
  const raw = storageGet(storage, SUPABASE_AUTH_STORAGE_KEY);
  if (!raw) return null;
  try {
    const token = (JSON.parse(raw) as { access_token?: unknown }).access_token;
    if (typeof token !== 'string') return raw;
    const claims = decodeJwtClaims(token);
    const key = claims.session_id ?? claims.sub;
    return typeof key === 'string' ? key : raw;
  } catch {
    return raw;
  }
}

/**
 * Every sign-out in the web app uses `scope: 'local'` (design D2): with the default `global`
 * scope a network/5xx failure keeps the local session (the user silently stays signed in) and it
 * would also revoke the user's other sessions.
 *
 * Bounded (review R1): `signOut({ scope: 'local' })` is NOT network-free. auth-js 2.119.2 first
 * loads the session, which refreshes the token if it expires within 90 s (retrying, no fetch
 * timeout), and then awaits `POST /logout` without a timeout. So it is raced against
 * SIGN_OUT_TIMEOUT_MS. If it has not finished by then, or it returned while the same session is
 * still stored (auth-js keeps a still-valid session when a proactive refresh is rejected), the
 * persisted session is removed here directly and subscribers get SIGNED_OUT. Never throws.
 */
export async function signOutLocal(): Promise<void> {
  const storage = safeLocalStorage();
  const before = storedSessionKey(storage);
  const done = supabase.auth.signOut({ scope: 'local' }).then(
    () => undefined,
    () => undefined,
  );
  await withDeadline(done, SIGN_OUT_TIMEOUT_MS);
  // Only remove what we set out to sign out: never a session another login stored meanwhile.
  if (before !== null && storedSessionKey(storage) === before) {
    storageRemove(storage, SUPABASE_AUTH_STORAGE_KEY);
    storageRemove(storage, `${SUPABASE_AUTH_STORAGE_KEY}-user`);
    localSignOutListeners.forEach((listener) => listener('SIGNED_OUT', null));
  }
}

let loginNavigator: (() => void) | null = null;

/** Registered by AuthProvider (it lives inside the router). Returns an unregister function. */
export function setLoginNavigator(navigateToLogin: () => void): () => void {
  loginNavigator = navigateToLogin;
  return () => {
    if (loginNavigator === navigateToLogin) loginNavigator = null;
  };
}

export const forceSignOut = createForcedSignOut({
  signOut: signOutLocal,
  // Without a registered navigator the route guard still redirects on SIGNED_OUT.
  navigateToLogin: () => loginNavigator?.(),
  storage: safeSessionStorage,
});

export const apiClient = createApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
  fetchImpl: (input, init) => fetch(input, init),
  // getSession() refreshes an expiring token; a transient failure there is not "signed out" (R10).
  getAccessToken: async () => {
    const result = classifyRefresh(await supabase.auth.getSession());
    if (result.ok) return { ok: true, accessToken: result.accessToken };
    if (result.definitive) return { ok: true, accessToken: null };
    return { ok: false, kind: result.kind, ...(result.status !== undefined ? { status: result.status } : {}) };
  },
  refreshAccessToken: async () => classifyRefresh(await supabase.auth.refreshSession()),
  rebindSession: (accessToken, signal) =>
    registerBrowserSession(
      { deviceId: getOrCreateDeviceId(), deviceName: navigator.userAgent.slice(0, 100) },
      accessToken,
      { signal },
    ),
  forceSignOut,
  isSessionEnded,
  isLogoutPending: () => isLogoutPending(),
});

/** GET /api/v1/auth/me response (contract in design D3 / connect-backend docs). */
export interface AuthMeResponse {
  user_id: string;
  role: string;
  device_id: string;
}

export const defaultAuthDeps: AuthProviderDeps = {
  markSessionEnded,
  getSession: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session;
  },
  onAuthStateChange: (callback) => {
    const { data } = supabase.auth.onAuthStateChange(callback);
    // Also hear sign-outs that signOutLocal completed itself (supabase-js emits nothing then).
    localSignOutListeners.add(callback);
    return () => {
      data.subscription.unsubscribe();
      localSignOutListeners.delete(callback);
    };
  },
  fetchMe: () => apiClient.request<AuthMeResponse>('/api/v1/auth/me'),
  callLogoutEndpoint: (timeoutMs) =>
    apiClient.request('/api/v1/auth/logout', { method: 'POST', timeoutMs, recovery: false }),
  signOut: signOutLocal,
  forceSignOut,
  setLoginNavigator,
  storage: safeLocalStorage,
  mode: import.meta.env.VITE_AUTH_SESSION_MODE,
  now: () => Date.now(),
};
