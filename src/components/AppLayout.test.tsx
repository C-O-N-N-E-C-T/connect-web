import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { AuthProvider } from '../auth/AuthProvider';
import { RequireRole } from '../auth/RequireRole';
import { LOGOUT_PENDING_KEY } from '../auth/logout';
import { makeAuthDeps, sessionFor } from '../test/authTestUtils';

function renderPanel(deps: ReturnType<typeof makeAuthDeps>['deps']) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <AuthProvider deps={deps}>
        <Routes>
          <Route path="/login" element={<p>LOGIN SCREEN</p>} />
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
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('AppLayout logout button (D1/D2)', () => {
  it('disables itself, shows progress, ignores double clicks and ends on /login', async () => {
    let finishRequest!: () => void;
    const { deps } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    deps.callLogoutEndpoint.mockImplementation(
      () => new Promise((resolve) => (finishRequest = () => resolve({ ok: true }))),
    );
    renderPanel(deps);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Çıkış yap' }));

    const busy = screen.getByRole('button', { name: 'Çıkış yapılıyor…' });
    expect(busy).toBeDisabled();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBe('sess-user-1');
    await user.click(busy);
    expect(deps.callLogoutEndpoint).toHaveBeenCalledOnce();
    expect(deps.callLogoutEndpoint).toHaveBeenCalledWith(5000);
    expect(deps.signOut).not.toHaveBeenCalled();

    await act(async () => finishRequest());

    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
    // Late responses of this session are ignored from now on (R2).
    expect(deps.markSessionEnded).toHaveBeenCalledWith('sess-user-1');
  });

  it('still signs out and reaches /login when the backend call fails', async () => {
    const { deps } = makeAuthDeps();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    deps.callLogoutEndpoint.mockRejectedValue(new Error('network'));
    renderPanel(deps);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Çıkış yap' }));

    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });
});
