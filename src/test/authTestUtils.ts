import { vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import type { AuthProviderDeps } from '../auth/AuthProvider';

export function tokenFor(claims: object): string {
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

/** Minimal Supabase session for tests (only the fields the app reads). */
/**
 * Minimal Supabase session. `sessionId` defaults to one per user, so token refreshes of the same
 * sign-in share it; pass a different one for a new sign-in of the same user.
 */
export function sessionFor(
  role: string | undefined,
  userId = 'user-1',
  tokenSuffix = '',
  sessionId = `sess-${userId}`,
): Session {
  const claims: Record<string, unknown> = { sub: userId, session_id: sessionId, jti: tokenSuffix };
  if (role !== undefined) claims.user_role = role;
  return { access_token: tokenFor(claims), user: { id: userId } } as unknown as Session;
}

type Listener = (event: AuthChangeEvent, session: Session | null) => void;

/**
 * Fake AuthProvider dependencies. `signOut` behaves like supabase-js: it emits SIGNED_OUT to the
 * subscribers. The clock is manual (`setNow`).
 */
export function makeAuthDeps(overrides: Partial<AuthProviderDeps> = {}) {
  const listeners = new Set<Listener>();
  let now = 1_000_000;
  const emit = (event: AuthChangeEvent, session: Session | null) =>
    listeners.forEach((listener) => listener(event, session));

  const deps = {
    getSession: vi.fn<AuthProviderDeps['getSession']>().mockResolvedValue(null),
    onAuthStateChange: vi.fn<AuthProviderDeps['onAuthStateChange']>((callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
    fetchMe: vi.fn<AuthProviderDeps['fetchMe']>().mockResolvedValue({
      ok: true,
      status: 200,
      data: { user_id: 'user-1', role: 'coordinator', device_id: 'dev-1' },
    }),
    callLogoutEndpoint: vi.fn<AuthProviderDeps['callLogoutEndpoint']>().mockResolvedValue({ ok: true }),
    signOut: vi.fn<AuthProviderDeps['signOut']>(async () => {
      emit('SIGNED_OUT', null);
    }),
    forceSignOut: vi.fn<AuthProviderDeps['forceSignOut']>().mockResolvedValue(undefined),
    markSessionEnded: vi.fn<AuthProviderDeps['markSessionEnded']>(),
    storedSessionKey: vi.fn<AuthProviderDeps['storedSessionKey']>(() => null),
    setLoginNavigator: vi.fn<AuthProviderDeps['setLoginNavigator']>(() => () => undefined),
    storage: () => window.localStorage,
    mode: 'real' as string | undefined,
    now: () => now,
  };
  Object.assign(deps, overrides);

  return {
    deps,
    emit,
    setNow(value: number) {
      now = value;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}
