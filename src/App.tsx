import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { defaultAuthDeps } from './auth/authRuntime';
import { RequireRole } from './auth/RequireRole';
import { LoginPage } from './pages/LoginPage';
import { CoordinatorDashboard } from './pages/CoordinatorDashboard';
import { AdminPage } from './pages/AdminPage';
import type { WebRole } from './lib/roles';

const COORDINATOR_ALLOW: WebRole[] = ['coordinator', 'administrator'];
const ADMIN_ALLOW: WebRole[] = ['administrator'];

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider deps={defaultAuthDeps}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/dashboard"
            element={
              <RequireRole allow={COORDINATOR_ALLOW}>
                <CoordinatorDashboard />
              </RequireRole>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireRole allow={ADMIN_ALLOW}>
                <AdminPage />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
