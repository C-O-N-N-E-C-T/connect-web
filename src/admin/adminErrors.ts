/**
 * OSP-72: maps an ApiError of an admin call to the Turkish text shown next to the action.
 * Sign-out, refresh and re-bind already happened in apiClient (OSP-70); SIGNED_OUT and
 * SESSION_CHANGED therefore show nothing (the app is already leaving the page).
 */
import { ROLE_FORBIDDEN_MESSAGE, type ApiError } from '../services/apiClient';

export type AdminAction = 'load' | 'createUser' | 'loadDevices' | 'revokeDevice' | 'revokeAll' | 'reactivate';

export const SELF_REVOKE_MESSAGE = 'Kendi hesabınızı devre dışı bırakamazsınız.';
export const DUPLICATE_EMAIL_MESSAGE = 'Bu e-posta adresiyle kayıtlı bir hesap zaten var.';

export function adminErrorMessage(error: ApiError, action: AdminAction): string | null {
  switch (error.kind) {
    case 'SIGNED_OUT':
    case 'SESSION_CHANGED':
      return null;
    case 'ROLE_FORBIDDEN':
      return ROLE_FORBIDDEN_MESSAGE;
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
      return 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.';
    case 'RATE_LIMITED':
      return 'Çok fazla istek gönderildi. Lütfen biraz sonra tekrar deneyin.';
    default:
      break;
  }
  if (error.status === 409) {
    if (action === 'createUser') return DUPLICATE_EMAIL_MESSAGE;
    if (action === 'revokeAll') return SELF_REVOKE_MESSAGE;
  }
  if (error.status === 404) {
    return action === 'revokeDevice' ? 'Cihaz bulunamadı.' : 'Kullanıcı bulunamadı.';
  }
  if (error.status === 400) return 'Gönderilen bilgiler geçersiz.';
  if (error.kind === 'SERVER_ERROR') {
    if (action === 'createUser') {
      return 'Hesap oluşturulamadı. Şifre güvenlik kurallarını karşılamıyor olabilir; tekrar deneyin.';
    }
    if (action === 'revokeAll') {
      return 'İşlem tamamlanamadı. Hesap devre dışı bırakılmış olabilir; lütfen tekrar deneyin.';
    }
    return 'Sunucu hatası. Lütfen tekrar deneyin.';
  }
  return 'Beklenmeyen bir hata oluştu.';
}
