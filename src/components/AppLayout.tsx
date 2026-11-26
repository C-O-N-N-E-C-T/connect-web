import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { ACCESS_DENIED_MESSAGE, isAccessDeniedState } from '../auth/accessDenied';
import { SupplementaryDisclaimer } from './SupplementaryDisclaimer';

/**
 * Shared shell for every authenticated panel view. The disclaimer lives here so
 * no main view can omit it (AC-29: 100% of main layout views).
 */
export function AppLayout({ title, children }: { title: string; children?: ReactNode }) {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const loggingOutRef = useRef(false);
  const location = useLocation();
  // OSP-71: yetkisiz bir sayfadan (ör. coordinator -> /admin) buraya yönlendirildiysek uyarı
  // gösterilir. Değer ilk render'da navigation state'inden okunur ve bileşen yaşadıkça kalır.
  const [accessDenied] = useState(() => isAccessDeniedState(location.state));

  // State aşağıdaki efektte geçmişten silinir: BrowserRouter state'i history'de tuttuğu için,
  // silinmezse sayfa yenilendiğinde uyarı yeniden çıkardı. Okumayı başlangıç değerinde, silmeyi
  // efektte yapmak StrictMode'un çift çalıştırmasında da uyarıyı görünür bırakır.
  useEffect(() => {
    if (isAccessDeniedState(location.state)) {
      navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: null },
      );
    }
  }, [location, navigate]);

  // Logout flow D1/D2 (see src/auth/logout.ts): never gets stuck, always ends on /login.
  async function handleLogout() {
    if (loggingOutRef.current) return; // ignore double clicks
    loggingOutRef.current = true;
    setLoggingOut(true);
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <main>
      <header>
        <h1>{title}</h1>
        <button type="button" onClick={handleLogout} disabled={loggingOut}>
          {loggingOut ? 'Çıkış yapılıyor…' : 'Çıkış yap'}
        </button>
      </header>
      <SupplementaryDisclaimer />
      {accessDenied && (
        <div role="alert" className="banner-error panel-banner">
          {ACCESS_DENIED_MESSAGE}
        </div>
      )}
      {children}
    </main>
  );
}
