import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { defaultAuthDeps } from './auth/authRuntime';
import { RequireRole } from './auth/RequireRole';
import { LoginPage } from './pages/LoginPage';
import { CoordinatorDashboard } from './pages/CoordinatorDashboard';
import { AdminPage } from './pages/AdminPage';

/**
 * Uygulamanın rota tablosu. OSP-71: App'ten ayrı dışa aktarılır ki testler aynı tabloyu
 * MemoryRouter ve sahte AuthProvider bağımlılıklarıyla, gerçek koruyucular ve sayfalarla çalıştırsın.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/dashboard"
        element={
          // OSP-71: operasyonel ekran; coordinator + administrator (administrator salt okunur).
          // Sunucu onayı beklenmez: JWT rolüyle hemen açılır, /auth/me rolü sonra düzeltir.
          <RequireRole action="viewOperations">
            <CoordinatorDashboard />
          </RequireRole>
        }
      />
      {/* OSP-71: `/admin/*` ile yönetici alt sayfaları da aynı korumanın arkasındadır. Rol
          GET /auth/me ile bu oturum için onaylanana kadar içerik gösterilmez. */}
      <Route
        path="/admin/*"
        element={
          <RequireRole action="admin" requireConfirmedRole>
            <AdminPage />
          </RequireRole>
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider deps={defaultAuthDeps}>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
