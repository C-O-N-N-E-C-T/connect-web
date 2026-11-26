import { describe, expect, it, vi } from 'vitest';
import { createAdminApi, type CreateUserInput } from './adminApi';
import { createApiClient, type ApiClient, type ApiClientDeps, type ApiResult } from './apiClient';

// OSP-72: the admin client only builds paths and bodies; error handling stays in apiClient.

const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

function fakeClient(result: ApiResult<unknown> = { ok: true, status: 200, data: {} }) {
  const request = vi.fn(async (_path: string, _options?: unknown) => result);
  return { client: { request } as unknown as Pick<ApiClient, 'request'>, request };
}

describe('adminApi paths and bodies', () => {
  it('lists users with limit and offset', async () => {
    const { client, request } = fakeClient({ ok: true, status: 200, data: { users: [], limit: 26, offset: 25 } });
    const result = await createAdminApi(client).listUsers({ limit: 26, offset: 25 });
    expect(request).toHaveBeenCalledWith('/api/v1/admin/users?limit=26&offset=25');
    expect(result.ok).toBe(true);
  });

  it('creates a user with a trimmed body', async () => {
    const { client, request } = fakeClient({
      ok: true,
      status: 201,
      data: { user: { id: USER, email: 'a@b.co', full_name: 'Ayşe', role: 'rescuer', is_active: true } },
    });
    await createAdminApi(client).createUser({
      email: '  a@b.co ',
      password: ' secret-pass ',
      full_name: ' Ayşe ',
      role: 'rescuer',
    });
    expect(request).toHaveBeenCalledWith('/api/v1/admin/users', {
      method: 'POST',
      body: { email: 'a@b.co', password: ' secret-pass ', full_name: 'Ayşe', role: 'rescuer' },
    });
  });

  it('refuses to create an administrator before any request', async () => {
    const { client, request } = fakeClient();
    const input = { email: 'a@b.co', password: 'x'.repeat(10), full_name: 'A', role: 'administrator' };
    await expect(createAdminApi(client).createUser(input as unknown as CreateUserInput)).rejects.toThrow(
      'only rescuer or coordinator',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('uses the exact device and account paths with POST and encoded ids', async () => {
    const { client, request } = fakeClient({ ok: true, status: 200, data: { devices: [], status: 'REVOKED', user: {} } });
    const api = createAdminApi(client);
    await api.listDevices(USER);
    await api.revokeDevice(USER, DEVICE);
    await api.revokeAll(USER);
    await api.reactivate(USER);
    await api.listDevices('a/b?c');
    expect(request.mock.calls).toEqual([
      [`/api/v1/admin/users/${USER}/devices`],
      [`/api/v1/admin/users/${USER}/devices/${DEVICE}/revoke`, { method: 'POST' }],
      [`/api/v1/admin/users/${USER}/revoke-all`, { method: 'POST' }],
      [`/api/v1/admin/users/${USER}/reactivate`, { method: 'POST' }],
      ['/api/v1/admin/users/a%2Fb%3Fc/devices'],
    ]);
  });

  it('builds the audit query in a fixed order and omits empty filters', async () => {
    const { client, request } = fakeClient({ ok: true, status: 200, data: { logs: [], limit: 26, offset: 0 } });
    const api = createAdminApi(client);
    await api.listAuditLogs(
      {
        to: '2026-11-26T10:30:59.999Z',
        target_record_id: USER,
        action_type: 'LOGIN',
        actor_user_id: '',
        from: '2026-11-26T10:00:00.000Z',
      },
      { limit: 26, offset: 50 },
    );
    await api.listAuditLogs({}, { limit: 26, offset: 0 });
    expect(request.mock.calls[0][0]).toBe(
      `/api/v1/admin/audit-logs?action_type=LOGIN&target_record_id=${USER}` +
        '&from=2026-11-26T10%3A00%3A00.000Z&to=2026-11-26T10%3A30%3A59.999Z&limit=26&offset=50',
    );
    expect(request.mock.calls[1][0]).toBe('/api/v1/admin/audit-logs?limit=26&offset=0');
  });
});

describe('adminApi response shape', () => {
  it.each([
    ['listUsers', { users: 'nope' }],
    ['listDevices', { devices: null }],
    ['listAuditLogs', {}],
    ['revokeAll', { user: [] }],
    ['reactivate', null],
  ] as const)('%s: an unexpected 2xx body is INVALID_RESPONSE', async (method, data) => {
    const { client } = fakeClient({ ok: true, status: 200, data });
    const api = createAdminApi(client);
    const calls = {
      listUsers: () => api.listUsers({ limit: 1, offset: 0 }),
      listDevices: () => api.listDevices(USER),
      listAuditLogs: () => api.listAuditLogs({}, { limit: 1, offset: 0 }),
      revokeAll: () => api.revokeAll(USER),
      reactivate: () => api.reactivate(USER),
    };
    expect(await calls[method]()).toEqual({ ok: false, error: { kind: 'INVALID_RESPONSE', status: 200 } });
  });

  it('passes errors through unchanged', async () => {
    const error = { kind: 'HTTP_ERROR' as const, status: 404, errorCode: 'NOT_FOUND' };
    const { client } = fakeClient({ ok: false, error });
    expect(await createAdminApi(client).listDevices(USER)).toEqual({ ok: false, error });
  });
});

describe('adminApi with the real apiClient (OSP-70 handling is reused)', () => {
  function setup(response: () => Response) {
    const forceSignOut = vi.fn<ApiClientDeps['forceSignOut']>().mockResolvedValue(undefined);
    const fetchImpl = vi.fn<ApiClientDeps['fetchImpl']>(async () => response());
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetchImpl,
      getAccessToken: async () => ({ ok: true, accessToken: 'tok-1' }),
      refreshAccessToken: async () => ({ ok: false, definitive: true }),
      rebindSession: async () => ({ ok: true }),
      forceSignOut,
      isLogoutPending: () => false,
      sessionKeyOf: () => 'A',
    });
    return { api: createAdminApi(client), forceSignOut, fetchImpl };
  }
  const error = (status: number, code: string) =>
    new Response(JSON.stringify({ error_code: code, message: 'x' }), { status });

  it('403 ROLE_FORBIDDEN is a typed error without sign-out', async () => {
    const { api, forceSignOut } = setup(() => error(403, 'ROLE_FORBIDDEN'));
    const result = await api.listUsers({ limit: 26, offset: 0 });
    expect(result).toEqual({ ok: false, error: { kind: 'ROLE_FORBIDDEN', status: 403, errorCode: 'ROLE_FORBIDDEN' } });
    expect(forceSignOut).not.toHaveBeenCalled();
  });

  it('403 DEVICE_REVOKED signs out once', async () => {
    const { api, forceSignOut } = setup(() => error(403, 'DEVICE_REVOKED'));
    const result = await api.revokeAll(USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('SIGNED_OUT');
    expect(forceSignOut).toHaveBeenCalledOnce();
    expect(forceSignOut).toHaveBeenCalledWith('DEVICE_REVOKED', 'tok-1');
  });

  it('409 CONFLICT is an HTTP_ERROR with status 409', async () => {
    const { api, fetchImpl } = setup(() => error(409, 'CONFLICT'));
    const result = await api.revokeAll(USER);
    expect(result).toEqual({ ok: false, error: { kind: 'HTTP_ERROR', status: 409, errorCode: 'CONFLICT' } });
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://api.test/api/v1/admin/users/${USER}/revoke-all`);
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
  });
});
