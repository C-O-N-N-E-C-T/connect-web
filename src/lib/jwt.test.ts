import { describe, expect, it } from 'vitest';
import { decodeJwtClaims, readUserRole } from './jwt';

function b64urlUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeToken(payload: object): string {
  return `${b64urlUtf8('{"alg":"HS256"}')}.${b64urlUtf8(JSON.stringify(payload))}.sig`;
}

describe('decodeJwtClaims', () => {
  it('reads claims from the payload', () => {
    const token = makeToken({ sub: 'u1', user_role: 'coordinator' });
    expect(decodeJwtClaims(token).user_role).toBe('coordinator');
  });

  it('handles non-ASCII characters in claims', () => {
    const token = makeToken({ full_name: 'Cansu Gün' });
    expect(decodeJwtClaims(token).full_name).toBe('Cansu Gün');
  });

  it('rejects malformed tokens', () => {
    expect(() => decodeJwtClaims('not-a-jwt')).toThrow('Invalid JWT format');
  });
});

describe('readUserRole', () => {
  it('returns the role claim', () => {
    expect(readUserRole(makeToken({ user_role: 'administrator' }))).toBe('administrator');
  });

  it('returns undefined for malformed tokens instead of throwing', () => {
    expect(readUserRole('garbage')).toBeUndefined();
    expect(readUserRole('a.b.c')).toBeUndefined();
  });
});
