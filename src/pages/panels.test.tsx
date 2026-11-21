import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CoordinatorDashboard } from './CoordinatorDashboard';
import { AdminPage } from './AdminPage';

vi.mock('../lib/supabase', () => ({
  supabase: { auth: { signOut: vi.fn().mockResolvedValue({ error: null }) } },
}));

describe('main panel layouts show the disclaimer (AC-29)', () => {
  it('coordinator dashboard', () => {
    render(
      <MemoryRouter>
        <CoordinatorDashboard />
      </MemoryRouter>,
    );
    expect(screen.getByRole('note')).toHaveTextContent('kurtarmayı garanti etmez');
  });

  it('administrator page', () => {
    render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('note')).toHaveTextContent('kurtarmayı garanti etmez');
  });
});
