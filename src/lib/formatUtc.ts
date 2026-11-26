/**
 * OSP-72: UTC timestamp helpers for the administrator screens. Every admin timestamp is shown in
 * UTC (never the browser's zone) so that values match the backend and the audit log exactly.
 */

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** `YYYY-MM-DD HH:mm:ss UTC`; null/undefined -> "—"; an unparseable value is returned verbatim. */
export function formatUtc(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
  );
}

const INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Converts a `<input type="datetime-local">` value, read as UTC, to an ISO string ending in `Z`.
 * `start` -> the first instant of that minute, `end` -> its last MICROsecond (inclusive filter end:
 * Postgres timestamptz stores microseconds, so `:59.999Z` would miss e.g. `:59.9995`).
 * Returns null for an invalid value or a date that does not exist (e.g. 2026-02-30).
 */
export function utcInputToIso(value: string, edge: 'start' | 'end'): string | null {
  const match = INPUT_PATTERN.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const ms = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(ms);
  if (
    Number.isNaN(ms) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  ) {
    return null;
  }
  const base = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
  return edge === 'start' ? `${base}:00.000Z` : `${base}:59.999999Z`;
}

/** ISO timestamp -> `YYYY-MM-DDTHH:mm` in UTC (for a datetime-local input), or '' if invalid. */
export function isoToUtcInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}
