/**
 * OSP-71: rota koruyucusu yetkisiz bir rotadan (ör. coordinator -> /admin) rolün ana sayfasına
 * yönlendirirken bu navigation state'ini taşır; panel (AppLayout) bunu görünce
 * "Bu sayfaya erişim yetkiniz yok." uyarısını gösterir. Bileşen dosyasından ayrı tutuldu ki Vite'in
 * hızlı yenilemesi (fast refresh) bileşen dosyalarında yalnızca bileşen dışa aktarımı görsün.
 */
export interface AccessDeniedState {
  accessDenied: true;
}

export const ACCESS_DENIED_STATE: AccessDeniedState = { accessDenied: true };

export const ACCESS_DENIED_MESSAGE = 'Bu sayfaya erişim yetkiniz yok.';

/** Navigation state'i (tipi bilinmeyen `location.state`) yetkisiz yönlendirme işareti mi. */
export function isAccessDeniedState(value: unknown): value is AccessDeniedState {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { accessDenied?: unknown }).accessDenied === true
  );
}
