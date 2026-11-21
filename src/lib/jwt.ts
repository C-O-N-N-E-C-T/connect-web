/**
 * Decodes the payload of a JWT WITHOUT verifying the signature.
 * Used only to read the `user_role` claim for UI routing. Authorization is
 * always enforced by the backend (signature is verified there).
 */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const json = decodeURIComponent(
    atob(padded)
      .split('')
      .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join(''),
  );
  return JSON.parse(json) as Record<string, unknown>;
}

/** Reads `user_role` from a token. Malformed tokens yield `undefined` instead of throwing. */
export function readUserRole(token: string): unknown {
  try {
    return decodeJwtClaims(token).user_role;
  } catch {
    return undefined;
  }
}
