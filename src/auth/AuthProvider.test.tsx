import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, ME_CHECK_MIN_INTERVAL_MS, useAuth, type AuthProviderDeps } from './AuthProvider';
import { RequireRole } from './RequireRole';
import { LOGOUT_PENDING_KEY } from './logout';
import { makeAuthDeps, sessionFor } from '../test/authTestUtils';

let lastAuth: ReturnType<typeof useAuth> | null = null;
const renderedAuth = () => lastAuth!;

function Probe() {
  const auth = useAuth();
  lastAuth = auth;
  const { status, role } = auth;
  const location = useLocation();
  return (
    <p data-testid="probe">
      {status}|{role ?? '-'}|{location.pathname}
    </p>
  );
}

function renderApp(deps: AuthProviderDeps, path = '/dashboard', strict = false) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider deps={deps}>
        <Probe />
        <Routes>
          <Route path="/login" element={<p>LOGIN SCREEN</p>} />
          <Route
            path="/dashboard"
            element={
              <RequireRole allow={['coordinator', 'administrator']}>
                <p>PANEL CONTENT</p>
              </RequireRole>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireRole allow={['administrator']}>
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

const probe = () => screen.getByTestId('probe').textContent;

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('AuthProvider: session bootstrap', () => {
  it('restores the session and role after a page reload (AC1)', async () => {
    const { deps } = makeAuthDeps({ mode: 'mock' });
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps);

    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
    expect(probe()).toBe('signedIn|coordinator|/dashboard');
  });

  it('is signed out without a stored session', async () => {
    const { deps } = makeAuthDeps();
    renderApp(deps);
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(probe()).toBe('signedOut|-|/login');
    expect(deps.fetchMe).not.toHaveBeenCalled();
  });

  it('follows auth events (sign-in in this tab, sign-out from another tab)', async () => {
    const { deps, emit } = makeAuthDeps({ mode: 'mock' });
    renderApp(deps, '/login');
    await waitFor(() => expect(probe()).toBe('signedOut|-|/login'));

    act(() => emit('SIGNED_IN', sessionFor('administrator')));
    expect(probe()).toBe('signedIn|administrator|/login');

    act(() => emit('SIGNED_OUT', null));
    expect(probe()).toBe('signedOut|-|/login');
  });

  it('registers a login navigator that navigates to /login', async () => {
    const { deps } = makeAuthDeps({ mode: 'mock' });
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps);
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();

    const navigateToLogin = deps.setLoginNavigator.mock.calls.at(-1)![0];
    act(() => navigateToLogin());
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
  });
});

describe('AuthProvider: GET /auth/me', () => {
  it('calls /auth/me once at startup when a session exists', async () => {
    const { deps } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps);
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledOnce());
  });

  it('is skipped in mock mode', async () => {
    const { deps } = makeAuthDeps({ mode: 'mock' });
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps);
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
    setVisibility('visible');
    expect(deps.fetchMe).not.toHaveBeenCalled();
  });

  it('lets the server role win over the JWT claim, also after a token refresh', async () => {
    const { deps, emit } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    deps.fetchMe.mockResolvedValue({
      ok: true,
      status: 200,
      data: { user_id: 'user-1', role: 'administrator', device_id: 'd' },
    });
    renderApp(deps);
    await waitFor(() => expect(probe()).toBe('signedIn|administrator|/dashboard'));

    // TOKEN_REFRESHED / SIGNED_IN (tab refocus) carry the stale JWT claim: keep the server role.
    act(() => emit('TOKEN_REFRESHED', sessionFor('coordinator', 'user-1', 'r2')));
    act(() => emit('SIGNED_IN', sessionFor('coordinator', 'user-1', 'r3')));
    expect(probe()).toBe('signedIn|administrator|/dashboard');
  });

  it('downgrades access when the server role is lower than the JWT claim', async () => {
    const { deps } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    deps.fetchMe.mockResolvedValue({
      ok: true,
      status: 200,
      data: { user_id: 'user-1', role: 'coordinator', device_id: 'd' },
    });
    renderApp(deps, '/admin');
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('forces sign-out with ROLE_NOT_ALLOWED for a non-web server role', async () => {
    const session = sessionFor('coordinator');
    const { deps } = makeAuthDeps();
    deps.getSession.mockResolvedValue(session);
    deps.fetchMe.mockResolvedValue({
      ok: true,
      status: 200,
      data: { user_id: 'user-1', role: 'rescuer', device_id: 'd' },
    });
    renderApp(deps);
    await waitFor(() => expect(deps.forceSignOut).toHaveBeenCalledWith('ROLE_NOT_ALLOWED', session.access_token));
  });

  it("ignores a stale /auth/me answer for another user (no ROLE_NOT_ALLOWED sign-out of B, R2)", async () => {
    let answer!: (value: Awaited<ReturnType<AuthProviderDeps['fetchMe']>>) => void;
    const { deps, emit } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator', 'user-a'));
    deps.fetchMe.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderApp(deps);
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledOnce());

    // A signs out, B signs in, then A's answer (A was demoted to rescuer) arrives.
    act(() => emit('SIGNED_OUT', null));
    act(() => emit('SIGNED_IN', sessionFor('coordinator', 'user-b')));
    await act(async () =>
      answer({ ok: true, status: 200, data: { user_id: 'user-a', role: 'rescuer', device_id: 'd' } }),
    );

    expect(deps.forceSignOut).not.toHaveBeenCalled();
    expect(probe()).toBe('signedIn|coordinator|/login'); // B is still signed in
  });

  it('ignores an /auth/me answer that belongs to an earlier sign-in of the same user (R2)', async () => {
    let answer!: (value: Awaited<ReturnType<AuthProviderDeps['fetchMe']>>) => void;
    const { deps, emit } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator', 'user-1', '', 'sess-old'));
    deps.fetchMe.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderApp(deps);
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledOnce());

    act(() => emit('SIGNED_IN', sessionFor('coordinator', 'user-1', '', 'sess-new')));
    await act(async () =>
      answer({ ok: true, status: 200, data: { user_id: 'user-1', role: 'rescuer', device_id: 'd' } }),
    );
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('keeps the JWT role when /auth/me fails with a non-session error', async () => {
    const { deps } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    deps.fetchMe.mockResolvedValue({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    renderApp(deps);
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalled());
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('swallows an unexpected exception from /auth/me (no unhandled rejection, R16)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    deps.fetchMe.mockRejectedValue(new Error('boom'));
    renderApp(deps);
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalled());
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    warn.mockRestore();
  });

  it('re-checks when the tab becomes visible, at most once per 10 s', async () => {
    const { deps, advance } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps);
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledTimes(1));

    advance(ME_CHECK_MIN_INTERVAL_MS - 1);
    act(() => setVisibility('visible'));
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);

    advance(1);
    act(() => setVisibility('hidden'));
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
    act(() => setVisibility('visible'));
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledTimes(2));
  });

  it('de-duplicates an in-flight check', async () => {
    const { deps, advance } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    deps.fetchMe.mockReturnValue(new Promise(() => undefined)); // never answers
    renderApp(deps);
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledTimes(1));

    advance(60_000);
    act(() => setVisibility('visible'));
    act(() => setVisibility('visible'));
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('does not check on the login page (a sign-in may be in progress)', async () => {
    const { deps, emit, advance } = makeAuthDeps();
    renderApp(deps, '/login');
    await waitFor(() => expect(probe()).toBe('signedOut|-|/login'));

    act(() => emit('SIGNED_IN', sessionFor('coordinator')));
    advance(60_000);
    act(() => setVisibility('visible'));
    expect(deps.fetchMe).not.toHaveBeenCalled();
  });
});

describe('AuthProvider: interrupted logout at startup (D2)', () => {
  it('finishes the logout before rendering any protected UI', async () => {
    window.localStorage.setItem(LOGOUT_PENDING_KEY, '1');
    let finishRequest!: () => void;
    const { deps, emit } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    deps.callLogoutEndpoint.mockReturnValue(new Promise<void>((resolve) => (finishRequest = resolve)));
    renderApp(deps);

    // The SDK still has the session and announces it: it must not become protected UI.
    act(() => emit('INITIAL_SESSION', sessionFor('coordinator')));
    expect(screen.queryByText('PANEL CONTENT')).not.toBeInTheDocument();
    expect(screen.getByText('Yükleniyor…')).toBeInTheDocument();
    expect(probe()).toBe('loading|-|/dashboard');
    expect(deps.callLogoutEndpoint).toHaveBeenCalledWith(3000);
    expect(deps.signOut).not.toHaveBeenCalled();

    await act(async () => finishRequest());

    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(deps.fetchMe).not.toHaveBeenCalled();
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('completes the logout even when the backend call fails', async () => {
    window.localStorage.setItem(LOGOUT_PENDING_KEY, '1');
    const { deps } = makeAuthDeps();
    deps.callLogoutEndpoint.mockRejectedValue(new Error('network'));
    renderApp(deps);
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('ends on /login within the bound even if signOut hangs (R1)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem(LOGOUT_PENDING_KEY, '1');
      const { deps } = makeAuthDeps();
      deps.signOut.mockReturnValue(new Promise(() => undefined));
      renderApp(deps);
      expect(screen.getByText('Yükleniyor…')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_600);
      });
      expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
      expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the backend call in mock mode but still signs out', async () => {
    window.localStorage.setItem(LOGOUT_PENDING_KEY, '1');
    const { deps } = makeAuthDeps({ mode: 'mock' });
    renderApp(deps);
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.callLogoutEndpoint).not.toHaveBeenCalled();
    expect(deps.signOut).toHaveBeenCalledOnce();
  });
});

describe('AuthProvider: a new sign-in ends an old pending logout (R6)', () => {
  it('applies a new sign-in while the old session\'s logout is still pending, and clears the flag', async () => {
    let finishSignOut!: () => void;
    const { deps, emit } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator', 'user-a'));
    // Slow local sign-out of A: SIGNED_OUT already fired, the promise has not resolved yet.
    deps.signOut.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          emit('SIGNED_OUT', null);
          finishSignOut = resolve;
        }),
    );
    renderApp(deps);
    await waitFor(() => expect(probe()).toBe('signedIn|coordinator|/dashboard'));

    let logout!: Promise<void>;
    act(() => {
      logout = renderedAuth().logout();
    });
    await waitFor(() => expect(probe()).toBe('signedOut|-|/login'));
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBe('sess-user-a');

    // The next coordinator signs in on the same PC.
    act(() => emit('SIGNED_IN', sessionFor('administrator', 'user-b')));
    expect(probe()).toBe('signedIn|administrator|/login');
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();

    // A's logout finishes late: B stays signed in.
    await act(async () => {
      finishSignOut();
      await logout;
    });
    expect(probe()).toBe('signedIn|administrator|/login');
  });

  it('does not log out a newer stored session at startup when the flag belongs to an older one', async () => {
    window.localStorage.setItem(LOGOUT_PENDING_KEY, 'sess-user-a');
    const { deps } = makeAuthDeps({ mode: 'mock' });
    deps.storedSessionKey.mockReturnValue('sess-user-b');
    deps.getSession.mockResolvedValue(sessionFor('coordinator', 'user-b'));
    renderApp(deps);
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
    expect(deps.signOut).not.toHaveBeenCalled();
    expect(deps.callLogoutEndpoint).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('still finishes the logout at startup when the flag matches the stored session', async () => {
    window.localStorage.setItem(LOGOUT_PENDING_KEY, 'sess-user-a');
    const { deps } = makeAuthDeps();
    deps.storedSessionKey.mockReturnValue('sess-user-a');
    renderApp(deps);
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(deps.markSessionEnded).toHaveBeenCalledWith('sess-user-a');
  });

  it('ignores the session being logged out (same session) while the flag is set', async () => {
    window.localStorage.setItem(LOGOUT_PENDING_KEY, 'sess-user-a');
    const { deps, emit } = makeAuthDeps();
    deps.storedSessionKey.mockReturnValue('sess-user-a');
    deps.callLogoutEndpoint.mockReturnValue(new Promise(() => undefined));
    renderApp(deps);
    act(() => emit('SIGNED_IN', sessionFor('coordinator', 'user-a', 'refocus')));
    expect(probe()).toBe('loading|-|/dashboard');
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBe('sess-user-a');
  });
});

describe('AuthProvider: StrictMode (double effects in development)', () => {
  it('calls /auth/me only once at startup', async () => {
    const { deps } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps, '/dashboard', true);
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledOnce());
  });

  it('finishes an interrupted logout once', async () => {
    window.localStorage.setItem(LOGOUT_PENDING_KEY, '1');
    const { deps } = makeAuthDeps();
    renderApp(deps, '/dashboard', true);
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.callLogoutEndpoint).toHaveBeenCalledOnce();
    expect(deps.signOut).toHaveBeenCalledOnce();
  });
});

describe('AuthProvider with blocked storage (R11)', () => {
  it('restores the session without a usable storage', async () => {
    const { deps } = makeAuthDeps({ storage: () => null });
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps);
    await waitFor(() => expect(probe()).toBe('signedIn|coordinator|/dashboard'));
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
  });
});

describe('useAuth', () => {
  it('throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow();
    spy.mockRestore();
  });
});
