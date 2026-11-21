/**
 * NFR-SAFE-03 / AC-29 / FR-D-02: must be visible on login and on every main layout view.
 * The wording follows the SOW: CONNECT does not guarantee rescue, and a missing
 * record must never be used to end a search.
 */
export function SupplementaryDisclaimer() {
  return (
    <aside role="note" className="disclaimer">
      CONNECT tamamlayıcı bir kanaldır ve kurtarmayı garanti etmez. Bir kaydın bulunmaması, arama
      operasyonlarını sonlandırmak için gerekçe değildir.
    </aside>
  );
}
