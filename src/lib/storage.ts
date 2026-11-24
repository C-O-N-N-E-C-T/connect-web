/**
 * Web Storage access that never throws.
 *
 * With "block all site data", in a sandboxed iframe or in some private modes, even reading the
 * `window.localStorage` / `window.sessionStorage` getter throws a SecurityError. Every access in
 * this app goes through these helpers; `null` means "storage unavailable" and callers treat it as
 * "no flag / no reason / nothing stored".
 */
export function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function storageGet(storage: Storage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(storage: Storage | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // quota / blocked: the value is simply unavailable
  }
}

export function storageRemove(storage: Storage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}
