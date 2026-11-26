import { afterEach, describe, expect, it } from 'vitest';
import { blockStorage, restoreStorage } from '../test/blockStorage';
import { safeLocalStorage, safeSessionStorage, storageGet, storageRemove, storageSet } from './storage';

afterEach(() => {
  restoreStorage();
});

describe('safe storage (R11)', () => {
  it('returns null instead of throwing when the getter throws', () => {
    blockStorage();
    expect(() => window.localStorage).toThrow();
    expect(safeLocalStorage()).toBeNull();
    expect(safeSessionStorage()).toBeNull();
    expect(storageGet(null, 'k')).toBeNull();
    expect(() => storageSet(null, 'k', 'v')).not.toThrow();
    expect(() => storageRemove(null, 'k')).not.toThrow();
  });

  it('swallows errors from storage methods', () => {
    const broken = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('x');
      },
    } as unknown as Storage;
    expect(storageGet(broken, 'k')).toBeNull();
    expect(() => storageSet(broken, 'k', 'v')).not.toThrow();
    expect(() => storageRemove(broken, 'k')).not.toThrow();
  });
});
