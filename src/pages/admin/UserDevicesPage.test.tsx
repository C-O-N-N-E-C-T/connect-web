import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import {
  ADMIN_ID,
  adminDevice,
  adminUser,
  DEVICE_ID,
  makeAdminApi,
  renderAdmin,
  USER_ID,
} from '../../test/adminTestUtils';
import type { AdminDevice, AdminUser } from '../../services/adminApi';

// OSP-72: devices and account actions of one user.

const OTHER_DEVICE = '44444444-4444-4444-8444-444444444444';
const OLD_DEVICE = '55555555-5555-4555-8555-555555555555';

function setup(
  options: { user?: AdminUser; devices?: AdminDevice[]; state?: boolean; currentDeviceId?: string } = {},
) {
  const user = options.user ?? adminUser();
  const api = makeAdminApi();
  api.listDevices.mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      devices: options.devices ?? [
        adminDevice(),
        adminDevice({ device_id: OTHER_DEVICE, device_name: null, has_session: false, last_login_at: null }),
        adminDevice({
          device_id: OLD_DEVICE,
          device_name: 'Eski tablet',
          is_device_revoked: true,
          device_revoked_at: '2026-11-24T12:00:00.000Z',
          has_session: false,
        }),
      ],
    },
  });
  api.listUsers.mockResolvedValue({ ok: true, status: 200, data: { users: [user], limit: 100, offset: 0 } });
  const rendered = renderAdmin(`/admin/users/${user.id}`, {
    api,
    state: options.state === false ? undefined : { user, fromSearch: '?page=2' },
    currentDeviceId: options.currentDeviceId,
  });
  return rendered;
}

const devicesTable = () => screen.findByRole('table', { name: 'Kayıtlı cihazlar' });

describe('UserDevicesPage', () => {
  it('lists the devices with the three states; a revoked device has no button', async () => {
    const { api } = setup();
    const table = await devicesTable();
    expect(api.listDevices).toHaveBeenCalledWith(USER_ID);
    expect(api.listUsers).not.toHaveBeenCalled(); // summary came from the navigation state
    const rows = within(table).getAllByRole('row');
    expect(within(rows[0]).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Cihaz adı',
      'Cihaz kimliği',
      'Son giriş (UTC)',
      'Durum',
      'İşlem',
    ]);
    expect(within(rows[1]).getByText('Etkin oturum')).toHaveClass('status-ok');
    expect(within(rows[1]).getByText('2026-11-25 10:00:00 UTC')).toBeInTheDocument();
    expect(within(rows[2]).getAllByRole('cell')[0]).toHaveTextContent('—');
    expect(within(rows[2]).getByText('Oturum yok')).toHaveClass('status-neutral');
    expect(within(rows[3]).getByText(/İptal edildi/)).toHaveTextContent('İptal edildi 2026-11-24 12:00:00 UTC');
    expect(within(rows[3]).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Yalnızca bu cihazı iptal et/ })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Ayşe Yılmaz' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Kullanıcı listesi' })).toHaveAttribute('href', '/admin/users?page=2');
  });

  it('opens the device dialog with its own wording and focus on Vazgeç', async () => {
    const { user } = setup();
    await devicesTable();
    await user.click(screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Yalnızca bu cihazı iptal et' });
    expect(dialog).toHaveTextContent('diğer cihazları etkilenmez');
    expect(dialog).toHaveTextContent(DEVICE_ID);
    expect(dialog).not.toHaveTextContent('TÜM cihazlarındaki');
    expect(within(dialog).getByRole('button', { name: 'Vazgeç' })).toHaveFocus();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('cancels without a call; confirms with revokeDevice only and reloads the devices', async () => {
    const { user, api } = setup();
    await devicesTable();
    await user.click(screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' }));
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.revokeDevice).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' }));
    await user.click(screen.getByRole('button', { name: 'Cihazı iptal et' }));
    expect(await screen.findByText('Cihaz iptal edildi.')).toHaveAttribute('role', 'status');
    expect(api.revokeDevice).toHaveBeenCalledOnce();
    expect(api.revokeDevice).toHaveBeenCalledWith(USER_ID, DEVICE_ID);
    expect(api.revokeAll).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  });

  it('reports an already revoked device; a 404 stays in the dialog', async () => {
    const { user, api } = setup();
    api.revokeDevice
      .mockResolvedValueOnce({ ok: true, status: 200, data: { device_id: DEVICE_ID, is_device_revoked: true, status: 'ALREADY_REVOKED' } })
      .mockResolvedValueOnce({ ok: false, error: { kind: 'HTTP_ERROR', status: 404, errorCode: 'NOT_FOUND' } });
    await devicesTable();
    await user.click(screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' }));
    await user.click(screen.getByRole('button', { name: 'Cihazı iptal et' }));
    expect(await screen.findByText('Bu cihaz zaten iptal edilmişti.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' }));
    await user.click(screen.getByRole('button', { name: 'Cihazı iptal et' }));
    const dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Cihaz bulunamadı.');
  });

  it('global revoke: different dialog, needs the acknowledgement, calls revokeAll only', async () => {
    const { user, api } = setup();
    await devicesTable();
    await user.click(screen.getByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' });
    expect(dialog).toHaveTextContent('TÜM cihazlarındaki');
    expect(dialog).toHaveTextContent('ayse@example.com');
    const confirm = within(dialog).getByRole('button', { name: 'Hesabı devre dışı bırak' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Bu işlemin kullanıcının tüm oturumlarını kapatacağını anlıyorum.' }));
    await user.click(confirm);

    expect(await screen.findByText('Hesap devre dışı bırakıldı ve tüm oturumlar kapatıldı.')).toBeInTheDocument();
    expect(api.revokeAll).toHaveBeenCalledOnce();
    expect(api.revokeAll).toHaveBeenCalledWith(USER_ID);
    expect(api.revokeDevice).not.toHaveBeenCalled();
    expect(screen.getByText('Devre dışı')).toHaveClass('status-off');
    expect(screen.getByRole('button', { name: 'Hesabı yeniden etkinleştir' })).toBeInTheDocument();
  });

  it('cannot disable the own account', async () => {
    setup({ user: adminUser({ id: ADMIN_ID, role: 'administrator' }) });
    await devicesTable();
    const button = screen.getByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Kendi hesabınızı devre dışı bırakamazsınız.');
  });

  it('maps a server 409 on revoke-all to the self message', async () => {
    const { user, api } = setup();
    api.revokeAll.mockResolvedValue({ ok: false, error: { kind: 'HTTP_ERROR', status: 409, errorCode: 'CONFLICT' } });
    await devicesTable();
    await user.click(screen.getByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Hesabı devre dışı bırak' }));
    const dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Kendi hesabınızı devre dışı bırakamazsınız.');
  });

  it('reactivates an inactive account', async () => {
    const { user, api } = setup({ user: adminUser({ is_active: false }) });
    await devicesTable();
    expect(screen.queryByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hesabı yeniden etkinleştir' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Hesabı yeniden etkinleştir' });
    expect(dialog).not.toHaveClass('modal-danger');
    await user.click(within(dialog).getByRole('button', { name: 'Yeniden etkinleştir' }));
    expect(await screen.findByText('Hesap yeniden etkinleştirildi.')).toBeInTheDocument();
    expect(api.reactivate).toHaveBeenCalledWith(USER_ID);
    expect(screen.getByText('Etkin')).toHaveClass('status-ok');
  });

  it('shows nothing after a forced sign-out', async () => {
    const { user, api } = setup();
    api.revokeDevice.mockResolvedValue({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'DEVICE_REVOKED' } });
    await devicesTable();
    await user.click(screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' }));
    await user.click(screen.getByRole('button', { name: 'Cihazı iptal et' }));
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cihazı iptal et' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rejects a non-UUID id without any request', async () => {
    const api = makeAdminApi();
    renderAdmin('/admin/users/42', { api });
    expect(await screen.findByRole('alert')).toHaveTextContent('Geçersiz kullanıcı kimliği.');
    expect(screen.getByRole('link', { name: '← Kullanıcı listesi' })).toHaveAttribute('href', '/admin/users');
    expect(api.listUsers).not.toHaveBeenCalled();
    expect(api.listDevices).not.toHaveBeenCalled();
  });

  it('without navigation state scans the user list page by page', async () => {
    const api = makeAdminApi();
    const filler = Array.from({ length: 100 }, (_, i) =>
      adminUser({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    );
    api.listUsers
      .mockResolvedValueOnce({ ok: true, status: 200, data: { users: filler, limit: 100, offset: 0 } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { users: [adminUser()], limit: 100, offset: 100 } });
    renderAdmin(`/admin/users/${USER_ID}`, { api });
    expect(await screen.findByRole('heading', { name: 'Ayşe Yılmaz' })).toBeInTheDocument();
    expect(api.listUsers.mock.calls.map(([page]) => page)).toEqual([
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
    ]);
  });

  it('says the user was not found when the scan ends without a match', async () => {
    const api = makeAdminApi();
    renderAdmin(`/admin/users/${USER_ID}`, { api });
    expect(await screen.findByText('Kullanıcı bulunamadı.')).toHaveAttribute('role', 'alert');
    expect(api.listUsers).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /Hesabı/ })).not.toBeInTheDocument();
  });

  it('links to the audit log filtered by this user', async () => {
    setup();
    await devicesTable();
    expect(screen.getByRole('link', { name: 'Bu kullanıcıyla ilgili denetim kayıtları' })).toHaveAttribute(
      'href',
      `/admin/audit-logs?target_record_id=${USER_ID}`,
    );
  });

  // OSP-72 QA fixes.
  const OWN_WARNING = 'Bu, şu an kullandığınız cihaz. İptal ederseniz oturumunuz hemen kapanır.';

  it('marks and warns about the device the administrator is using now', async () => {
    const { user } = setup({ user: adminUser({ id: ADMIN_ID, role: 'administrator' }), currentDeviceId: DEVICE_ID });
    const table = await devicesTable();
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).getAllByRole('cell')[0]).toHaveTextContent('Saha telefonu (bu cihaz)');
    expect(within(rows[2]).getAllByRole('cell')[0]).not.toHaveTextContent('(bu cihaz)');

    await user.click(screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(OWN_WARNING);
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    await user.click(screen.getByRole('button', { name: `Yalnızca bu cihazı iptal et: ${OTHER_DEVICE}` }));
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(OWN_WARNING);
  });

  it('does not mark the same device id on another user', async () => {
    const { user } = setup({ currentDeviceId: DEVICE_ID });
    await devicesTable();
    expect(screen.queryByText(/\(bu cihaz\)/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' }));
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(OWN_WARNING);
  });

  it('moves focus to the account heading after disabling and after reactivating', async () => {
    const { user } = setup();
    await devicesTable();
    await user.click(screen.getByRole('button', { name: 'Hesabı devre dışı bırak ve tüm oturumları kapat' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Hesabı devre dışı bırak' }));
    await screen.findByText('Hesap devre dışı bırakıldı ve tüm oturumlar kapatıldı.');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Hesap işlemleri' })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Hesabı yeniden etkinleştir' }));
    await user.click(screen.getByRole('button', { name: 'Yeniden etkinleştir' }));
    await screen.findByText('Hesap yeniden etkinleştirildi.');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Hesap işlemleri' })).toHaveFocus());
  });

  it('moves focus to the devices heading after a device revoke; back to the opener on cancel', async () => {
    const { user } = setup();
    await devicesTable();
    const opener = screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(opener).toHaveFocus();
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Cihazı iptal et' }));
    await screen.findByText('Cihaz iptal edildi.');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Kayıtlı cihazlar' })).toHaveFocus());
  });

  it('reloads the device list after a 404 while keeping the error in the dialog', async () => {
    const { user, api } = setup();
    api.revokeDevice.mockResolvedValue({ ok: false, error: { kind: 'HTTP_ERROR', status: 404, errorCode: 'NOT_FOUND' } });
    await devicesTable();
    expect(api.listDevices).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' }));
    await user.click(screen.getByRole('button', { name: 'Cihazı iptal et' }));
    const dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Cihaz bulunamadı.');
    await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('does not reload the device list for other device-revoke errors', async () => {
    const { user, api } = setup();
    api.revokeDevice.mockResolvedValue({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    await devicesTable();
    await user.click(screen.getByRole('button', { name: 'Yalnızca bu cihazı iptal et: Saha telefonu' }));
    await user.click(screen.getByRole('button', { name: 'Cihazı iptal et' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Sunucuya ulaşılamadı');
    expect(api.listDevices).toHaveBeenCalledTimes(1);
  });
});
