/**
 * App wiring of the auth building blocks (Supabase client, forced sign-out, API client).
 * The building blocks themselves are dependency-injected and unit-tested in isolation.
 */
import { supabase } from '../lib/supabase';
import { createApiClient } from '../services/apiClient';
import { registerBrowserSession } from '../services/authSessionClient';
import { getOrCreateDeviceId } from '../services/deviceId';
import { createForcedSignOut } from './forcedSignOut';

export const LOGOUT_PENDING_KEY = 'connect.logout_pending';

export function isLogoutPending(storage: Storage = window.localStorage): boolean {
  try {
    return storage.getItem(LOGOUT_PENDING_KEY) !== null;
  } catch {
    return false;
  }
}

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
  storage: () => window.sessionStorage,
});

export const apiClient = createApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
  fetchImpl: (input, init) => fetch(input, init),
  getAccessToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  },
  refreshAccessToken: async () => {
    const { data, error } = await supabase.auth.refreshSession();
    if (error) return null;
    return data.session?.access_token ?? null;
  },
  rebindSession: (accessToken) =>
    registerBrowserSession(
      { deviceId: getOrCreateDeviceId(), deviceName: navigator.userAgent.slice(0, 100) },
      accessToken,
    ),
  forceSignOut,
  isLogoutPending: () => isLogoutPending(),
});
