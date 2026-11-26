/**
 * OSP-72 QA (R21): additional cross-tab edge cases on top of crossTab.test.tsx.
 */
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth, type AuthProviderDeps } from './AuthProvider';
import { RequireRole } from './RequireRole';
import { LOGOUT_PENDING_KEY } from './logout';
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

function renderApp(deps: AuthProviderDeps, strict = false) {
  const tree = (
    <MemoryRouter initialEntries={['/admin']}>
      <AuthProvider deps={deps}>
        <Probe />
        <Routes>
          <Route path="/login" element={<p>LOGIN SCREEN</p>} />
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
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const probe = () => screen.getByTestId('probe').textContent ?? '';
const stored = (session: Session) => JSON.stringify({ access_token: session.access_token });
const me = (role: string, userId = 'user-1'): MeResult => ({
  ok: true,
  status: 200,
  data: { user_id: userId, role, device_id: 'dev-1' },
});
const fireStorage = (init: StorageEventInit) =>
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', init));
  });

async function signedInAdmin(strict = false) {
  const helpers = makeAuthDeps();
  const session = sessionFor('administrator', 'user-1', '', 'sess-a');
  helpers.deps.getSession.mockResolvedValue(session);
  helpers.deps.fetchMe.mockResolvedValue(me('administrator'));
  renderApp(helpers.deps, strict);
  expect(await screen.findByText('ADMIN CONTENT')).toBeInTheDocument();
  return { ...helpers, session };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('cross-tab sign-out, QA edge cases (R21)', () => {
  it('ignores an event for the same key from sessionStorage (other storage area)', async () => {
    const { deps } = await signedInAdmin();
    // jsdom only accepts its own Storage in the init dict; the test setup uses a MemoryStorage.
    const event = new StorageEvent('storage', { key: TEST_AUTH_STORAGE_KEY, newValue: null });
    Object.defineProperty(event, 'storageArea', { value: window.sessionStorage });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(screen.getByText('ADMIN CONTENT')).toBeInTheDocument();
    expect(deps.markSessionEnded).not.toHaveBeenCalled();
  });

  it('a new session of the SAME user in another tab is still a session change (role re-confirmed)', async () => {
    const { deps, session } = await signedInAdmin();
    const next = sessionFor('administrator', 'user-1', '', 'sess-b');
    deps.getSession.mockResolvedValue(next);
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(session), newValue: stored(next) });
    expect(deps.markSessionEnded).toHaveBeenCalledWith('sess-a');
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('ADMIN CONTENT')).toBeInTheDocument();
    expect(deps.callLogoutEndpoint).not.toHaveBeenCalled();
    expect(deps.signOut).not.toHaveBeenCalled();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('a transient getSession failure after a session change ends on /login, never stuck loading', async () => {
    const { deps, session } = await signedInAdmin();
    deps.getSession.mockRejectedValue(new Error('offline'));
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(session), newValue: '{"access_token":"garbage"}' });
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.signOut).not.toHaveBeenCalled();
  });

  it('under StrictMode only one listener is active (one sign-out per event)', async () => {
    const { deps, session } = await signedInAdmin(true);
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(session), newValue: null });
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.markSessionEnded).toHaveBeenCalledTimes(1);
    expect(deps.callLogoutEndpoint).not.toHaveBeenCalled();
  });

  it('a second removal event while the first change is resolving does not double-apply', async () => {
    const { deps, session } = await signedInAdmin();
    const next = sessionFor('administrator', 'user-2', '', 'sess-b');
    let resolve!: (s: Session | null) => void;
    deps.getSession.mockReturnValue(new Promise((r) => (resolve = r)));
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(session), newValue: stored(next) });
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(next), newValue: null });
    await act(async () => resolve(null));
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.markSessionEnded).toHaveBeenCalledTimes(1);
  });

  // Fixed in OSP-72 (QA, was a bug): after a session change, if the NEW session's logout is already pending (the other
  // tab signed in and immediately signed out again before this tab's getSession() answered),
  // endSessionLocally returns without applying anything. sessionRef is null, so the later removal
  // event is ignored too ("already signed out") and this tab stays on "loading" forever.
  // AuthProvider.tsx endSessionLocally: `if (session && isLogoutPending(...)) return;` should
  // `applySession(null)` instead of returning.
  it('does not get stuck on loading when the new session is already being logged out', async () => {
    const { deps, session } = await signedInAdmin();
    const next = sessionFor('administrator', 'user-2', '', 'sess-b');
    let resolve!: (s: Session | null) => void;
    deps.getSession.mockReturnValue(new Promise((r) => (resolve = r)));
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(session), newValue: stored(next) });
    window.localStorage.setItem(LOGOUT_PENDING_KEY, 'sess-b');
    await act(async () => resolve(next));
    fireStorage({ key: TEST_AUTH_STORAGE_KEY, oldValue: stored(next), newValue: null });
    await waitFor(() => expect(probe()).toContain('signedOut'), { timeout: 500 });
  });
});
