import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { SupplementaryDisclaimer } from './SupplementaryDisclaimer';

/**
 * Shared shell for every authenticated panel view. The disclaimer lives here so
 * no main view can omit it (AC-29: 100% of main layout views).
 */
export function AppLayout({ title, children }: { title: string; children?: ReactNode }) {
  const navigate = useNavigate();

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <main>
      <header>
        <h1>{title}</h1>
        <button type="button" onClick={handleLogout}>
          Çıkış yap
        </button>
      </header>
      <SupplementaryDisclaimer />
      {children}
    </main>
  );
}
