/**
 * AC-19 demo scenario end to end (design D3): the coordinator has the panel open, an admin revokes
 * the device, the coordinator returns to the tab -> GET /auth/me -> 403 DEVICE_REVOKED -> signed
 * out, /login shows the reason. Real API client, forced sign-out, provider, guard and login page;
 * only Supabase and fetch are faked.
 */
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './AuthProvider';
import { RequireRole } from './RequireRole';
import { createForcedSignOut } from './forcedSignOut';
import { createApiClient } from '../services/apiClient';
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
                  <RequireRole allow={['coordinator']}>
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
