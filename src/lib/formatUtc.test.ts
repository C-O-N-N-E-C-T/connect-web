import { describe, expect, it } from 'vitest';
import { formatUtc, isoToUtcInput, utcInputToIso } from './formatUtc';

// OSP-72: admin timestamps are always shown in UTC.
describe('formatUtc', () => {
  it('formats an ISO timestamp in UTC', () => {
    expect(formatUtc('2026-11-26T09:05:03.123Z')).toBe('2026-11-26 09:05:03 UTC');
  });

  it('converts an offset timestamp to UTC', () => {
    expect(formatUtc('2026-11-26T12:05:03+03:00')).toBe('2026-11-26 09:05:03 UTC');
  });

  it('shows a dash for a missing value', () => {
    expect(formatUtc(null)).toBe('—');
    expect(formatUtc(undefined)).toBe('—');
  });

  it('returns an unparseable value verbatim', () => {
    expect(formatUtc('garbage')).toBe('garbage');
  });
});

describe('utcInputToIso', () => {
  it('maps the start of a minute', () => {
    expect(utcInputToIso('2026-11-26T10:30', 'start')).toBe('2026-11-26T10:30:00.000Z');
  });

  it('maps the end of a minute (inclusive)', () => {
    expect(utcInputToIso('2026-11-26T10:30', 'end')).toBe('2026-11-26T10:30:59.999999Z');
  });

  it('accepts seconds from the input', () => {
    expect(utcInputToIso('2026-11-26T10:30:15', 'start')).toBe('2026-11-26T10:30:00.000Z');
  });

  it.each(['2026-02-30T10:00', '2026-11-26', 'abc', '', '2026-11-26T25:00'])('rejects %s', (value) => {
    expect(utcInputToIso(value, 'start')).toBeNull();
  });
});

describe('isoToUtcInput', () => {
  it('round-trips with utcInputToIso', () => {
    const iso = utcInputToIso('2026-01-02T03:04', 'start');
    expect(iso).not.toBeNull();
    expect(isoToUtcInput(iso)).toBe('2026-01-02T03:04');
  });

  it('returns an empty string for an invalid value', () => {
    expect(isoToUtcInput('nope')).toBe('');
    expect(isoToUtcInput(null)).toBe('');
  });
});
