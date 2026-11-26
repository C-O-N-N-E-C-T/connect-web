import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { CoordinatorDashboard } from './CoordinatorDashboard';
import { AdminPage } from './AdminPage';
import { AuthContextProvider } from '../auth/AuthProvider';
import type { AppRole } from '../lib/roles';
import { AdminApiProvider } from '../admin/AdminApiContext';
import { makeAdminApi } from '../test/adminTestUtils';

// OSP-71: rol parametreli; varsayılan administrator (önceki testlerle aynı).
// OSP-72: AdminPage has nested routes and calls the admin API, so the tree gets a fake AdminApi
// and is rendered under `/admin/*` at `/admin`.
function withAuth(children: ReactNode, role: AppRole = 'administrator', path = '/') {
  return (
    <MemoryRouter initialEntries={[path]}>
      <AuthContextProvider
        value={{
          status: 'signedIn',
          session: null,
          role,
          connectionProblem: false,
          roleConfirmed: true,
          roleCheckStatus: 'pending',
          logout: vi.fn().mockResolvedValue(undefined),
          revalidate: vi.fn().mockResolvedValue(undefined),
          signOutDisallowedRole: vi.fn().mockResolvedValue(undefined),
        }}
      >
        <AdminApiProvider api={makeAdminApi()}>
          <Routes>
            <Route path="/admin/*" element={children} />
            <Route path="*" element={children} />
          </Routes>
        </AdminApiProvider>
      </AuthContextProvider>
    </MemoryRouter>
  );
}

describe('main panel layouts show the disclaimer (AC-29)', () => {
  it('coordinator dashboard', () => {
    render(withAuth(<CoordinatorDashboard />));
    expect(screen.getByRole('note')).toHaveTextContent('kurtarmayı garanti etmez');
  });

  it('administrator page', () => {
    render(withAuth(<AdminPage />, 'administrator', '/admin'));
    expect(screen.getByRole('note')).toHaveTextContent('kurtarmayı garanti etmez');
  });
});

// OSP-71: operasyonel ekranın rol matrisine göre kontrolleri.
describe('coordinator dashboard controls (OSP-71)', () => {
  it('shows the disabled placeholder override and assign buttons to a coordinator', () => {
    render(withAuth(<CoordinatorDashboard />, 'coordinator'));
    const override = screen.getByRole('button', { name: 'Override' });
    const assign = screen.getByRole('button', { name: 'Kaynak ata' });
    for (const button of [override, assign]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Bu işlem henüz uygulanmadı.');
      expect(button).toHaveAttribute('aria-description', 'Bu işlem henüz uygulanmadı.');
    }
    expect(screen.queryByText('Salt okunur görünüm')).not.toBeInTheDocument();
  });

  it('shows an administrator a read-only view without override or assign controls', () => {
    const { container } = render(withAuth(<CoordinatorDashboard />, 'administrator'));
    expect(screen.getByText('Salt okunur görünüm')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Override' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kaynak ata' })).not.toBeInTheDocument();
    // Gizleme CSS ile değil: kontroller DOM'da hiç yok, yalnızca çıkış butonu kalır.
    expect(container.querySelector('.panel-actions')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Çıkış yap']);
  });
});
