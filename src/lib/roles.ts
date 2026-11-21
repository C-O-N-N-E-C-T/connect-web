/** Roles that may use the web dashboard. `rescuer` is mobile-only. */
export type WebRole = 'coordinator' | 'administrator';

export type AppRole = WebRole | 'rescuer';

export function isWebRole(role: unknown): role is WebRole {
  return role === 'coordinator' || role === 'administrator';
}

/** Route a web user lands on after a successful login. */
export function routeForRole(role: WebRole): string {
  return role === 'administrator' ? '/admin' : '/dashboard';
}
