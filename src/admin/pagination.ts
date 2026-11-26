/**
 * OSP-72: offset paging without a total count. The backend returns no total, so one extra row is
 * requested (limit = PAGE_SIZE + 1); its presence means there is a next page.
 */
import type { PageRequest } from '../services/adminApi';

export const PAGE_SIZE = 25;
/** Backend offset limit is 100000: (4001 - 1) * 25 = 100000. */
export const MAX_PAGE = 4001;

/** 1-based page from `?page=`. `canonical` is false when the param must be rewritten. */
export function readPage(params: URLSearchParams): { page: number; canonical: boolean } {
  const values = params.getAll('page');
  if (values.length === 0) return { page: 1, canonical: true };
  const raw = values[0];
  if (values.length > 1 || !/^\d+$/.test(raw)) return { page: 1, canonical: false };
  const page = Number(raw);
  if (page < 1 || page > MAX_PAGE) return { page: 1, canonical: false };
  // Page 1 is written without the param; a leading zero is rewritten too.
  return { page, canonical: page !== 1 && String(page) === raw };
}

export function pageRequest(page: number): PageRequest {
  return { limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE };
}

export function splitPage<T>(rows: readonly T[]): { rows: T[]; hasNext: boolean } {
  return { rows: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE };
}
