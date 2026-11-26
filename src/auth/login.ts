import { readUserRole } from '../lib/jwt';
import { isWebRole, routeForRole } from '../lib/roles';
import type { RegisterSessionResult, SessionErrorCode } from '../services/authSessionClient';

export type SignInFailure = 'INVALID_CREDENTIALS' | 'NETWORK_ERROR' | 'UNKNOWN';

/** Includes the forced sign-out reasons (OSP-70) so /login can show why the session ended. */
export type LoginErrorCode = SignInFailure | 'ROLE_NOT_ALLOWED' | 'SESSION_EXPIRED' | SessionErrorCode;

export type LoginResult = { ok: true; route: string } | { ok: false; code: LoginErrorCode };

/**
 * Maps a Supabase auth error to a UI error code.
 * 4xx = the server answered and rejected the credentials.
 * No HTTP status (or 0) = the request never got a response, i.e. a network failure.
 */
export function classifySignInError(error: { status?: number }): SignInFailure {
  const status = error.status;
  if (typeof status !== 'number' || status === 0) return 'NETWORK_ERROR';
  if (status >= 400 && status < 500) return 'INVALID_CREDENTIALS';
  return 'UNKNOWN';
}

/** Dependencies are injected so the flow can be unit-tested without Supabase or fetch. */
export interface LoginDeps {
  signIn(email: string, password: string): Promise<{ accessToken: string } | { error: SignInFailure }>;
  /** Must sign out with `scope: 'local'` (design D2). */
  signOut(): Promise<void>;
  registerSession(accessToken: string): Promise<RegisterSessionResult>;
}

/**
 * Login order matters:
 *  1. Supabase password check.
 *  2. Role check from the signed JWT claim. Rescuers are rejected BEFORE
 *     /auth/session is called, so they never create a web session.
 *  3. Browser session registration (OSP-60).
 *  4. Route by role.
 */
export async function loginWithPassword(
  email: string,
  password: string,
  deps: LoginDeps,
): Promise<LoginResult> {
  const signedIn = await deps.signIn(email, password);
  if ('error' in signedIn) {
    return { ok: false, code: signedIn.error };
  }

  const role = readUserRole(signedIn.accessToken);
  if (!isWebRole(role)) {
    await deps.signOut();
    return { ok: false, code: 'ROLE_NOT_ALLOWED' };
  }

  const registered = await deps.registerSession(signedIn.accessToken);
  if (!registered.ok) {
    await deps.signOut();
    return { ok: false, code: registered.code };
  }

  return { ok: true, route: routeForRole(role) };
}

export const LOGIN_ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  INVALID_CREDENTIALS: 'E-posta veya şifre hatalı.',
  ROLE_NOT_ALLOWED: 'Saha kurtarıcı hesapları web panelinden giriş yapamaz.',
  ACCOUNT_DISABLED: 'Hesabınız devre dışı bırakıldı. Yöneticinize başvurun.',
  DEVICE_REVOKED: 'Bu cihazın erişimi iptal edildi.',
  RATE_LIMITED: 'Çok fazla deneme yapıldı. Lütfen bir dakika sonra tekrar deneyin.',
  SESSION_NOT_BOUND: 'Oturum cihaza bağlanamadı. Tekrar giriş yapın.',
  SESSION_EXPIRED: 'Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.',
  NETWORK_ERROR: 'Bağlantı kurulamadı. İnternet bağlantınızı kontrol edin.',
  UNKNOWN: 'Beklenmeyen bir hata oluştu.',
};
