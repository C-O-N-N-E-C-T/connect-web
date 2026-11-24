const original = {
  local: Object.getOwnPropertyDescriptor(window, 'localStorage')!,
  session: Object.getOwnPropertyDescriptor(window, 'sessionStorage')!,
};

/** Simulates "block all site data": even reading window.localStorage / sessionStorage throws. */
export function blockStorage() {
  const thrower = {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  };
  Object.defineProperty(window, 'localStorage', thrower);
  Object.defineProperty(window, 'sessionStorage', thrower);
}

export function restoreStorage() {
  Object.defineProperty(window, 'localStorage', original.local);
  Object.defineProperty(window, 'sessionStorage', original.session);
}
