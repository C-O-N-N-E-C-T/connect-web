import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAdmin } from '../../test/adminTestUtils';

/**
 * OSP-72: in VITE_AUTH_SESSION_MODE=mock the session is never bound to a device, so admin calls
 * would end in a forced SESSION_NOT_BOUND sign-out. The panel explains the setup instead.
 */
describe('AdminPage in mock session mode', () => {
  it.each(['/admin/users', '/admin/audit-logs', '/admin/users/3f1c2b7e-8d4a-4f6b-9c1e-2a5d7e9f0b13'])(
    'shows the setup hint and makes no admin call at %s',
    async (path) => {
      const { api } = renderAdmin(path, { backendDisabled: true });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Yönetici ekranları mock modunda çalışmaz');
      expect(alert).toHaveTextContent('VITE_AUTH_SESSION_MODE=real');
      expect(screen.getByRole('heading', { name: 'Yönetici Paneli' })).toBeInTheDocument();

      for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it('loads data normally when the backend is enabled', async () => {
    const { api } = renderAdmin('/admin/users');
    expect(await screen.findByRole('heading', { name: 'Kullanıcılar' })).toBeInTheDocument();
    expect(screen.queryByText(/mock modunda çalışmaz/)).not.toBeInTheDocument();
    expect(api.listUsers).toHaveBeenCalled();
  });
});
