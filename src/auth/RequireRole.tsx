import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { can, type PermissionAction } from '../lib/permissions';
import { isWebRole, routeForRole } from '../lib/roles';
import { ACCESS_DENIED_STATE } from './accessDenied';
import { useAuth } from './AuthProvider';

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
 * - `requireConfirmedRole` verilmişse rol GET /auth/me ile bu oturum için onaylanana kadar
 *   "Yükleniyor…" gösterilir (ör. /admin: JWT'deki eski bir yönetici iddiası ekranı açmasın).
 *   /auth/me geçici hata verdiyse (ağ, TIMEOUT, 5xx, 429) bunun yerine "Sunucuya ulaşılamıyor.
 *   Yeniden deneniyor…" gösterilir; oturum kapanmaz.
 * - Web rolü ama `action` için yetkisiz (ör. coordinator -> /admin) -> rolün ana sayfasına
 *   (`routeForRole`) gidilir ve orada "Bu sayfaya erişim yetkiniz yok." uyarısı gösterilir. Oturum
 *   açık kalır.
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
  const { status, role, roleConfirmed, roleCheckUnreachable, revalidate, connectionProblem, signOutDisallowedRole } =
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
  if (requireConfirmedRole && !roleConfirmed) {
    // OSP-71: son /auth/me geçici hatayla bittiyse süresiz "Yükleniyor…" yerine bağlantı sorunu
    // gösterilir (oturum açık kalır; periyodik / focus kontrolü yeniden dener). Bekleme metinleri
    // ekran okuyucuya duyurulsun diye role="status".
    return roleCheckUnreachable ? (
      <p role="status">Sunucuya ulaşılamıyor. Yeniden deneniyor…</p>
    ) : (
      <p role="status">Yükleniyor…</p>
    );
  }
  if (!can(role, action)) {
    const home = routeForRole(role);
    // Döngü koruması: rolün ana sayfası da bu korumaya takılıyorsa (matris hatası) /login'e git.
    if (home === location.pathname) return <Navigate to="/login" replace />;
    return <Navigate to={home} replace state={ACCESS_DENIED_STATE} />;
  }
  return <>{children}</>;
}
