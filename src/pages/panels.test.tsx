import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { CoordinatorDashboard } from './CoordinatorDashboard';
import { AdminPage } from './AdminPage';
import { AuthContextProvider } from '../auth/AuthProvider';

function withAuth(children: ReactNode) {
  return (
    <MemoryRouter>
      <AuthContextProvider
        value={{
          status: 'signedIn',
          session: null,
          role: 'administrator',
          connectionProblem: false,
          logout: vi.fn().mockResolvedValue(undefined),
          revalidate: vi.fn().mockResolvedValue(undefined),
        }}
      >
        {children}
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
    render(withAuth(<AdminPage />));
    expect(screen.getByRole('note')).toHaveTextContent('kurtarmayı garanti etmez');
  });
});
