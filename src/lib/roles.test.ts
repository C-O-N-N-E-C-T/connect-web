import { describe, expect, it } from 'vitest';
import { isWebRole, routeForRole } from './roles';

describe('roles', () => {
  it('allows only coordinator and administrator on the web', () => {
    expect(isWebRole('coordinator')).toBe(true);
    expect(isWebRole('administrator')).toBe(true);
    expect(isWebRole('rescuer')).toBe(false);
    expect(isWebRole(null)).toBe(false);
    expect(isWebRole(undefined)).toBe(false);
  });

  it('routes administrators to /admin and coordinators to /dashboard', () => {
    expect(routeForRole('administrator')).toBe('/admin');
    expect(routeForRole('coordinator')).toBe('/dashboard');
  });
});
