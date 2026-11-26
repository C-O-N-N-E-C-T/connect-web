import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { decodeJwtClaims, readSessionKey, readUserRole } from '../lib/jwt';
import { isWebRole, type AppRole } from '../lib/roles';
import type { ApiErrorKind, ApiResult, TransientKind } from '../services/apiClient';
import type { ForceSignOut } from './forcedSignOut';
import {
  ANY_SESSION,
  clearLogoutPending,
  isLogoutPending,
  LOGOUT_TIMEOUT_MS,
  pendingLogoutKey,
  performLogout,
  STARTUP_LOGOUT_TIMEOUT_MS,
} from './logout';

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  /** Server role from GET /auth/me when known, otherwise the JWT `user_role` claim. */
  role: AppRole | null;
  /**
   * True while the stored session cannot be read because Supabase is unreachable (review R4). The
   * status then stays `loading` (no panel, no /login) and the read is retried.
   */
  connectionProblem: boolean;
  /**
   * OSP-71: `role` bu oturum için GET /auth/me ile sunucudan onaylandı mı. Yalnızca /auth/me
   * cevabı AYNI oturuma ve AYNI kullanıcıya uygulandığında true olur; yeni oturumda, kullanıcı
   * değişince ve çıkışta false'a döner. /admin gibi sunucu onayı isteyen rotalar bunu bekler
   * (JWT'deki eski bir rol iddiası tek başına yönetici ekranını açmasın diye). Mock modda backend
   * olmadığı için oturum açıkken her zaman true'dur (rol yalnızca JWT'den gelir).
   */
  roleConfirmed: boolean;
  /**
   * OSP-71: bu oturum için son GET /auth/me geçici bir hatayla (ağ, TIMEOUT, 5xx, 429) bitti.
   * Rol onayı bekleyen ekranlar (ör. /admin) bu sırada süresiz "Yükleniyor…" yerine bağlantı
   * sorunu mesajını gösterir. Oturum KAPANMAZ; aynı oturum için başarılı bir /auth/me gelince,
   * yeni oturumda ve çıkışta false'a döner.
   */
  roleCheckUnreachable: boolean;
}

export interface AuthContextValue extends AuthState {
  /** Logout flow D1/D2. Never rejects. The caller navigates to /login afterwards. */
  logout(): Promise<void>;
  /** Re-reads the local session (used after a back/forward-cache restore). */
  revalidate(): Promise<void>;
  /**
   * OSP-71: oturumdaki rol web paneline izinli değilse (rescuer) oturumu ROLE_NOT_ALLOWED
   * gerekçesiyle zorla kapatır. Sunucu rolü için checkMe'nin kullandığı mekanizmanın
   * (`forceSignOut`) aynısıdır; rota koruyucusu JWT'den gelen rescuer rolü için efekt içinde
   * çağırır. Rol bu arada web rolüne döndüyse ya da oturumun çıkışı beklemedeyse hiçbir şey yapmaz.
   */
  signOutDisallowedRole(): Promise<void>;
}

export interface AuthMeBody {
  user_id: string;
  role: string;
  device_id: string;
}

/** Injected so the provider can be tested without Supabase or the network. */
export interface AuthProviderDeps {
  /**
   * The stored session, refreshed if needed; null = signed out. REJECTS when it cannot be
   * determined for a transient reason (offline / 5xx while refreshing an expiring token): that is
   * not "signed out" (review R4).
   */
  getSession(): Promise<Session | null>;
  /** Subscribes; returns the unsubscribe function. */
  onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): () => void;
  fetchMe(): Promise<ApiResult<AuthMeBody>>;
  /** POST /api/v1/auth/logout with API-client recovery disabled. */
  callLogoutEndpoint(timeoutMs: number): Promise<unknown>;
  /** `signOut({ scope: 'local' })`, never throws. */
  signOut(): Promise<void>;
  forceSignOut: ForceSignOut;
  /** Records that this tab ended a session on purpose (see endedSessions.ts). */
  markSessionEnded(sessionKey: string | null): void;
  /** A fresh sign-in makes that identity live again (see endedSessions.ts). */
  clearSessionEnded(sessionKey: string | null): void;
  /** Identity of the session persisted by supabase-js, read without any network call. */
  storedSessionKey(): string | null;
  setLoginNavigator(navigateToLogin: () => void): () => void;
  /** localStorage (holds the logout-pending flag), or null when storage is blocked. */
  storage(): Storage | null;
  /** VITE_AUTH_SESSION_MODE. In `mock` mode no backend call is made. */
  mode: string | undefined;
  now(): number;
}

/**
 * GET /auth/me için en kısa aralık (throttle). Visibility, pencere `focus`'u, açılış kurtarması
 * (R4) sonrası ve /login'den panele geçişteki kontroller, AYNI oturum için son kontrol bu süreden
 * daha yakın zamanda başladıysa atlanır. Farklı bir oturum (yeni giriş) bu sınıra takılmaz ve
 * hemen doğrulanır (OSP-71). Periyodik kontrol bu sınırı kullanmaz; aralığı zaten 15 sn'dir.
 */
export const ME_CHECK_MIN_INTERVAL_MS = 10_000;

/**
 * OSP-71 (AC-19): sekme görünürken ve oturum açıkken GET /auth/me bu aralıkla tekrarlanır.
 * Yalnızca visibility'ye bağlı kontrol, ekranda açık kalan bir sekmede iptal edilen cihazı hiç
 * fark etmiyordu. Backend /auth/me'yi /auth/* rate limit'inden muaf tuttuğu için bu sıklık giriş
 * kotasını tüketmez. Periyot her yeni kontrolle (hangi yoldan başlarsa başlasın) sıfırlanır.
 */
export const ME_CHECK_INTERVAL_MS = 15_000;

const AuthContext = createContext<AuthContextValue | null>(null);

/** Exposed for tests that render a panel without the full provider. */
export const AuthContextProvider = AuthContext.Provider;

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

function isAppRole(value: unknown): value is AppRole {
  return value === 'rescuer' || isWebRole(value);
}

function jwtRole(session: Session): AppRole | null {
  const role = readUserRole(session.access_token);
  return isAppRole(role) ? role : null;
}

function userIdOf(session: Session): string | null {
  if (session.user?.id) return session.user.id;
  try {
    const sub = decodeJwtClaims(session.access_token).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

/** Identity of a session (JWT session_id, else the user id). */
export function sessionKeyOf(session: Session): string | null {
  return readSessionKey(session.access_token) ?? userIdOf(session);
}

const LOADING: AuthState = {
  status: 'loading',
  session: null,
  role: null,
  connectionProblem: false,
  roleConfirmed: false,
  roleCheckUnreachable: false,
};
const SIGNED_OUT: AuthState = {
  status: 'signedOut',
  session: null,
  role: null,
  connectionProblem: false,
  roleConfirmed: false,
  roleCheckUnreachable: false,
};

/**
 * OSP-71: GET /auth/me sonucu için geçici hata türleri. Bunlar hiçbir zaman çıkış nedeni değildir;
 * yalnızca "sunucuya ulaşılamıyor" bilgisini tetikler. Liste apiClient'ın `TransientKind`'ına
 * bağlıdır: `Record<TransientKind, true>` eksik ya da fazla bir anahtarda derleme hatası verir, böylece
 * iki liste birbirinden kayamaz (Set<TransientKind> yalnızca fazla üyeyi yakalardı, eksiği değil).
 */
const TRANSIENT_ME_ERRORS: Readonly<Record<TransientKind, true>> = {
  NETWORK_ERROR: true,
  TIMEOUT: true,
  SERVER_ERROR: true,
  RATE_LIMITED: true,
};

function isTransientMeError(kind: ApiErrorKind): kind is TransientKind {
  // Kendi anahtarı mı (prototipten gelen `toString` vb. sayılmaz).
  return Object.prototype.hasOwnProperty.call(TRANSIENT_ME_ERRORS, kind);
}

/**
 * OSP-71: rol onayı için kullanılan oturum kimliği. `sessionKeyOf`'tan farklı olarak user id'ye
 * DÜŞMEZ: token'da `session_id` yoksa aynı kullanıcının yeni girişi eski onayı devralabilirdi; bu
 * durumda null döner ve onay hiç verilmez (güvenli taraf). Throttle, endedSessions ve
 * logout-pending eskisi gibi `sessionKeyOf` kullanır.
 */
function confirmKeyOf(session: Session): string | null {
  // readSessionKey bilerek kullanılmaz: o da `session_id` yoksa `sub`'a düşer.
  try {
    const sessionId = decodeJwtClaims(session.access_token).session_id;
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
  } catch {
    return null;
  }
}

/** Retry delays for reading the session while Supabase is unreachable (R4); the last one repeats. */
export const SESSION_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];

/**
 * Holds the Supabase session and the user's role for the whole app (OSP-70).
 *
 * - Startup: `getSession()` (the session lives in localStorage, so it survives a reload: AC1),
 *   then GET /auth/me to confirm the session and take the role from the server.
 * - `onAuthStateChange` keeps the state in sync (sign-in, token refresh, sign-out in this or
 *   another tab).
 * - If a logout was interrupted (flag `connect.logout_pending`), it is finished first and no
 *   protected UI is rendered meanwhile (design D2).
 * - When the tab becomes visible again, GET /auth/me runs once more so a revoked device or
 *   disabled account is noticed (AC-19, design D3).
 * - OSP-71: sekme görünürken 15 sn'de bir, pencereye dönüşte (`focus`) ve girişten / açılış
 *   kurtarmasından sonra da GET /auth/me çalışır; böylece açık duran panel de bir sonraki
 *   kontrolde kapanır (AC-19).
 *
 * Must be rendered inside the router (it navigates to /login on a forced sign-out).
 */
export function AuthProvider({ deps, children }: { deps: AuthProviderDeps; children: ReactNode }) {
  const [state, setState] = useState<AuthState>(LOADING);
  const navigate = useNavigate();
  const location = useLocation();

  const depsRef = useRef(deps);
  depsRef.current = deps;
  /** Latest known session, updated synchronously (state updates are applied later). */
  const sessionRef = useRef<Session | null>(null);
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  /** Role confirmed by GET /auth/me, kept per user so token refreshes do not overwrite it. */
  // OSP-71: onayın hangi oturum için alındığı da tutulur (`sessionKey`). Rol seçimi eskisi gibi
  // kullanıcıya göredir; `roleConfirmed` ise yalnızca aynı oturum için true olur.
  const serverRoleRef = useRef<{ userId: string; sessionKey: string | null; role: AppRole } | null>(null);
  const meInFlightRef = useRef<Promise<void> | null>(null);
  const lastMeStartRef = useRef<number | null>(null);
  // OSP-71: son kontrolün hangi oturum için başladığı. Throttle yalnızca aynı oturum için
  // uygulanır; yeni bir giriş (farklı oturum) 10 sn kuralına takılmadan hemen doğrulanır.
  const lastMeKeyRef = useRef<string | null>(null);
  // OSP-71: periyodik zamanlayıcıyı yeniden kuran fonksiyon (periyot efekti aktifken dolu).
  // checkMe yeni bir istek başlattığında çağrılır; böylece iki kontrol arası en fazla 15 sn olur
  // ve focus/visibility kontrolünün hemen ardından gereksiz bir periyodik istek gitmez.
  const reschedulePeriodicRef = useRef<(() => void) | null>(null);
  // OSP-71: son /auth/me'si geçici hatayla biten oturumun anahtarı (`sessionKeyOf`). Token
  // yenilemesinde (applySession) bilgi bu sayede korunur; başka bir oturuma taşınmaz.
  const meUnreachableKeyRef = useRef<string | null>(null);
  const logoutInFlightRef = useRef<Promise<void> | null>(null);

  /** Bir oturumun geçerli rolü: aynı kullanıcı için sunucu rolü biliniyorsa o, yoksa JWT iddiası. */
  const roleOf = useCallback((session: Session): AppRole | null => {
    const server = serverRoleRef.current;
    return server && server.userId === userIdOf(session) ? server.role : jwtRole(session);
  }, []);

  const applySession = useCallback((session: Session | null) => {
    sessionRef.current = session;
    if (!session) {
      serverRoleRef.current = null;
      meUnreachableKeyRef.current = null;
      setState(SIGNED_OUT);
      return;
    }
    const server = serverRoleRef.current;
    // OSP-71: onay yalnızca aynı kullanıcı VE aynı oturum için geçerlidir. Aynı oturumun token
    // yenilemesi onayı korur; aynı kullanıcının yeni bir girişi (farklı session_id) korumaz.
    // `session_id` claim'i olmayan token'da confirmKeyOf null döner ve onay verilmez.
    const confirmKey = confirmKeyOf(session);
    const roleConfirmed =
      depsRef.current.mode === 'mock' ||
      (server !== null &&
        confirmKey !== null &&
        server.userId === userIdOf(session) &&
        server.sessionKey === confirmKey);
    const roleCheckUnreachable = meUnreachableKeyRef.current === sessionKeyOf(session);
    setState({
      status: 'signedIn',
      session,
      role: roleOf(session),
      connectionProblem: false,
      roleConfirmed,
      roleCheckUnreachable,
    });
  }, [roleOf]);

  /**
   * GET /api/v1/auth/me — the user's "option 2" decision (design D3): this lightweight endpoint
   * is the session check of the web dashboard, so AC-19 ("the very next API call signs the user
   * out") is observable even though the panels make no backend calls yet. We deliberately do NOT
   * ping GET /api/v1/victims or /api/v1/admin/users instead: GET /victims writes a victim-access
   * audit row on every call (OSP-65 / AC-28), which would pollute the audit log and download
   * sensitive data for nothing, and those endpoints belong to other stories.
   *
   * Errors are handled by the API client (401/403 -> refresh / re-bind / forced sign-out); here we
   * only apply the server role. Skipped in mock mode (no backend).
   */
  const checkMe = useCallback(async (): Promise<void> => {
    const d = depsRef.current;
    if (d.mode === 'mock') return;
    if (meInFlightRef.current) return meInFlightRef.current;
    lastMeStartRef.current = d.now();
    const startedFor = sessionRef.current ? sessionKeyOf(sessionRef.current) : null;
    // OSP-71: onay anahtarı ayrı tutulur (session_id yoksa null -> onay yok).
    const startedConfirmKey = sessionRef.current ? confirmKeyOf(sessionRef.current) : null;
    lastMeKeyRef.current = startedFor;
    // OSP-71: yeni bir kontrol başladı; periyodik zamanlayıcı bu andan itibaren 15 sn sayar.
    reschedulePeriodicRef.current?.();

    /**
     * OSP-71: "sunucuya ulaşılamıyor" işaretini günceller. Yalnızca soran oturum hâlâ geçerliyse
     * ve çıkışı beklemede değilse uygulanır (R2): başka bir oturumun geç gelen sonucu yeni oturumu
     * etkilemez. Hiçbir durumda oturumu kapatmaz.
     */
    const setUnreachable = (unreachable: boolean) => {
      const current = sessionRef.current;
      if (!current || startedFor === null || sessionKeyOf(current) !== startedFor) return;
      if (isLogoutPending(d.storage(), startedFor)) return;
      if (unreachable) meUnreachableKeyRef.current = startedFor;
      else if (meUnreachableKeyRef.current === startedFor) meUnreachableKeyRef.current = null;
      setState((prev) =>
        prev.session && sessionKeyOf(prev.session) === startedFor && prev.roleCheckUnreachable !== unreachable
          ? { ...prev, roleCheckUnreachable: unreachable }
          : prev,
      );
    };

    const run = (async () => {
      let result: Awaited<ReturnType<AuthProviderDeps['fetchMe']>>;
      try {
        result = await d.fetchMe();
      } catch (error) {
        // Never an unhandled rejection from a fire-and-forget check (review R16).
        if (import.meta.env.DEV) {
          console.warn('[AuthProvider] /auth/me check failed unexpectedly', {
            name: error instanceof Error ? error.name : typeof error,
          });
        }
        // OSP-71: beklenmeyen istisna da geçici hata gibi ele alınır (sunucuya ulaşıldığı
        // doğrulanamadı); /admin süresiz "Yükleniyor…"da kalmaz. Oturum kapanmaz.
        setUnreachable(true);
        return;
      }
      if (!result.ok) {
        // OSP-71: geçici hata (ağ, TIMEOUT, 5xx, 429) işareti koyar. Geçici olmayan bir sonuç
        // (HTTP_ERROR, FORBIDDEN, SESSION_CHANGED vb.) sunucunun erişilebilir olduğunu gösterir ve
        // işareti kaldırır. Kesin red (401/403 -> zorla çıkış) apiClient'ta eskisi gibi ele alınır;
        // o durumda oturum zaten bittiği için burada bir şey değişmez.
        setUnreachable(isTransientMeError(result.error.kind));
        return;
      }
      // OSP-71: 2xx cevap (biçimsiz gövde dahil) sunucunun erişilebilir olduğunu gösterir.
      setUnreachable(false);
      const body = result.data;
      if (!body || typeof body.role !== 'string' || typeof body.user_id !== 'string') return;

      // R2: apply the answer only to the session that asked, and only for the same user. A stale
      // answer (user A's, arriving while user B is signed in) must not sign B out.
      const session = sessionRef.current;
      if (!session || isLogoutPending(d.storage(), sessionKeyOf(session))) return;
      if (sessionKeyOf(session) !== startedFor || userIdOf(session) !== body.user_id) return;
      // Server role wins over the JWT claim. A non-web role must not use the dashboard.
      if (!isWebRole(body.role)) {
        await d.forceSignOut('ROLE_NOT_ALLOWED', session.access_token);
        return;
      }
      const role = body.role;
      serverRoleRef.current = { userId: body.user_id, sessionKey: startedConfirmKey, role };
      // OSP-71: cevap bu oturum için alındıysa (ve token'da session_id varsa) rol sunucu onaylıdır.
      setState((prev) =>
        prev.session && userIdOf(prev.session) === body.user_id
          ? {
              ...prev,
              role,
              roleConfirmed:
                prev.roleConfirmed ||
                (startedConfirmKey !== null && confirmKeyOf(prev.session) === startedConfirmKey),
            }
          : prev,
      );
    })();

    meInFlightRef.current = run.finally(() => {
      meInFlightRef.current = null;
    });
    return meInFlightRef.current;
  }, []);

  /**
   * OSP-71: açılış dışındaki tüm kontrol yollarının (visibility, focus, periyodik, giriş /
   * kurtarma sonrası, /login'den panele geçiş) ortak koruması. Kontrol yalnızca şu durumda gider:
   * oturum var, sekme görünür, /login'de değiliz (R12: orada giriş sürüyor olabilir) ve bu oturumun
   * çıkışı beklemede değil. `throttle` true ise aynı oturum için son kontrol 10 sn'den yeniyse
   * atlanır. Aynı anda tek istek kuralı (single-flight) checkMe içinde zaten uygulanır; mock mod da
   * checkMe içinde atlanır.
   */
  const guardedCheck = useCallback(
    (throttle: boolean) => {
      const d = depsRef.current;
      const session = sessionRef.current;
      if (!session) return;
      if (document.visibilityState !== 'visible') return;
      if (pathnameRef.current === '/login') return;
      const key = sessionKeyOf(session);
      if (isLogoutPending(d.storage(), key)) return;
      if (throttle) {
        const last = lastMeStartRef.current;
        if (last !== null && lastMeKeyRef.current === key && d.now() - last < ME_CHECK_MIN_INTERVAL_MS) {
          return;
        }
      }
      void checkMe();
    },
    [checkMe],
  );

  const runLogout = useCallback((timeoutMs: number, sessionKey: string | null): Promise<void> => {
    if (logoutInFlightRef.current) return logoutInFlightRef.current;
    const d = depsRef.current;
    // Late responses of this session must not refresh, re-bind or show a banner (review R2).
    if (sessionKey !== ANY_SESSION) d.markSessionEnded(sessionKey);
    const flow = performLogout(
      {
        sessionKey: sessionKey === ANY_SESSION ? null : sessionKey,
        storage: d.storage(),
        // Mock mode has no backend: skip POST /auth/logout like POST /auth/session is skipped.
        callLogoutEndpoint: d.mode === 'mock' ? async () => undefined : d.callLogoutEndpoint,
        signOut: d.signOut,
      },
      timeoutMs,
    ).then(() => {
      // A new sign-in may have happened meanwhile (R6): never "sign out" that session in the UI.
      const current = sessionRef.current;
      if (!current || sessionKey === ANY_SESSION || sessionKeyOf(current) === sessionKey) {
        applySession(null);
      }
    });
    logoutInFlightRef.current = flow.finally(() => {
      logoutInFlightRef.current = null;
    });
    return logoutInFlightRef.current;
  }, [applySession]);

  // Session bootstrap + subscription.
  useEffect(() => {
    const d = depsRef.current;
    let active = true;

    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    // OSP-71: giriş / kurtarma sonrası ertelenmiş kontrol zamanlayıcıları (unmount'ta temizlenir).
    const deferredChecks = new Set<ReturnType<typeof setTimeout>>();

    const unsubscribe = d.onAuthStateChange((event, session) => {
      // Synchronous state updates only. Never await a Supabase call inside this callback
      // (known supabase-js deadlock). If async work is ever needed here, defer it with
      // setTimeout(..., 0).
      if (!active) return;
      // The startup getSession() decides the initial state: a null INITIAL_SESSION is also what
      // supabase-js reports when it could not refresh an expiring token offline (R4).
      if (event === 'INITIAL_SESSION' && !session) return;
      if (!session) {
        applySession(null);
        return;
      }
      // While THIS session's logout is pending it must never turn into protected UI.
      const pending = pendingLogoutKey(d.storage());
      if (pending !== null) {
        if (pending === ANY_SESSION || pending === sessionKeyOf(session)) return;
        // A different session = a new sign-in: it ends the old pending logout (review R6), so a
        // later reload does not log the new session out.
        clearLogoutPending(d.storage());
      }
      // A real sign-in from the signed-out state (not a token refresh of a session being signed
      // out) is a live session, even if its identity was ended before (sub fallback, R2).
      if (event === 'SIGNED_IN' && !sessionRef.current) d.clearSessionEnded(sessionKeyOf(session));
      // OSP-71: yalnızca açılış kurtarmasını (R4) çözen TOKEN_REFRESHED sonrası sunucuyla bir kez
      // doğrula: oturum zaten bu sekmede kayıtlıydı, sadece okunamıyordu. SIGNED_IN burada BİLEREK
      // tetiklemez: oturumu olmayan sekme /login'dedir; panel yolunda `loading`'de bekleyen bir
      // sekmeye gelen SIGNED_IN ise başka bir sekmedeki girişin yayınıdır ve o sekmenin
      // POST /auth/session'ı henüz bitmemiş olabilir. Hemen /auth/me göndermek 403
      // SESSION_NOT_BOUND, gereksiz bir rebind (rate limit + fazladan LOGIN audit satırı) demektir.
      // Yeni girişi /login'den panele geçiş kontrolü ve periyodik kontrol karşılar. Oturumu zaten
      // olan bir sekmedeki TOKEN_REFRESHED (supabase-js'in olağan yenilemesi) de tetiklemez.
      const recoversSession = !sessionRef.current && event === 'TOKEN_REFRESHED';
      applySession(session);
      if (recoversSession) {
        // Bu callback içinde Supabase çağrısı beklenmemeli (supabase-js kilitlenmesi); checkMe
        // erişim token'ını okuyacağı için setTimeout(..., 0) ile erteliyoruz (unmount'ta silinir).
        // /login'de guardedCheck atlar; o durumda panele geçiş (pathname değişimi) kontrol eder.
        // Throttle'lı: açılıştaki getSession kontrolüyle çakışırsa ikinci istek gitmez.
        const timer = setTimeout(() => {
          deferredChecks.delete(timer);
          if (active) guardedCheck(true);
        }, 0);
        deferredChecks.add(timer);
      }
    });

    const pending = pendingLogoutKey(d.storage());
    const stored = d.storedSessionKey();
    if (pending !== null && pending !== ANY_SESSION && stored !== null && stored !== pending) {
      // The flag belongs to an older session; the stored one is a newer sign-in (R6): keep it.
      clearLogoutPending(d.storage());
    }
    if (isLogoutPending(d.storage())) {
      // Interrupted logout (browser closed / reloaded during POST /auth/logout): finish it first.
      // Status stays "loading" until it is done, so no protected UI is rendered.
      void runLogout(STARTUP_LOGOUT_TIMEOUT_MS, pendingLogoutKey(d.storage()));
    } else {
      const load = () => {
        void d.getSession().then(
          (session) => {
            if (!active || (session && isLogoutPending(d.storage(), sessionKeyOf(session)))) return;
            applySession(session);
            // R12: not on /login, where a sign-in may be in progress.
            if (session && pathnameRef.current !== '/login') void checkMe();
          },
          () => {
            // R4: the session could not be read for a transient reason. It is still stored, so
            // this is NOT "signed out": stay loading and try again. A TOKEN_REFRESHED / SIGNED_IN
            // event from supabase-js (network back) ends this state too.
            if (!active || sessionRef.current) return;
            setState((prev) => (prev.status === 'loading' ? { ...prev, connectionProblem: true } : prev));
            const delay = SESSION_RETRY_DELAYS_MS[Math.min(retries, SESSION_RETRY_DELAYS_MS.length - 1)];
            retries += 1;
            retryTimer = setTimeout(() => {
              if (active && !sessionRef.current) load();
            }, delay);
          },
        );
      };
      load();
    }

    return () => {
      active = false;
      clearTimeout(retryTimer);
      deferredChecks.forEach((timer) => clearTimeout(timer));
      deferredChecks.clear();
      unsubscribe();
    };
  }, [applySession, checkMe, guardedCheck, runLogout]);

  // Forced sign-outs navigate through the router.
  useEffect(
    () =>
      depsRef.current.setLoginNavigator(() => {
        if (pathnameRef.current !== '/login') navigate('/login', { replace: true });
      }),
    [navigate],
  );

  // Sekme tekrar görünür olunca veya pencereye dönülünce (OSP-71: `focus`) sunucuyla yeniden
  // kontrol et. İkisi de aynı throttle'ı (aynı oturum için 10 sn) kullanır; pencereye dönüşte
  // genellikle ikisi birden tetiklenir ve böylece tek istek gider.
  useEffect(() => {
    const handleReturn = () => guardedCheck(true);
    document.addEventListener('visibilitychange', handleReturn);
    window.addEventListener('focus', handleReturn);
    return () => {
      document.removeEventListener('visibilitychange', handleReturn);
      window.removeEventListener('focus', handleReturn);
    };
  }, [guardedCheck]);

  // OSP-71 (AC-19): periyodik kontrol. Yalnızca oturum açıkken, /login dışında, mock mod değilken
  // ve sekme görünürken çalışır. Sekme gizlenince zamanlayıcı durur (gereksiz istek yok); görünür
  // olunca yukarıdaki visibility yolu hemen kontrol eder ve periyot yeniden başlar. Oturum kapanınca
  // (signOut / zorla çıkış -> status signedOut), /login'e geçince veya unmount'ta efekt temizlenir
  // ve zamanlayıcı silinir. Her sekme kendi zamanlayıcısını yönetir.
  const periodicActive =
    state.status === 'signedIn' && location.pathname !== '/login' && deps.mode !== 'mock';
  useEffect(() => {
    if (!periodicActive) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    // Zamanlayıcıyı sıfırdan kurar; sekme gizliyse kurmaz.
    const schedule = () => {
      stop();
      if (document.visibilityState !== 'visible') return;
      timer = setTimeout(tick, ME_CHECK_INTERVAL_MS);
    };
    function tick() {
      timer = undefined;
      // Önce bir sonraki turu kur: istek uçuştaysa checkMe yeni istek başlatmaz (single-flight)
      // ve zamanlayıcıyı da yeniden kurmaz; periyot yine de devam etmeli.
      schedule();
      // Throttle yok: periyodun kendisi zaten son kontrolden 15 sn sonrasıdır.
      guardedCheck(false);
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') schedule();
      else stop();
    };
    reschedulePeriodicRef.current = schedule;
    document.addEventListener('visibilitychange', handleVisibility);
    schedule();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
      if (reschedulePeriodicRef.current === schedule) reschedulePeriodicRef.current = null;
    };
  }, [periodicActive, guardedCheck]);

  // OSP-71: kullanıcı /login'den panele geçtiğinde (yeni giriş tamamlandı ya da kayıtlı oturumla
  // /login'den yönlendirildi) bir kez kontrol et. /login'de kontrol yapılmadığı (R12) için bu
  // geçiş, yeni oturumun sunucuda doğrulandığı ilk andır. Throttle aynı oturum için çift isteği önler.
  const previousPathRef = useRef(location.pathname);
  useEffect(() => {
    const previous = previousPathRef.current;
    previousPathRef.current = location.pathname;
    if (previous === '/login' && location.pathname !== '/login' && state.status === 'signedIn') {
      guardedCheck(true);
    }
  }, [location.pathname, state.status, guardedCheck]);

  const logout = useCallback(
    () =>
      runLogout(LOGOUT_TIMEOUT_MS, sessionRef.current ? sessionKeyOf(sessionRef.current) : ANY_SESSION),
    [runLogout],
  );

  const revalidate = useCallback(async () => {
    const d = depsRef.current;
    let session: Session | null;
    try {
      session = await d.getSession();
    } catch {
      return; // R4: unknown (transient) is not "signed out": keep the current state
    }
    if (session && isLogoutPending(d.storage(), sessionKeyOf(session))) return;
    applySession(session);
  }, [applySession]);

  const signOutDisallowedRole = useCallback(async () => {
    const d = depsRef.current;
    const session = sessionRef.current;
    if (!session || isLogoutPending(d.storage(), sessionKeyOf(session))) return;
    // Yarış koruması: istek ile bu çağrı arasında rol web rolüne döndüyse (ör. sunucu onayı ya da
    // başka bir kullanıcının girişi) o oturum kapatılmaz.
    if (roleOf(session) !== 'rescuer') return;
    await d.forceSignOut('ROLE_NOT_ALLOWED', session.access_token);
  }, [roleOf]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, logout, revalidate, signOutDisallowedRole }),
    [state, logout, revalidate, signOutDisallowedRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
