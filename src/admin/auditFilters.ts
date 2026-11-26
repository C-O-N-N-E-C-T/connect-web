/**
 * OSP-72: audit-log filters in the URL (`?action_type&actor_user_id&target_record_id&from&to&page`)
 * and the form draft. Times are UTC; `from` and `to` are inclusive (backend >= / <=).
 */
import { isAuditActionType, type AuditActionType, type AuditLogFilters } from '../services/adminApi';
import { isoToUtcInput, utcInputToIso } from '../lib/formatUtc';
import { readPage } from './pagination';

/** Same shape zod 3 `z.string().uuid()` accepts. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What zod 3 `z.string().datetime()` accepts: seconds required, optional fraction, `Z` only. */
const ISO_Z_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const INVALID_UUID_MESSAGE = 'Geçerli bir kimlik (UUID) girin.';
export const INVALID_DATE_MESSAGE = 'Geçerli bir tarih ve saat girin.';
export const RANGE_MESSAGE = 'Bitiş zamanı başlangıçtan önce olamaz.';

const KEYS = ['action_type', 'actor_user_id', 'target_record_id', 'from', 'to'] as const;

/**
 * The calendar date and time must exist: `new Date()` rolls `2026-02-30` or `T24:00` over to a
 * valid date, but the backend rejects them (400), so they must be dropped here (OSP-72 QA).
 * Only the part up to the seconds is compared; any fraction length is fine (microseconds).
 */
function isIsoZ(value: string): boolean {
  if (!ISO_Z_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

export function hasActiveFilters(filters: AuditLogFilters): boolean {
  return KEYS.some((key) => filters[key] !== undefined && filters[key] !== '');
}

/** Canonical query string: fixed key order, page omitted when 1. */
export function writeAuditSearch(filters: AuditLogFilters, page: number): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of KEYS) {
    const value = filters[key];
    if (value !== undefined && value !== '') params.set(key, value);
  }
  if (page > 1) params.set('page', String(page));
  return params;
}

/**
 * Reads the filters from the URL. Invalid values (unknown action type, non-UUID ids, times that
 * are not ISO with `Z`, an invalid page, `to` before `from`) and unknown params are dropped.
 * `changed` = the URL differs from its canonical form and should be replaced.
 */
export function readAuditSearch(params: URLSearchParams): {
  filters: AuditLogFilters;
  page: number;
  canonical: URLSearchParams;
  changed: boolean;
} {
  const filters: AuditLogFilters = {};
  const action = params.get('action_type');
  if (isAuditActionType(action)) filters.action_type = action;
  for (const key of ['actor_user_id', 'target_record_id'] as const) {
    const value = params.get(key);
    if (value !== null && UUID_PATTERN.test(value)) filters[key] = value;
  }
  for (const key of ['from', 'to'] as const) {
    const value = params.get(key);
    if (value !== null && isIsoZ(value)) filters[key] = value;
  }
  if (filters.from && filters.to && new Date(filters.to) < new Date(filters.from)) delete filters.to;
  const { page } = readPage(params);
  const canonical = writeAuditSearch(filters, page);
  return { filters, page, canonical, changed: canonical.toString() !== params.toString() };
}

/** Form state; `from` / `to` are datetime-local strings read as UTC. */
export interface AuditFilterDraft {
  action_type: '' | AuditActionType;
  actor_user_id: string;
  target_record_id: string;
  from: string;
  to: string;
}

export const EMPTY_DRAFT: AuditFilterDraft = {
  action_type: '',
  actor_user_id: '',
  target_record_id: '',
  from: '',
  to: '',
};

export function draftFromFilters(filters: AuditLogFilters): AuditFilterDraft {
  return {
    action_type: filters.action_type ?? '',
    actor_user_id: filters.actor_user_id ?? '',
    target_record_id: filters.target_record_id ?? '',
    from: isoToUtcInput(filters.from),
    to: isoToUtcInput(filters.to),
  };
}

export type DraftErrors = Partial<Record<keyof AuditFilterDraft, string>>;

export function validateDraft(
  draft: AuditFilterDraft,
): { ok: true; filters: AuditLogFilters } | { ok: false; errors: DraftErrors } {
  const filters: AuditLogFilters = {};
  const errors: DraftErrors = {};
  if (draft.action_type) filters.action_type = draft.action_type;
  for (const key of ['actor_user_id', 'target_record_id'] as const) {
    const value = draft[key].trim();
    if (value === '') continue;
    if (UUID_PATTERN.test(value)) filters[key] = value;
    else errors[key] = INVALID_UUID_MESSAGE;
  }
  for (const [key, edge] of [
    ['from', 'start'],
    ['to', 'end'],
  ] as const) {
    const value = draft[key].trim();
    if (value === '') continue;
    const iso = utcInputToIso(value, edge);
    if (iso) filters[key] = iso;
    else errors[key] = INVALID_DATE_MESSAGE;
  }
  if (filters.from && filters.to && new Date(filters.to) < new Date(filters.from)) {
    errors.to = RANGE_MESSAGE;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, filters };
}
