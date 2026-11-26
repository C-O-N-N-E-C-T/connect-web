import { describe, expect, it } from 'vitest';
import { can, PERMISSION_ACTIONS, type PermissionAction } from './permissions';

// OSP-71: rol matrisinin her hücresi. Beklenen tablo backend OSP-62 ile birebir aynıdır
// (connect-backend src/routes/business.ts ve src/routes/admin.ts).
const EXPECTED: Record<string, Record<PermissionAction, boolean>> = {
  rescuer: { viewOperations: false, override: false, assign: false, admin: false },
  coordinator: { viewOperations: true, override: true, assign: true, admin: false },
  administrator: { viewOperations: true, override: false, assign: false, admin: true },
};

const cells = Object.entries(EXPECTED).flatMap(([role, row]) =>
  PERMISSION_ACTIONS.map((action) => [role, action, row[action]] as const),
);

describe('can (OSP-71 role matrix)', () => {
  it('covers exactly the four actions', () => {
    expect([...PERMISSION_ACTIONS].sort()).toEqual(['admin', 'assign', 'override', 'viewOperations']);
  });

  it.each(cells)('%s / %s -> %s', (role, action, expected) => {
    expect(can(role, action)).toBe(expected);
  });

  // Bilinmeyen, eksik ya da tip dışı roller güvenli tarafta kalır: hiçbir eylem yok.
  it.each([null, undefined, '', 'superuser', 'Administrator', 'COORDINATOR', 42, {}, ['administrator']])(
    'denies every action for an unknown role (%j)',
    (role) => {
      for (const action of PERMISSION_ACTIONS) expect(can(role, action)).toBe(false);
    },
  );

  it('does not grant inherited object keys as roles', () => {
    expect(can('toString', 'admin')).toBe(false);
    expect(can('__proto__', 'viewOperations')).toBe(false);
  });
});
