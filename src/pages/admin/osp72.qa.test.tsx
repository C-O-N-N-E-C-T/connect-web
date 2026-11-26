/**
 * OSP-72 QA: races, StrictMode, double submit, sign-out rendering and URL canonicalisation of the
 * admin screens (additions to the developer's page tests).
 */
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthContextProvider } from '../../auth/AuthProvider';
import { AdminApiProvider } from '../../admin/AdminApiContext';
import { AdminPage } from '../AdminPage';
import { sessionFor } from '../../test/authTestUtils';
import {
  ADMIN_ID,
  adminDevice,
  adminUser,
  auditLog,
  currentLocation,
  DEVICE_ID,
  makeAdminApi,
  renderAdmin,
  USER_ID,
  type FakeAdminApi,
} from '../../test/adminTestUtils';
import type { ApiResult } from '../../services/apiClient';
import type { AuditLogsResponse } from '../../services/adminApi';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const logs = (...ids: string[]): ApiResult<AuditLogsResponse> => ({
  ok: true,
  status: 200,
  data: { logs: ids.map((id) => auditLog({ id, target_record_id: id })), limit: 26, offset: 0 },
});
const ID_A = '0aaaaaaa-0000-4000-8000-000000000001';
const ID_B = '0bbbbbbb-0000-4000-8000-000000000002';

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

/** renderAdmin, but inside <StrictMode>. */
function renderStrict(path: string, api: FakeAdminApi, state?: unknown) {
  const url = new URL(path, 'http://localhost');
  const user = userEvent.setup();
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[{ pathname: url.pathname, search: url.search, state }]}>
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
          <AdminApiProvider api={api}>
            <LocationProbe />
            <Routes>
              <Route path="/admin/*" element={<AdminPage />} />
            </Routes>
          </AdminApiProvider>
        </AuthContextProvider>
      </MemoryRouter>
    </StrictMode>,
  );
  return { user };
}

function devicesApi() {
  const api = makeAdminApi();
  api.listDevices.mockResolvedValue({ ok: true, status: 200, data: { devices: [adminDevice()] } });
  api.listUsers.mockResolvedValue({ ok: true, status: 200, data: { users: [adminUser()], limit: 100, offset: 0 } });
  return api;
}

describe('AuditLogPage races and canonicalisation', () => {
  it('a late answer for old filters never overwrites the newer result', async () => {
    const api = makeAdminApi();
    const first = deferred<ApiResult<AuditLogsResponse>>();
    api.listAuditLogs.mockReturnValueOnce(first.promise).mockResolvedValueOnce(logs(ID_B));
    const { user } = renderAdmin('/admin/audit-logs', { api });
    await user.selectOptions(screen.getByLabelText('İşlem türü'), 'LOGIN');
    await user.click(screen.getByRole('button', { name: 'Filtrele' }));
    expect(await screen.findByText(ID_B)).toBeInTheDocument();
    await act(async () => first.resolve(logs(ID_A)));
    expect(screen.queryByText(ID_A)).not.toBeInTheDocument();
    expect(screen.getByText(ID_B)).toBeInTheDocument();
  });

  it('a late ERROR for old filters does not replace the newer rows with an alert', async () => {
    const api = makeAdminApi();
    const first = deferred<ApiResult<AuditLogsResponse>>();
    api.listAuditLogs.mockReturnValueOnce(first.promise).mockResolvedValueOnce(logs(ID_B));
    const { user } = renderAdmin('/admin/audit-logs', { api });
    await user.click(screen.getByRole('button', { name: 'Filtrele' })); // same URL -> reload
    expect(await screen.findByText(ID_B)).toBeInTheDocument();
    await act(async () => first.resolve({ ok: false, error: { kind: 'SERVER_ERROR', status: 500 } }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a messy URL is canonicalised with ONE replace and ONE request (no loop)', async () => {
    const api = makeAdminApi();
    renderAdmin(
      `/admin/audit-logs?x=1&page=01&to=2026-11-01T00:00:00.000Z&from=2026-11-02T00:00:00.000Z&action_type=NOPE&actor_user_id=${ADMIN_ID}&actor_user_id=${USER_ID}`,
      { api },
    );
    await screen.findByText('Filtrele');
    await waitFor(() => expect(currentLocation(screen)).toBe(
      `/admin/audit-logs?actor_user_id=${ADMIN_ID}&from=2026-11-02T00%3A00%3A00.000Z`,
    ));
    await new Promise((r) => setTimeout(r, 30));
    expect(api.listAuditLogs).toHaveBeenCalledTimes(1);
    expect(api.listAuditLogs).toHaveBeenCalledWith(
      { actor_user_id: ADMIN_ID, from: '2026-11-02T00:00:00.000Z' },
      { limit: 26, offset: 0 },
    );
  });

  it.each(['SIGNED_OUT', 'SESSION_CHANGED'] as const)('%s renders no alert and no retry', async (kind) => {
    const api = makeAdminApi();
    api.listAuditLogs.mockResolvedValue({ ok: false, error: { kind } });
    renderAdmin('/admin/audit-logs', { api });
    await waitFor(() => expect(screen.queryByText('Yükleniyor…')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tekrar dene' })).not.toBeInTheDocument();
  });

  it('a backend 400 on the filters shows the invalid-input message', async () => {
    const api = makeAdminApi();
    api.listAuditLogs.mockResolvedValue({ ok: false, error: { kind: 'HTTP_ERROR', status: 400, errorCode: 'VALIDATION_ERROR' } });
    renderAdmin('/admin/audit-logs', { api });
    expect(await screen.findByRole('alert')).toHaveTextContent('Gönderilen bilgiler geçersiz.');
  });

  it('paging keeps the filters and the newer page wins under StrictMode', async () => {
    const api = makeAdminApi();
    api.listAuditLogs.mockImplementation(async (_f, page) =>
      page.offset === 0
        ? { ok: true, status: 200, data: { logs: Array.from({ length: 26 }, (_, i) => auditLog({ id: `p1-${i}` })), limit: 26, offset: 0 } }
        : logs(ID_B),
    );
    const { user } = renderStrict('/admin/audit-logs?action_type=LOGIN', api);
    await user.click(await screen.findByRole('button', { name: 'Sonraki' }));
    expect(await screen.findByText(ID_B)).toBeInTheDocument();
    expect(currentLocation(screen)).toBe('/admin/audit-logs?action_type=LOGIN&page=2');
    expect(api.listAuditLogs).toHaveBeenLastCalledWith({ action_type: 'LOGIN' }, { limit: 26, offset: 25 });
  });
});

describe('UserDevicesPage destructive actions', () => {
  it('a double click on "Hesabı devre dışı bırak" sends ONE revoke-all', async () => {
    const api = devicesApi();
    const answer = deferred<Awaited<ReturnType<FakeAdminApi['revokeAll']>>>();
    api.revokeAll.mockReturnValue(answer.promise);
    const { user } = renderAdmin(`/admin/users/${USER_ID}`, { api, state: { user: adminUser() } });
    await user.click(await screen.findByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.dblClick(within(dialog).getByRole('button', { name: 'Hesabı devre dışı bırak' }));
    await act(async () => answer.resolve({ ok: true, status: 200, data: { user: { id: USER_ID, is_active: false } } }));
    expect(api.revokeAll).toHaveBeenCalledTimes(1);
    expect(api.revokeDevice).not.toHaveBeenCalled();
  });

  it('a double click on "Cihazı iptal et" sends ONE device revoke and never revoke-all', async () => {
    const api = devicesApi();
    const { user } = renderAdmin(`/admin/users/${USER_ID}`, { api, state: { user: adminUser() } });
    await user.click(await screen.findByRole('button', { name: /Yalnızca bu cihazı iptal et:/ }));
    await user.dblClick(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cihazı iptal et' }));
    await screen.findByText('Cihaz iptal edildi.');
    expect(api.revokeDevice).toHaveBeenCalledTimes(1);
    expect(api.revokeDevice).toHaveBeenCalledWith(USER_ID, DEVICE_ID);
    expect(api.revokeAll).not.toHaveBeenCalled();
  });

  it('StrictMode: focus starts on Vazgeç, Escape closes and focus returns to the opener', async () => {
    const api = devicesApi();
    const { user } = renderStrict(`/admin/users/${USER_ID}`, api, { user: adminUser() });
    const opener = await screen.findByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' });
    await user.click(opener);
    expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Vazgeç' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(api.revokeAll).not.toHaveBeenCalled();
  });

  it('Tab stays inside the global-revoke dialog', async () => {
    const api = devicesApi();
    const { user } = renderAdmin(`/admin/users/${USER_ID}`, { api, state: { user: adminUser() } });
    await user.click(await screen.findByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' }));
    const dialog = screen.getByRole('alertdialog');
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('a 500 on revoke-all stays in the dialog with the "may already be disabled" text; status unchanged', async () => {
    const api = devicesApi();
    api.revokeAll.mockResolvedValue({ ok: false, error: { kind: 'SERVER_ERROR', status: 500 } });
    const { user } = renderAdmin(`/admin/users/${USER_ID}`, { api, state: { user: adminUser() } });
    await user.click(await screen.findByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Hesabı devre dışı bırak' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Hesap devre dışı bırakılmış olabilir');
    expect(screen.queryByText('Hesabı yeniden etkinleştir')).not.toBeInTheDocument();
  });

  it('SIGNED_OUT during a device revoke shows no error in the dialog', async () => {
    const api = devicesApi();
    api.revokeDevice.mockResolvedValue({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'DEVICE_REVOKED' } });
    const { user } = renderAdmin(`/admin/users/${USER_ID}`, { api, state: { user: adminUser() } });
    await user.click(await screen.findByRole('button', { name: /Yalnızca bu cihazı iptal et:/ }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cihazı iptal et' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cihazı iptal et' })).toBeEnabled());
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the own account cannot be disabled (button disabled, no dialog, no request)', async () => {
    const api = devicesApi();
    const self = adminUser({ id: ADMIN_ID, role: 'administrator' });
    const { user } = renderAdmin(`/admin/users/${ADMIN_ID}`, { api, state: { user: self } });
    const button = await screen.findByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.revokeAll).not.toHaveBeenCalled();
  });

  // Observation (UX gap, not an AC): when the user summary cannot be found (not in the first 1000
  // users, or the list call failed) the account section offers NO global revoke / reactivate.
  it('KNOWN LIMIT: no account actions when the user is beyond the 1000-user scan', async () => {
    const api = makeAdminApi();
    api.listDevices.mockResolvedValue({ ok: true, status: 200, data: { devices: [adminDevice()] } });
    const filler = Array.from({ length: 100 }, (_, i) =>
      adminUser({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    );
    api.listUsers.mockResolvedValue({ ok: true, status: 200, data: { users: filler, limit: 100, offset: 0 } });
    renderAdmin(`/admin/users/${USER_ID}`, { api });
    expect(await screen.findByRole('alert')).toHaveTextContent('Kullanıcı bulunamadı.');
    expect(api.listUsers).toHaveBeenCalledTimes(10);
    expect(screen.getByRole('button', { name: /Yalnızca bu cihazı iptal et:/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' })).not.toBeInTheDocument();
  });
});

describe('CreateUserDialog double submit', () => {
  it('a double click on Oluştur creates ONE account', async () => {
    const api = makeAdminApi();
    const { user } = renderAdmin('/admin/users', { api });
    await screen.findByText('Henüz kullanıcı yok.');
    await user.click(screen.getByRole('button', { name: 'Yeni kullanıcı' }));
    await user.type(screen.getByLabelText('Ad Soyad'), 'Mehmet Kaya');
    await user.type(screen.getByLabelText('E-posta'), 'mehmet@example.com');
    await user.type(screen.getByLabelText('Geçici şifre'), 'GüçlüŞifre123');
    await user.selectOptions(screen.getByLabelText('Rol'), 'rescuer');
    await user.dblClick(screen.getByRole('button', { name: 'Oluştur' }));
    await screen.findByText('Hesap oluşturuldu: mehmet@example.com');
    expect(api.createUser).toHaveBeenCalledTimes(1);
    expect(api.createUser).toHaveBeenCalledWith(expect.objectContaining({ role: 'rescuer' }));
  });

  it('the administrator role cannot be injected by editing the select value', async () => {
    const api = makeAdminApi();
    const { user } = renderAdmin('/admin/users', { api });
    await screen.findByText('Henüz kullanıcı yok.');
    await user.click(screen.getByRole('button', { name: 'Yeni kullanıcı' }));
    await user.type(screen.getByLabelText('Ad Soyad'), 'Mehmet Kaya');
    await user.type(screen.getByLabelText('E-posta'), 'mehmet@example.com');
    await user.type(screen.getByLabelText('Geçici şifre'), 'GüçlüŞifre123');
    const select = screen.getByLabelText('Rol') as HTMLSelectElement;
    // DevTools-style tampering: add an option and select it.
    const forged = document.createElement('option');
    forged.value = 'administrator';
    select.appendChild(forged);
    await user.selectOptions(select, 'administrator');
    await user.click(screen.getByRole('button', { name: 'Oluştur' }));
    expect(await screen.findByText('Bir rol seçin.')).toBeInTheDocument();
    expect(api.createUser).not.toHaveBeenCalled();
  });
});
