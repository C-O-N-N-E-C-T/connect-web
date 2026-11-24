import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type ApiClientDeps, type RefreshResult } from './apiClient';

const BASE = 'http://api.test';

function jsonResponse(status: number, body?: unknown): Response {
  if (body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { error_code: code, message: 'x' });
}

/** A token holder that behaves like the Supabase session: refresh swaps the current token. */
function makeDeps(overrides: Partial<ApiClientDeps> = {}) {
  let current: string | null = 'tok-1';
  const deps = {
    baseUrl: BASE,
    fetchImpl: vi.fn<ApiClientDeps['fetchImpl']>(),
    getAccessToken: vi.fn<ApiClientDeps['getAccessToken']>(async () => ({ ok: true, accessToken: current })),
    refreshAccessToken: vi.fn<ApiClientDeps['refreshAccessToken']>(async () => {
      current = 'tok-2';
      return { ok: true, accessToken: current };
    }),
    rebindSession: vi.fn<ApiClientDeps['rebindSession']>().mockResolvedValue({ ok: true }),
    forceSignOut: vi.fn<ApiClientDeps['forceSignOut']>().mockResolvedValue(undefined),
    isLogoutPending: vi.fn(() => false),
  };
  Object.assign(deps, overrides);
  return {
    deps,
    setToken(token: string | null) {
      current = token;
    },
  };
}

function authHeaderOf(call: unknown[]): string {
  const init = call[1] as RequestInit;
  return (init.headers as Record<string, string>).Authorization;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('apiClient: basics', () => {
  it('attaches the bearer token and returns parsed JSON', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockImplementation(async () => jsonResponse(200, { role: 'coordinator' }));
    const client = createApiClient(deps);

    const result = await client.request<{ role: string }>('/api/v1/auth/me');

    expect(result).toEqual({ ok: true, status: 200, data: { role: 'coordinator' } });
    const [url, init] = deps.fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/auth/me`);
    expect(init?.method).toBe('GET');
    expect(authHeaderOf(deps.fetchImpl.mock.calls[0])).toBe('Bearer tok-1');
  });

  it('sends a JSON body with a content type', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockImplementation(async () => jsonResponse(200, {}));
    await createApiClient(deps).request('/api/v1/x', { method: 'POST', body: { a: 1 } });
    const init = deps.fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('does not parse a 204 body', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockImplementation(async () => jsonResponse(204));
    expect(await createApiClient(deps).request('/api/v1/auth/logout', { method: 'POST' })).toEqual({
      ok: true,
      status: 204,
      data: undefined,
    });
  });

  it('returns INVALID_RESPONSE for a 2xx body that is not JSON', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockImplementation(async () => new Response('<html>', { status: 200 }));
    const result = await createApiClient(deps).request('/api/v1/x');
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_RESPONSE', status: 200 } });
  });

  it.each(['https://evil.test/api', '//evil.test/api', 'api/v1/x', '/\\evil.test/api', '/api\\x'])(
    'refuses a path that is not a relative API path (%s)',
    async (path) => {
      const { deps } = makeDeps();
      await expect(createApiClient(deps).request(path)).rejects.toThrow();
      expect(deps.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('returns UNAUTHENTICATED without a network call when there is no session', async () => {
    const { deps, setToken } = makeDeps();
    setToken(null);
    const result = await createApiClient(deps).request('/api/v1/x');
    expect(result).toEqual({ ok: false, error: { kind: 'UNAUTHENTICATED' } });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });
});

describe('apiClient: session lookup failures (R10, R16)', () => {
  it.each([
    [{ ok: false, kind: 'NETWORK_ERROR' } as const, { kind: 'NETWORK_ERROR' }],
    [{ ok: false, kind: 'SERVER_ERROR', status: 503 } as const, { kind: 'SERVER_ERROR', status: 503 }],
    [{ ok: false, kind: 'RATE_LIMITED', status: 429 } as const, { kind: 'RATE_LIMITED', status: 429 }],
  ])('maps a transient lookup failure to a typed error, not UNAUTHENTICATED', async (lookup, expected) => {
    const { deps } = makeDeps();
    deps.getAccessToken.mockResolvedValueOnce(lookup);
    expect(await createApiClient(deps).request('/api/v1/x')).toEqual({ ok: false, error: expected });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('maps a throwing lookup to NETWORK_ERROR and logs only the error name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps } = makeDeps();
    deps.getAccessToken.mockRejectedValueOnce(new TypeError('secret-token-in-message'));
    expect(await createApiClient(deps).request('/api/v1/x')).toEqual({
      ok: false,
      error: { kind: 'NETWORK_ERROR' },
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token-in-message');
    expect(JSON.stringify(warn.mock.calls)).toContain('TypeError');
    warn.mockRestore();
  });
});

describe('apiClient: 401 UNAUTHENTICATED', () => {
  it('refreshes once and retries with the new token', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl
      .mockResolvedValueOnce(errorResponse(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));

    const result = await createApiClient(deps).request('/api/v1/x');

    expect(result).toEqual({ ok: true, status: 200, data: { ok: 1 } });
    expect(deps.refreshAccessToken).toHaveBeenCalledOnce();
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
    expect(authHeaderOf(deps.fetchImpl.mock.calls[1])).toBe('Bearer tok-2');
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('forces sign-out with SESSION_EXPIRED when the refresh is definitively rejected', async () => {
    const { deps } = makeDeps();
    deps.refreshAccessToken.mockResolvedValue({ ok: false, definitive: true });
    deps.fetchImpl.mockImplementation(async () => errorResponse(401, 'UNAUTHENTICATED'));

    const result = await createApiClient(deps).request('/api/v1/x');

    expect(result).toEqual({
      ok: false,
      error: { kind: 'SIGNED_OUT', reason: 'SESSION_EXPIRED', status: 401, errorCode: 'UNAUTHENTICATED' },
    });
    expect(deps.forceSignOut).toHaveBeenCalledWith('SESSION_EXPIRED', 'tok-1');
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
  });

  // D4a: transient refresh failures keep the user signed in; the next request tries again.
  it.each<[string, RefreshResult | Error, object]>([
    ['network error', { ok: false, definitive: false, kind: 'NETWORK_ERROR' }, { kind: 'NETWORK_ERROR' }],
    [
      '5xx',
      { ok: false, definitive: false, kind: 'SERVER_ERROR', status: 503 },
      { kind: 'SERVER_ERROR', status: 503 },
    ],
    [
      '429',
      { ok: false, definitive: false, kind: 'RATE_LIMITED', status: 429 },
      { kind: 'RATE_LIMITED', status: 429 },
    ],
    ['a thrown error', new Error('lock timeout'), { kind: 'NETWORK_ERROR' }],
  ])('does not sign out when the refresh fails with %s (D4a)', async (_name, failure, expected) => {
    const { deps } = makeDeps();
    if (failure instanceof Error) deps.refreshAccessToken.mockRejectedValueOnce(failure);
    else deps.refreshAccessToken.mockResolvedValueOnce(failure);
    deps.fetchImpl.mockImplementation(async (_url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer tok-2' ? jsonResponse(200, { fine: true }) : errorResponse(401, 'UNAUTHENTICATED');
    });
    const client = createApiClient(deps);

    expect(await client.request('/api/v1/x')).toEqual({ ok: false, error: expected });
    expect(deps.forceSignOut).not.toHaveBeenCalled();
    expect(deps.fetchImpl).toHaveBeenCalledOnce(); // no retry

    // Connection back: the next request refreshes again and succeeds.
    expect(await client.request('/api/v1/x')).toEqual({ ok: true, status: 200, data: { fine: true } });
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('gives every waiter of a shared refresh that failed transiently the typed error, none signs out', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { deps } = makeDeps();
    deps.refreshAccessToken.mockImplementationOnce(async () => {
      await gate;
      return { ok: false, definitive: false, kind: 'NETWORK_ERROR' };
    });
    deps.fetchImpl.mockImplementation(async (_url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer tok-2' ? jsonResponse(200, {}) : errorResponse(401, 'UNAUTHENTICATED');
    });
    const client = createApiClient(deps);

    const all = Promise.all([client.request('/api/v1/a'), client.request('/api/v1/b'), client.request('/api/v1/c')]);
    await vi.waitFor(() => expect(deps.refreshAccessToken).toHaveBeenCalled());
    release();
    const results = await all;

    expect(results).toEqual(Array(3).fill({ ok: false, error: { kind: 'NETWORK_ERROR' } }));
    expect(deps.refreshAccessToken).toHaveBeenCalledOnce();
    expect(deps.forceSignOut).not.toHaveBeenCalled();

    // No cached failure: a later request starts a fresh refresh.
    expect((await client.request('/api/v1/d')).ok).toBe(true);
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('forces sign-out when the retry is still 401 (no second refresh)', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockImplementation(async () => errorResponse(401, 'UNAUTHENTICATED'));

    const result = await createApiClient(deps).request('/api/v1/x');

    expect(result).toMatchObject({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'SESSION_EXPIRED' } });
    expect(deps.refreshAccessToken).toHaveBeenCalledOnce();
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
    expect(deps.forceSignOut).toHaveBeenCalledOnce();
    expect(deps.forceSignOut).toHaveBeenCalledWith('SESSION_EXPIRED', 'tok-2');
  });

  it('shares one refresh between concurrent 401s', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { deps, setToken } = makeDeps();
    deps.refreshAccessToken.mockImplementation(async () => {
      await gate;
      setToken('tok-2');
      return { ok: true, accessToken: 'tok-2' };
    });
    deps.fetchImpl.mockImplementation(async (_url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer tok-2' ? jsonResponse(200, {}) : errorResponse(401, 'UNAUTHENTICATED');
    });
    const client = createApiClient(deps);

    const all = Promise.all([client.request('/api/v1/a'), client.request('/api/v1/b'), client.request('/api/v1/c')]);
    await vi.waitFor(() => expect(deps.refreshAccessToken).toHaveBeenCalled());
    release();
    const results = await all;

    expect(results.every((r) => r.ok)).toBe(true);
    expect(deps.refreshAccessToken).toHaveBeenCalledOnce();
    expect(deps.fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('uses an already refreshed token instead of refreshing again (late 401)', async () => {
    const { deps, setToken } = makeDeps();
    deps.fetchImpl.mockImplementationOnce(async () => {
      setToken('tok-9'); // the SDK refreshed the session while this request was in flight
      return errorResponse(401, 'UNAUTHENTICATED');
    });
    deps.fetchImpl.mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await createApiClient(deps).request('/api/v1/x');

    expect(result.ok).toBe(true);
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(authHeaderOf(deps.fetchImpl.mock.calls[1])).toBe('Bearer tok-9');
  });

  it('signs out with the retry reason when the retry answers DEVICE_REVOKED', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl
      .mockResolvedValueOnce(errorResponse(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(errorResponse(403, 'DEVICE_REVOKED'));
    const result = await createApiClient(deps).request('/api/v1/x');
    expect(result).toMatchObject({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'DEVICE_REVOKED' } });
    expect(deps.forceSignOut).toHaveBeenCalledWith('DEVICE_REVOKED', 'tok-2');
  });

  it('does not re-bind when the retry after a refresh answers SESSION_NOT_BOUND', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl
      .mockResolvedValueOnce(errorResponse(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(errorResponse(403, 'SESSION_NOT_BOUND'));
    const result = await createApiClient(deps).request('/api/v1/x');
    expect(result).toMatchObject({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'SESSION_NOT_BOUND' } });
    expect(deps.rebindSession).not.toHaveBeenCalled();
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('apiClient: 403', () => {
  it.each(['DEVICE_REVOKED', 'ACCOUNT_DISABLED'] as const)(
    'forces sign-out immediately on %s (no refresh, no retry)',
    async (code) => {
      const { deps } = makeDeps();
      deps.fetchImpl.mockImplementation(async () => errorResponse(403, code));

      const result = await createApiClient(deps).request('/api/v1/auth/me');

      expect(result).toEqual({
        ok: false,
        error: { kind: 'SIGNED_OUT', reason: code, status: 403, errorCode: code },
      });
      expect(deps.forceSignOut).toHaveBeenCalledWith(code, 'tok-1');
      expect(deps.fetchImpl).toHaveBeenCalledOnce();
      expect(deps.refreshAccessToken).not.toHaveBeenCalled();
      expect(deps.rebindSession).not.toHaveBeenCalled();
    },
  );

  it('returns ROLE_FORBIDDEN as a typed error without signing out', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockImplementation(async () => errorResponse(403, 'ROLE_FORBIDDEN'));
    const result = await createApiClient(deps).request('/api/v1/admin/users');
    expect(result).toEqual({
      ok: false,
      error: { kind: 'ROLE_FORBIDDEN', status: 403, errorCode: 'ROLE_FORBIDDEN' },
    });
    expect(deps.forceSignOut).not.toHaveBeenCalled();
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns FORBIDDEN for a 403 with an unknown or missing code, without signing out', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockResolvedValueOnce(errorResponse(403, 'SOMETHING_NEW'));
    deps.fetchImpl.mockResolvedValueOnce(new Response('nope', { status: 403 }));
    const client = createApiClient(deps);
    expect(await client.request('/api/v1/x')).toEqual({
      ok: false,
      error: { kind: 'FORBIDDEN', status: 403, errorCode: 'SOMETHING_NEW' },
    });
    expect(await client.request('/api/v1/x')).toEqual({ ok: false, error: { kind: 'FORBIDDEN', status: 403 } });
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('re-binds once on SESSION_NOT_BOUND and retries', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl
      .mockResolvedValueOnce(errorResponse(403, 'SESSION_NOT_BOUND'))
      .mockResolvedValueOnce(jsonResponse(200, { fine: true }));

    const result = await createApiClient(deps).request('/api/v1/x');

    expect(result).toEqual({ ok: true, status: 200, data: { fine: true } });
    expect(deps.rebindSession).toHaveBeenCalledOnce();
    expect(deps.rebindSession).toHaveBeenCalledWith('tok-1');
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('shares one re-bind between concurrent SESSION_NOT_BOUND responses', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let bound = false;
    const { deps } = makeDeps();
    deps.rebindSession.mockImplementation(async () => {
      await gate;
      bound = true;
      return { ok: true };
    });
    deps.fetchImpl.mockImplementation(async () =>
      bound ? jsonResponse(200, {}) : errorResponse(403, 'SESSION_NOT_BOUND'),
    );
    const client = createApiClient(deps);

    const all = Promise.all([client.request('/api/v1/a'), client.request('/api/v1/b')]);
    await vi.waitFor(() => expect(deps.rebindSession).toHaveBeenCalled());
    release();
    const results = await all;

    expect(results.every((r) => r.ok)).toBe(true);
    expect(deps.rebindSession).toHaveBeenCalledOnce();
  });

  it.each(['DEVICE_REVOKED', 'ACCOUNT_DISABLED'] as const)(
    'forces sign-out with %s when the re-bind is refused with it',
    async (code) => {
      const { deps } = makeDeps();
      deps.rebindSession.mockResolvedValue({ ok: false, code });
      deps.fetchImpl.mockImplementation(async () => errorResponse(403, 'SESSION_NOT_BOUND'));
      const result = await createApiClient(deps).request('/api/v1/x');
      expect(result).toMatchObject({ ok: false, error: { kind: 'SIGNED_OUT', reason: code } });
      expect(deps.forceSignOut).toHaveBeenCalledWith(code, 'tok-1');
      expect(deps.fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it('forces sign-out with SESSION_EXPIRED when the re-bind answers 401', async () => {
    const { deps } = makeDeps();
    deps.rebindSession.mockResolvedValue({ ok: false, code: 'UNKNOWN', status: 401 });
    deps.fetchImpl.mockImplementation(async () => errorResponse(403, 'SESSION_NOT_BOUND'));
    const result = await createApiClient(deps).request('/api/v1/x');
    expect(result).toMatchObject({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'SESSION_EXPIRED' } });
    expect(deps.forceSignOut).toHaveBeenCalledWith('SESSION_EXPIRED', 'tok-1');
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
  });

  // D4a: transient re-bind failures keep the user signed in; the next request re-binds again.
  it.each<[string, () => Promise<unknown>, object]>([
    ['network error', async () => ({ ok: false, code: 'NETWORK_ERROR' }), { kind: 'NETWORK_ERROR' }],
    [
      '429',
      async () => ({ ok: false, code: 'RATE_LIMITED', status: 429 }),
      { kind: 'RATE_LIMITED', status: 429 },
    ],
    ['5xx', async () => ({ ok: false, code: 'UNKNOWN', status: 503 }), { kind: 'SERVER_ERROR', status: 503 }],
    [
      'UNKNOWN 4xx',
      async () => ({ ok: false, code: 'UNKNOWN', status: 400 }),
      { kind: 'HTTP_ERROR', status: 400, errorCode: 'UNKNOWN' },
    ],
    ['a thrown error', async () => Promise.reject(new Error('boom')), { kind: 'NETWORK_ERROR' }],
  ])('does not sign out when the re-bind fails with %s (D4a)', async (_name, rebind, expected) => {
    let bound = false;
    const { deps } = makeDeps();
    deps.rebindSession.mockImplementationOnce(rebind as ApiClientDeps['rebindSession']);
    deps.rebindSession.mockImplementation(async () => {
      bound = true;
      return { ok: true };
    });
    deps.fetchImpl.mockImplementation(async () =>
      bound ? jsonResponse(200, { fine: true }) : errorResponse(403, 'SESSION_NOT_BOUND'),
    );
    const client = createApiClient(deps);

    expect(await client.request('/api/v1/x')).toEqual({ ok: false, error: expected });
    expect(deps.forceSignOut).not.toHaveBeenCalled();
    expect(deps.fetchImpl).toHaveBeenCalledOnce(); // no retry

    expect(await client.request('/api/v1/x')).toEqual({ ok: true, status: 200, data: { fine: true } });
    expect(deps.rebindSession).toHaveBeenCalledTimes(2);
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('gives every waiter of a shared re-bind that failed transiently the typed error, none signs out', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let bound = false;
    const { deps } = makeDeps();
    deps.rebindSession.mockImplementationOnce(async () => {
      await gate;
      return { ok: false, code: 'NETWORK_ERROR' };
    });
    deps.rebindSession.mockImplementation(async () => {
      bound = true;
      return { ok: true };
    });
    deps.fetchImpl.mockImplementation(async () =>
      bound ? jsonResponse(200, {}) : errorResponse(403, 'SESSION_NOT_BOUND'),
    );
    const client = createApiClient(deps);

    const all = Promise.all([client.request('/api/v1/a'), client.request('/api/v1/b')]);
    await vi.waitFor(() => expect(deps.rebindSession).toHaveBeenCalled());
    release();
    expect(await all).toEqual(Array(2).fill({ ok: false, error: { kind: 'NETWORK_ERROR' } }));
    expect(deps.rebindSession).toHaveBeenCalledOnce();
    expect(deps.forceSignOut).not.toHaveBeenCalled();

    expect((await client.request('/api/v1/c')).ok).toBe(true);
    expect(deps.rebindSession).toHaveBeenCalledTimes(2);
  });

  it('forces sign-out when the retry after a re-bind is still SESSION_NOT_BOUND', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockImplementation(async () => errorResponse(403, 'SESSION_NOT_BOUND'));
    const result = await createApiClient(deps).request('/api/v1/x');
    expect(result).toMatchObject({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'SESSION_NOT_BOUND' } });
    expect(deps.rebindSession).toHaveBeenCalledOnce();
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not refresh when the retry after a re-bind answers 401', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl
      .mockResolvedValueOnce(errorResponse(403, 'SESSION_NOT_BOUND'))
      .mockResolvedValueOnce(errorResponse(401, 'UNAUTHENTICATED'));
    const result = await createApiClient(deps).request('/api/v1/x');
    expect(result).toMatchObject({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'SESSION_EXPIRED' } });
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('apiClient: errors that never sign out', () => {
  it.each([
    [429, 'RATE_LIMITED', 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR', 'SERVER_ERROR'],
    [503, 'INTERNAL_ERROR', 'SERVER_ERROR'],
    [404, 'NOT_FOUND', 'HTTP_ERROR'],
  ])('maps %i to a typed error', async (status, code, kind) => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockImplementation(async () => errorResponse(status, code));
    const result = await createApiClient(deps).request('/api/v1/x');
    expect(result).toEqual({ ok: false, error: { kind, status, errorCode: code } });
    expect(deps.forceSignOut).not.toHaveBeenCalled();
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
  });

  it('maps a fetch failure to NETWORK_ERROR', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await createApiClient(deps).request('/api/v1/x');
    expect(result).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('aborts after the timeout and maps it to TIMEOUT', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    deps.fetchImpl.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = createApiClient(deps).request('/api/v1/x', { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(deps.fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });
});

describe('apiClient: one deadline for the whole request', () => {
  it('times out when getting the token hangs (no request is sent)', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    deps.getAccessToken.mockImplementation(() => new Promise(() => undefined));
    const pending = createApiClient(deps).request('/api/v1/x', { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it('times out (without signing out) when the refresh hangs', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    deps.refreshAccessToken.mockImplementation(() => new Promise<RefreshResult>(() => undefined));
    deps.fetchImpl.mockImplementation(async () => errorResponse(401, 'UNAUTHENTICATED'));
    const pending = createApiClient(deps).request('/api/v1/x', { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('times out (without signing out) when the re-bind hangs', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    deps.rebindSession.mockImplementation(() => new Promise(() => undefined));
    deps.fetchImpl.mockImplementation(async () => errorResponse(403, 'SESSION_NOT_BOUND'));
    const pending = createApiClient(deps).request('/api/v1/x', { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });
});

describe('apiClient: recovery disabled (logout)', () => {
  it.each([
    [401, 'UNAUTHENTICATED', 'UNAUTHENTICATED'],
    [403, 'SESSION_NOT_BOUND', 'FORBIDDEN'],
    [403, 'DEVICE_REVOKED', 'FORBIDDEN'],
    [403, 'ACCOUNT_DISABLED', 'FORBIDDEN'],
  ])('returns %i %s as a typed error with no refresh, re-bind, retry or sign-out', async (status, code, kind) => {
    const { deps } = makeDeps();
    deps.fetchImpl.mockImplementation(async () => errorResponse(status, code));
    const result = await createApiClient(deps).request('/api/v1/auth/logout', {
      method: 'POST',
      recovery: false,
    });
    expect(result).toEqual({ ok: false, error: { kind, status, errorCode: code } });
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(deps.rebindSession).not.toHaveBeenCalled();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('suppresses recovery for every request while a logout is pending', async () => {
    const { deps } = makeDeps({ isLogoutPending: vi.fn(() => true) });
    deps.fetchImpl
      .mockResolvedValueOnce(errorResponse(403, 'SESSION_NOT_BOUND'))
      .mockResolvedValueOnce(errorResponse(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(errorResponse(403, 'DEVICE_REVOKED'));
    const client = createApiClient(deps);

    expect((await client.request('/api/v1/auth/me')).ok).toBe(false);
    expect((await client.request('/api/v1/auth/me')).ok).toBe(false);
    expect((await client.request('/api/v1/auth/me')).ok).toBe(false);

    expect(deps.fetchImpl).toHaveBeenCalledTimes(3);
    expect(deps.rebindSession).not.toHaveBeenCalled();
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });

  it('does not re-bind when a logout starts while the request is in flight', async () => {
    let pending = false;
    const { deps } = makeDeps({ isLogoutPending: vi.fn(() => pending) });
    deps.fetchImpl.mockImplementationOnce(async () => {
      pending = true; // the user pressed "Çıkış yap" meanwhile
      return errorResponse(403, 'SESSION_NOT_BOUND');
    });
    const result = await createApiClient(deps).request('/api/v1/auth/me');
    expect(result).toEqual({
      ok: false,
      error: { kind: 'FORBIDDEN', status: 403, errorCode: 'SESSION_NOT_BOUND' },
    });
    expect(deps.rebindSession).not.toHaveBeenCalled();
    expect(deps.forceSignOut).not.toHaveBeenCalled();
  });
});

describe('ROLE_FORBIDDEN_MESSAGE', () => {
  it('is the agreed Turkish text', async () => {
    const { ROLE_FORBIDDEN_MESSAGE } = await import('./apiClient');
    expect(ROLE_FORBIDDEN_MESSAGE).toBe('Bu işlem için yetkiniz yok.');
  });
});
