export const TIMED_OUT = Symbol('timed out');

/**
 * Resolves to TIMED_OUT if `promise` has not settled within `ms`. It only stops waiting; the
 * underlying work is not cancelled.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return Promise.resolve(TIMED_OUT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
