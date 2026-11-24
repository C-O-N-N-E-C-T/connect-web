/**
 * App wiring of the auth building blocks (Supabase client, forced sign-out, API client).
 * The building blocks themselves are dependency-injected and unit-tested in isolation.
 */
import { supabase } from '../lib/supabase';
import { safeLocalStorage, safeSessionStorage } from '../lib/storage';
import { createApiClient } from '../services/apiClient';
import { registerBrowserSession } from '../services/authSessionClient';
import { getOrCreateDeviceId } from '../services/deviceId';
import { createForcedSignOut } from './forcedSignOut';
import { isLogoutPending } from './logout';
import { classifyRefresh } from './refreshResult';
import type { AuthProviderDeps } from './AuthProvider';

/**
 * Every sign-out in the web app uses `scope: 'local'` (design D2): with the default `global`
 * scope a network/5xx failure keeps the local session (the user silently stays signed in) and it
 * would also revoke the user's other sessions. Never throws.
 */
export async function signOutLocal(): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // The local session is removed before the server call; nothing else to do.
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
  getAccessToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  },
  refreshAccessToken: async () => classifyRefresh(await supabase.auth.refreshSession()),
  rebindSession: (accessToken) =>
    registerBrowserSession(
      { deviceId: getOrCreateDeviceId(), deviceName: navigator.userAgent.slice(0, 100) },
      accessToken,
    ),
  forceSignOut,
  isLogoutPending: () => isLogoutPending(),
});

/** GET /api/v1/auth/me response (contract in design D3 / connect-backend docs). */
export interface AuthMeResponse {
  user_id: string;
  role: string;
  device_id: string;
}

export const defaultAuthDeps: AuthProviderDeps = {
  getSession: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session;
  },
  onAuthStateChange: (callback) => {
    const { data } = supabase.auth.onAuthStateChange(callback);
    return () => data.subscription.unsubscribe();
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
