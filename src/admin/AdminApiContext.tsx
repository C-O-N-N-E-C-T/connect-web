/**
 * OSP-72: the AdminApi is injected through context so the admin pages never import authRuntime
 * (Supabase) and tests can provide fakes.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AdminApi } from '../services/adminApi';

interface AdminContextValue {
  api: AdminApi;
  /** This browser's device id (registered with POST /auth/session), or null if unknown. */
  currentDeviceId: () => string | null;
  /**
   * True in `VITE_AUTH_SESSION_MODE=mock`: the session is never bound to a device, so every
   * admin call would end in a forced SESSION_NOT_BOUND sign-out. The admin pages show a setup
   * hint instead of calling the API.
   */
  backendDisabled: boolean;
}

const AdminApiContext = createContext<AdminContextValue | null>(null);
const NO_DEVICE = () => null;

export function AdminApiProvider({
  api,
  currentDeviceId = NO_DEVICE,
  backendDisabled = false,
  children,
}: {
  api: AdminApi;
  currentDeviceId?: () => string | null;
  backendDisabled?: boolean;
  children?: ReactNode;
}) {
  const value = useMemo(
    () => ({ api, currentDeviceId, backendDisabled }),
    [api, currentDeviceId, backendDisabled],
  );
  return <AdminApiContext.Provider value={value}>{children}</AdminApiContext.Provider>;
}

function useAdminContext(): AdminContextValue {
  const value = useContext(AdminApiContext);
  if (!value) throw new Error('useAdminApi must be used inside <AdminApiProvider>');
  return value;
}

export function useAdminApi(): AdminApi {
  return useAdminContext().api;
}

/** OSP-72: true when the admin API cannot work (mock session mode). */
export function useAdminBackendDisabled(): boolean {
  return useAdminContext().backendDisabled;
}

/** OSP-72: the device this admin is using now (to warn before revoking it). */
export function useCurrentDeviceId(): string | null {
  return useAdminContext().currentDeviceId();
}
