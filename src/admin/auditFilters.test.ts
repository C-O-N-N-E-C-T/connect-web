import { describe, expect, it } from 'vitest';
import {
  draftFromFilters,
  EMPTY_DRAFT,
  INVALID_DATE_MESSAGE,
  INVALID_UUID_MESSAGE,
  RANGE_MESSAGE,
  readAuditSearch,
  validateDraft,
  writeAuditSearch,
} from './auditFilters';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

// OSP-72: audit filters live in the URL; invalid params are dropped.
describe('readAuditSearch', () => {
  it('reads valid filters and the page', () => {
    const params = new URLSearchParams({
      action_type: 'LOGIN',
      actor_user_id: A,
      target_record_id: B,
      from: '2026-11-26T10:00:00.000Z',
      to: '2026-11-26T11:00:59.999Z',
      page: '2',
    });
    const result = readAuditSearch(params);
    expect(result.filters).toEqual({
      action_type: 'LOGIN',
      actor_user_id: A,
      target_record_id: B,
      from: '2026-11-26T10:00:00.000Z',
      to: '2026-11-26T11:00:59.999Z',
    });
    expect(result.page).toBe(2);
    expect(result.changed).toBe(false);
  });

  it('drops invalid params and reports the change', () => {
    const params = new URLSearchParams({
      action_type: 'BAD',
      actor_user_id: 'not-a-uuid',
      target_record_id: A,
      from: '2026-11-26T10:00:00+03:00',
      to: 'yesterday',
      page: 'abc',
      extra: '1',
    });
    const result = readAuditSearch(params);
    expect(result.filters).toEqual({ target_record_id: A });
    expect(result.page).toBe(1);
    expect(result.changed).toBe(true);
    expect(result.canonical.toString()).toBe(`target_record_id=${A}`);
  });

  it('keeps a microsecond end time as is (canonical form is a fixed point)', () => {
    const params = new URLSearchParams({ to: '2026-11-26T10:30:59.999999Z' });
    const first = readAuditSearch(params);
    expect(first.filters).toEqual({ to: '2026-11-26T10:30:59.999999Z' });
    expect(first.changed).toBe(false);
    expect(readAuditSearch(first.canonical).changed).toBe(false);
  });

  it('drops impossible calendar dates', () => {
    for (const bad of ['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z']) {
      const result = readAuditSearch(new URLSearchParams({ from: bad }));
      expect(result.filters).toEqual({});
      expect(result.changed).toBe(true);
    }
  });

  it('drops `to` when it is before `from`', () => {
    const result = readAuditSearch(
      new URLSearchParams({ from: '2026-11-26T10:00:00.000Z', to: '2026-11-26T09:00:00.000Z' }),
    );
    expect(result.filters).toEqual({ from: '2026-11-26T10:00:00.000Z' });
    expect(result.changed).toBe(true);
  });

  it('round-trips with writeAuditSearch', () => {
    const filters = { action_type: 'VICTIM_VIEW' as const, actor_user_id: A, to: '2026-11-26T10:30:59.999Z' };
    const written = writeAuditSearch(filters, 3);
    expect(written.toString()).toBe(`action_type=VICTIM_VIEW&actor_user_id=${A}&to=2026-11-26T10%3A30%3A59.999Z&page=3`);
    const read = readAuditSearch(written);
    expect(read.filters).toEqual(filters);
    expect(read.page).toBe(3);
    expect(read.changed).toBe(false);
    expect(writeAuditSearch({}, 1).toString()).toBe('');
  });
});

describe('validateDraft', () => {
  it('accepts an empty draft', () => {
    expect(validateDraft(EMPTY_DRAFT)).toEqual({ ok: true, filters: {} });
  });

  it('reports a bad UUID and a bad date', () => {
    const result = validateDraft({ ...EMPTY_DRAFT, actor_user_id: 'x', target_record_id: 'y', from: '2026-02-30T10:00' });
    expect(result).toEqual({
      ok: false,
      errors: { actor_user_id: INVALID_UUID_MESSAGE, target_record_id: INVALID_UUID_MESSAGE, from: INVALID_DATE_MESSAGE },
    });
  });

  it('reports an end before the start on `to`', () => {
    const result = validateDraft({ ...EMPTY_DRAFT, from: '2026-11-26T10:30', to: '2026-11-26T10:29' });
    expect(result).toEqual({ ok: false, errors: { to: RANGE_MESSAGE } });
  });

  it('makes the end inclusive to the end of the minute', () => {
    const result = validateDraft({ ...EMPTY_DRAFT, from: '2026-11-26T10:30', to: '2026-11-26T10:30', actor_user_id: ` ${A} ` });
    expect(result).toEqual({
      ok: true,
      filters: { actor_user_id: A, from: '2026-11-26T10:30:00.000Z', to: '2026-11-26T10:30:59.999999Z' },
    });
  });

  it('draftFromFilters shows the filters in the form', () => {
    expect(
      draftFromFilters({ action_type: 'LOGIN', from: '2026-11-26T10:30:00.000Z', to: '2026-11-26T10:45:59.999Z' }),
    ).toEqual({ ...EMPTY_DRAFT, action_type: 'LOGIN', from: '2026-11-26T10:30', to: '2026-11-26T10:45' });
  });
});
