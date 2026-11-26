import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../components/AppLayout';
import { UsersPage } from './admin/UsersPage';
import { UserDevicesPage } from './admin/UserDevicesPage';
import { AuditLogPage } from './admin/AuditLogPage';
import { useAdminBackendDisabled } from '../admin/AdminApiContext';

/**
 * OSP-72: administrator screens (OSP-66 admin API). The parent route is `/admin/*` behind
 * `RequireRole action="admin" requireConfirmedRole` (OSP-71); the title stays "Yönetici Paneli"
 * on every sub-route.
 */
export function AdminPage() {
  const backendDisabled = useAdminBackendDisabled();
  return (
    <AppLayout title="Yönetici Paneli" wide>
      <nav aria-label="Yönetici bölümleri" className="admin-nav">
        <NavLink to="/admin/users">Kullanıcılar</NavLink>
        <NavLink to="/admin/audit-logs">Denetim kayıtları</NavLink>
      </nav>
      <section className="admin-content">
        {backendDisabled ? (
          // OSP-72: in mock mode the session is never bound, so every admin call would end in a
          // forced "Oturum cihaza bağlanamadı" sign-out. Explain the setup instead of calling.
          <div role="alert" className="banner-error">
            <p>Yönetici ekranları mock modunda çalışmaz; gerçek backend gerekir.</p>
            <p>
              <code>.env</code> dosyasında <code>VITE_AUTH_SESSION_MODE=real</code> yapın ve{' '}
              <code>npm run dev</code> komutunu yeniden başlatın.
            </p>
          </div>
        ) : (
        <Routes>
          <Route index element={<Navigate to="users" replace />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="users/:userId" element={<UserDevicesPage />} />
          <Route path="audit-logs" element={<AuditLogPage />} />
          <Route path="*" element={<Navigate to="/admin/users" replace />} />
        </Routes>
        )}
      </section>
    </AppLayout>
  );
}
