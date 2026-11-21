import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequireRole } from './RequireRole';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));

function tokenFor(claims: object): string {
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

function renderGuarded() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
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
    </MemoryRouter>,
  );
}

function firePageShow(persisted: boolean) {
  const event = new Event('pageshow') as Event & { persisted: boolean };
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RequireRole', () => {
  it('shows the panel for an allowed role', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: tokenFor({ user_role: 'coordinator' }) } },
    });
    renderGuarded();
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();
  });

  it('redirects to login when there is no session', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    renderGuarded();
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
  });

  it('redirects to login for a role that is not allowed', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: tokenFor({ user_role: 'rescuer' }) } },
    });
    renderGuarded();
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
  });

  it('re-checks the session when restored from the back/forward cache', async () => {
    mocks.getSession
      .mockResolvedValueOnce({
        data: { session: { access_token: tokenFor({ user_role: 'coordinator' }) } },
      })
      .mockResolvedValueOnce({ data: { session: null } });

    renderGuarded();
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();

    act(() => firePageShow(true));
    await waitFor(() => expect(screen.getByText('LOGIN SCREEN')).toBeInTheDocument());
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });

  it('ignores normal page shows (not restored from cache)', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: tokenFor({ user_role: 'coordinator' }) } },
    });
    renderGuarded();
    expect(await screen.findByText('PANEL CONTENT')).toBeInTheDocument();

    act(() => firePageShow(false));
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
  });
});
