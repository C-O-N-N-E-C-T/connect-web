import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSignOutReason,
  createForcedSignOut,
  peekSignOutReason,
  SIGNOUT_REASON_KEY,
  subscribeSignOutReason,
} from './forcedSignOut';

beforeEach(() => {
  window.sessionStorage.clear();
});

function makeDeps() {
  const order: string[] = [];
  const deps = {
    signOut: vi.fn(async () => {
      order.push(`signOut(reason=${window.sessionStorage.getItem(SIGNOUT_REASON_KEY)})`);
    }),
    navigateToLogin: vi.fn(() => {
      order.push('navigate');
    }),
    storage: () => window.sessionStorage,
  };
  return { deps, order };
}

describe('createForcedSignOut', () => {
  it('stores the reason before signing out, then navigates', async () => {
    const { deps, order } = makeDeps();
    await createForcedSignOut(deps)('DEVICE_REVOKED', 'tok');
    expect(order).toEqual(['signOut(reason=DEVICE_REVOKED)', 'navigate']);
  });

  it('runs concurrent calls as one sign-out, one navigation and one message (first reason wins)', async () => {
    const { deps } = makeDeps();
    const force = createForcedSignOut(deps);
    await Promise.all([
      force('DEVICE_REVOKED', 'tok'),
      force('ACCOUNT_DISABLED', 'tok'),
      force('SESSION_EXPIRED', 'other'),
    ]);
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(deps.navigateToLogin).toHaveBeenCalledOnce();
    expect(peekSignOutReason(window.sessionStorage)).toBe('DEVICE_REVOKED');
  });

  it('ignores a late call for a token that was already signed out', async () => {
    const { deps } = makeDeps();
    const force = createForcedSignOut(deps);
    await force('DEVICE_REVOKED', 'tok');
    await force('SESSION_EXPIRED', 'tok');
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(deps.navigateToLogin).toHaveBeenCalledOnce();
    expect(peekSignOutReason(window.sessionStorage)).toBe('DEVICE_REVOKED');
  });

  it('signs out a later session again (latch is reset)', async () => {
    const { deps } = makeDeps();
    const force = createForcedSignOut(deps);
    await force('DEVICE_REVOKED', 'tok-a');
    await force('ACCOUNT_DISABLED', 'tok-b');
    expect(deps.signOut).toHaveBeenCalledTimes(2);
    expect(peekSignOutReason(window.sessionStorage)).toBe('ACCOUNT_DISABLED');
  });

  it('still navigates when signOut throws', async () => {
    const { deps } = makeDeps();
    deps.signOut.mockRejectedValueOnce(new Error('boom'));
    await createForcedSignOut(deps)('SESSION_EXPIRED', 'tok');
    expect(deps.navigateToLogin).toHaveBeenCalledOnce();
  });

  it('still navigates when signOut hangs (R1)', async () => {
    vi.useFakeTimers();
    try {
      const { deps } = makeDeps();
      deps.signOut.mockReturnValueOnce(new Promise(() => undefined));
      const done = createForcedSignOut(deps)('SESSION_EXPIRED', 'tok-hang');
      await vi.advanceTimersByTimeAsync(3_500);
      await done;
      expect(deps.navigateToLogin).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies reason subscribers', async () => {
    const { deps } = makeDeps();
    const listener = vi.fn();
    const unsubscribe = subscribeSignOutReason(listener);
    await createForcedSignOut(deps)('ROLE_NOT_ALLOWED', 'tok');
    unsubscribe();
    expect(listener).toHaveBeenCalledWith('ROLE_NOT_ALLOWED');
  });
});

describe('sign-out reason storage', () => {
  it('peeks without clearing and ignores unknown values', () => {
    window.sessionStorage.setItem(SIGNOUT_REASON_KEY, 'SESSION_EXPIRED');
    expect(peekSignOutReason(window.sessionStorage)).toBe('SESSION_EXPIRED');
    expect(peekSignOutReason(window.sessionStorage)).toBe('SESSION_EXPIRED');
    clearSignOutReason(window.sessionStorage);
    expect(peekSignOutReason(window.sessionStorage)).toBeNull();

    window.sessionStorage.setItem(SIGNOUT_REASON_KEY, '<script>');
    expect(peekSignOutReason(window.sessionStorage)).toBeNull();
  });
});
