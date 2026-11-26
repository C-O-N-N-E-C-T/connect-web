/** OSP-72: helpers for the admin page tests (fake AdminApi, fixtures, render at a route). */
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthContextProvider } from '../auth/AuthProvider';
import { AdminApiProvider } from '../admin/AdminApiContext';
import { AdminPage } from '../pages/AdminPage';
import type { AdminApi, AdminDevice, AdminUser, AuditLogEntry } from '../services/adminApi';
import { sessionFor } from './authTestUtils';

export const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

export function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: USER_ID,
    email: 'ayse@example.com',
    full_name: 'Ayşe Yılmaz',
    role: 'coordinator',
    is_active: true,
    created_at: '2026-11-20T08:30:00.000Z',
    all_sessions_revoked_at: null,
    ...overrides,
  };
}

export function adminDevice(overrides: Partial<AdminDevice> = {}): AdminDevice {
  return {
    device_id: DEVICE_ID,
    device_name: 'Saha telefonu',
    last_login_at: '2026-11-25T10:00:00.000Z',
    is_device_revoked: false,
    device_revoked_at: null,
    has_session: true,
    ...overrides,
  };
}

export function auditLog(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    actor_user_id: ADMIN_ID,
    actor_role: 'administrator',
    device_id: DEVICE_ID,
    action_type: 'LOGIN',
    target_record_id: USER_ID,
    created_at: '2026-11-26T09:05:03.123Z',
    ...overrides,
  };
}

/** Fake AdminApi: every method succeeds with empty data unless overridden. */
export function makeAdminApi(overrides: Partial<AdminApi> = {}) {
  const api = {
    listUsers: vi.fn<AdminApi['listUsers']>(async (page) => ({
      ok: true,
      status: 200,
      data: { users: [], limit: page.limit, offset: page.offset },
    })),
    createUser: vi.fn<AdminApi['createUser']>(async (input) => ({
      ok: true,
      status: 201,
      data: { user: { id: USER_ID, email: input.email, full_name: input.full_name, role: input.role, is_active: true } },
    })),
    listDevices: vi.fn<AdminApi['listDevices']>(async () => ({ ok: true, status: 200, data: { devices: [] } })),
    revokeDevice: vi.fn<AdminApi['revokeDevice']>(async (_userId, deviceId) => ({
      ok: true,
      status: 200,
      data: { device_id: deviceId, is_device_revoked: true, status: 'REVOKED' },
    })),
    revokeAll: vi.fn<AdminApi['revokeAll']>(async (userId) => ({
      ok: true,
      status: 200,
      data: { user: { id: userId, is_active: false } },
    })),
    reactivate: vi.fn<AdminApi['reactivate']>(async (userId) => ({
      ok: true,
      status: 200,
      data: { user: { id: userId, is_active: true } },
    })),
    listAuditLogs: vi.fn<AdminApi['listAuditLogs']>(async (_filters, page) => ({
      ok: true,
      status: 200,
      data: { logs: [], limit: page.limit, offset: page.offset },
    })),
  };
  Object.assign(api, overrides);
  return api;
}

export type FakeAdminApi = ReturnType<typeof makeAdminApi>;

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

/** Renders AdminPage at `path` for a confirmed administrator (session for ADMIN_ID). */
export function renderAdmin(
  path: string,
  options: {
    api?: FakeAdminApi;
    state?: unknown;
    currentDeviceId?: string | null;
    backendDisabled?: boolean;
  } = {},
) {
  const api = options.api ?? makeAdminApi();
  const url = new URL(path, 'http://localhost');
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[{ pathname: url.pathname, search: url.search, state: options.state }]}>
      <AuthContextProvider
        value={{
          status: 'signedIn',
          session: sessionFor('administrator', ADMIN_ID),
          role: 'administrator',
          connectionProblem: false,
          roleConfirmed: true,
          roleCheckStatus: 'pending',
          logout: vi.fn().mockResolvedValue(undefined),
          revalidate: vi.fn().mockResolvedValue(undefined),
          signOutDisallowedRole: vi.fn().mockResolvedValue(undefined),
        }}
      >
        <AdminApiProvider
          api={api}
          currentDeviceId={() => options.currentDeviceId ?? null}
          backendDisabled={options.backendDisabled ?? false}
        >
          <LocationProbe />
          <Routes>
            <Route path="/admin/*" element={<AdminPage />} />
          </Routes>
        </AdminApiProvider>
      </AuthContextProvider>
    </MemoryRouter>,
  );
  return { user, api };
}

export const currentLocation = (screen: { getByTestId(id: string): HTMLElement }) =>
  screen.getByTestId('location').textContent ?? '';
