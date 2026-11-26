/**
 * OSP-72: one user's devices and account actions (GET /admin/users/:id/devices, device revoke,
 * revoke-all, reactivate). "Yalnızca bu cihazı iptal et" and "Hesabı devre dışı bırak ve tüm
 * oturumları kapat" have clearly different confirmations; the global one also needs an
 * acknowledgement checkbox. An administrator cannot disable their own account.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { useAdminApi, useCurrentDeviceId } from '../../admin/AdminApiContext';
import { adminErrorMessage, SELF_REVOKE_MESSAGE } from '../../admin/adminErrors';
import { UUID_PATTERN } from '../../admin/auditFilters';
import { roleLabel } from '../../admin/labels';
import { AccountStatus } from '../../admin/StatusPill';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatUtc } from '../../lib/formatUtc';
import type { AdminApi, AdminDevice, AdminUser } from '../../services/adminApi';

/** The user list is scanned at most this many pages of 100 to find the summary (1000 users). */
const SCAN_PAGES = 10;
const SCAN_SIZE = 100;
const NOT_FOUND = 'Kullanıcı bulunamadı.';

type Summary = { status: 'loading' } | { status: 'error'; message: string | null } | { status: 'ready'; user: AdminUser };
type Devices =
  | { status: 'loading' }
  | { status: 'error'; message: string | null }
  | { status: 'ready'; devices: AdminDevice[] };
type DialogState = null | { kind: 'device'; device: AdminDevice } | { kind: 'revokeAll' } | { kind: 'reactivate' };

interface NavState {
  user?: AdminUser;
  fromSearch?: string;
}

function readNavState(state: unknown): NavState {
  if (typeof state !== 'object' || state === null) return {};
  const { user, fromSearch } = state as Record<string, unknown>;
  const result: NavState = {};
  if (typeof user === 'object' && user !== null && typeof (user as AdminUser).id === 'string') {
    result.user = user as AdminUser;
  }
  if (typeof fromSearch === 'string' && (fromSearch === '' || fromSearch.startsWith('?'))) {
    result.fromSearch = fromSearch;
  }
  return result;
}

async function findUser(api: AdminApi, userId: string): Promise<Summary> {
  for (let page = 0; page < SCAN_PAGES; page += 1) {
    const result = await api.listUsers({ limit: SCAN_SIZE, offset: page * SCAN_SIZE });
    if (!result.ok) return { status: 'error', message: adminErrorMessage(result.error, 'load') };
    const user = result.data.users.find((row) => row.id === userId);
    if (user) return { status: 'ready', user };
    if (result.data.users.length < SCAN_SIZE) break;
  }
  return { status: 'error', message: NOT_FOUND };
}

export function UserDevicesPage() {
  const { userId = '' } = useParams();
  const valid = UUID_PATTERN.test(userId);
  const location = useLocation();
  const [navState] = useState(() => readNavState(location.state));
  const backTo = `/admin/users${navState.fromSearch ?? ''}`;
  const backLink = <Link to={backTo}>← Kullanıcı listesi</Link>;

  if (!valid) {
    return (
      <>
        <p>{backLink}</p>
        <div role="alert" className="banner-error">
          Geçersiz kullanıcı kimliği.
        </div>
      </>
    );
  }
  return <UserDevices key={userId} userId={userId} stateUser={navState.user} backLink={backLink} />;
}

function UserDevices({
  userId,
  stateUser,
  backLink,
}: {
  userId: string;
  stateUser: AdminUser | undefined;
  backLink: ReactNode;
}) {
  const api = useAdminApi();
  const { session } = useAuth();
  const isSelf = session?.user?.id === userId;
  const currentDeviceId = useCurrentDeviceId();
  /** OSP-72 QA: the device the administrator is using right now (own account only). */
  const isCurrentDevice = (device: AdminDevice) =>
    isSelf && currentDeviceId !== null && device.device_id === currentDeviceId;
  // OSP-72 QA: where focus goes after a successful action (the opener is replaced or removed).
  const devicesHeadingRef = useRef<HTMLHeadingElement>(null);
  const accountHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterCloseRef = useRef<HTMLElement | null>(null);
  const returnFocus = () => focusAfterCloseRef.current;
  const [summary, setSummary] = useState<Summary>(() =>
    stateUser?.id === userId ? { status: 'ready', user: stateUser } : { status: 'loading' },
  );
  const [devices, setDevices] = useState<Devices>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const deviceSeq = useRef(0);

  useEffect(() => {
    if (summary.status === 'ready') return;
    let active = true;
    void findUser(api, userId).then((found) => {
      if (active) setSummary(found);
    });
    return () => {
      active = false;
    };
    // Only on mount: later account changes update the summary locally.
  }, [api, userId]);

  useEffect(() => {
    const current = ++deviceSeq.current;
    setDevices((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
    void api.listDevices(userId).then((result) => {
      if (current !== deviceSeq.current) return;
      if (result.ok) setDevices({ status: 'ready', devices: result.data.devices });
      else setDevices({ status: 'error', message: adminErrorMessage(result.error, 'loadDevices') });
    });
  }, [api, userId, reloadKey]);

  function open(next: DialogState) {
    focusAfterCloseRef.current = null;
    setNotice(null);
    setDialogError(null);
    setDialog(next);
  }

  function close() {
    if (pending) return;
    setDialog(null);
    setDialogError(null);
  }

  function setActive(isActive: boolean) {
    setSummary((current) =>
      current.status === 'ready' ? { status: 'ready', user: { ...current.user, is_active: isActive } } : current,
    );
  }

  async function confirm() {
    if (!dialog || pending) return;
    setPending(true);
    setDialogError(null);
    if (dialog.kind === 'device') {
      const result = await api.revokeDevice(userId, dialog.device.device_id);
      setPending(false);
      if (!result.ok) {
        setDialogError(adminErrorMessage(result.error, 'revokeDevice'));
        // OSP-72 QA: a 404 means the list is out of date (device gone): refresh it behind the dialog.
        if (result.error.status === 404) setReloadKey((key) => key + 1);
        return;
      }
      focusAfterCloseRef.current = devicesHeadingRef.current;
      setDialog(null);
      setNotice(result.data.status === 'ALREADY_REVOKED' ? 'Bu cihaz zaten iptal edilmişti.' : 'Cihaz iptal edildi.');
    } else if (dialog.kind === 'revokeAll') {
      const result = await api.revokeAll(userId);
      setPending(false);
      if (!result.ok) return setDialogError(adminErrorMessage(result.error, 'revokeAll'));
      focusAfterCloseRef.current = accountHeadingRef.current;
      setDialog(null);
      setActive(false);
      setNotice('Hesap devre dışı bırakıldı ve tüm oturumlar kapatıldı.');
    } else {
      const result = await api.reactivate(userId);
      setPending(false);
      if (!result.ok) return setDialogError(adminErrorMessage(result.error, 'reactivate'));
      focusAfterCloseRef.current = accountHeadingRef.current;
      setDialog(null);
      setActive(true);
      setNotice('Hesap yeniden etkinleştirildi.');
    }
    setReloadKey((key) => key + 1);
  }

  const user = summary.status === 'ready' ? summary.user : null;

  return (
    <>
      <p>{backLink}</p>
      {summary.status === 'loading' && <p role="status">Yükleniyor…</p>}
      {summary.status === 'error' && summary.message !== null && (
        <div role="alert" className="banner-error">
          {summary.message}
        </div>
      )}
      {user && (
        <div className="user-summary">
          <h2>{user.full_name ?? user.email ?? user.id}</h2>
          <p>{user.email ?? '—'}</p>
          <p>
            {roleLabel(user.role)} · <AccountStatus active={user.is_active} />
          </p>
        </div>
      )}
      <p>
        <Link to={`/admin/audit-logs?target_record_id=${userId}`}>Bu kullanıcıyla ilgili denetim kayıtları</Link>
      </p>
      {notice && (
        <p role="status" className="banner-success">
          {notice}
        </p>
      )}

      <section aria-labelledby="devices-heading">
        <h3 id="devices-heading" ref={devicesHeadingRef} tabIndex={-1}>
          Kayıtlı cihazlar
        </h3>
        {devices.status === 'loading' && <p role="status">Yükleniyor…</p>}
        {devices.status === 'error' && devices.message !== null && (
          <>
            <div role="alert" className="banner-error">
              {devices.message}
            </div>
            <p>
              <button type="button" className="button-secondary" onClick={() => setReloadKey((key) => key + 1)}>
                Tekrar dene
              </button>
            </p>
          </>
        )}
        {devices.status === 'ready' &&
          (devices.devices.length === 0 ? (
            <p>Bu kullanıcının kayıtlı cihazı yok.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Kayıtlı cihazlar</caption>
                <thead>
                  <tr>
                    <th scope="col">Cihaz adı</th>
                    <th scope="col">Cihaz kimliği</th>
                    <th scope="col">Son giriş (UTC)</th>
                    <th scope="col">Durum</th>
                    <th scope="col">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.devices.map((device) => (
                    <tr key={device.device_id}>
                      <td>
                        {device.device_name ?? '—'}
                        {isCurrentDevice(device) ? ' (bu cihaz)' : ''}
                      </td>
                      <td>
                        <code>{device.device_id}</code>
                      </td>
                      <td>
                        {device.last_login_at ? (
                          <time dateTime={device.last_login_at}>{formatUtc(device.last_login_at)}</time>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {device.is_device_revoked ? (
                          <span className="status-pill status-off">
                            İptal edildi {device.device_revoked_at ? formatUtc(device.device_revoked_at) : ''}
                          </span>
                        ) : device.has_session ? (
                          <span className="status-pill status-ok">Etkin oturum</span>
                        ) : (
                          <span className="status-pill status-neutral">Oturum yok</span>
                        )}
                      </td>
                      <td>
                        {!device.is_device_revoked && (
                          <button
                            type="button"
                            className="button-danger-outline"
                            aria-label={`Yalnızca bu cihazı iptal et: ${device.device_name ?? device.device_id}`}
                            onClick={() => open({ kind: 'device', device })}
                          >
                            Yalnızca bu cihazı iptal et
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </section>

      <section className="danger-zone" aria-labelledby="account-heading">
        <h3 id="account-heading" ref={accountHeadingRef} tabIndex={-1}>
          Hesap işlemleri
        </h3>
        {summary.status === 'loading' && <p role="status">Yükleniyor…</p>}
        {user &&
          (user.is_active ? (
            <>
              <p>
                Hesap devre dışı kalır, kullanıcının tüm cihazlarındaki oturumlar kapatılır ve yeni girişler
                engellenir.
              </p>
              <button
                type="button"
                className="button-danger"
                disabled={isSelf}
                aria-describedby={isSelf ? 'self-hint' : undefined}
                onClick={() => open({ kind: 'revokeAll' })}
              >
                Hesabı devre dışı bırak ve tüm oturumları kapat
              </button>
              {isSelf && <p id="self-hint">{SELF_REVOKE_MESSAGE}</p>}
            </>
          ) : (
            <button type="button" onClick={() => open({ kind: 'reactivate' })}>
              Hesabı yeniden etkinleştir
            </button>
          ))}
      </section>

      {dialog?.kind === 'device' && (
        <ConfirmDialog
          title="Yalnızca bu cihazı iptal et"
          confirmLabel="Cihazı iptal et"
          tone="danger"
          pending={pending}
          error={dialogError}
          onConfirm={confirm}
          onCancel={close}
          returnFocus={returnFocus}
        >
          <p>
            <strong>{dialog.device.device_name ?? 'Adsız cihaz'}</strong> ({dialog.device.device_id}) cihazındaki
            oturum kapatılacak ve bu cihaz bir daha giriş yapamayacak. Kullanıcının hesabı ve diğer cihazları
            etkilenmez.
          </p>
          {isCurrentDevice(dialog.device) && (
            <p>
              <strong>Bu, şu an kullandığınız cihaz. İptal ederseniz oturumunuz hemen kapanır.</strong>
            </p>
          )}
        </ConfirmDialog>
      )}
      {dialog?.kind === 'revokeAll' && (
        <ConfirmDialog
          title="Hesabı devre dışı bırak ve tüm oturumları kapat"
          confirmLabel="Hesabı devre dışı bırak"
          tone="danger"
          acknowledgement="Bu işlemin kullanıcının tüm oturumlarını kapatacağını anlıyorum."
          pending={pending}
          error={dialogError}
          onConfirm={confirm}
          onCancel={close}
          returnFocus={returnFocus}
        >
          <p>
            <strong>{user?.email ?? user?.full_name ?? userId}</strong> hesabı devre dışı bırakılacak. Kullanıcının
            TÜM cihazlarındaki oturumlar hemen kapatılacak ve yeni girişler engellenecek. Hesap daha sonra yeniden
            etkinleştirilebilir, ancak kapatılan oturumlar geri gelmez; kullanıcı yeniden giriş yapmak zorunda kalır.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'reactivate' && (
        <ConfirmDialog
          title="Hesabı yeniden etkinleştir"
          confirmLabel="Yeniden etkinleştir"
          tone="default"
          pending={pending}
          error={dialogError}
          onConfirm={confirm}
          onCancel={close}
          returnFocus={returnFocus}
        >
          <p>
            <strong>{user?.email ?? user?.full_name ?? userId}</strong> hesabı yeniden etkinleştirilecek. Daha önce
            kapatılan oturumlar geçersiz kalır; kullanıcının yeniden giriş yapması gerekir. İptal edilmiş cihazlar
            iptal edilmiş olarak kalır.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
