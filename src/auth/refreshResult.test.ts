import { describe, expect, it } from 'vitest';
import {
  AuthApiError,
  AuthRefreshDiscardedError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
  type Session,
} from '@supabase/supabase-js';
import { classifyRefresh } from './refreshResult';

const session = { access_token: 'new-token' } as Session;
const failed = (error: unknown) => classifyRefresh({ data: { session: null }, error });

describe('classifyRefresh (D4a, real auth-js error classes)', () => {
  it('returns the new token on success', () => {
    expect(classifyRefresh({ data: { session }, error: null })).toEqual({ ok: true, accessToken: 'new-token' });
  });

  it('treats success without a session as definitive', () => {
    expect(classifyRefresh({ data: { session: null }, error: null })).toEqual({ ok: false, definitive: true });
  });

  it.each([
    ['invalid refresh token (400)', new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found')],
    ['refresh token already used (400)', new AuthApiError('Already Used', 400, 'refresh_token_already_used')],
    ['forbidden (403)', new AuthApiError('Forbidden', 403, undefined)],
    ['session_not_found / no refresh token', new AuthSessionMissingError()],
  ])('is definitive for %s', (_name, error) => {
    expect(failed(error)).toEqual({ ok: false, definitive: true });
  });

  it.each([
    ['network failure', new AuthRetryableFetchError('Failed to fetch', 0), { kind: 'NETWORK_ERROR' }],
    ['502', new AuthRetryableFetchError('Bad Gateway', 502), { kind: 'SERVER_ERROR', status: 502 }],
    ['503', new AuthRetryableFetchError('Unavailable', 503), { kind: 'SERVER_ERROR', status: 503 }],
    ['other 5xx', new AuthApiError('HTTP Version', 505, undefined), { kind: 'SERVER_ERROR', status: 505 }],
    ['429', new AuthApiError('Too many', 429, 'over_request_rate_limit'), { kind: 'RATE_LIMITED', status: 429 }],
    ['discarded refresh', new AuthRefreshDiscardedError(), { kind: 'NETWORK_ERROR' }],
    ['unknown error', new AuthUnknownError('bad json', null), { kind: 'NETWORK_ERROR' }],
  ])('is transient for %s', (_name, error, expected) => {
    expect(failed(error)).toEqual({ ok: false, definitive: false, ...expected });
  });
});
