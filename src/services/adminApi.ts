/**
 * OSP-72: typed client for the administrator API of OSP-66 (connect-backend src/routes/admin.ts,
 * docs/osp-66-admin-api.md). Every call goes through `apiClient.request`, which already handles
 * 401 refresh, SESSION_NOT_BOUND re-bind and the forced sign-out on DEVICE_REVOKED /
 * ACCOUNT_DISABLED (OSP-70). This module adds no error handling of its own beyond a shape check
 * of successful responses.
 */
import type { ApiClient, ApiResult } from './apiClient';
import type { AppRole } from '../lib/roles';

/** Roles an administrator may create from the web panel. `administrator` is never creatable. */
export type CreatableRole = 'rescuer' | 'coordinator';
export const CREATABLE_ROLES: readonly CreatableRole[] = ['rescuer', 'coordinator'];

export function isCreatableRole(value: unknown): value is CreatableRole {
  return value === 'rescuer' || value === 'coordinator';
}

/** Mirrors connect-backend src/types/database.ts AUDIT_ACTION_TYPES (keep in sync). */
export const AUDIT_ACTION_TYPES = [
  'LOGIN',
  'LOGOUT',
  'LOGIN_REJECTED',
  'USER_CREATED',
  'DEVICE_REVOKED',
  'ACCOUNT_DISABLED',
  'USER_REACTIVATED',
  'VICTIM_LIST_VIEW',
  'VICTIM_VIEW',
  'VICTIM_UPDATE',
  'RETENTION_PURGE',
  'OBSERVATION_SYNC',
] as const;
export type AuditActionType = (typeof AUDIT_ACTION_TYPES)[number];

export function isAuditActionType(value: unknown): value is AuditActionType {
  return typeof value === 'string' && (AUDIT_ACTION_TYPES as readonly string[]).includes(value);
}

export interface AdminUser {
  id: string;
  email: string | null;
  full_name: string | null;
  role: AppRole;
  is_active: boolean;
  created_at: string;
  all_sessions_revoked_at: string | null;
}

export interface AdminDevice {
  device_id: string;
  device_name: string | null;
  last_login_at: string | null;
  is_device_revoked: boolean;
  device_revoked_at: string | null;
  has_session: boolean;
}

export interface AuditLogEntry {
  id: string;
  actor_user_id: string | null;
  actor_role: string | null;
  device_id: string | null;
  action_type: string;
  target_record_id: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface ListUsersResponse {
  users: AdminUser[];
  limit: number;
  offset: number;
}

export interface CreateUserInput {
  email: string;
  password: string;
  full_name: string;
  role: CreatableRole;
}

export interface CreateUserResponse {
  user: { id: string; email: string; full_name: string; role: CreatableRole; is_active: true };
}

export interface ListDevicesResponse {
  devices: AdminDevice[];
}

export type RevokeDeviceStatus = 'REVOKED' | 'ALREADY_REVOKED';

export interface RevokeDeviceResponse {
  device_id: string;
  is_device_revoked: true;
  status: RevokeDeviceStatus;
}

export interface AccountStateResponse {
  user: { id: string; is_active: boolean };
}

export interface AuditLogFilters {
  action_type?: AuditActionType;
  actor_user_id?: string;
  target_record_id?: string;
  /** ISO datetime ending in `Z`, inclusive. */
  from?: string;
  /** ISO datetime ending in `Z`, inclusive. */
  to?: string;
}

export interface AuditLogsResponse {
  logs: AuditLogEntry[];
  limit: number;
  offset: number;
}

export interface AdminApi {
  listUsers(page: PageRequest): Promise<ApiResult<ListUsersResponse>>;
  createUser(input: CreateUserInput): Promise<ApiResult<CreateUserResponse>>;
  listDevices(userId: string): Promise<ApiResult<ListDevicesResponse>>;
  revokeDevice(userId: string, deviceId: string): Promise<ApiResult<RevokeDeviceResponse>>;
  revokeAll(userId: string): Promise<ApiResult<AccountStateResponse>>;
  reactivate(userId: string): Promise<ApiResult<AccountStateResponse>>;
  listAuditLogs(filters: AuditLogFilters, page: PageRequest): Promise<ApiResult<AuditLogsResponse>>;
}

const BASE = '/api/v1/admin';
const AUDIT_FILTER_KEYS = ['action_type', 'actor_user_id', 'target_record_id', 'from', 'to'] as const;

type Shape = { array: string } | { object: string } | { string: string };

/** A 2xx body without the expected field is INVALID_RESPONSE (never rendered as data). */
function checkShape<T>(result: ApiResult<T>, shape: Shape): ApiResult<T> {
  if (!result.ok) return result;
  const body = result.data as Record<string, unknown> | null | undefined;
  const isObject = typeof body === 'object' && body !== null;
  let valid: boolean;
  if ('array' in shape) valid = isObject && Array.isArray(body[shape.array]);
  else if ('object' in shape) {
    const field = isObject ? body[shape.object] : undefined;
    valid = typeof field === 'object' && field !== null && !Array.isArray(field);
  } else valid = isObject && typeof body[shape.string] === 'string';
  return valid ? result : { ok: false, error: { kind: 'INVALID_RESPONSE', status: result.status } };
}

function pageQuery(query: URLSearchParams, page: PageRequest): string {
  query.set('limit', String(page.limit));
  query.set('offset', String(page.offset));
  return query.toString();
}

export function createAdminApi(client: Pick<ApiClient, 'request'>): AdminApi {
  const userPath = (userId: string) => `${BASE}/users/${encodeURIComponent(userId)}`;

  return {
    async listUsers(page) {
      const query = pageQuery(new URLSearchParams(), page);
      return checkShape(await client.request<ListUsersResponse>(`${BASE}/users?${query}`), { array: 'users' });
    },

    async createUser(input) {
      // Defence in depth (OSP-72): the UI offers only creatable roles and the backend answers 403
      // for administrator, but an administrator account is never even requested from here.
      if (!isCreatableRole(input.role)) {
        throw new Error('adminApi: only rescuer or coordinator accounts can be created');
      }
      const body = {
        email: input.email.trim(),
        password: input.password,
        full_name: input.full_name.trim(),
        role: input.role,
      };
      return checkShape(
        await client.request<CreateUserResponse>(`${BASE}/users`, { method: 'POST', body }),
        { object: 'user' },
      );
    },

    async listDevices(userId) {
      return checkShape(await client.request<ListDevicesResponse>(`${userPath(userId)}/devices`), {
        array: 'devices',
      });
    },

    async revokeDevice(userId, deviceId) {
      const path = `${userPath(userId)}/devices/${encodeURIComponent(deviceId)}/revoke`;
      return checkShape(await client.request<RevokeDeviceResponse>(path, { method: 'POST' }), {
        string: 'status',
      });
    },

    async revokeAll(userId) {
      return checkShape(
        await client.request<AccountStateResponse>(`${userPath(userId)}/revoke-all`, { method: 'POST' }),
        { object: 'user' },
      );
    },

    async reactivate(userId) {
      return checkShape(
        await client.request<AccountStateResponse>(`${userPath(userId)}/reactivate`, { method: 'POST' }),
        { object: 'user' },
      );
    },

    async listAuditLogs(filters, page) {
      const query = new URLSearchParams();
      for (const key of AUDIT_FILTER_KEYS) {
        const value = filters[key];
        if (value !== undefined && value !== '') query.set(key, value);
      }
      const path = `${BASE}/audit-logs?${pageQuery(query, page)}`;
      return checkShape(await client.request<AuditLogsResponse>(path), { array: 'logs' });
    },
  };
}
