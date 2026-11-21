import { describe, expect, it, vi } from 'vitest';
import { classifySignInError, loginWithPassword, type LoginDeps } from './login';

function tokenFor(claims: object): string {
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

function makeDeps(overrides: Partial<LoginDeps> = {}): LoginDeps {
  return {
    signIn: vi.fn().mockResolvedValue({ accessToken: tokenFor({ user_role: 'coordinator' }) }),
    signOut: vi.fn().mockResolvedValue(undefined),
    registerSession: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

describe('classifySignInError', () => {
  it('treats 4xx responses as invalid credentials', () => {
    expect(classifySignInError({ status: 400 })).toBe('INVALID_CREDENTIALS');
  });

  it('treats status 0 and missing status as a network failure', () => {
    expect(classifySignInError({ status: 0 })).toBe('NETWORK_ERROR');
    expect(classifySignInError({})).toBe('NETWORK_ERROR');
  });

  it('treats 5xx responses as unknown', () => {
    expect(classifySignInError({ status: 500 })).toBe('UNKNOWN');
  });
});

describe('loginWithPassword', () => {
  it('routes a coordinator to /dashboard after registering the session', async () => {
    const deps = makeDeps();
    const result = await loginWithPassword('cansugnnn@gmail.com', 'pw', deps);
    expect(result).toEqual({ ok: true, route: '/dashboard' });
    expect(deps.registerSession).toHaveBeenCalledOnce();
  });

  it('routes an administrator to /admin', async () => {
    const deps = makeDeps({
      signIn: vi.fn().mockResolvedValue({ accessToken: tokenFor({ user_role: 'administrator' }) }),
    });
    expect(await loginWithPassword('a@b.co', 'pw', deps)).toEqual({ ok: true, route: '/admin' });
  });

  it('rejects invalid credentials without touching the session', async () => {
    const deps = makeDeps({ signIn: vi.fn().mockResolvedValue({ error: 'INVALID_CREDENTIALS' }) });
    expect(await loginWithPassword('a@b.co', 'bad', deps)).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' });
    expect(deps.registerSession).not.toHaveBeenCalled();
  });

  it('reports network failures as NETWORK_ERROR, not as wrong credentials', async () => {
    const deps = makeDeps({ signIn: vi.fn().mockResolvedValue({ error: 'NETWORK_ERROR' }) });
    expect(await loginWithPassword('a@b.co', 'pw', deps)).toEqual({ ok: false, code: 'NETWORK_ERROR' });
    expect(deps.registerSession).not.toHaveBeenCalled();
  });

  it('rejects rescuers before calling /auth/session and signs them out', async () => {
    const deps = makeDeps({
      signIn: vi.fn().mockResolvedValue({ accessToken: tokenFor({ user_role: 'rescuer' }) }),
    });
    expect(await loginWithPassword('r@gmail.com', 'pw', deps)).toEqual({ ok: false, code: 'ROLE_NOT_ALLOWED' });
    expect(deps.registerSession).not.toHaveBeenCalled();
    expect(deps.signOut).toHaveBeenCalledOnce();
  });

  it('treats a missing role claim (inactive profile) as not allowed', async () => {
    const deps = makeDeps({ signIn: vi.fn().mockResolvedValue({ accessToken: tokenFor({ sub: 'x' }) }) });
    expect(await loginWithPassword('x@gmail.com', 'pw', deps)).toEqual({ ok: false, code: 'ROLE_NOT_ALLOWED' });
  });

  it('treats a malformed access token as not allowed instead of throwing', async () => {
    const deps = makeDeps({ signIn: vi.fn().mockResolvedValue({ accessToken: 'garbage' }) });
    expect(await loginWithPassword('x@gmail.com', 'pw', deps)).toEqual({ ok: false, code: 'ROLE_NOT_ALLOWED' });
    expect(deps.signOut).toHaveBeenCalledOnce();
  });

  it('signs out and surfaces ACCOUNT_DISABLED from /auth/session', async () => {
    const deps = makeDeps({ registerSession: vi.fn().mockResolvedValue({ ok: false, code: 'ACCOUNT_DISABLED' }) });
    expect(await loginWithPassword('c@gmail.com', 'pw', deps)).toEqual({ ok: false, code: 'ACCOUNT_DISABLED' });
    expect(deps.signOut).toHaveBeenCalledOnce();
  });

  it('surfaces DEVICE_REVOKED and RATE_LIMITED from /auth/session', async () => {
    const revoked = makeDeps({ registerSession: vi.fn().mockResolvedValue({ ok: false, code: 'DEVICE_REVOKED' }) });
    expect(await loginWithPassword('c@gmail.com', 'pw', revoked)).toEqual({ ok: false, code: 'DEVICE_REVOKED' });

    const limited = makeDeps({ registerSession: vi.fn().mockResolvedValue({ ok: false, code: 'RATE_LIMITED' }) });
    expect(await loginWithPassword('c@gmail.com', 'pw', limited)).toEqual({ ok: false, code: 'RATE_LIMITED' });
  });
});
