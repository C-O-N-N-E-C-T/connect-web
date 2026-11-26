/**
 * OSP-72: audit log (GET /admin/audit-logs) with filters and paging in the URL. All times are UTC;
 * `from` and `to` are inclusive, `to` up to the end of the chosen minute.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAdminApi } from '../../admin/AdminApiContext';
import { adminErrorMessage } from '../../admin/adminErrors';
import {
  draftFromFilters,
  EMPTY_DRAFT,
  hasActiveFilters,
  readAuditSearch,
  validateDraft,
  writeAuditSearch,
  type AuditFilterDraft,
  type DraftErrors,
} from '../../admin/auditFilters';
import { actionTypeLabel, ACTION_TYPE_LABELS, roleLabel } from '../../admin/labels';
import { pageRequest, splitPage } from '../../admin/pagination';
import { Pagination } from '../../components/Pagination';
import { formatUtc } from '../../lib/formatUtc';
import { AUDIT_ACTION_TYPES, type AuditLogEntry } from '../../services/adminApi';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string | null }
  | { status: 'ready'; rows: AuditLogEntry[]; hasNext: boolean };

type DraftField = keyof AuditFilterDraft;
const FIELD_ORDER: DraftField[] = ['action_type', 'actor_user_id', 'target_record_id', 'from', 'to'];
const FIELD_LABELS: Record<DraftField, string> = {
  action_type: 'İşlem türü',
  actor_user_id: 'Aktör kullanıcı kimliği',
  target_record_id: 'Hedef kayıt kimliği',
  from: 'Başlangıç (UTC)',
  to: 'Bitiş (UTC)',
};

export function AuditLogPage() {
  const api = useAdminApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSearch = searchParams.toString();
  const parsed = useMemo(() => readAuditSearch(new URLSearchParams(rawSearch)), [rawSearch]);
  const { filters, page, changed } = parsed;
  const canonicalKey = parsed.canonical.toString();
  const [draft, setDraft] = useState<AuditFilterDraft>(() => draftFromFilters(filters));
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);
  const refs = useRef<Partial<Record<DraftField, HTMLInputElement | HTMLSelectElement | null>>>({});

  useEffect(() => {
    if (changed) setSearchParams(parsed.canonical, { replace: true });
  }, [changed, parsed, setSearchParams]);

  // The form shows what the URL filters by (back / forward, links from the user page).
  useEffect(() => {
    setDraft(draftFromFilters(readAuditSearch(new URLSearchParams(canonicalKey)).filters));
    setDraftErrors({});
  }, [canonicalKey]);

  useEffect(() => {
    const current = ++seq.current;
    const { filters: active, page: activePage } = readAuditSearch(new URLSearchParams(canonicalKey));
    setLoad({ status: 'loading' });
    void api.listAuditLogs(active, pageRequest(activePage)).then((result) => {
      if (current !== seq.current) return;
      if (result.ok) setLoad({ status: 'ready', ...splitPage(result.data.logs) });
      else setLoad({ status: 'error', message: adminErrorMessage(result.error, 'load') });
    });
  }, [api, canonicalKey, reloadKey]);

  function navigate(next: URLSearchParams) {
    if (next.toString() === canonicalKey) setReloadKey((key) => key + 1);
    else setSearchParams(next);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validateDraft(draft);
    if (!result.ok) {
      setDraftErrors(result.errors);
      const first = FIELD_ORDER.find((field) => result.errors[field]);
      if (first) refs.current[first]?.focus();
      return;
    }
    setDraftErrors({});
    navigate(writeAuditSearch(result.filters, 1));
  }

  function handleClear() {
    setDraft(EMPTY_DRAFT);
    setDraftErrors({});
    navigate(new URLSearchParams());
  }

  function inputProps(name: DraftField) {
    const error = draftErrors[name];
    return {
      id: `audit-${name}`,
      name,
      value: draft[name],
      'aria-invalid': error ? true : undefined,
      'aria-describedby': error ? `audit-${name}-error` : undefined,
      onChange: (event: { target: { value: string } }) =>
        setDraft((current) => ({ ...current, [name]: event.target.value })),
    };
  }

  function fieldBlock(name: DraftField, control: ReactNode) {
    return (
      <div className="filter-field">
        <label htmlFor={`audit-${name}`}>{FIELD_LABELS[name]}</label>
        {control}
        {draftErrors[name] && (
          <p id={`audit-${name}-error`} className="field-error">
            {draftErrors[name]}
          </p>
        )}
      </div>
    );
  }

  const filtered = hasActiveFilters(filters);

  return (
    <>
      <h2>Denetim kayıtları</h2>
      <form aria-label="Denetim kaydı filtreleri" className="filter-form" noValidate onSubmit={handleSubmit}>
        {fieldBlock(
          'action_type',
          <select ref={(el) => void (refs.current.action_type = el)} {...inputProps('action_type')}>
            <option value="">Tümü</option>
            {AUDIT_ACTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {`${ACTION_TYPE_LABELS[type]} (${type})`}
              </option>
            ))}
          </select>,
        )}
        {fieldBlock(
          'actor_user_id',
          <input ref={(el) => void (refs.current.actor_user_id = el)} type="text" autoComplete="off" {...inputProps('actor_user_id')} />,
        )}
        {fieldBlock(
          'target_record_id',
          <input
            ref={(el) => void (refs.current.target_record_id = el)}
            type="text"
            autoComplete="off"
            {...inputProps('target_record_id')}
          />,
        )}
        {fieldBlock('from', <input ref={(el) => void (refs.current.from = el)} type="datetime-local" {...inputProps('from')} />)}
        {fieldBlock('to', <input ref={(el) => void (refs.current.to = el)} type="datetime-local" {...inputProps('to')} />)}
        <div className="filter-actions">
          <button type="submit">Filtrele</button>
          <button type="button" className="button-secondary" onClick={handleClear}>
            Temizle
          </button>
        </div>
      </form>

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
            <p>
              {page > 1 ? 'Bu sayfada kayıt yok.' : filtered ? 'Filtrelere uyan kayıt bulunamadı.' : 'Kayıt bulunamadı.'}
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Denetim kayıtları</caption>
                <thead>
                  <tr>
                    <th scope="col">Zaman (UTC)</th>
                    <th scope="col">Aktör</th>
                    <th scope="col">Rol</th>
                    <th scope="col">Cihaz (device_id)</th>
                    <th scope="col">İşlem</th>
                    <th scope="col">Hedef kayıt (target_record_id)</th>
                  </tr>
                </thead>
                <tbody>
                  {load.rows.map((log) => {
                    const label = actionTypeLabel(log.action_type);
                    return (
                      <tr key={log.id}>
                        <td>
                          <time dateTime={log.created_at}>{formatUtc(log.created_at)}</time>
                        </td>
                        <td>{log.actor_user_id ? <code>{log.actor_user_id}</code> : '—'}</td>
                        <td>{roleLabel(log.actor_role)}</td>
                        <td>{log.device_id ? <code>{log.device_id}</code> : '—'}</td>
                        <td>
                          <code>{log.action_type}</code>
                          {label ? ` ${label}` : ''}
                        </td>
                        <td>{log.target_record_id ? <code>{log.target_record_id}</code> : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {(page > 1 || load.hasNext) && (
            <Pagination page={page} hasNext={load.hasNext} onChange={(next) => setSearchParams(writeAuditSearch(filters, next))} />
          )}
        </>
      )}
    </>
  );
}
