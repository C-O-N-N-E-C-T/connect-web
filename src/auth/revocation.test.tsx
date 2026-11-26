/**
 * AC-19 demo scenario end to end (design D3): the coordinator has the panel open, an admin revokes
 * the device, the coordinator returns to the tab -> GET /auth/me -> 403 DEVICE_REVOKED -> signed
 * out, /login shows the reason. Real API client, forced sign-out, provider, guard and login page;
 * only Supabase and fetch are faked.
 */
import { resetEndedSessions } from './endedSessions';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, ME_CHECK_INTERVAL_MS } from './AuthProvider';
import { RequireRole } from './RequireRole';
import { createForcedSignOut } from './forcedSignOut';
import { createApiClient, DEFAULT_TIMEOUT_MS } from '../services/apiClient';
import { LoginPage } from '../pages/LoginPage';
import { AppLayout } from '../components/AppLayout';
import { makeAuthDeps, sessionFor } from '../test/authTestUtils';

vi.mock('../lib/supabase', () => ({
  supabase: { auth: { signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setVisible() {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  resetEndedSessions();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// StrictMode like `npm run dev` (main.tsx): effects and state initializers run twice.
describe.each([
  ['DEVICE_REVOKED', 'Bu cihazın erişimi iptal edildi.'],
  ['ACCOUNT_DISABLED', 'Hesabınız devre dışı bırakıldı. Yöneticinize başvurun.'],
])('admin revokes the session (%s)', (code, message) => {
  it('signs the user out on the next /auth/me and shows the reason on /login', async () => {
    const session = sessionFor('coordinator');
    const { deps, advance } = makeAuthDeps();
    deps.getSession.mockResolvedValue(session);

    let navigateToLogin: (() => void) | null = null;
    deps.setLoginNavigator.mockImplementation((fn) => {
      navigateToLogin = fn;
      return () => undefined;
    });
    const forceSignOut = createForcedSignOut({
      signOut: deps.signOut,
      navigateToLogin: () => navigateToLogin?.(),
      storage: () => window.sessionStorage,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { user_id: 'user-1', role: 'coordinator', device_id: 'd' }))
      .mockResolvedValueOnce(json(403, { error_code: code, message: 'revoked' }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetchImpl,
      getAccessToken: async () => ({ ok: true, accessToken: session.access_token }),
      refreshAccessToken: vi.fn(),
      rebindSession: vi.fn(),
      forceSignOut,
      isLogoutPending: () => false,
    });
    deps.forceSignOut.mockImplementation(forceSignOut);
    deps.fetchMe.mockImplementation(() => client.request('/api/v1/auth/me'));

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/dashboard']}>
          <AuthProvider deps={deps}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/dashboard"
                element={
                  <RequireRole action="viewOperations">
                    <AppLayout title="Koordinasyon Paneli" />
                  </RequireRole>
                }
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>,
    );

    expect(await screen.findByText('Koordinasyon Paneli')).toBeInTheDocument();
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    advance(30_000);
    act(() => setVisible());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText('Koordinasyon Paneli')).not.toBeInTheDocument();
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(deps.callLogoutEndpoint).not.toHaveBeenCalled();
  });
});

// OSP-71 (AC-19): panel ekranda açık kalırken (sekme hiç gizlenmeden) iptal, periyodik kontrolle
// yakalanır. Gerçek API istemcisi, zorla çıkış, provider, guard ve giriş sayfası; yalnızca Supabase
// ve fetch sahte. Sahte zamanlayıcılar `shouldAdvanceTime` OLMADAN kullanılır (yavaş CI'da da
// belirleyici); waitFor/findBy yerine `flush()` ile bekleyen promise'ler boşaltılır.
describe('periodic /auth/me while the panel stays open (OSP-71)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
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

  // Paneli açık bir koordinatörle kurar; ilk /auth/me 200, sonrakiler `later` ile belirlenir.
  async function openPanel(later: (url: string, init?: RequestInit) => Promise<Response>) {
    const session = sessionFor('coordinator');
    const { deps } = makeAuthDeps({ now: () => Date.now() });
    deps.getSession.mockResolvedValue(session);

    let navigateToLogin: (() => void) | null = null;
    deps.setLoginNavigator.mockImplementation((fn) => {
      navigateToLogin = fn;
      return () => undefined;
    });
    const forceSignOut = createForcedSignOut({
      signOut: deps.signOut,
      navigateToLogin: () => navigateToLogin?.(),
      storage: () => window.sessionStorage,
    });
    const fetchImpl = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json(200, { user_id: 'user-1', role: 'coordinator', device_id: 'd' }))
      .mockImplementation(later);
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetchImpl,
      getAccessToken: async () => ({ ok: true, accessToken: session.access_token }),
      refreshAccessToken: vi.fn(),
      rebindSession: vi.fn(),
      forceSignOut,
      isLogoutPending: () => false,
    });
    deps.forceSignOut.mockImplementation(forceSignOut);
    deps.fetchMe.mockImplementation(() => client.request('/api/v1/auth/me'));

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/dashboard']}>
          <AuthProvider deps={deps}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/dashboard"
                element={
                  <RequireRole action="viewOperations">
                    <AppLayout title="Koordinasyon Paneli" />
                  </RequireRole>
                }
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>,
    );

    await flush();
    expect(screen.getByText('Koordinasyon Paneli')).toBeInTheDocument();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    return { deps, fetchImpl };
  }

  it.each([
    ['DEVICE_REVOKED', 'Bu cihazın erişimi iptal edildi.'],
    ['ACCOUNT_DISABLED', 'Hesabınız devre dışı bırakıldı. Yöneticinize başvurun.'],
  ])('signs the user out on the next periodic check after %s, without a visibility change', async (code, message) => {
    const { deps, fetchImpl } = await openPanel(async () => json(403, { error_code: code, message: 'revoked' }));

    await elapse(ME_CHECK_INTERVAL_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await elapse(1);
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText('Koordinasyon Paneli')).not.toBeInTheDocument();
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(deps.callLogoutEndpoint).not.toHaveBeenCalled();

    // Çıkıştan sonra periyodik kontrol durur.
    await elapse(ME_CHECK_INTERVAL_MS * 3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['429', async () => json(429, { error_code: 'RATE_LIMITED', message: 'slow down' })],
    ['503', async () => json(503, { error_code: 'SERVER_ERROR', message: 'unavailable' })],
    ['network error', async () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('keeps the session when the periodic check fails transiently (%s)', async (_label, later) => {
    const { deps, fetchImpl } = await openPanel(later);

    await elapse(ME_CHECK_INTERVAL_MS * 3);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(screen.getByText('Koordinasyon Paneli')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(deps.signOut).not.toHaveBeenCalled();
  });

  it('keeps the session when the periodic check times out', async () => {
    // Sunucu hiç cevap vermez; istek yalnızca API istemcisinin zaman aşımıyla (abort) biter.
    const { deps, fetchImpl } = await openPanel(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );

    // t=15 sn: istek başlar; istemci zaman aşımı (15 sn) dolana kadar uçuşta kalır.
    await elapse(ME_CHECK_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await elapse(DEFAULT_TIMEOUT_MS);
    await flush();
    await expect(deps.fetchMe.mock.results[1]!.value).resolves.toEqual({
      ok: false,
      error: { kind: 'TIMEOUT' },
    });

    expect(screen.getByText('Koordinasyon Paneli')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(deps.signOut).not.toHaveBeenCalled();

    // Zaman aşımından sonra periyodik kontrol sürer.
    await elapse(ME_CHECK_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
