import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequireRole } from './RequireRole';
import { AuthProvider, type AuthProviderDeps } from './AuthProvider';
import { makeAuthDeps, sessionFor } from '../test/authTestUtils';

function renderGuarded(deps: AuthProviderDeps) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <AuthProvider deps={deps}>
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
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function firePageShow(persisted: boolean) {
  const event = new Event('pageshow') as Event & { persisted: boolean };
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

/** Mock mode: no GET /auth/me, so only the local session decides (as before OSP-70). */
function setup() {
  return makeAuthDeps({ mode: 'mock' });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('RequireRole', () => {
  it('shows the panel for an allowed role', async () => {
    const { deps } = setup();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderGuarded(deps);
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
  });

  it('shows a loading state, not the panel, until the session is known', () => {
    const { deps } = setup();
    deps.getSession.mockReturnValue(new Promise(() => undefined));
    renderGuarded(deps);
    expect(screen.getByText('Yükleniyor…')).toBeInTheDocument();
    expect(screen.queryByText('PANEL CONTENT')).not.toBeInTheDocument();
  });

  it('redirects to login when there is no session', async () => {
    const { deps } = setup();
    deps.getSession.mockResolvedValue(null);
    renderGuarded(deps);
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
  });

  it('redirects to login for a role that is not allowed', async () => {
    const { deps } = setup();
    deps.getSession.mockResolvedValue(sessionFor('rescuer'));
    renderGuarded(deps);
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
  });

  it('redirects to login when the session ends (SIGNED_OUT event)', async () => {
    const { deps, emit } = setup();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderGuarded(deps);
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();

    act(() => emit('SIGNED_OUT', null));
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
  });

  it('re-checks the session when restored from the back/forward cache', async () => {
    const { deps } = setup();
    deps.getSession.mockResolvedValueOnce(sessionFor('coordinator')).mockResolvedValueOnce(null);

    renderGuarded(deps);
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();

    act(() => firePageShow(true));
    await waitFor(() => expect(screen.getByText('LOGIN SCREEN')).toBeInTheDocument());
    expect(deps.getSession).toHaveBeenCalledTimes(2);
  });

  it('ignores normal page shows (not restored from cache)', async () => {
    const { deps } = setup();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderGuarded(deps);
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();

    act(() => firePageShow(false));
    expect(deps.getSession).toHaveBeenCalledTimes(1);
  });
});
