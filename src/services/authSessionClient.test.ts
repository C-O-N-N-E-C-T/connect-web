import { describe, expect, it, vi } from 'vitest';
import { registerBrowserSession } from './authSessionClient';

const input = { deviceId: 'd-1', deviceName: 'test-browser' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('registerBrowserSession', () => {
  it('returns ok without a network call in mock mode', async () => {
    const fetchImpl = vi.fn();
    const result = await registerBrowserSession(input, 'token', { mode: 'mock', fetchImpl });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the bearer token and device payload in real mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const result = await registerBrowserSession(input, 'tok', {
      mode: 'real',
      apiBaseUrl: 'http://api.test',
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://api.test/api/v1/auth/session');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ device_id: 'd-1', device_name: 'test-browser' });
  });

  it('maps ACCOUNT_DISABLED from the error body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { error_code: 'ACCOUNT_DISABLED', message: 'x' }));
    const result = await registerBrowserSession(input, 'tok', { mode: 'real', fetchImpl });
    expect(result).toEqual({ ok: false, code: 'ACCOUNT_DISABLED' });
  });

  it('maps DEVICE_REVOKED from the error body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { error_code: 'DEVICE_REVOKED', message: 'x' }));
    const result = await registerBrowserSession(input, 'tok', { mode: 'real', fetchImpl });
    expect(result).toEqual({ ok: false, code: 'DEVICE_REVOKED' });
  });

  it('maps HTTP 429 to RATE_LIMITED', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { error_code: 'RATE_LIMITED', message: 'x' }));
    const result = await registerBrowserSession(input, 'tok', { mode: 'real', fetchImpl });
    expect(result).toEqual({ ok: false, code: 'RATE_LIMITED' });
  });

  it('maps network failures to NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await registerBrowserSession(input, 'tok', { mode: 'real', fetchImpl });
    expect(result).toEqual({ ok: false, code: 'NETWORK_ERROR' });
  });

  it('maps unknown error bodies to UNKNOWN', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('oops', { status: 500 }));
    const result = await registerBrowserSession(input, 'tok', { mode: 'real', fetchImpl });
    expect(result).toEqual({ ok: false, code: 'UNKNOWN' });
  });
});
