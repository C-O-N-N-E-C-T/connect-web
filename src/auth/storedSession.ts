import { readSessionKey } from '../lib/jwt';

/**
 * Identity (session_id, else sub) of a raw persisted supabase-js session value, or null when there
 * is none. A value that cannot be parsed is its own identity (so any change counts as a change).
 * Shared by authRuntime (reading storage) and AuthProvider (cross-tab `storage` events, OSP-72 R21).
 */
export function sessionKeyFromStoredValue(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const token = (JSON.parse(raw) as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== 'string') return raw;
    return readSessionKey(token) ?? raw;
  } catch {
    return raw;
  }
}
