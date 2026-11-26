import { describe, expect, it } from 'vitest';
import { adminErrorMessage, type AdminAction } from './adminErrors';
import { ROLE_FORBIDDEN_MESSAGE, type ApiError } from '../services/apiClient';

const NETWORK = 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.';

// OSP-72: every ApiError of an admin call maps to one text (or nothing).
describe('adminErrorMessage', () => {
  it.each<[string, ApiError, AdminAction, string | null]>([
    ['signed out', { kind: 'SIGNED_OUT', reason: 'DEVICE_REVOKED' }, 'load', null],
    ['session changed', { kind: 'SESSION_CHANGED' }, 'revokeAll', null],
    ['role forbidden', { kind: 'ROLE_FORBIDDEN', status: 403 }, 'createUser', ROLE_FORBIDDEN_MESSAGE],
    ['network', { kind: 'NETWORK_ERROR' }, 'load', NETWORK],
    ['timeout', { kind: 'TIMEOUT' }, 'reactivate', NETWORK],
    ['rate limited', { kind: 'RATE_LIMITED', status: 429 }, 'load', 'Çok fazla istek gönderildi. Lütfen biraz sonra tekrar deneyin.'],
    ['409 create', { kind: 'HTTP_ERROR', status: 409 }, 'createUser', 'Bu e-posta adresiyle kayıtlı bir hesap zaten var.'],
    ['409 revoke-all', { kind: 'HTTP_ERROR', status: 409 }, 'revokeAll', 'Kendi hesabınızı devre dışı bırakamazsınız.'],
    ['409 other', { kind: 'HTTP_ERROR', status: 409 }, 'load', 'Beklenmeyen bir hata oluştu.'],
    ['404 device', { kind: 'HTTP_ERROR', status: 404 }, 'revokeDevice', 'Cihaz bulunamadı.'],
    ['404 user', { kind: 'HTTP_ERROR', status: 404 }, 'loadDevices', 'Kullanıcı bulunamadı.'],
    ['404 reactivate', { kind: 'HTTP_ERROR', status: 404 }, 'reactivate', 'Kullanıcı bulunamadı.'],
    ['400', { kind: 'HTTP_ERROR', status: 400 }, 'load', 'Gönderilen bilgiler geçersiz.'],
    [
      '500 create',
      { kind: 'SERVER_ERROR', status: 500 },
      'createUser',
      'Hesap oluşturulamadı. Şifre güvenlik kurallarını karşılamıyor olabilir; tekrar deneyin.',
    ],
    [
      '500 revoke-all',
      { kind: 'SERVER_ERROR', status: 500 },
      'revokeAll',
      'İşlem tamamlanamadı. Hesap devre dışı bırakılmış olabilir; lütfen tekrar deneyin.',
    ],
    ['500 other', { kind: 'SERVER_ERROR', status: 503 }, 'load', 'Sunucu hatası. Lütfen tekrar deneyin.'],
    ['invalid response', { kind: 'INVALID_RESPONSE', status: 200 }, 'load', 'Beklenmeyen bir hata oluştu.'],
    ['forbidden', { kind: 'FORBIDDEN', status: 403 }, 'load', 'Beklenmeyen bir hata oluştu.'],
  ])('%s', (_label, error, action, expected) => {
    expect(adminErrorMessage(error, action)).toBe(expected);
  });
});
