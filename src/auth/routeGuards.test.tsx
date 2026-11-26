/**
 * OSP-71: rota koruyucularının uçtan uca davranışı. Uygulamanın GERÇEK rota tablosu (AppRoutes),
 * gerçek koruyucu, sayfalar ve giriş sayfası kullanılır; yalnızca Supabase, /auth/me ve ağ sahtedir.
 * Zorla çıkış gerçek `createForcedSignOut` ile kurulur ki /login'deki gerekçe mesajı da doğrulansın.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppRoutes } from '../App';
import { AuthProvider, ME_CHECK_INTERVAL_MS, useAuth, type AuthProviderDeps } from './AuthProvider';
import { createForcedSignOut } from './forcedSignOut';
import { resetEndedSessions } from './endedSessions';
import { makeAuthDeps, sessionFor, tokenFor } from '../test/authTestUtils';
import type { Session } from '@supabase/supabase-js';

vi.mock('../lib/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-test-auth-token',
  supabase: { auth: { signInWithPassword: vi.fn(), signOut: vi.fn(), getSession: vi.fn() } },
}));

type MeResult = Awaited<ReturnType<AuthProviderDeps['fetchMe']>>;

const ROLE_NOT_ALLOWED_MESSAGE = 'Saha kurtarıcı hesapları web panelinden giriş yapamaz.';
const ACCESS_DENIED = 'Bu sayfaya erişim yetkiniz yok.';

function meAnswer(role: string, userId = 'user-1'): MeResult {
  return { ok: true, status: 200, data: { user_id: userId, role, device_id: 'dev-1' } };
}

// Konumu, navigation state'ini ve rol onayını ekrana yazar (yönlendirme ve state temizliği için).
function Probe() {
  const location = useLocation();
  const { status, role, roleConfirmed } = useAuth();
  return (
    <p data-testid="probe">
      {location.pathname}|{JSON.stringify(location.state ?? null)}|{status}|{role ?? '-'}|
      {roleConfirmed ? 'confirmed' : 'unconfirmed'}
    </p>
  );
}

const probe = () => screen.getByTestId('probe').textContent ?? '';
const pathname = () => probe().split('|')[0];

/** Sahte bağımlılıklar + gerçek zorla çıkış (gerekçe sessionStorage'a yazılır, /login'e gidilir). */
function setup(overrides: Partial<AuthProviderDeps> = {}) {
  const helpers = makeAuthDeps(overrides);
  const { deps } = helpers;
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
  deps.forceSignOut.mockImplementation(forceSignOut);
  return helpers;
}

function renderAt(deps: AuthProviderDeps, path: string, strict = false) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider deps={deps}>
        <Probe />
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** /auth/me'yi elle cevaplanacak şekilde bekletir. */
function deferMe(deps: ReturnType<typeof makeAuthDeps>['deps']) {
  const answers: Array<(value: MeResult) => void> = [];
  deps.fetchMe.mockImplementation(() => new Promise<MeResult>((resolve) => answers.push(resolve)));
  return {
    async answer(value: MeResult) {
      const next = answers.shift();
      if (!next) throw new Error('no pending /auth/me');
      await act(async () => next(value));
    },
    pending: () => answers.length,
  };
}

const loginScreen = () => screen.findByRole('heading', { name: 'CONNECT' });

beforeEach(() => {
  resetEndedSessions();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('signed-out users (AC-19)', () => {
  it.each(['/dashboard', '/admin', '/admin/users', '/admin/users/42'])(
    'redirects %s to /login',
    async (path) => {
      const { deps } = setup();
      renderAt(deps, path);
      expect(await loginScreen()).toBeInTheDocument();
      expect(pathname()).toBe('/login');
      expect(screen.queryByText('Koordinasyon Paneli')).not.toBeInTheDocument();
      expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
      expect(deps.fetchMe).not.toHaveBeenCalled();
    },
  );

  it('redirects an unknown path to /login', async () => {
    const { deps } = setup();
    renderAt(deps, '/somewhere');
    expect(await loginScreen()).toBeInTheDocument();
    expect(pathname()).toBe('/login');
  });
});

describe('rescuer (JWT claim) is signed out of the web panel', () => {
  it.each(['/dashboard', '/admin', '/admin/users'])(
    'signs out with ROLE_NOT_ALLOWED on %s and shows the reason on /login',
    async (path) => {
      const session = sessionFor('rescuer');
      const { deps } = setup();
      deps.getSession.mockResolvedValue(session);
      // /auth/me hiç cevap vermez: çıkışı yalnızca JWT'deki rol tetikler.
      deps.fetchMe.mockReturnValue(new Promise(() => undefined));
      renderAt(deps, path);

      expect(await screen.findByRole('alert')).toHaveTextContent(ROLE_NOT_ALLOWED_MESSAGE);
      expect(pathname()).toBe('/login');
      expect(deps.forceSignOut).toHaveBeenCalledWith('ROLE_NOT_ALLOWED', session.access_token);
      expect(deps.signOut).toHaveBeenCalledOnce();
      // Zorla çıkış POST /auth/logout çağırmaz (token zaten reddedilmiş sayılır).
      expect(deps.callLogoutEndpoint).not.toHaveBeenCalled();
      await waitFor(() => expect(probe()).toContain('signedOut'));
      expect(screen.queryByText('Koordinasyon Paneli')).not.toBeInTheDocument();
      expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
    },
  );

  it('signs out once under StrictMode (double effects)', async () => {
    const session = sessionFor('rescuer');
    const { deps } = setup();
    deps.getSession.mockResolvedValue(session);
    deps.fetchMe.mockReturnValue(new Promise(() => undefined));
    renderAt(deps, '/dashboard', true);

    expect(await screen.findByRole('alert')).toHaveTextContent(ROLE_NOT_ALLOWED_MESSAGE);
    expect(deps.signOut).toHaveBeenCalledOnce();
  });

  it('also signs out in mock mode (no backend)', async () => {
    const { deps } = setup({ mode: 'mock' });
    deps.getSession.mockResolvedValue(sessionFor('rescuer'));
    renderAt(deps, '/dashboard');

    expect(await screen.findByRole('alert')).toHaveTextContent(ROLE_NOT_ALLOWED_MESSAGE);
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(deps.fetchMe).not.toHaveBeenCalled();
  });
});

describe('unknown roles stay on the safe side', () => {
  it.each([undefined, 'superuser'])('sends a session with role %j to /login without a panel', async (role) => {
    const { deps } = setup({ mode: 'mock' });
    deps.getSession.mockResolvedValue(sessionFor(role));
    renderAt(deps, '/dashboard');
    expect(await loginScreen()).toBeInTheDocument();
    expect(screen.queryByText('Koordinasyon Paneli')).not.toBeInTheDocument();
  });
});

describe('coordinator cannot open /admin/*', () => {
  it.each(['/admin', '/admin/x', '/admin/users/42'])(
    'is sent from %s to /dashboard with a warning and stays signed in',
    async (path) => {
      const { deps } = setup();
      deps.getSession.mockResolvedValue(sessionFor('coordinator'));
      renderAt(deps, path);

      expect(await screen.findByRole('alert')).toHaveTextContent(ACCESS_DENIED);
      expect(screen.getByRole('heading', { name: 'Koordinasyon Paneli' })).toBeInTheDocument();
      expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
      expect(pathname()).toBe('/dashboard');
      // Uyarı state'i history'den silinir: yenilemede uyarı tekrar çıkmaz.
      await waitFor(() => expect(probe()).toContain('/dashboard|null|signedIn|coordinator'));
      expect(screen.getByRole('alert')).toHaveTextContent(ACCESS_DENIED);
      expect(deps.signOut).not.toHaveBeenCalled();
      expect(deps.forceSignOut).not.toHaveBeenCalled();
    },
  );

  it('keeps the warning visible under StrictMode while clearing the history state', async () => {
    const { deps } = setup();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderAt(deps, '/admin', true);

    expect(await screen.findByRole('alert')).toHaveTextContent(ACCESS_DENIED);
    await waitFor(() => expect(probe()).toContain('/dashboard|null|'));
    expect(screen.getByRole('alert')).toHaveTextContent(ACCESS_DENIED);
  });

  it('shows no warning when /dashboard is opened directly (e.g. after a reload)', async () => {
    const { deps } = setup();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderAt(deps, '/dashboard');
    expect(await screen.findByRole('heading', { name: 'Koordinasyon Paneli' })).toBeInTheDocument();
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('waits for the server role on /admin before redirecting', async () => {
    const { deps } = setup();
    const me = deferMe(deps);
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderAt(deps, '/admin');

    expect(await screen.findByText('Yükleniyor…')).toBeInTheDocument();
    expect(pathname()).toBe('/admin');
    await me.answer(meAnswer('coordinator'));
    expect(await screen.findByRole('alert')).toHaveTextContent(ACCESS_DENIED);
    expect(pathname()).toBe('/dashboard');
  });
});

describe('administrator on /admin/* waits for the server role', () => {
  it.each(['/admin', '/admin/users'])('shows "Yükleniyor…" on %s until /auth/me confirms', async (path) => {
    const { deps } = setup();
    const me = deferMe(deps);
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    renderAt(deps, path);

    await waitFor(() => expect(me.pending()).toBe(1));
    expect(screen.getByText('Yükleniyor…')).toBeInTheDocument();
    expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
    expect(probe()).toContain('signedIn|administrator|unconfirmed');

    await me.answer(meAnswer('administrator'));
    expect(await screen.findByRole('heading', { name: 'Yönetici Paneli' })).toBeInTheDocument();
    expect(pathname()).toBe(path);
    expect(probe()).toContain('|confirmed');
    expect(screen.queryByText('Yükleniyor…')).not.toBeInTheDocument();
  });

  it('does not open /admin when /auth/me says the user is a coordinator', async () => {
    const { deps } = setup();
    const me = deferMe(deps);
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    renderAt(deps, '/admin');

    await waitFor(() => expect(me.pending()).toBe(1));
    await me.answer(meAnswer('coordinator'));
    expect(await screen.findByRole('alert')).toHaveTextContent(ACCESS_DENIED);
    expect(pathname()).toBe('/dashboard');
    expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('signs out when /auth/me says the user is a rescuer', async () => {
    const session = sessionFor('administrator');
    const { deps } = setup();
    const me = deferMe(deps);
    deps.getSession.mockResolvedValue(session);
    renderAt(deps, '/admin');

    await waitFor(() => expect(me.pending()).toBe(1));
    await me.answer(meAnswer('rescuer'));
    expect(await screen.findByRole('alert')).toHaveTextContent(ROLE_NOT_ALLOWED_MESSAGE);
    expect(deps.forceSignOut).toHaveBeenCalledWith('ROLE_NOT_ALLOWED', session.access_token);
    expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
  });

  it('keeps waiting (no admin view, no sign-out) when /auth/me fails transiently', async () => {
    const { deps } = setup();
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    deps.fetchMe.mockResolvedValue({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    renderAt(deps, '/admin');

    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledOnce());
    await act(async () => undefined);
    // Düzeltme 2: geçici hatada süresiz "Yükleniyor…" yerine bağlantı sorunu mesajı.
    expect(screen.getByRole('status')).toHaveTextContent('Sunucuya ulaşılamıyor. Yeniden deneniyor…');
    expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
    expect(probe()).toContain('signedIn|administrator|unconfirmed');
  });

  it('keeps the confirmation over a token refresh of the same session', async () => {
    const { deps, emit } = setup();
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    deps.fetchMe.mockResolvedValue(meAnswer('administrator'));
    renderAt(deps, '/admin');
    expect(await screen.findByRole('heading', { name: 'Yönetici Paneli' })).toBeInTheDocument();

    act(() => emit('TOKEN_REFRESHED', sessionFor('administrator', 'user-1', 'r2')));
    expect(screen.getByRole('heading', { name: 'Yönetici Paneli' })).toBeInTheDocument();
    expect(probe()).toContain('|confirmed');
  });

  it('asks again for a new session of the same user (confirmation is per session)', async () => {
    const { deps, emit } = setup();
    const me = deferMe(deps);
    deps.getSession.mockResolvedValue(sessionFor('administrator', 'user-1', '', 'sess-old'));
    renderAt(deps, '/admin');
    await waitFor(() => expect(me.pending()).toBe(1));
    await me.answer(meAnswer('administrator'));
    expect(await screen.findByRole('heading', { name: 'Yönetici Paneli' })).toBeInTheDocument();

    // Aynı kullanıcının yeni bir girişi (farklı session_id): onay sıfırlanır, panel bekler.
    act(() => emit('SIGNED_IN', sessionFor('administrator', 'user-1', '', 'sess-new')));
    expect(screen.getByText('Yükleniyor…')).toBeInTheDocument();
    expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
    expect(probe()).toContain('unconfirmed');

    // Pencereye dönüş kontrolü yeni oturum için throttle'a takılmadan hemen çalışır.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(me.pending()).toBe(1));
    await me.answer(meAnswer('administrator'));
    expect(await screen.findByRole('heading', { name: 'Yönetici Paneli' })).toBeInTheDocument();
  });

  it('drops the confirmation on sign-out', async () => {
    const { deps, emit } = setup();
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    deps.fetchMe.mockResolvedValue(meAnswer('administrator'));
    renderAt(deps, '/admin');
    expect(await screen.findByRole('heading', { name: 'Yönetici Paneli' })).toBeInTheDocument();

    act(() => emit('SIGNED_OUT', null));
    expect(await loginScreen()).toBeInTheDocument();
    expect(probe()).toContain('signedOut|-|unconfirmed');
  });

  it('opens /admin in mock mode without a backend (JWT role only)', async () => {
    const { deps } = setup({ mode: 'mock' });
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    renderAt(deps, '/admin/users');
    expect(await screen.findByRole('heading', { name: 'Yönetici Paneli' })).toBeInTheDocument();
    expect(deps.fetchMe).not.toHaveBeenCalled();
  });

  it('keeps the existing connection-problem message while the session cannot be read', async () => {
    const { deps } = setup();
    deps.getSession.mockRejectedValue(new Error('offline'));
    renderAt(deps, '/admin');
    // Bekleme metinleri artık hep role="status"; ilk "Yükleniyor…" da status olduğu için metinle aranır.
    expect(await screen.findByText('Sunucuya ulaşılamıyor. Yeniden deneniyor…')).toHaveAttribute('role', 'status');
    expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
  });
});

describe('/dashboard by role (operational view)', () => {
  it('opens at once for an administrator (no wait for /auth/me), read-only without controls', async () => {
    const { deps } = setup();
    deferMe(deps); // /auth/me cevap vermez: /dashboard beklemez.
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    renderAt(deps, '/dashboard');

    expect(await screen.findByRole('heading', { name: 'Koordinasyon Paneli' })).toBeInTheDocument();
    expect(probe()).toContain('unconfirmed');
    expect(screen.getByText('Salt okunur görünüm')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Override' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kaynak ata' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the placeholder override and assign buttons to a coordinator', async () => {
    const { deps } = setup();
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderAt(deps, '/dashboard');

    expect(await screen.findByRole('button', { name: 'Override' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Kaynak ata' })).toBeDisabled();
    expect(screen.queryByText('Salt okunur görünüm')).not.toBeInTheDocument();
  });

  it('hides the controls when /auth/me downgrades a coordinator JWT to administrator', async () => {
    const { deps } = setup();
    const me = deferMe(deps);
    deps.getSession.mockResolvedValue(sessionFor('coordinator'));
    renderAt(deps, '/dashboard');
    expect(await screen.findByRole('button', { name: 'Override' })).toBeInTheDocument();

    await waitFor(() => expect(me.pending()).toBe(1));
    await me.answer(meAnswer('administrator'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Override' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Kaynak ata' })).not.toBeInTheDocument();
    expect(screen.getByText('Salt okunur görünüm')).toBeInTheDocument();
  });
});

// Düzeltme 1: token'da `session_id` yoksa onay user id'ye düşmez; hiç verilmez (güvenli taraf).
describe('role confirmation needs a session_id claim', () => {
  function sessionWithoutSessionId(role: string, userId = 'user-1'): Session {
    return { access_token: tokenFor({ sub: userId, user_role: role }), user: { id: userId } } as unknown as Session;
  }

  it('stays on "Yükleniyor…" on /admin even when /auth/me says administrator', async () => {
    const { deps } = setup();
    deps.getSession.mockResolvedValue(sessionWithoutSessionId('administrator'));
    deps.fetchMe.mockResolvedValue(meAnswer('administrator'));
    renderAt(deps, '/admin');

    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledOnce());
    await act(async () => undefined);
    expect(screen.getByRole('status')).toHaveTextContent('Yükleniyor…');
    expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
    expect(probe()).toContain('signedIn|administrator|unconfirmed');
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('does not confirm a later sign-in of the same user either (no user-id fallback)', async () => {
    const { deps, emit } = setup();
    deps.getSession.mockResolvedValue(sessionWithoutSessionId('administrator'));
    deps.fetchMe.mockResolvedValue(meAnswer('administrator'));
    renderAt(deps, '/admin');
    await waitFor(() => expect(deps.fetchMe).toHaveBeenCalledOnce());
    await act(async () => undefined);
    expect(probe()).toContain('unconfirmed');

    // Aynı kullanıcının yine session_id'siz yeni token'ı: sessionKeyOf ikisinde de user id'dir,
    // ama onay anahtarı null olduğu için önceki /auth/me cevabı devralınmaz.
    const next = {
      access_token: tokenFor({ sub: 'user-1', user_role: 'administrator', jti: 'new' }),
      user: { id: 'user-1' },
    } as unknown as Session;
    act(() => emit('SIGNED_IN', next));
    expect(screen.getByRole('status')).toHaveTextContent('Yükleniyor…');
    expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
    expect(probe()).toContain('unconfirmed');
  });
});

// Düzeltme 2: /admin'de sunucuya ulaşılamazken bağlantı sorunu mesajı; oturum açık kalır.
// Sahte zamanlayıcılar `shouldAdvanceTime` OLMADAN; bekleyen promise'ler flush() ile boşaltılır.
describe('/admin while /auth/me is unreachable', () => {
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
  async function flush() {
    for (let i = 0; i < 5; i += 1) await elapse(0);
  }

  const UNREACHABLE = 'Sunucuya ulaşılamıyor. Yeniden deneniyor…';

  it.each([
    ['NETWORK_ERROR', { kind: 'NETWORK_ERROR' }],
    ['TIMEOUT', { kind: 'TIMEOUT' }],
    ['5xx', { kind: 'SERVER_ERROR', status: 503 }],
    ['429', { kind: 'RATE_LIMITED', status: 429 }],
  ] as const)('shows the connection message after a %s, stays signed in, opens after the next successful check', async (_label, error) => {
    const { deps } = setup({ now: () => Date.now() });
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    deps.fetchMe.mockResolvedValueOnce({ ok: false, error: { ...error } }).mockResolvedValue(meAnswer('administrator'));
    renderAt(deps, '/admin');
    await flush();

    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(UNREACHABLE);
    expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
    expect(probe()).toContain('signedIn|administrator|unconfirmed');
    expect(deps.forceSignOut).not.toHaveBeenCalled();
    expect(deps.signOut).not.toHaveBeenCalled();

    // Sonraki periyodik kontrol başarılı: mesaj kalkar, /admin açılır.
    await elapse(ME_CHECK_INTERVAL_MS);
    await flush();
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'Yönetici Paneli' })).toBeInTheDocument();
    expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
    expect(probe()).toContain('|confirmed');
  });

  it('keeps the message over a token refresh of the same session, drops it for a new session', async () => {
    const { deps, emit } = setup({ now: () => Date.now() });
    deps.getSession.mockResolvedValue(sessionFor('administrator', 'user-1', '', 'sess-a'));
    deps.fetchMe.mockResolvedValueOnce({ ok: false, error: { kind: 'NETWORK_ERROR' } }).mockReturnValue(new Promise(() => undefined));
    renderAt(deps, '/admin');
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent(UNREACHABLE);

    act(() => emit('TOKEN_REFRESHED', sessionFor('administrator', 'user-1', 'r2', 'sess-a')));
    expect(screen.getByRole('status')).toHaveTextContent(UNREACHABLE);

    act(() => emit('SIGNED_IN', sessionFor('administrator', 'user-1', '', 'sess-b')));
    expect(screen.getByRole('status')).toHaveTextContent('Yükleniyor…');
  });

  it('ignores a transient failure that belongs to an earlier session (R2)', async () => {
    let answer!: (value: MeResult) => void;
    const { deps, emit } = setup({ now: () => Date.now() });
    deps.getSession.mockResolvedValue(sessionFor('administrator', 'user-1', '', 'sess-a'));
    deps.fetchMe.mockReturnValueOnce(new Promise((resolve) => (answer = resolve))).mockReturnValue(new Promise(() => undefined));
    renderAt(deps, '/admin');
    await flush();

    act(() => emit('SIGNED_IN', sessionFor('administrator', 'user-1', '', 'sess-b')));
    await act(async () => answer({ ok: false, error: { kind: 'NETWORK_ERROR' } }));
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Yükleniyor…');
    expect(probe()).toContain('unconfirmed');
  });

  it('treats an exception from /auth/me like a transient failure; the next successful check opens /admin', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { deps } = setup({ now: () => Date.now() });
      deps.getSession.mockResolvedValue(sessionFor('administrator'));
      deps.fetchMe.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(meAnswer('administrator'));
      renderAt(deps, '/admin');
      await flush();

      expect(deps.fetchMe).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent(UNREACHABLE);
      expect(probe()).toContain('signedIn|administrator|unconfirmed');
      expect(deps.signOut).not.toHaveBeenCalled();
      expect(deps.forceSignOut).not.toHaveBeenCalled();
      // Güvenli loglama korunur: yalnızca hata adı, mesaj yok.
      expect(warn).toHaveBeenCalledWith('[AuthProvider] /auth/me check failed unexpectedly', { name: 'Error' });

      await elapse(ME_CHECK_INTERVAL_MS);
      await flush();
      expect(deps.fetchMe).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('heading', { name: 'Yönetici Paneli' })).toBeInTheDocument();
      expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
      expect(probe()).toContain('|confirmed');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['HTTP_ERROR', { ok: false, error: { kind: 'HTTP_ERROR', status: 404 } }],
    ['FORBIDDEN', { ok: false, error: { kind: 'FORBIDDEN', status: 403 } }],
    ['SESSION_CHANGED', { ok: false, error: { kind: 'SESSION_CHANGED' } }],
    ['a malformed body', { ok: true, status: 200, data: { unexpected: true } }],
  ] as const)('clears the message when a later check ends with %s (server reachable), stays signed in', async (_label, later) => {
    const { deps } = setup({ now: () => Date.now() });
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    deps.fetchMe
      .mockResolvedValueOnce({ ok: false, error: { kind: 'NETWORK_ERROR' } })
      .mockResolvedValue(later as unknown as MeResult);
    renderAt(deps, '/admin');
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent(UNREACHABLE);

    await elapse(ME_CHECK_INTERVAL_MS);
    await flush();
    expect(deps.fetchMe).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Yükleniyor…');
    expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
    expect(screen.queryByText('Yönetici Paneli')).not.toBeInTheDocument();
    expect(probe()).toContain('signedIn|administrator|unconfirmed');
    expect(deps.signOut).not.toHaveBeenCalled();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('ignores a late exception that belongs to an earlier session (R2)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let fail!: (error: Error) => void;
      const { deps, emit } = setup({ now: () => Date.now() });
      deps.getSession.mockResolvedValue(sessionFor('administrator', 'user-1', '', 'sess-a'));
      deps.fetchMe
        .mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)))
        .mockReturnValue(new Promise(() => undefined));
      renderAt(deps, '/admin');
      await flush();

      act(() => emit('SIGNED_IN', sessionFor('administrator', 'user-1', '', 'sess-b')));
      await act(async () => fail(new Error('late')));
      await flush();
      expect(screen.getByRole('status')).toHaveTextContent('Yükleniyor…');
      expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
      expect(probe()).toContain('signedIn|administrator|unconfirmed');
      expect(deps.signOut).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not affect /dashboard', async () => {
    const { deps } = setup({ now: () => Date.now() });
    deps.getSession.mockResolvedValue(sessionFor('administrator'));
    deps.fetchMe.mockResolvedValue({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    renderAt(deps, '/dashboard');
    await flush();

    expect(deps.fetchMe).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Koordinasyon Paneli' })).toBeInTheDocument();
    expect(screen.getByText('Salt okunur görünüm')).toBeInTheDocument();
    expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(deps.signOut).not.toHaveBeenCalled();
  });
});
