import type { ReactNode } from 'react';
import { can, type PermissionAction } from '../lib/permissions';
import { useAuth } from './AuthProvider';

/**
 * OSP-71: bir kontrolü (buton, form vb.) yalnızca o eyleme yetkili role gösterir.
 *
 * Yetki yoksa içerik hiç render edilmez (DOM'da da bulunmaz); yalnızca CSS ile gizlemek, ekran
 * okuyucular ve geliştirici araçları için kontrolü görünür bırakırdı. İsteğe bağlı `fallback`
 * yetkisiz rolde gösterilir (ör. "Salt okunur görünüm" etiketi).
 *
 * Bu yalnızca arayüz gizlemesidir; asıl yetki kontrolünü backend her çağrıda yapar (FR-B-06).
 */
export function RoleGate({
  action,
  children,
  fallback = null,
}: {
  action: PermissionAction;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { role } = useAuth();
  return <>{can(role, action) ? children : fallback}</>;
}
