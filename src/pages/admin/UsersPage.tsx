/** OSP-72: user list (GET /admin/users) with paging and the create-user dialog. */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { useAdminApi } from '../../admin/AdminApiContext';
import { adminErrorMessage } from '../../admin/adminErrors';
import { roleLabel } from '../../admin/labels';
import { pageRequest, readPage, splitPage } from '../../admin/pagination';
import { AccountStatus } from '../../admin/StatusPill';
import { Pagination } from '../../components/Pagination';
import { formatUtc } from '../../lib/formatUtc';
import type { AdminUser, CreateUserResponse } from '../../services/adminApi';
import { CreateUserDialog } from './CreateUserDialog';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string | null }
  | { status: 'ready'; rows: AdminUser[]; hasNext: boolean };

export function UsersPage() {
  const api = useAdminApi();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { page, canonical } = readPage(searchParams);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!canonical) setSearchParams(page > 1 ? { page: String(page) } : {}, { replace: true });
  }, [canonical, page, setSearchParams]);

  useEffect(() => {
    const current = ++seq.current;
    setLoad({ status: 'loading' });
    void api.listUsers(pageRequest(page)).then((result) => {
      if (current !== seq.current) return; // a newer request owns the screen
      if (result.ok) setLoad({ status: 'ready', ...splitPage(result.data.users) });
      else setLoad({ status: 'error', message: adminErrorMessage(result.error, 'load') });
    });
  }, [api, page, reloadKey]);

  function goTo(next: number) {
    setNotice(null);
    setSearchParams(next > 1 ? { page: String(next) } : {});
  }

  function handleCreated(user: CreateUserResponse['user']) {
    setCreating(false);
    setNotice(`Hesap oluşturuldu: ${user.email}`);
    // The new account is the newest, so it is on page 1.
    if (page === 1) setReloadKey((key) => key + 1);
    else setSearchParams({});
  }

  return (
    <>
      <div className="admin-toolbar">
        <h2>Kullanıcılar</h2>
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setCreating(true);
          }}
        >
          Yeni kullanıcı
        </button>
      </div>
      {notice && (
        <p role="status" className="banner-success">
          {notice}
        </p>
      )}
      {load.status === 'loading' && <p role="status">Yükleniyor…</p>}
      {load.status === 'error' && load.message !== null && (
        <>
          <div role="alert" className="banner-error">
            {load.message}
          </div>
          <p>
            <button type="button" className="button-secondary" onClick={() => setReloadKey((key) => key + 1)}>
              Tekrar dene
            </button>
          </p>
        </>
      )}
      {load.status === 'ready' && (
        <>
          {load.rows.length === 0 ? (
            <p>{page === 1 ? 'Henüz kullanıcı yok.' : 'Bu sayfada kayıt yok.'}</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Kullanıcı listesi</caption>
                <thead>
                  <tr>
                    <th scope="col">Ad Soyad</th>
                    <th scope="col">E-posta</th>
                    <th scope="col">Rol</th>
                    <th scope="col">Durum</th>
                    <th scope="col">Oluşturulma (UTC)</th>
                    <th scope="col">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {load.rows.map((user) => (
                    <tr key={user.id}>
                      <td>
                        {user.full_name ?? '—'}
                        {user.id === currentUserId ? ' (siz)' : ''}
                      </td>
                      <td>{user.email ?? '—'}</td>
                      <td>{roleLabel(user.role)}</td>
                      <td>
                        <AccountStatus active={user.is_active} />
                      </td>
                      <td>
                        <time dateTime={user.created_at}>{formatUtc(user.created_at)}</time>
                      </td>
                      <td>
                        <Link
                          to={`/admin/users/${encodeURIComponent(user.id)}`}
                          state={{ user, fromSearch: location.search }}
                        >
                          Cihazlar ve hesap
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(page > 1 || load.hasNext) && <Pagination page={page} hasNext={load.hasNext} onChange={goTo} />}
        </>
      )}
      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={handleCreated} />}
    </>
  );
}
