/**
 * Client for POST /api/v1/auth/session (OSP-60).
 *
 * OSP-60 is not implemented yet. In `mock` mode (VITE_AUTH_SESSION_MODE=mock)
 * this module returns success without a network call. Switch to `real` once
 * the backend endpoint is ready. The response contract is assumed from the
 * OSP-60 description and must be confirmed with the backend owner.
 */

export interface RegisterSessionInput {
  deviceId: string;
  deviceName: string;
}

export type SessionErrorCode =
  | 'ACCOUNT_DISABLED'
  | 'DEVICE_REVOKED'
  | 'RATE_LIMITED'
  | 'SESSION_NOT_BOUND'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export type RegisterSessionResult = { ok: true } | { ok: false; code: SessionErrorCode };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'ACCOUNT_DISABLED',
  'DEVICE_REVOKED',
  'RATE_LIMITED',
  'SESSION_NOT_BOUND',
]);

export async function registerBrowserSession(
  input: RegisterSessionInput,
  accessToken: string,
  options: { mode?: string; apiBaseUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<RegisterSessionResult> {
  const mode = options.mode ?? import.meta.env.VITE_AUTH_SESSION_MODE;
  if (mode === 'mock') {
    return { ok: true };
  }

  const baseUrl = options.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ device_id: input.deviceId, device_name: input.deviceName }),
    });
  } catch {
    return { ok: false, code: 'NETWORK_ERROR' };
  }

  if (response.ok) {
    return { ok: true };
  }

  let code: string | undefined;
  try {
    const body = (await response.json()) as { error_code?: string };
    code = body.error_code;
  } catch {
    code = undefined;
  }

  if (response.status === 429) return { ok: false, code: 'RATE_LIMITED' };
  if (code && KNOWN_CODES.has(code)) return { ok: false, code: code as SessionErrorCode };
  return { ok: false, code: 'UNKNOWN' };
}
