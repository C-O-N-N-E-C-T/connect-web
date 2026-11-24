/**
 * The app wiring with Supabase and fetch faked: checks that every sign-out uses scope 'local',
 * that a forced sign-out never calls /auth/logout, and that logout runs without recovery.
 */
import { resetEndedSessions } from './endedSessions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { SIGNOUT_REASON_KEY } from './forcedSignOut';
import { tokenFor } from '../test/authTestUtils';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-test-auth-token',
  supabase: {
    auth: {
      signOut: mocks.signOut,
      getSession: mocks.getSession,
      refreshSession: mocks.refreshSession,
      onAuthStateChange: mocks.onAuthStateChange,
    },
  },
}));

const { apiClient, defaultAuthDeps, forceSignOut, setLoginNavigator, signOutLocal } = await import(
  './authRuntime'
);

const fetchMock = vi.fn<typeof fetch>();

function sessionWith(token: string) {
  return { data: { session: { access_token: token } }, error: null };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function urlsCalled(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

beforeEach(() => {
  resetEndedSessions();
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: mocks.unsubscribe } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authRuntime', () => {
  it('signOutLocal uses scope local and never throws', async () => {
    mocks.signOut.mockRejectedValueOnce(new Error('boom'));
    await expect(signOutLocal()).resolves.toBeUndefined();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('forceSignOut signs out locally, stores the reason, navigates and never calls /auth/logout', async () => {
    const navigate = vi.fn();
    const unregister = setLoginNavigator(navigate);
    await forceSignOut('DEVICE_REVOKED', 'tok-force');
    unregister();

    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(window.sessionStorage.getItem(SIGNOUT_REASON_KEY)).toBe('DEVICE_REVOKED');
    expect(navigate).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 403 DEVICE_REVOKED from the API signs out locally without calling /auth/logout', async () => {
    mocks.getSession.mockResolvedValue(sessionWith('tok-revoked'));
    fetchMock.mockResolvedValue(json(403, { error_code: 'DEVICE_REVOKED', message: 'x' }));

    const result = await defaultAuthDeps.fetchMe();

    expect(result).toMatchObject({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'DEVICE_REVOKED' } });
    expect(urlsCalled()).toEqual(['http://localhost:3000/api/v1/auth/me']);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('logout endpoint: one POST with the bearer token, no refresh on 401, no sign-out', async () => {
    mocks.getSession.mockResolvedValue(sessionWith('tok-logout'));
    fetchMock.mockResolvedValue(json(401, { error_code: 'UNAUTHENTICATED', message: 'x' }));

    await defaultAuthDeps.callLogoutEndpoint(5000);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/auth/logout');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-logout');
    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('a transient failure while reading the session is NETWORK_ERROR, not UNAUTHENTICATED (R10)', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    });
    const result = await apiClient.request('/api/v1/auth/me');
    expect(result).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('a network failure during refresh keeps the user signed in (D4a)', async () => {
    mocks.getSession.mockResolvedValue(sessionWith('tok-offline'));
    mocks.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    });
    fetchMock.mockResolvedValue(json(401, { error_code: 'UNAUTHENTICATED', message: 'x' }));

    const result = await apiClient.request('/api/v1/auth/me');

    expect(result).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SIGNOUT_REASON_KEY)).toBeNull();
  });

  it('a rejected refresh token (SDK 4xx) ends in a forced sign-out with SESSION_EXPIRED', async () => {
    mocks.getSession.mockResolvedValue(sessionWith('tok-expired'));
    mocks.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found'),
    });
    fetchMock.mockResolvedValue(json(401, { error_code: 'UNAUTHENTICATED', message: 'x' }));

    const result = await apiClient.request('/api/v1/auth/me');

    expect(result).toMatchObject({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'SESSION_EXPIRED' } });
    expect(mocks.refreshSession).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(window.sessionStorage.getItem(SIGNOUT_REASON_KEY)).toBe('SESSION_EXPIRED');
  });

  it('a late 401 after a deliberate logout shows no SESSION_EXPIRED banner (R2)', async () => {
    const token = tokenFor({ sub: 'u', session_id: 'sess-logged-out' });
    mocks.getSession.mockResolvedValueOnce(sessionWith(token)); // when the request was sent
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null }); // after logout
    fetchMock.mockImplementation(async () => {
      defaultAuthDeps.markSessionEnded('sess-logged-out'); // logout pressed meanwhile
      return json(401, { error_code: 'UNAUTHENTICATED', message: 'x' });
    });

    const result = await apiClient.request('/api/v1/auth/me');

    expect(result).toEqual({ ok: false, error: { kind: 'SESSION_CHANGED' } });
    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SIGNOUT_REASON_KEY)).toBeNull();
  });

  it('wires the auth subscription and its unsubscribe', () => {
    const callback = vi.fn();
    const unsubscribe = defaultAuthDeps.onAuthStateChange(callback);
    expect(mocks.onAuthStateChange).toHaveBeenCalledWith(callback);
    unsubscribe();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it('defaultAuthDeps.signOut is the local sign-out', async () => {
    await defaultAuthDeps.signOut();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

});

describe('signOutLocal is bounded (R1)', () => {
  const KEY = 'sb-test-auth-token';
  const stored = (sessionId: string) =>
    JSON.stringify({ access_token: tokenFor({ sub: 'u', session_id: sessionId }), refresh_token: 'r' });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes the persisted session itself and emits SIGNED_OUT when signOut hangs', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(KEY, stored('s-1'));
    window.localStorage.setItem(`${KEY}-user`, '{}');
    mocks.signOut.mockReturnValue(new Promise(() => undefined)); // e.g. refresh hangs offline
    const callback = vi.fn();
    const unsubscribe = defaultAuthDeps.onAuthStateChange(callback);

    let finished = false;
    const done = signOutLocal().then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(finished).toBe(false);
    expect(window.localStorage.getItem(KEY)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(window.localStorage.getItem(`${KEY}-user`)).toBeNull();
    expect(callback).toHaveBeenCalledWith('SIGNED_OUT', null);
    unsubscribe();
  });

  it('removes the session when signOut returned but left the same session stored', async () => {
    window.localStorage.setItem(KEY, stored('s-1'));
    mocks.signOut.mockResolvedValue({ error: { name: 'AuthApiError', status: 400 } });
    await signOutLocal();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('does not touch storage when signOut removed the session itself', async () => {
    window.localStorage.setItem(KEY, stored('s-1'));
    mocks.signOut.mockImplementation(async () => {
      window.localStorage.removeItem(KEY);
      return { error: null };
    });
    const callback = vi.fn();
    const unsubscribe = defaultAuthDeps.onAuthStateChange(callback);
    await signOutLocal();
    expect(callback).not.toHaveBeenCalled(); // supabase-js emits SIGNED_OUT itself
    unsubscribe();
  });

  it('never removes a session another login stored meanwhile', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(KEY, stored('s-1'));
    mocks.signOut.mockImplementation(() => {
      window.localStorage.setItem(KEY, stored('s-2')); // a new sign-in replaced the session
      return new Promise(() => undefined);
    });
    const done = signOutLocal();
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(window.localStorage.getItem(KEY)).toBe(stored('s-2'));
  });
});
