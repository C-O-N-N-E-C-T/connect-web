/** OSP-72: Turkish display labels for roles and audit action types. */
import type { AuditActionType } from '../services/adminApi';

export const ROLE_LABELS: Record<string, string> = {
  rescuer: 'Kurtarıcı',
  coordinator: 'Koordinatör',
  administrator: 'Yönetici',
};

/** Label of a role; an unknown role is shown verbatim, a missing one as "—". */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—';
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, role) ? ROLE_LABELS[role] : role;
}

export const ACTION_TYPE_LABELS: Record<AuditActionType, string> = {
  LOGIN: 'Giriş',
  LOGOUT: 'Çıkış',
  LOGIN_REJECTED: 'Reddedilen giriş',
  USER_CREATED: 'Kullanıcı oluşturuldu',
  DEVICE_REVOKED: 'Cihaz iptal edildi',
  ACCOUNT_DISABLED: 'Hesap devre dışı bırakıldı',
  USER_REACTIVATED: 'Hesap yeniden etkinleştirildi',
  VICTIM_LIST_VIEW: 'Kazazede listesi görüntülendi',
  VICTIM_VIEW: 'Kazazede kaydı görüntülendi',
  VICTIM_UPDATE: 'Kazazede kaydı güncellendi',
  RETENTION_PURGE: 'Saklama süresi temizliği',
  OBSERVATION_SYNC: 'Gözlem senkronizasyonu',
};

/** Label of a known action type, or null for an unknown one (shown verbatim by the caller). */
export function actionTypeLabel(actionType: string): string | null {
  return Object.prototype.hasOwnProperty.call(ACTION_TYPE_LABELS, actionType)
    ? ACTION_TYPE_LABELS[actionType as AuditActionType]
    : null;
}
