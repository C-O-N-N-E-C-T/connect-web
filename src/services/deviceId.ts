import { safeLocalStorage, storageGet, storageSet } from '../lib/storage';

const STORAGE_KEY = 'connect.device_id';

/** Used when storage is blocked: stable for this page load only. */
let ephemeralId: string | null = null;

/** Returns a persistent per-browser UUID, creating it on first use. */
export function getOrCreateDeviceId(storage: Storage | null = safeLocalStorage()): string {
  const existing = storageGet(storage, STORAGE_KEY);
  if (existing) return existing;
  const id = ephemeralId ?? crypto.randomUUID();
  storageSet(storage, STORAGE_KEY, id);
  if (storageGet(storage, STORAGE_KEY) !== id) ephemeralId = id;
  return id;
}
