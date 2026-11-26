/**
 * OSP-72 QA: contract and time-zone checks of the audit filters. Run with different TZ values
 * (e.g. `TZ=Pacific/Auckland npx vitest run`, `TZ=America/Los_Angeles ...`): every expectation is
 * in UTC and must not depend on the machine zone.
 */
import { describe, expect, it } from 'vitest';
import { readAuditSearch, validateDraft, writeAuditSearch, EMPTY_DRAFT } from './auditFilters';
import { readPage } from './pagination';
import { formatUtc, isoToUtcInput, utcInputToIso } from '../lib/formatUtc';

const draft = (from: string, to: string) => ({ ...EMPTY_DRAFT, from, to });

describe('UTC conversion is time-zone independent', () => {
  it.each([
    // US DST gap (02:30 local does not exist in Los Angeles on 2026-03-08)
    ['2026-03-08T02:30', '2026-03-08T02:30:00.000Z', '2026-03-08T02:30:59.999999Z'],
    // NZ DST overlap (02:30 local exists twice in Auckland on 2026-04-05)
    ['2026-04-05T02:30', '2026-04-05T02:30:00.000Z', '2026-04-05T02:30:59.999999Z'],
    // midnight / new year / leap day edges
    ['2026-12-31T23:59', '2026-12-31T23:59:00.000Z', '2026-12-31T23:59:59.999999Z'],
    ['2028-02-29T00:00', '2028-02-29T00:00:00.000Z', '2028-02-29T00:00:59.999999Z'],
  ])('%s -> start %s, end %s', (input, start, end) => {
    expect(utcInputToIso(input, 'start')).toBe(start);
    expect(utcInputToIso(input, 'end')).toBe(end);
    expect(isoToUtcInput(start)).toBe(input);
    expect(isoToUtcInput(end)).toBe(input);
  });

  it('formatUtc never rounds up to the next second / day', () => {
    expect(formatUtc('2026-12-31T23:59:59.999Z')).toBe('2026-12-31 23:59:59 UTC');
    expect(formatUtc('2026-11-26T00:00:00+03:00')).toBe('2026-11-25 21:00:00 UTC');
  });

  it('rejects dates that do not exist, in any zone', () => {
    expect(utcInputToIso('2026-02-29T00:00', 'start')).toBeNull();
    expect(utcInputToIso('2026-04-31T10:00', 'end')).toBeNull();
    expect(utcInputToIso('2026-01-01T24:00', 'end')).toBeNull();
  });

  it('from == to (same minute) is a valid one-minute window', () => {
    const result = validateDraft(draft('2026-11-26T10:00', '2026-11-26T10:00'));
    expect(result).toEqual({ ok: true, filters: { from: '2026-11-26T10:00:00.000Z', to: '2026-11-26T10:00:59.999999Z' } });
  });
});

describe('URL canonical form is a fixed point (no replace loops)', () => {
  it.each([
    '',
    'page=1',
    'page=0',
    'page=02',
    'page=4001',
    'page=4002',
    'page=2&page=3',
    'action_type=LOGIN&action_type=LOGOUT',
    'to=2026-11-01T00:00:00Z&from=2026-11-02T00:00:00Z',
    'from=2026-11-02T00:00:00Z&to=2026-11-02T00:00:00Z',
    'actor_user_id=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    'x=1&target_record_id=bad',
    'from=2026-11-02T00%3A00%3A00.000Z',
    'from=2026-11-02T00:00:00.000%2B03:00',
  ])('%s', (search) => {
    const first = readAuditSearch(new URLSearchParams(search));
    const second = readAuditSearch(first.canonical);
    expect(second.changed).toBe(false);
    expect(second.canonical.toString()).toBe(first.canonical.toString());
    expect(second.filters).toEqual(first.filters);
    expect(readPage(first.canonical).canonical).toBe(true);
    expect(writeAuditSearch(first.filters, first.page).toString()).toBe(first.canonical.toString());
  });
});

describe('contract with connect-backend zod 3.25 (z.string().datetime())', () => {
  // Fixed in OSP-72 (QA, was a bug): the web's ISO check only tests the shape and `new Date()`, which rolls over
  // impossible dates (Feb 30 -> Mar 2, 24:00 -> next day). zod rejects them, so a hand-edited or
  // old link answers 400 and the page shows "Gönderilen bilgiler geçersiz." with a retry that can
  // never succeed. Fix: in auditFilters.ts isIsoZ, also require the date to round-trip
  // (e.g. `new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)`).
  it('drops impossible calendar dates from the URL instead of sending them', () => {
    for (const bad of ['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-04-31T12:00:00.000Z']) {
      expect(readAuditSearch(new URLSearchParams({ from: bad })).filters.from).toBeUndefined();
    }
  });

  // Fixed in OSP-72 (QA, was a bug): `to` is inclusive (`created_at <= to`) and Postgres timestamptz has MICROsecond
  // precision, but the end of the minute is sent as `:59.999Z`. A row written at
  // 10:00:59.9995 is outside the chosen minute filter. zod accepts any fraction length, so the
  // fix is `${base}:59.999999Z` in formatUtc.ts utcInputToIso('end').
  it('end of minute covers the last microsecond (Postgres precision)', () => {
    const end = utcInputToIso('2026-11-26T10:00', 'end');
    expect(end).toBe('2026-11-26T10:00:59.999999Z');
  });

  it('accepts minute-only ISO (zod does) only by dropping it: web is stricter, never sends it', () => {
    expect(readAuditSearch(new URLSearchParams({ from: '2026-11-26T10:00Z' })).filters).toEqual({});
  });
});
