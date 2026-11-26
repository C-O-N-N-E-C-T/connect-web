import { describe, expect, it } from 'vitest';
import { pageRequest, readPage, splitPage } from './pagination';

// OSP-72: 25 rows per page, one extra row requested to detect a next page.
describe('readPage', () => {
  it.each(['0', '-1', 'abc', '1.5', '4002', '', '03'])('treats ?page=%s as not canonical', (raw) => {
    const result = readPage(new URLSearchParams({ page: raw }));
    expect(result.canonical).toBe(false);
    expect(result.page).toBe(raw === '03' ? 3 : 1);
  });

  it('accepts a valid page', () => {
    expect(readPage(new URLSearchParams({ page: '3' }))).toEqual({ page: 3, canonical: true });
    expect(readPage(new URLSearchParams({ page: '4001' }))).toEqual({ page: 4001, canonical: true });
  });

  it('defaults to page 1 and wants page=1 omitted', () => {
    expect(readPage(new URLSearchParams())).toEqual({ page: 1, canonical: true });
    expect(readPage(new URLSearchParams({ page: '1' }))).toEqual({ page: 1, canonical: false });
  });
});

describe('pageRequest / splitPage', () => {
  it('requests 26 rows at the page offset', () => {
    expect(pageRequest(1)).toEqual({ limit: 26, offset: 0 });
    expect(pageRequest(3)).toEqual({ limit: 26, offset: 50 });
  });

  it('splits off the extra row as hasNext', () => {
    const rows = Array.from({ length: 26 }, (_, i) => i);
    expect(splitPage(rows)).toEqual({ rows: rows.slice(0, 25), hasNext: true });
    expect(splitPage(rows.slice(0, 25))).toEqual({ rows: rows.slice(0, 25), hasNext: false });
  });
});
