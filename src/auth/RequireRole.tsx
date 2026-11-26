import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { can, type PermissionAction } from '../lib/permissions';
import { isWebRole, routeForRole } from '../lib/roles';
import { ACCESS_DENIED_STATE } from './accessDenied';
import { useAuth, type RoleCheckStatus } from './AuthProvider';

// OSP-71: rol onayı beklenirken gösterilen metinler (RoleCheckStatus'a göre).
const WAITING_MESSAGES: Record<Exclude<RoleCheckStatus, 'missingSessionId'>, string> = {
  pending: 'Yükleniyor…',
  unreachable: 'Sunucuya ulaşılamıyor. Yeniden deneniyor…',
  failed: 'Rol doğrulanamadı. Yeniden deneniyor…',
};

/**
 * OSP-71: token'da `session_id` yoksa rol hiçbir zaman onaylanamaz. Süresiz bekleme yerine açık
 * bir hata ve mevcut güvenli çıkış akışını (AuthProvider `logout`, D1/D2) başlatan bir buton
 * gösterilir. Otomatik çıkış YAPILMAZ; kullanıcı karar verir.
 */
function MissingSessionIdNotice() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const loggingOutRef = useRef(false);

  async function handleLogout() {
    if (loggingOutRef.current) return; // çift tıklamayı yok say
    loggingOutRef.current = true;
    setLoggingOut(true);
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div role="alert" className="banner-error">
      <p>Oturum bilgisi eksik. Lütfen çıkış yapıp yeniden giriş yapın.</p>
      <button type="button" onClick={handleLogout} disabled={loggingOut}>
        {loggingOut ? 'Çıkış yapılıyor…' : 'Çıkış yap'}
      </button>
    </div>
  );
}

/**
 * UI-level route guard. It only hides screens. The backend still enforces RBAC
 * on every API call (FR-B-06).
 *
 * Session and role come from AuthProvider (server role from GET /auth/me when known, otherwise
 * the JWT claim).
 *
 * OSP-71: yetki, tekil rol matrisinden (`src/lib/permissions.ts`, backend OSP-62 ile aynı) okunur:
 * - Oturum yok -> /login (AC-19).
 * - Rol `rescuer` (JWT'den gelse bile) -> oturum ROLE_NOT_ALLOWED ile zorla kapatılır ve /login'e
 *   gidilir; /login bu gerekçeyi gösterir. Çıkış render sırasında değil, efekt içinde başlatılır.
 * - Bilinmeyen / eksik rol -> /login (güvenli taraf).
 * - Mevcut rol (sunucu rolü ya da JWT) `action` için yetkisizse (ör. coordinator -> /admin) onay
 *   BEKLENMEDEN rolün ana sayfasına (`routeForRole`) gidilir ve orada "Bu sayfaya erişim
 *   yetkiniz yok." uyarısı gösterilir; oturum açık kalır. Erken reddetmek güvenli yöndür (hiçbir
 *   şey açmaz); sunucuya ulaşılamasa da coordinator bekleme ekranında takılmaz.
 * - `requireConfirmedRole` verilmişse ve mevcut rol yetkili görünüyorsa (ör. JWT administrator),
 *   içerik ancak rol GET /auth/me ile bu oturum için onaylanınca gösterilir. Beklerken
 *   `roleCheckStatus`'a göre "Yükleniyor…", "Sunucuya ulaşılamıyor…", "Rol doğrulanamadı…" ya da
 *   (session_id yoksa) çıkış butonlu bir hata gösterilir; oturum kapanmaz.
 *
 * The session is re-checked when the page is restored from the browser's back/forward
 * cache (`pageshow` with `persisted`). Without this, pressing Back after logout could
 * show the last panel view from cache.
 */
export function RequireRole({
  action,
  requireConfirmedRole = false,
  children,
}: {
  action: PermissionAction;
  /** true ise rol sunucuda (GET /auth/me) onaylanmadan içerik gösterilmez. */
  requireConfirmedRole?: boolean;
  children: ReactNode;
}) {
  const { status, role, roleConfirmed, roleCheckStatus, revalidate, connectionProblem, signOutDisallowedRole } =
    useAuth();
  const location = useLocation();
  const disallowedRole = status === 'signedIn' && role === 'rescuer';

  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        void revalidate();
      }
    }
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [revalidate]);

  // OSP-71: rescuer web paneline alınmaz. Zorla çıkış bir yan etki olduğu için efektte başlatılır;
  // forceSignOut tekil uçuşludur (single-flight) ve biten oturumu yok sayar, bu yüzden StrictMode'un
  // çift efekti ya da aynı anda gelen /auth/me cevabı ikinci bir çıkış/mesaj üretmez.
  useEffect(() => {
    if (disallowedRole) void signOutDisallowedRole();
  }, [disallowedRole, signOutDisallowedRole]);

  if (status === 'loading') {
    return connectionProblem ? (
      <p role="status">Sunucuya ulaşılamıyor. Yeniden deneniyor…</p>
    ) : (
      <p role="status">Yükleniyor…</p>
    );
  }
  if (status === 'signedOut') return <Navigate to="/login" replace />;
  // Rescuer ve bilinmeyen roller: panel hiç gösterilmeden /login (rescuer için çıkış efektte).
  if (!isWebRole(role)) return <Navigate to="/login" replace />;
  // OSP-71: yetkisizlik onaydan ÖNCE kontrol edilir (erken red güvenli yöndür).
  if (!can(role, action)) {
    const home = routeForRole(role);
    // Döngü koruması: rolün ana sayfası da bu korumaya takılıyorsa (matris hatası) /login'e git.
    if (home === location.pathname) return <Navigate to="/login" replace />;
    return <Navigate to={home} replace state={ACCESS_DENIED_STATE} />;
  }
  // İzin ise yalnızca sunucu onayından sonra verilir.
  if (requireConfirmedRole && !roleConfirmed) {
    if (roleCheckStatus === 'missingSessionId') return <MissingSessionIdNotice />;
    // Bekleme metinleri ekran okuyucuya duyurulsun diye role="status"; periyodik / focus
    // kontrolü yeniden dener, oturum açık kalır.
    return <p role="status">{WAITING_MESSAGES[roleCheckStatus]}</p>;
  }
  return <>{children}</>;
}
