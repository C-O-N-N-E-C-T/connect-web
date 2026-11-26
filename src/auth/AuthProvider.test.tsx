import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  AuthProvider,
  ME_CHECK_INTERVAL_MS,
  ME_CHECK_MIN_INTERVAL_MS,
  useAuth,
  type AuthProviderDeps,
} from './AuthProvider';
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

  it('a sign-in from the signed-out state clears an old ended mark; a token refresh does not', async () => {
    const { deps, emit } = makeAuthDeps({ mode: 'mock' });
    renderApp(deps, '/login');
    await waitFor(() => expect(probe()).toBe('signedOut|-|/login'));
    act(() => emit('SIGNED_IN', sessionFor('coordinator')));
    expect(deps.clearSessionEnded).toHaveBeenCalledWith('sess-user-1');
    act(() => emit('TOKEN_REFRESHED', sessionFor('coordinator', 'user-1', 'r2')));
    act(() => emit('SIGNED_IN', sessionFor('coordinator', 'user-1', 'refocus')));
    expect(deps.clearSessionEnded).toHaveBeenCalledOnce();
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

describe('AuthProvider: Supabase unreachable at startup (R4)', () => {
  it('stays loading (not /login) and retries until the stored session can be read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { deps, emit } = makeAuthDeps({ mode: 'mock' });
      deps.getSession
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(sessionFor('coordinator'));
      renderApp(deps);

      // supabase-js reports the unreadable session as a null INITIAL_SESSION: ignored.
      act(() => emit('INITIAL_SESSION', null));
      expect(await screen.findByText('Sunucuya ulaşılamıyor. Yeniden deneniyor…')).toBeInTheDocument();
      expect(screen.queryByText('LOGIN SCREEN')).not.toBeInTheDocument();
      expect(probe()).toBe('loading|-|/dashboard');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(deps.getSession).toHaveBeenCalledTimes(2);
      expect(probe()).toBe('loading|-|/dashboard');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
      expect(deps.getSession).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a TOKEN_REFRESHED event (network back) ends the waiting state', async () => {
    const { deps, emit } = makeAuthDeps({ mode: 'mock' });
    deps.getSession.mockRejectedValue(new Error('offline'));
    renderApp(deps);
    expect(await screen.findByText('Sunucuya ulaşılamıyor. Yeniden deneniyor…')).toBeInTheDocument();

    act(() => emit('TOKEN_REFRESHED', sessionFor('coordinator')));
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
  });

  it('a transient failure during the back/forward-cache re-check keeps the user signed in', async () => {
    const { deps } = makeAuthDeps({ mode: 'mock' });
    deps.getSession.mockResolvedValueOnce(sessionFor('coordinator')).mockRejectedValueOnce(new Error('offline'));
    renderApp(deps);
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
    await act(async () => {
      await renderedAuth().revalidate();
    });
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
  });

  it('a null INITIAL_SESSION does not hide a session that getSession() returns', async () => {
    const { deps, emit } = makeAuthDeps({ mode: 'mock' });
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps);
    act(() => emit('INITIAL_SESSION', null));
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
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
    // OSP-71: web rolü olan ama /admin'e yetkisi olmayan kullanıcı artık /login'e değil, kendi ana
    // sayfasına (/dashboard) gider ve oturumu açık kalır. Yönetici içeriği hiç görünmez.
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
    expect(probe()).toBe('signedIn|coordinator|/dashboard');
    expect(screen.queryByText('ADMIN CONTENT')).not.toBeInTheDocument();
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

  it('does not check at startup on the login page either (R12)', async () => {
    const { deps } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps, '/login');
    await waitFor(() => expect(probe()).toBe('signedIn|coordinator|/login'));
    expect(deps.fetchMe).not.toHaveBeenCalled();
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

// OSP-71 (AC-19): periyodik, focus ve kurtarma / panele geçiş sonrası GET /auth/me kontrolleri.
// Sahte zamanlayıcılar `shouldAdvanceTime` OLMADAN kullanılır: zaman yalnızca testin ilerlettiği
// kadar akar, yavaş CI'da da sonuç belirleyicidir. Bu yüzden waitFor/findBy (gerçek zamanlı
// yoklama) yerine `flush()` ile bekleyen promise'ler boşaltılır. `now` da sahte saatten (Date.now)
// okunur ki throttle ile periyot aynı saati paylaşsın.
describe('AuthProvider: periodic /auth/me check (OSP-71)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Sahte zamanı ilerletir ve React güncellemelerini/promise'leri boşaltır.
  async function elapse(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  // Zaman ilerletmeden bekleyen promise zincirlerini ve 0 ms'lik zamanlayıcıları boşaltır.
  async function flush() {
    for (let i = 0; i < 5; i += 1) await elapse(0);
  }

  // Pencereye dönüşü taklit eder (window `focus`).
  function focusWindow() {
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
  }

  // Oturum açık, /dashboard'da, açılış kontrolü bitmiş bir uygulama.
  async function startSignedIn(overrides: Partial<AuthProviderDeps> = {}) {
    const helpers = makeAuthDeps({ now: () => Date.now(), ...overrides });
    helpers.deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    const view = renderApp(helpers.deps);
    await flush();
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    expect(helpers.deps.fetchMe).toHaveBeenCalledTimes(1);
    return { ...helpers, view };
  }

  it('checks every 15 s while the tab is visible', async () => {
    expect(ME_CHECK_INTERVAL_MS).toBe(15_000);
    const { deps } = await startSignedIn();

    await elapse(ME_CHECK_INTERVAL_MS - 1);
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
    await elapse(1);
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);
    await elapse(ME_CHECK_INTERVAL_MS);
    expect(deps.fetchMe).toHaveBeenCalledTimes(3);
    await elapse(ME_CHECK_INTERVAL_MS);
    expect(deps.fetchMe).toHaveBeenCalledTimes(4);
  });

  it('also checks periodically under StrictMode, without double requests', async () => {
    const { deps } = makeAuthDeps({ now: () => Date.now() });
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps, '/dashboard', true);
    await flush();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
    await elapse(ME_CHECK_INTERVAL_MS);
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);
  });

  it('applies a changed server role from a periodic check', async () => {
    const { deps } = await startSignedIn();
    expect(probe()).toBe('signedIn|coordinator|/dashboard');

    // Yönetici kullanıcının rolünü değiştirdi: bir sonraki periyodik kontrol yeni rolü uygular.
    deps.fetchMe.mockResolvedValue({
      ok: true,
      status: 200,
      data: { user_id: 'user-1', role: 'administrator', device_id: 'dev-1' },
    });
    await elapse(ME_CHECK_INTERVAL_MS);
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);
    expect(probe()).toBe('signedIn|administrator|/dashboard');
    expect(renderedAuth().role).toBe('administrator');
  });

  it('does not check while the tab is hidden and checks at once when it is visible again', async () => {
    const { deps } = await startSignedIn();

    act(() => setVisibility('hidden'));
    await elapse(60_000);
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);

    // Periyot görünür olma anından yeniden başlar.
    await elapse(ME_CHECK_INTERVAL_MS - 1);
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);
    await elapse(1);
    expect(deps.fetchMe).toHaveBeenCalledTimes(3);
  });

  it('checks on window focus, at most once per 10 s, and restarts the period', async () => {
    const { deps } = await startSignedIn();

    // Açılış kontrolünün hemen ardından: throttle (10 sn) nedeniyle istek yok.
    focusWindow();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);

    await elapse(ME_CHECK_MIN_INTERVAL_MS - 1);
    focusWindow();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);

    await elapse(1);
    focusWindow();
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);
    await flush();

    // Pencereye dönüşte focus + visibilitychange birlikte gelir: tek istek.
    focusWindow();
    act(() => setVisibility('visible'));
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);

    // Bir sonraki periyodik kontrol focus kontrolünden 15 sn sonradır.
    await elapse(ME_CHECK_INTERVAL_MS - 1);
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);
    await elapse(1);
    expect(deps.fetchMe).toHaveBeenCalledTimes(3);
  });

  it('does not check on /login (periodic, focus or visibility)', async () => {
    const { deps } = makeAuthDeps({ now: () => Date.now() });
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps, '/login');
    await flush();
    expect(probe()).toBe('signedIn|coordinator|/login');

    await elapse(60_000);
    focusWindow();
    act(() => setVisibility('visible'));
    expect(deps.fetchMe).not.toHaveBeenCalled();
  });

  it('does not check in mock mode', async () => {
    const { deps } = makeAuthDeps({ mode: 'mock', now: () => Date.now() });
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderApp(deps);
    await flush();
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    await elapse(60_000);
    focusWindow();
    expect(deps.fetchMe).not.toHaveBeenCalled();
  });

  it('stops after a sign-out', async () => {
    const { deps, emit } = await startSignedIn();
    act(() => emit('SIGNED_OUT', null));
    await elapse(60_000);
    focusWindow();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('stops after unmount', async () => {
    const { deps, view } = await startSignedIn();
    view.unmount();
    await elapse(60_000);
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not check while this session\'s logout is pending', async () => {
    const { deps } = await startSignedIn();
    deps.callLogoutEndpoint.mockReturnValue(new Promise(() => undefined)); // hiç cevap vermez
    deps.signOut.mockReturnValue(new Promise(() => undefined)); // çıkış hiç bitmez
    void renderedAuth().logout();
    await elapse(ME_CHECK_INTERVAL_MS * 2);
    focusWindow();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('never has two checks in flight', async () => {
    const { deps } = makeAuthDeps({ now: () => Date.now() });
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    deps.fetchMe.mockReturnValue(new Promise(() => undefined)); // hiç cevap vermez
    renderApp(deps);
    await flush();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);

    await elapse(ME_CHECK_INTERVAL_MS * 4);
    focusWindow();
    act(() => setVisibility('visible'));
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('keeps the session when the periodic check fails transiently (429, 503, timeout, network)', async () => {
    const { deps } = await startSignedIn();
    deps.fetchMe
      .mockResolvedValueOnce({ ok: false, error: { kind: 'RATE_LIMITED', status: 429 } } as never)
      .mockResolvedValueOnce({ ok: false, error: { kind: 'SERVER_ERROR', status: 503 } } as never)
      .mockResolvedValueOnce({ ok: false, error: { kind: 'TIMEOUT' } } as never)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await elapse(ME_CHECK_INTERVAL_MS * 4);
    expect(deps.fetchMe).toHaveBeenCalledTimes(5);
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    expect(probe()).toBe('signedIn|coordinator|/dashboard');
    expect(deps.forceSignOut).not.toHaveBeenCalled();
    expect(deps.signOut).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('AuthProvider: check after recovery / moving on to the panel (OSP-71)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function elapse(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  // Zaman ilerletmeden bekleyen promise zincirlerini ve 0 ms'lik zamanlayıcıları boşaltır.
  async function flush() {
    for (let i = 0; i < 5; i += 1) await elapse(0);
  }

  // /login'deki giriş tamamlanınca panele geçişi taklit eden basit sayfa.
  function LoginStub() {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate('/dashboard', { replace: true })}>
        GO PANEL
      </button>
    );
  }

  function renderWithRoutes(deps: AuthProviderDeps, path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider deps={deps}>
          <Probe />
          <Routes>
            <Route path="/login" element={<LoginStub />} />
            <Route path="/open" element={<p>OPEN PAGE</p>} />
            <Route
              path="/dashboard"
              element={
                <RequireRole action="viewOperations">
                  <p>PANEL CONTENT</p>
                </RequireRole>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  it('checks once when a TOKEN_REFRESHED ends the startup recovery (R4)', async () => {
    const { deps, emit } = makeAuthDeps({ now: () => Date.now() });
    deps.getSession.mockRejectedValue(new Error('offline'));
    renderWithRoutes(deps, '/dashboard');
    await flush();
    expect(screen.getByText('Sunucuya ulaşılamıyor. Yeniden deneniyor…')).toBeInTheDocument();
    expect(deps.fetchMe).not.toHaveBeenCalled();

    act(() => emit('TOKEN_REFRESHED', sessionFor('coordinator')));
    await flush();
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);

    // Aynı oturumun sonraki olağan yenilemeleri ek istek açmaz.
    act(() => emit('TOKEN_REFRESHED', sessionFor('coordinator', 'user-1', 'r2')));
    await flush();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('clears the deferred recovery check on unmount', async () => {
    const { deps, emit } = makeAuthDeps({ now: () => Date.now() });
    deps.getSession.mockRejectedValue(new Error('offline'));
    const view = renderWithRoutes(deps, '/dashboard');
    await flush();

    // TOKEN_REFRESHED ertelenmiş (0 ms) kontrolü kurar; zamanlayıcı çalışmadan unmount edilir.
    act(() => {
      emit('TOKEN_REFRESHED', sessionFor('coordinator'));
      view.unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
    await elapse(60_000);
    expect(deps.fetchMe).not.toHaveBeenCalled();
  });

  it.each([
    ['still loading at startup', () => new Promise<never>(() => undefined)],
    ['waiting for Supabase (R4)', () => Promise.reject(new Error('offline'))],
  ])(
    'a SIGNED_IN broadcast to a panel tab that is %s does not check at once (no SESSION_NOT_BOUND race)',
    async (_label, getSession) => {
      const { deps, emit } = makeAuthDeps({ now: () => Date.now() });
      deps.getSession.mockImplementation(getSession);
      renderWithRoutes(deps, '/dashboard');
      await flush();
      expect(probe()).toBe('loading|-|/dashboard');

      // Başka sekmedeki giriş: o sekmenin POST /auth/session'ı henüz bitmemiş olabilir.
      act(() => emit('SIGNED_IN', sessionFor('coordinator')));
      await flush();
      expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
      expect(deps.fetchMe).not.toHaveBeenCalled();

      // Oturum yine de doğrulanır: periyodik kontrolle.
      await elapse(ME_CHECK_INTERVAL_MS);
      expect(deps.fetchMe).toHaveBeenCalledTimes(1);
    },
  );

  it('does not check on a SIGNED_IN outside the panel either; the period covers it', async () => {
    const { deps, emit } = makeAuthDeps({ now: () => Date.now() });
    renderWithRoutes(deps, '/open');
    await flush();
    expect(probe()).toBe('signedOut|-|/open');

    act(() => emit('SIGNED_IN', sessionFor('coordinator')));
    await flush();
    expect(deps.fetchMe).not.toHaveBeenCalled();
    await elapse(ME_CHECK_INTERVAL_MS);
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('does not check during the sign-in on /login, but once when moving on to the panel', async () => {
    const { deps, emit } = makeAuthDeps({ now: () => Date.now() });
    renderWithRoutes(deps, '/login');
    await flush();
    expect(probe()).toBe('signedOut|-|/login');

    act(() => emit('SIGNED_IN', sessionFor('coordinator')));
    await flush();
    expect(deps.fetchMe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'GO PANEL' }));
    await flush();
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
  });

  // PR #5 düzeltme 4: giriş sonrası kontrol, pathname ile status'un hangi sırayla değiştiğinden
  // bağımsız olarak bir kez çalışır.
  it('checks once when the path leaves /login BEFORE the session is known', async () => {
    const { deps, emit } = makeAuthDeps({ now: () => Date.now() });
    deps.getSession.mockReturnValue(new Promise(() => undefined)); // açılış okuması bitmez
    renderWithRoutes(deps, '/login');
    await flush();
    expect(probe()).toBe('loading|-|/login');

    // Önce pathname değişir (oturum henüz bilinmiyor), sonra status signedIn olur.
    fireEvent.click(screen.getByRole('button', { name: 'GO PANEL' }));
    await flush();
    expect(probe()).toBe('loading|-|/dashboard');
    expect(deps.fetchMe).not.toHaveBeenCalled();

    act(() => emit('SIGNED_IN', sessionFor('coordinator')));
    await flush();
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);

    // Sonraki durum değişiklikleri (token yenilemesi) ikinci bir giriş sonrası kontrolü açmaz.
    act(() => emit('TOKEN_REFRESHED', sessionFor('coordinator', 'user-1', 'r2')));
    await flush();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('checks once when the session is known BEFORE the path leaves /login', async () => {
    const { deps, emit } = makeAuthDeps({ now: () => Date.now() });
    renderWithRoutes(deps, '/login');
    await flush();

    act(() => emit('SIGNED_IN', sessionFor('coordinator')));
    await flush();
    expect(deps.fetchMe).not.toHaveBeenCalled(); // R12: /login'de kontrol yok

    fireEvent.click(screen.getByRole('button', { name: 'GO PANEL' }));
    await flush();
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);

    act(() => emit('TOKEN_REFRESHED', sessionFor('coordinator', 'user-1', 'r2')));
    await flush();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('a different session signed in within 10 s is checked at once; the same session is throttled', async () => {
    const { deps, emit } = makeAuthDeps({ now: () => Date.now() });
    deps.getSession.mockResolvedValue(sessionFor('coordinator', 'user-a'));
    renderWithRoutes(deps, '/dashboard');
    await flush();
    expect(deps.fetchMe).toHaveBeenCalledTimes(1);

    // Aynı sekmede çıkış ve 10 sn dolmadan FARKLI bir oturumla giriş: throttle atlanır.
    await elapse(1_000);
    act(() => emit('SIGNED_OUT', null));
    await flush();
    expect(probe()).toBe('signedOut|-|/login');
    act(() => emit('SIGNED_IN', sessionFor('coordinator', 'user-b')));
    fireEvent.click(screen.getByRole('button', { name: 'GO PANEL' }));
    await flush();
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);

    // Karşılaştırma: AYNI oturum 10 sn içinde tekrar panele gelirse throttle uygulanır.
    await elapse(1_000);
    act(() => emit('SIGNED_OUT', null));
    await flush();
    act(() => emit('SIGNED_IN', sessionFor('coordinator', 'user-b')));
    fireEvent.click(screen.getByRole('button', { name: 'GO PANEL' }));
    await flush();
    expect(screen.getByText('PANEL CONTENT')).toBeInTheDocument();
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);
  });
});

describe('useAuth', () => {
  it('throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow();
    spy.mockRestore();
  });
});
