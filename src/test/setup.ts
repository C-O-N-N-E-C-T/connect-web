import '@testing-library/jest-dom/vitest';

// Node 26 exposes an experimental `localStorage` global that shadows jsdom's and
// yields undefined here. Provide a plain in-memory Storage for tests.
class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
}

Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true });
Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
