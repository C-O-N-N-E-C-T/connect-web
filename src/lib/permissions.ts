/**
 * OSP-71: web panelinin TEK rol matrisi. Rota koruyucuları (RequireRole) ve buton görünürlüğü
 * (RoleGate) yetkiyi yalnızca buradan okur; böylece hangi rolün neyi görebileceği tek yerde durur.
 *
 * Matris backend'deki OSP-62 RBAC matrisiyle BİREBİR aynıdır
 * (connect-backend: src/routes/business.ts ve src/routes/admin.ts):
 *
 * | Eylem            | Backend ucu                           | rescuer | coordinator | administrator |
 * |------------------|---------------------------------------|---------|-------------|---------------|
 * | `viewOperations` | GET /victims, GET /victims/:id        | hayır   | evet        | evet          |
 * | `override`       | PATCH /victims/:id/override (FR-D-06) | hayır   | evet        | hayır         |
 * | `assign`         | POST /assignments (FR-D-07)           | hayır   | evet        | hayır         |
 * | `admin`          | /admin/* (OSP-66)                     | hayır   | hayır       | evet          |
 *
 * `rescuer` yalnızca POST /sync kullanır (mobil); web panelinde hiçbir eylemi yoktur.
 *
 * Bu yalnızca arayüz düzeyinde bir gizlemedir: backend her API çağrısında rolü yine kendisi
 * denetler (FR-B-06). İstemci matrisi backend'den GENİŞ olmamalıdır; backend değişirse burası da
 * aynı değişiklikle güncellenmelidir.
 */
import { isWebRole, type WebRole } from './roles';

export type PermissionAction = 'viewOperations' | 'override' | 'assign' | 'admin';

/** Tüm eylemler (testlerde matrisin her hücresini dolaşmak için). */
export const PERMISSION_ACTIONS: readonly PermissionAction[] = [
  'viewOperations',
  'override',
  'assign',
  'admin',
];

// Yalnızca web rolleri anahtar olarak bulunur; rescuer ve bilinmeyen roller hiç listelenmez ve
// aşağıdaki `can` onlar için her zaman false döner (güvenli taraf).
const ROLE_MATRIX: Readonly<Record<WebRole, ReadonlySet<PermissionAction>>> = {
  coordinator: new Set<PermissionAction>(['viewOperations', 'override', 'assign']),
  // Administrator operasyonel ekranları salt okunur görür: override ve atama yetkisi yoktur.
  administrator: new Set<PermissionAction>(['viewOperations', 'admin']),
};

/**
 * Rolün bu eylemi yapıp yapamayacağı. Bilinmeyen, null ya da web dışı (rescuer) rol için her
 * eylemde false döner. `role` bilerek `unknown`: JWT veya sunucudan gelen ham değer de güvenle
 * verilebilir.
 */
export function can(role: unknown, action: PermissionAction): boolean {
  if (!isWebRole(role)) return false;
  return ROLE_MATRIX[role].has(action);
}
