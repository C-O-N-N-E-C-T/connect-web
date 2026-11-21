import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { readUserRole } from '../lib/jwt';
import { isWebRole, type WebRole } from '../lib/roles';

type GuardState = 'checking' | 'allowed' | 'denied';

/**
 * UI-level route guard. It only hides screens. The backend still enforces RBAC
 * on every API call (FR-B-06).
 *
 * The session is re-checked when the page is restored from the browser's back/forward
 * cache (`pageshow` with `persisted`). Without this, pressing Back after logout could
 * show the last panel view from cache.
 */
export function RequireRole({ allow, children }: { allow: WebRole[]; children: ReactNode }) {
  const [state, setState] = useState<GuardState>('checking');

  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const token = data.session?.access_token;
      if (!token) return setState('denied');
      const role = readUserRole(token);
      setState(isWebRole(role) && allow.includes(role) ? 'allowed' : 'denied');
    }

    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        void checkSession();
      }
    }

    void checkSession();
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      cancelled = true;
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [allow]);

  if (state === 'checking') return <p>Yükleniyor…</p>;
  if (state === 'denied') return <Navigate to="/login" replace />;
  return <>{children}</>;
}
