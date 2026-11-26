import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import {
  ADMIN_ID,
  adminUser,
  currentLocation,
  makeAdminApi,
  renderAdmin,
} from '../../test/adminTestUtils';
import type { AdminUser } from '../../services/adminApi';

// OSP-72: user list and the create-user dialog.

function withUsers(users: AdminUser[]) {
  const api = makeAdminApi();
  api.listUsers.mockImplementation(async (page) => ({
    ok: true,
    status: 200,
    data: { users: users.slice(page.offset, page.offset + page.limit), limit: page.limit, offset: page.offset },
  }));
  return api;
}

const manyUsers = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    adminUser({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `u${i}@example.com`, full_name: `Kişi ${i}` }),
  );

describe('UsersPage', () => {
  it('redirects /admin to /admin/users and loads the first page', async () => {
    const { api } = renderAdmin('/admin');
    expect(await screen.findByRole('heading', { name: 'Kullanıcılar' })).toBeInTheDocument();
    expect(currentLocation(screen)).toBe('/admin/users');
    expect(api.listUsers).toHaveBeenCalledWith({ limit: 26, offset: 0 });
    expect(screen.getByRole('link', { name: 'Kullanıcılar' })).toHaveAttribute('aria-current', 'page');
  });

  it('renders the rows with labels, status and UTC times; marks the own row', async () => {
    const api = withUsers([
      adminUser({ full_name: null, role: 'rescuer', is_active: false }),
      adminUser({ id: ADMIN_ID, email: 'admin@example.com', full_name: 'Yönetici Kişi', role: 'administrator' }),
    ]);
    renderAdmin('/admin/users', { api });
    const table = await screen.findByRole('table', { name: 'Kullanıcı listesi' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[0]).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Ad Soyad',
      'E-posta',
      'Rol',
      'Durum',
      'Oluşturulma (UTC)',
      'İşlem',
    ]);
    expect(within(rows[1]).getAllByRole('cell').map((td) => td.textContent)).toEqual([
      '—',
      'ayse@example.com',
      'Kurtarıcı',
      'Devre dışı',
      '2026-11-20 08:30:00 UTC',
      'Cihazlar ve hesap',
    ]);
    expect(within(rows[2]).getAllByRole('cell')[0]).toHaveTextContent('Yönetici Kişi (siz)');
    expect(within(rows[2]).getByText('Etkin')).toHaveClass('status-ok');
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href', `/admin/users/${adminUser().id}`);
  });

  it('shows loading, then the empty state', async () => {
    renderAdmin('/admin/users');
    expect(screen.getByRole('status')).toHaveTextContent('Yükleniyor…');
    expect(await screen.findByText('Henüz kullanıcı yok.')).toBeInTheDocument();
  });

  it('shows a network error with retry; SIGNED_OUT shows nothing', async () => {
    const api = makeAdminApi();
    api.listUsers.mockResolvedValueOnce({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    const { user } = renderAdmin('/admin/users', { api });
    expect(await screen.findByRole('alert')).toHaveTextContent('Sunucuya ulaşılamadı');
    await user.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    expect(await screen.findByText('Henüz kullanıcı yok.')).toBeInTheDocument();
    expect(api.listUsers).toHaveBeenCalledTimes(2);
  });

  it('renders no alert after a forced sign-out', async () => {
    const api = makeAdminApi();
    api.listUsers.mockResolvedValue({ ok: false, error: { kind: 'SIGNED_OUT', reason: 'ACCOUNT_DISABLED' } });
    renderAdmin('/admin/users', { api });
    await waitFor(() => expect(screen.queryByText('Yükleniyor…')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('pages with 25 rows and limit 26', async () => {
    const api = withUsers(manyUsers(30));
    const { user } = renderAdmin('/admin/users', { api });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(26); // header + 25
    expect(screen.getByRole('button', { name: 'Önceki' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Sonraki' }));
    expect(currentLocation(screen)).toBe('/admin/users?page=2');
    await waitFor(() => expect(api.listUsers).toHaveBeenLastCalledWith({ limit: 26, offset: 25 }));
    expect(await screen.findByText('Sayfa 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sonraki' })).toBeDisabled();
  });

  it('canonicalises an invalid ?page', async () => {
    const { api } = renderAdmin('/admin/users?page=abc');
    await waitFor(() => expect(currentLocation(screen)).toBe('/admin/users'));
    expect(api.listUsers).toHaveBeenCalledWith({ limit: 26, offset: 0 });
  });

  it('shows an empty later page with the pager', async () => {
    renderAdmin('/admin/users?page=3');
    expect(await screen.findByText('Bu sayfada kayıt yok.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Önceki' })).toBeEnabled();
  });
});

describe('CreateUserDialog', () => {
  async function openDialog(api = makeAdminApi()) {
    const rendered = renderAdmin('/admin/users', { api });
    await screen.findByText('Henüz kullanıcı yok.');
    await rendered.user.click(screen.getByRole('button', { name: 'Yeni kullanıcı' }));
    return { ...rendered, dialog: screen.getByRole('dialog', { name: 'Yeni kullanıcı oluştur' }) };
  }

  async function fill(user: Awaited<ReturnType<typeof openDialog>>['user'], password = 'GüçlüŞifre123') {
    await user.type(screen.getByLabelText('Ad Soyad'), '  Mehmet Kaya ');
    await user.type(screen.getByLabelText('E-posta'), ' mehmet@example.com ');
    await user.type(screen.getByLabelText('Geçici şifre'), password);
    await user.selectOptions(screen.getByLabelText('Rol'), 'coordinator');
  }

  it('offers only rescuer and coordinator (no administrator)', async () => {
    const { dialog } = await openDialog();
    const options = within(within(dialog).getByLabelText('Rol')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Rol seçin', 'Kurtarıcı', 'Koordinatör']);
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'rescuer', 'coordinator']);
    expect(within(dialog).queryByRole('option', { name: 'Yönetici' })).not.toBeInTheDocument();
    expect(dialog.querySelector('option[value="administrator"]')).toBeNull();
    expect(within(dialog).getByText('Yönetici hesabı bu panelden oluşturulamaz.')).toBeInTheDocument();
  });

  it('validates an empty form without calling the API and focuses the first field', async () => {
    const { user, api } = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Oluştur' }));
    expect(screen.getByText('Ad soyad girin (en fazla 100 karakter).')).toBeInTheDocument();
    expect(screen.getByText('Geçerli bir e-posta adresi girin.')).toBeInTheDocument();
    expect(screen.getByText('Şifre 10 ile 72 karakter arasında olmalı.')).toBeInTheDocument();
    expect(screen.getByText('Bir rol seçin.')).toBeInTheDocument();
    expect(screen.getByLabelText('Ad Soyad')).toHaveFocus();
    expect(screen.getByLabelText('Ad Soyad')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Ad Soyad')).toHaveAccessibleDescription('Ad soyad girin (en fazla 100 karakter).');
    expect(api.createUser).not.toHaveBeenCalled();
  });

  it('rejects a 9-character password', async () => {
    const { user, api } = await openDialog();
    await fill(user, '123456789');
    await user.click(screen.getByRole('button', { name: 'Oluştur' }));
    expect(screen.getByText('Şifre 10 ile 72 karakter arasında olmalı.')).toBeInTheDocument();
    expect(screen.getByLabelText('Geçici şifre')).toHaveFocus();
    expect(api.createUser).not.toHaveBeenCalled();
  });

  it('creates the account, closes, shows a notice and reloads page 1', async () => {
    const { user, api } = await openDialog();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Oluştur' }));
    expect(api.createUser).toHaveBeenCalledWith({
      email: 'mehmet@example.com',
      password: 'GüçlüŞifre123',
      full_name: 'Mehmet Kaya',
      role: 'coordinator',
    });
    expect(await screen.findByText('Hesap oluşturuldu: mehmet@example.com')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(api.listUsers).toHaveBeenCalledTimes(2));
    expect(api.listUsers).toHaveBeenLastCalledWith({ limit: 26, offset: 0 });
  });

  it('shows a duplicate e-mail on the field and stays open', async () => {
    const api = makeAdminApi();
    api.createUser.mockResolvedValue({ ok: false, error: { kind: 'HTTP_ERROR', status: 409, errorCode: 'CONFLICT' } });
    const { user } = await openDialog(api);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Oluştur' }));
    expect(await screen.findByText('Bu e-posta adresiyle kayıtlı bir hesap zaten var.')).toBeInTheDocument();
    expect(screen.getByLabelText('E-posta')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('explains a 500 as possible password rules', async () => {
    const api = makeAdminApi();
    api.createUser.mockResolvedValue({ ok: false, error: { kind: 'SERVER_ERROR', status: 500 } });
    const { user } = await openDialog(api);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Oluştur' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      'Şifre güvenlik kurallarını karşılamıyor olabilir',
    );
  });

  it('closes on Escape and on Vazgeç without a call', async () => {
    const { user, api } = await openDialog();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yeni kullanıcı' }));
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.createUser).not.toHaveBeenCalled();
  });
});
