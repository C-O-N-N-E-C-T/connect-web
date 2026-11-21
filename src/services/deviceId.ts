const STORAGE_KEY = 'connect.device_id';

/** Returns a persistent per-browser UUID, creating it on first use. */
export function getOrCreateDeviceId(storage: Storage = window.localStorage): string {
  const existing = storage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  storage.setItem(STORAGE_KEY, id);
  return id;
}
