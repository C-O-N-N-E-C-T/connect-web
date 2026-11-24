import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { validateLoginForm, LoginPage } from './LoginPage';
import { createForcedSignOut, SIGNOUT_REASON_KEY } from '../auth/forcedSignOut';
import { blockStorage, restoreStorage } from '../test/blockStorage';

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  registerBrowserSession: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: mocks.signInWithPassword,
      signOut: mocks.signOut,
    },
  },
}));

vi.mock('../services/authSessionClient', () => ({
  registerBrowserSession: mocks.registerBrowserSession,
}));

function tokenFor(claims: object): string {
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

async function submitCredentials(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('E-posta'), email);
  await user.type(screen.getByLabelText('Şifre'), password);
  await user.click(screen.getByRole('button', { name: 'Giriş yap' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  mocks.signOut.mockResolvedValue({ error: null });
});

describe('validateLoginForm', () => {
  it('accepts a gmail address with a password', () => {
    expect(validateLoginForm('cansugnnn@gmail.com', 'secret')).toBeNull();
  });

  it('rejects a malformed email', () => {
    expect(validateLoginForm('not-an-email', 'secret')).toBe('Geçerli bir e-posta adresi girin.');
  });

  it('rejects an empty password', () => {
    expect(validateLoginForm('a@b.co', '')).toBe('Şifre boş bırakılamaz.');
  });
});

describe('LoginPage', () => {
  it('shows the supplementary disclaimer (AC-29)', () => {
    renderLogin();
    expect(screen.getByRole('note')).toHaveTextContent('kurtarmayı garanti etmez');
  });

  it('shows the invalid-credentials banner for a 4xx Supabase error', async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { status: 400, message: 'Invalid login credentials' },
    });
    renderLogin();
    await submitCredentials('a@b.co', 'wrong');

    expect(await screen.findByRole('alert')).toHaveTextContent('E-posta veya şifre hatalı.');
    expect(mocks.registerBrowserSession).not.toHaveBeenCalled();
  });

  it('shows a connection message, not a wrong-password message, when the network fails', async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { status: 0, message: 'Failed to fetch' },
    });
    renderLogin();
    await submitCredentials('a@b.co', 'pw');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Bağlantı kurulamadı');
    expect(alert).not.toHaveTextContent('şifre hatalı');
  });

  it('rejects a rescuer with a clear role message and signs them out', async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { session: { access_token: tokenFor({ user_role: 'rescuer' }) } },
      error: null,
    });
    renderLogin();
    await submitCredentials('rescuer@gmail.com', 'pw');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Saha kurtarıcı hesapları web panelinden giriş yapamaz.',
    );
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.registerBrowserSession).not.toHaveBeenCalled();
  });

  it.each([
    ['ACCOUNT_DISABLED', 'Hesabınız devre dışı bırakıldı. Yöneticinize başvurun.'],
    ['DEVICE_REVOKED', 'Bu cihazın erişimi iptal edildi.'],
    ['RATE_LIMITED', 'Çok fazla deneme yapıldı. Lütfen bir dakika sonra tekrar deneyin.'],
  ])('shows the banner for %s from /auth/session', async (code, message) => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { session: { access_token: tokenFor({ user_role: 'coordinator' }) } },
      error: null,
    });
    mocks.registerBrowserSession.mockResolvedValue({ ok: false, code });
    renderLogin();
    await submitCredentials('coordinator@gmail.com', 'pw');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('links the email validation error to its input', async () => {
    renderLogin();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('E-posta'), 'bad');
    await user.click(screen.getByRole('button', { name: 'Giriş yap' }));

    const input = screen.getByLabelText('E-posta');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'form-error');
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe('LoginPage: forced sign-out reason (OSP-70)', () => {
  it.each([
    ['DEVICE_REVOKED', 'Bu cihazın erişimi iptal edildi.'],
    ['ACCOUNT_DISABLED', 'Hesabınız devre dışı bırakıldı. Yöneticinize başvurun.'],
    ['SESSION_NOT_BOUND', 'Oturum cihaza bağlanamadı. Tekrar giriş yapın.'],
    ['ROLE_NOT_ALLOWED', 'Saha kurtarıcı hesapları web panelinden giriş yapamaz.'],
    ['SESSION_EXPIRED', 'Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.'],
  ])('shows the reason %s once, then clears it', (reason, message) => {
    window.sessionStorage.setItem(SIGNOUT_REASON_KEY, reason);
    const first = renderLogin();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(window.sessionStorage.getItem(SIGNOUT_REASON_KEY)).toBeNull();

    first.unmount();
    renderLogin();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the reason visible under StrictMode (double initializer and effects)', () => {
    window.sessionStorage.setItem(SIGNOUT_REASON_KEY, 'DEVICE_REVOKED');
    render(
      <StrictMode>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </StrictMode>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Bu cihazın erişimi iptal edildi.');
    expect(window.sessionStorage.getItem(SIGNOUT_REASON_KEY)).toBeNull();
  });

  it('ignores an unknown stored value', () => {
    window.sessionStorage.setItem(SIGNOUT_REASON_KEY, 'ANYTHING');
    renderLogin();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a reason that arrives while the page is already open', async () => {
    renderLogin();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const force = createForcedSignOut({
      signOut: async () => undefined,
      navigateToLogin: () => undefined,
      storage: () => window.sessionStorage,
    });
    await act(() => force('SESSION_EXPIRED', 'tok'));

    expect(screen.getByRole('alert')).toHaveTextContent('Oturumunuzun süresi doldu.');
    expect(window.sessionStorage.getItem(SIGNOUT_REASON_KEY)).toBeNull();
  });

  it('hides the reason when the user submits again', async () => {
    window.sessionStorage.setItem(SIGNOUT_REASON_KEY, 'DEVICE_REVOKED');
    mocks.signInWithPassword.mockReturnValue(new Promise(() => undefined));
    renderLogin();
    expect(screen.getByRole('alert')).toHaveTextContent('Bu cihazın erişimi iptal edildi.');
    await submitCredentials('a@b.co', 'pw');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('LoginPage with blocked storage (R11)', () => {
  it('renders and signs in without touching storage errors', async () => {
    blockStorage();
    try {
      mocks.signInWithPassword.mockResolvedValue({
        data: { session: { access_token: tokenFor({ user_role: 'coordinator' }) } },
        error: null,
      });
      mocks.registerBrowserSession.mockResolvedValue({ ok: true });
      renderLogin();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await submitCredentials('coordinator@gmail.com', 'pw');
      await waitFor(() => expect(mocks.registerBrowserSession).toHaveBeenCalledOnce());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      restoreStorage();
    }
  });
});
