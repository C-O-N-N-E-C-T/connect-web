import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { auditLog, currentLocation, DEVICE_ID, makeAdminApi, renderAdmin, USER_ID, ADMIN_ID } from '../../test/adminTestUtils';
import type { AuditLogEntry } from '../../services/adminApi';

// OSP-72: audit log with filters and paging in the URL.

function withLogs(logs: AuditLogEntry[]) {
  const api = makeAdminApi();
  api.listAuditLogs.mockImplementation(async (_filters, page) => ({
    ok: true,
    status: 200,
    data: { logs: logs.slice(page.offset, page.offset + page.limit), limit: page.limit, offset: page.offset },
  }));
  return api;
}

const manyLogs = (count: number) =>
  Array.from({ length: count }, (_, i) => auditLog({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));

describe('AuditLogPage', () => {
  it('renders the columns and rows; nulls as "—", unknown action verbatim', async () => {
    const api = withLogs([
      auditLog(),
      auditLog({ id: 'x2', actor_user_id: null, actor_role: null, device_id: null, target_record_id: null, action_type: 'FOO' }),
    ]);
    renderAdmin('/admin/audit-logs', { api });
    const table = await screen.findByRole('table', { name: 'Denetim kayıtları' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[0]).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Zaman (UTC)',
      'Aktör',
      'Rol',
      'Cihaz (device_id)',
      'İşlem',
      'Hedef kayıt (target_record_id)',
    ]);
    expect(within(rows[1]).getAllByRole('cell').map((td) => td.textContent)).toEqual([
      '2026-11-26 09:05:03 UTC',
      ADMIN_ID,
      'Yönetici',
      DEVICE_ID,
      'LOGIN Giriş',
      USER_ID,
    ]);
    expect(within(rows[2]).getAllByRole('cell').map((td) => td.textContent)).toEqual([
      '2026-11-26 09:05:03 UTC',
      '—',
      '—',
      '—',
      'FOO',
      '—',
    ]);
    expect(api.listAuditLogs).toHaveBeenCalledWith({}, { limit: 26, offset: 0 });
  });

  it('prefills the form from the URL and requests with those filters', async () => {
    const { api } = renderAdmin(
      `/admin/audit-logs?action_type=DEVICE_REVOKED&actor_user_id=${ADMIN_ID}&from=2026-11-26T10:00:00.000Z&to=2026-11-26T10:30:59.999Z&page=2`,
    );
    await screen.findByText('Bu sayfada kayıt yok.');
    expect(api.listAuditLogs).toHaveBeenCalledWith(
      { action_type: 'DEVICE_REVOKED', actor_user_id: ADMIN_ID, from: '2026-11-26T10:00:00.000Z', to: '2026-11-26T10:30:59.999Z' },
      { limit: 26, offset: 25 },
    );
    expect(screen.getByLabelText('İşlem türü')).toHaveValue('DEVICE_REVOKED');
    expect(screen.getByLabelText('Aktör kullanıcı kimliği')).toHaveValue(ADMIN_ID);
    expect(screen.getByLabelText('Başlangıç (UTC)')).toHaveValue('2026-11-26T10:00');
    expect(screen.getByLabelText('Bitiş (UTC)')).toHaveValue('2026-11-26T10:30');
  });

  it('writes the filters to the URL on submit (page reset) and requests offset 0', async () => {
    const { user, api } = renderAdmin('/admin/audit-logs?page=3');
    await screen.findByText('Bu sayfada kayıt yok.');
    await user.selectOptions(screen.getByLabelText('İşlem türü'), 'LOGIN');
    await user.type(screen.getByLabelText('Hedef kayıt kimliği'), USER_ID);
    await user.click(screen.getByRole('button', { name: 'Filtrele' }));
    expect(currentLocation(screen)).toBe(`/admin/audit-logs?action_type=LOGIN&target_record_id=${USER_ID}`);
    await waitFor(() =>
      expect(api.listAuditLogs).toHaveBeenLastCalledWith(
        { action_type: 'LOGIN', target_record_id: USER_ID },
        { limit: 26, offset: 0 },
      ),
    );
    expect(await screen.findByText('Filtrelere uyan kayıt bulunamadı.')).toBeInTheDocument();
  });

  it('shows field errors and makes no request for a bad UUID or an end before the start', async () => {
    const { user, api } = renderAdmin('/admin/audit-logs');
    await screen.findByText('Kayıt bulunamadı.');
    await user.type(screen.getByLabelText('Aktör kullanıcı kimliği'), 'abc');
    await user.type(screen.getByLabelText('Başlangıç (UTC)'), '2026-11-26T10:30');
    await user.type(screen.getByLabelText('Bitiş (UTC)'), '2026-11-26T10:00');
    await user.click(screen.getByRole('button', { name: 'Filtrele' }));
    expect(screen.getByLabelText('Aktör kullanıcı kimliği')).toHaveAccessibleDescription('Geçerli bir kimlik (UUID) girin.');
    expect(screen.getByLabelText('Aktör kullanıcı kimliği')).toHaveFocus();
    expect(screen.getByLabelText('Bitiş (UTC)')).toHaveAccessibleDescription('Bitiş zamanı başlangıçtan önce olamaz.');
    expect(api.listAuditLogs).toHaveBeenCalledOnce();
    expect(currentLocation(screen)).toBe('/admin/audit-logs');
  });

  it('makes the end time inclusive to the end of the minute', async () => {
    const { user, api } = renderAdmin('/admin/audit-logs');
    await screen.findByText('Kayıt bulunamadı.');
    await user.type(screen.getByLabelText('Bitiş (UTC)'), '2026-11-26T10:30');
    await user.click(screen.getByRole('button', { name: 'Filtrele' }));
    await waitFor(() =>
      expect(api.listAuditLogs).toHaveBeenLastCalledWith({ to: '2026-11-26T10:30:59.999999Z' }, { limit: 26, offset: 0 }),
    );
  });

  it('clears the filters with Temizle', async () => {
    const { user, api } = renderAdmin('/admin/audit-logs?action_type=LOGIN');
    await screen.findByText('Filtrelere uyan kayıt bulunamadı.');
    await user.click(screen.getByRole('button', { name: 'Temizle' }));
    expect(currentLocation(screen)).toBe('/admin/audit-logs');
    expect(screen.getByLabelText('İşlem türü')).toHaveValue('');
    await waitFor(() => expect(api.listAuditLogs).toHaveBeenLastCalledWith({}, { limit: 26, offset: 0 }));
  });

  it('keeps the filters when paging', async () => {
    const api = withLogs(manyLogs(30));
    const { user } = renderAdmin('/admin/audit-logs?action_type=LOGIN', { api });
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Sonraki' }));
    expect(currentLocation(screen)).toBe('/admin/audit-logs?action_type=LOGIN&page=2');
    await waitFor(() =>
      expect(api.listAuditLogs).toHaveBeenLastCalledWith({ action_type: 'LOGIN' }, { limit: 26, offset: 25 }),
    );
  });

  it('removes an invalid action_type from the URL and requests without it', async () => {
    const { api } = renderAdmin(`/admin/audit-logs?action_type=BAD&target_record_id=${USER_ID}`);
    await waitFor(() => expect(currentLocation(screen)).toBe(`/admin/audit-logs?target_record_id=${USER_ID}`));
    expect(api.listAuditLogs).toHaveBeenCalledOnce();
    expect(api.listAuditLogs).toHaveBeenCalledWith({ target_record_id: USER_ID }, { limit: 26, offset: 0 });
  });

  it('shows an error alert with retry', async () => {
    const api = makeAdminApi();
    api.listAuditLogs.mockResolvedValueOnce({ ok: false, error: { kind: 'ROLE_FORBIDDEN', status: 403 } });
    const { user } = renderAdmin('/admin/audit-logs', { api });
    expect(await screen.findByRole('alert')).toHaveTextContent('Bu işlem için yetkiniz yok.');
    await user.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    expect(await screen.findByText('Kayıt bulunamadı.')).toBeInTheDocument();
  });
});
