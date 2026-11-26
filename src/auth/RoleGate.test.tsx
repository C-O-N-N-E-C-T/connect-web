import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoleGate } from './RoleGate';
import { AuthContextProvider, type AuthContextValue } from './AuthProvider';
import type { AppRole } from '../lib/roles';
import type { PermissionAction } from '../lib/permissions';

function renderGate(role: AppRole | null, action: PermissionAction, fallback?: string) {
  const value: AuthContextValue = {
    status: role ? 'signedIn' : 'signedOut',
    session: null,
    role,
    connectionProblem: false,
    roleConfirmed: role !== null,
    roleCheckUnreachable: false,
    logout: vi.fn().mockResolvedValue(undefined),
    revalidate: vi.fn().mockResolvedValue(undefined),
    signOutDisallowedRole: vi.fn().mockResolvedValue(undefined),
  };
  return render(
    <AuthContextProvider value={value}>
      <div data-testid="host">
        <RoleGate action={action} fallback={fallback === undefined ? undefined : <span>{fallback}</span>}>
          <button type="button">GATED</button>
        </RoleGate>
      </div>
    </AuthContextProvider>,
  );
}

describe('RoleGate (OSP-71)', () => {
  it.each([
    ['coordinator', 'override'],
    ['coordinator', 'assign'],
    ['coordinator', 'viewOperations'],
    ['administrator', 'admin'],
    ['administrator', 'viewOperations'],
  ] as const)('renders the content for %s / %s', (role, action) => {
    renderGate(role, action);
    expect(screen.getByRole('button', { name: 'GATED' })).toBeInTheDocument();
  });

  it.each([
    ['administrator', 'override'],
    ['administrator', 'assign'],
    ['coordinator', 'admin'],
    ['rescuer', 'viewOperations'],
    [null, 'viewOperations'],
  ] as const)('does not put the content in the DOM for %s / %s', (role, action) => {
    renderGate(role, action);
    expect(screen.queryByText('GATED')).toBeNull();
    expect(screen.getByTestId('host')).toBeEmptyDOMElement();
  });

  it('renders the fallback instead when the role is not allowed', () => {
    renderGate('administrator', 'override', 'Salt okunur');
    expect(screen.getByText('Salt okunur')).toBeInTheDocument();
    expect(screen.queryByText('GATED')).toBeNull();
  });

  it('does not render the fallback when the role is allowed', () => {
    renderGate('coordinator', 'override', 'Salt okunur');
    expect(screen.getByRole('button', { name: 'GATED' })).toBeInTheDocument();
    expect(screen.queryByText('Salt okunur')).toBeNull();
  });
});
