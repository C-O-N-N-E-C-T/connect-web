import { AppLayout } from '../components/AppLayout';
import { RoleGate } from '../auth/RoleGate';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../lib/permissions';

// OSP-71: yer tutucu butonların "henüz uygulanmadı" açıklaması (title + aria-description).
const NOT_IMPLEMENTED = 'Bu işlem henüz uygulanmadı.';

/**
 * Placeholder for the main coordinator view. Map and records are out of OSP-69 scope.
 *
 * OSP-71: operasyonel ekranın yetki iskeleti. "Override" (FR-D-06) ve "Kaynak ata" (FR-D-07)
 * kontrolleri yalnızca coordinator'a render edilir (RoleGate; yetkisiz rolde DOM'da yoktur).
 * Administrator sayfayı salt okunur görür ve bunu belirten bir etiket görür. Butonlar şimdilik
 * işlevsizdir (disabled); gerçek uçlar (PATCH /victims/:id/override, POST /assignments) sonraki
 * görevlerde bağlanacak.
 */
export function CoordinatorDashboard() {
  const { role } = useAuth();
  // Operasyonel eylemlerin hiçbirine yetkisi olmayan rol (administrator) için salt okunur etiketi.
  const readOnly = !can(role, 'override') && !can(role, 'assign');

  return (
    <AppLayout title="Koordinasyon Paneli">
      {readOnly ? (
        // Durağan bir etiket: canlı bölge (role="status") değil, sayfa ile birlikte okunur.
        <p className="read-only-badge">Salt okunur görünüm</p>
      ) : (
        // Boş bir grup ekran okuyucuya anlamsız görünmesin diye yalnızca yetkili rolde render edilir.
        <div className="panel-actions" role="group" aria-label="Operasyon işlemleri">
          <RoleGate action="override">
            <button type="button" disabled title={NOT_IMPLEMENTED} aria-description={NOT_IMPLEMENTED}>
              Override
            </button>
          </RoleGate>
          <RoleGate action="assign">
            <button type="button" disabled title={NOT_IMPLEMENTED} aria-description={NOT_IMPLEMENTED}>
              Kaynak ata
            </button>
          </RoleGate>
        </div>
      )}
    </AppLayout>
  );
}
