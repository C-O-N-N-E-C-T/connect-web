/**
 * The app wiring with Supabase and fetch faked: checks that every sign-out uses scope 'local',
 * that a forced sign-out never calls /auth/logout, and that logout runs without recovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNOUT_REASON_KEY } from './forcedSignOut';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
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

  it('a failed refresh (SDK error) ends in a forced sign-out with SESSION_EXPIRED', async () => {
    mocks.getSession.mockResolvedValue(sessionWith('tok-expired'));
    mocks.refreshSession.mockResolvedValue({ data: { session: null }, error: { message: 'invalid' } });
    fetchMock.mockResolvedValue(json(401, { error_code: 'UNAUTHENTICATED', message: 'x' }));

    const result = await apiClient.request('/api/v1/auth/me');

    expect(result).toMatchObject({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'SESSION_EXPIRED' } });
    expect(mocks.refreshSession).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(window.sessionStorage.getItem(SIGNOUT_REASON_KEY)).toBe('SESSION_EXPIRED');
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
