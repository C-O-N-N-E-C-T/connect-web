import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (see .env.example)');
}

/**
 * localStorage key of the persisted Supabase session. This is exactly supabase-js 2.119's default
 * (`sb-<first label of the project host>-auth-token`, see `SupabaseClient` constructor); it is set
 * explicitly so the app can remove the session itself if `signOut` hangs (src/auth/authRuntime.ts)
 * and existing sessions keep working.
 */
export const SUPABASE_AUTH_STORAGE_KEY = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;

/** Browser client: anon key only. The service_role key must never reach this app. */
export const supabase = createClient(url, anonKey, {
  auth: { storageKey: SUPABASE_AUTH_STORAGE_KEY },
});
