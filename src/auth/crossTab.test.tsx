/**
 * OSP-72 (R21): a session removed or replaced in another tab (StorageEvent on the supabase-js
 * auth key) ends this tab's session locally, without any backend logout or supabase-js signOut.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth, type AuthProviderDeps } from './AuthProvider';
import { RequireRole } from './RequireRole';
import { makeAuthDeps, sessionFor, TEST_AUTH_STORAGE_KEY } from '../test/authTestUtils';
import type { Session } from '@supabase/supabase-js';

type MeResult = Awaited<ReturnType<AuthProviderDeps['fetchMe']>>;

function Probe() {
  const { status, roleConfirmed } = useAuth();
  const location = useLocation();
  return (
    <p data-testid="probe">
      {status}|{location.pathname}|{roleConfirmed ? 'confirmed' : 'unconfirmed'}
    </p>
  );
}

function renderApp(deps: AuthProviderDeps, path = '/admin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider deps={deps}>
        <Probe />
        <Routes>
          <Route path="/login" element={<p>LOGIN SCREEN</p>} />
          <Route
            path="/dashboard"
            element={
              <RequireRole action="viewOperations">
                <p>PANEL CONTENT</p>
              </RequireRole>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireRole action="admin" requireConfirmedRole>
                <p>ADMIN CONTENT</p>
              </RequireRole>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const probe = () => screen.getByTestId('probe').textContent ?? '';
const stored = (session: Session) => JSON.stringify({ access_token: session.access_token });
const me = (role: string, userId = 'user-1'): MeResult => ({
  ok: true,
  status: 200,
  data: { user_id: userId, role, device_id: 'dev-1' },
});

function fireStorage(init: StorageEventInit) {
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', init));
  });
}

async function signedInAdmin(overrides: Partial<AuthProviderDeps> = {}) {
  const helpers = makeAuthDeps(overrides);
  const session = sessionFor('administrator', 'user-1', '', 'sess-a');
  helpers.deps.getSession.mockResolvedValue(session);
  helpers.deps.fetchMe.mockResolvedValue(me('administrator'));
  const view = renderApp(helpers.deps);
  expect(await screen.findByText('ADMIN CONTENT')).toBeInTheDocument();
  return { ...helpers, session, view };
}

function expectNoRemoteSignOut(deps: ReturnType<typeof makeAuthDeps>['deps']) {
  expect(deps.callLogoutEndpoint).not.toHaveBeenCalled();
  expect(deps.signOut).not.toHaveBeenCalled();
  expect(deps.forceSignOut).not.toHaveBeenCalled();
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('cross-tab sign-out (R21)', () => {
  it('signs out locally and shows /login when another tab removes the session', async () => {
    const { deps, session } = await signedInAdmin();
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(session), newValue: null });

    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(screen.queryByText('ADMIN CONTENT')).not.toBeInTheDocument();
    expect(probe()).toBe('signedOut|/login|unconfirmed');
    // Late responses of the old session are SESSION_CHANGED, never a sign-out (R2).
    expect(deps.markSessionEnded).toHaveBeenCalledWith('sess-a');
    expectNoRemoteSignOut(deps);
  });

  it('also signs out when another tab clears the whole storage', async () => {
    const { deps } = await signedInAdmin();
    fireStorage({ key: null });
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expectNoRemoteSignOut(deps);
  });

  it('ignores events for other keys', async () => {
    const { deps } = await signedInAdmin();
    fireStorage({ key: 'connect.logout_pending', newValue: 'sess-a' });
    fireStorage({ key: `${TEST_AUTH_STORAGE_KEY}-user`, newValue: null });
    fireStorage({ key: 'something-else', newValue: null });
    expect(screen.getByText('ADMIN CONTENT')).toBeInTheDocument();
    expect(probe()).toBe('signedIn|/admin|confirmed');
    expect(deps.markSessionEnded).not.toHaveBeenCalled();
  });

  it('ignores a token refresh of the same session', async () => {
    const { deps, session } = await signedInAdmin();
    const refreshed = sessionFor('administrator', 'user-1', 'r2', 'sess-a');
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(session), newValue: stored(refreshed) });
    expect(screen.getByText('ADMIN CONTENT')).toBeInTheDocument();
    expect(probe()).toBe('signedIn|/admin|confirmed');
    expect(deps.markSessionEnded).not.toHaveBeenCalled();
    expect(deps.getSession).toHaveBeenCalledOnce();
  });

  it('treats a different stored session as a session change: old content hidden, new role re-confirmed', async () => {
    const { deps, session } = await signedInAdmin();
    const other = sessionFor('administrator', 'user-2', '', 'sess-b');
    let answer!: (value: MeResult) => void;
    deps.fetchMe.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    deps.getSession.mockResolvedValue(other);

    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(session), newValue: stored(other) });
    expect(screen.queryByText('ADMIN CONTENT')).not.toBeInTheDocument();
    expect(deps.markSessionEnded).toHaveBeenCalledWith('sess-a');

    await waitFor(() => expect(probe()).toBe('signedIn|/admin|unconfirmed'));
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('ADMIN CONTENT')).not.toBeInTheDocument();
    await act(async () => answer(me('administrator', 'user-2')));
    expect(await screen.findByText('ADMIN CONTENT')).toBeInTheDocument();
    expectNoRemoteSignOut(deps);
  });

  it('does nothing while already signed out', async () => {
    const { deps } = makeAuthDeps();
    renderApp(deps, '/login');
    await waitFor(() => expect(probe()).toBe('signedOut|/login|unconfirmed'));
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, newValue: null });
    expect(deps.markSessionEnded).not.toHaveBeenCalled();
    expect(deps.getSession).toHaveBeenCalledOnce();
  });

  it('works in mock mode too (no backend involved)', async () => {
    const { deps } = makeAuthDeps({ mode: 'mock' });
    const session = sessionFor('coordinator', 'user-1', '', 'sess-a');
    deps.getSession.mockResolvedValue(session);
    renderApp(deps, '/dashboard');
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(session), newValue: null });
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expectNoRemoteSignOut(deps);
  });

  it('removes the listener on unmount', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    try {
      const { deps, view } = await signedInAdmin();
      view.unmount();
      expect(remove).toHaveBeenCalledWith('storage', expect.any(Function));
      fireStorage({ key: TEST_AUTH_STORAGE_KEY, newValue: null });
      expect(deps.markSessionEnded).not.toHaveBeenCalled();
    } finally {
      remove.mockRestore();
    }
  });

  it('is off without an auth storage key', async () => {
    const { deps } = await signedInAdmin({ authStorageKey: undefined });
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, newValue: null });
    expect(screen.getByText('ADMIN CONTENT')).toBeInTheDocument();
    expect(deps.markSessionEnded).not.toHaveBeenCalled();
  });
});

describe('/auth/me check without a local session (R21)', () => {
  it('signs out locally when a focus check finds no stored session (UNAUTHENTICATED)', async () => {
    const { deps, advance } = await signedInAdmin();
    deps.fetchMe.mockResolvedValue({ ok: false, error: { kind: 'UNAUTHENTICATED' } });
    advance(60_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.markSessionEnded).toHaveBeenCalledWith('sess-a');
    expectNoRemoteSignOut(deps);
  });

  it('keeps the session for other check failures', async () => {
    const { deps, advance } = await signedInAdmin();
    deps.fetchMe.mockResolvedValue({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    advance(60_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledTimes(2));
    expect(probe()).toContain('signedIn|/admin');
    expect(deps.markSessionEnded).not.toHaveBeenCalled();
  });
});
