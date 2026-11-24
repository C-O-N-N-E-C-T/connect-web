import { useEffect, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { isWebRole, type WebRole } from '../lib/roles';
import { useAuth } from './AuthProvider';

/**
 * UI-level route guard. It only hides screens. The backend still enforces RBAC
 * on every API call (FR-B-06).
 *
 * Session and role come from AuthProvider (server role from GET /auth/me when known, otherwise
 * the JWT claim).
 *
 * The session is re-checked when the page is restored from the browser's back/forward
 * cache (`pageshow` with `persisted`). Without this, pressing Back after logout could
 * show the last panel view from cache.
 */
export function RequireRole({ allow, children }: { allow: WebRole[]; children: ReactNode }) {
  const { status, role, revalidate } = useAuth();

  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        void revalidate();
      }
    }
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [revalidate]);

  if (status === 'loading') return <p>Yükleniyor…</p>;
  if (status === 'signedOut') return <Navigate to="/login" replace />;
  if (!isWebRole(role) || !allow.includes(role)) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
