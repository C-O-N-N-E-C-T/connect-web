import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGOUT_PENDING_KEY, LOGOUT_TIMEOUT_MS, performLogout } from './logout';
import { createApiClient, type ApiClientDeps } from '../services/apiClient';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('performLogout', () => {
  it('writes the pending flag BEFORE the request, signs out, then removes the flag', async () => {
    const order: string[] = [];
    await performLogout(
      {
        storage: window.localStorage,
        callLogoutEndpoint: vi.fn(async () => {
          order.push(`request(flag=${window.localStorage.getItem(LOGOUT_PENDING_KEY)})`);
        }),
        signOut: vi.fn(async () => {
          order.push(`signOut(flag=${window.localStorage.getItem(LOGOUT_PENDING_KEY)})`);
        }),
      },
      LOGOUT_TIMEOUT_MS,
    );
    expect(order).toEqual(['request(flag=1)', 'signOut(flag=1)']);
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('continues when the request rejects and when signOut throws', async () => {
    const signOut = vi.fn().mockRejectedValue(new Error('boom'));
    await performLogout(
      { storage: window.localStorage, callLogoutEndpoint: vi.fn().mockRejectedValue(new Error('x')), signOut },
      LOGOUT_TIMEOUT_MS,
    );
    expect(signOut).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });
});

describe('performLogout is bounded (R1)', () => {
  it.each([
    ['hangs', () => new Promise<void>(() => undefined)],
    ['throws', () => Promise.reject(new Error('boom'))],
  ])('finishes and clears the flag when signOut %s', async (_name, signOutImpl) => {
    vi.useFakeTimers();
    let finished = false;
    const done = performLogout(
      { storage: window.localStorage, callLogoutEndpoint: async () => undefined, signOut: vi.fn(signOutImpl) },
      LOGOUT_TIMEOUT_MS,
    ).then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(3_500);
    await done;
    expect(finished).toBe(true);
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });
});

/**
 * Logout through the real API client (recovery disabled), with a fake fetch: every outcome must
 * still end in signOut, and no refresh / re-bind / forced sign-out may happen.
 */
describe('logout through the API client', () => {
  function setup(
    fetchImpl: ApiClientDeps['fetchImpl'],
    getAccessToken: ApiClientDeps['getAccessToken'] = async () => 'tok',
  ) {
    const clientDeps = {
      baseUrl: 'http://api.test',
      fetchImpl: vi.fn(fetchImpl),
      getAccessToken: vi.fn(getAccessToken),
      refreshAccessToken: vi.fn().mockResolvedValue('tok-2'),
      rebindSession: vi.fn().mockResolvedValue({ ok: true }),
      forceSignOut: vi.fn().mockResolvedValue(undefined),
      isLogoutPending: () => window.localStorage.getItem(LOGOUT_PENDING_KEY) !== null,
    };
    const client = createApiClient(clientDeps);
    const signOut = vi.fn().mockResolvedValue(undefined);
    const run = () =>
      performLogout(
        {
          storage: window.localStorage,
          callLogoutEndpoint: (timeoutMs) =>
            client.request('/api/v1/auth/logout', { method: 'POST', timeoutMs, recovery: false }),
          signOut,
        },
        LOGOUT_TIMEOUT_MS,
      );
    return { clientDeps, signOut, run };
  }

  const error = (status: number, code: string) =>
    new Response(JSON.stringify({ error_code: code, message: 'x' }), { status });

  it.each([
    ['204 success', () => new Response(null, { status: 204 })],
    ['network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['500', () => error(500, 'INTERNAL_ERROR')],
    ['401', () => error(401, 'UNAUTHENTICATED')],
    ['403 SESSION_NOT_BOUND', () => error(403, 'SESSION_NOT_BOUND')],
    ['403 DEVICE_REVOKED', () => error(403, 'DEVICE_REVOKED')],
    ['403 ACCOUNT_DISABLED', () => error(403, 'ACCOUNT_DISABLED')],
    ['429', () => error(429, 'RATE_LIMITED')],
  ])('signs out after %s, without refresh, re-bind, retry or forced sign-out', async (_name, respond) => {
    const { clientDeps, signOut, run } = setup(async () => respond());
    await run();

    expect(signOut).toHaveBeenCalledOnce();
    expect(clientDeps.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = clientDeps.fetchImpl.mock.calls[0];
    expect(url).toBe('http://api.test/api/v1/auth/logout');
    expect(init?.method).toBe('POST');
    expect(clientDeps.refreshAccessToken).not.toHaveBeenCalled();
    expect(clientDeps.rebindSession).not.toHaveBeenCalled();
    expect(clientDeps.forceSignOut).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('gives up on the request after 5 s and still signs out', async () => {
    vi.useFakeTimers();
    const { clientDeps, signOut, run } = setup(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const done = run();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signOut).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1');

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(signOut).toHaveBeenCalledOnce();
    expect(clientDeps.fetchImpl).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('still signs out after 5 s when reading the session hangs (offline, expired token)', async () => {
    vi.useFakeTimers();
    const { clientDeps, signOut, run } = setup(
      async () => new Response(null, { status: 204 }),
      () => new Promise<string | null>(() => undefined),
    );
    const done = run();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(signOut).toHaveBeenCalledOnce();
    expect(clientDeps.fetchImpl).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });
});
