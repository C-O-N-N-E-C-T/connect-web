import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
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
      {children}
    </main>
  );
}
