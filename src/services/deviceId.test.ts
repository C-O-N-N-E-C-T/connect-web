import { describe, expect, it } from 'vitest';
import { getOrCreateDeviceId } from './deviceId';

describe('getOrCreateDeviceId', () => {
  it('creates an id once and reuses it', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as unknown as Storage;

    const first = getOrCreateDeviceId(storage);
    const second = getOrCreateDeviceId(storage);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });
});
