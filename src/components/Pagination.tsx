/** OSP-72: previous / next pager for lists without a total count. */
export function Pagination({
  page,
  hasNext,
  disabled = false,
  onChange,
}: {
  page: number;
  hasNext: boolean;
  disabled?: boolean;
  onChange: (page: number) => void;
}) {
  return (
    <nav aria-label="Sayfalama" className="pagination">
      <button type="button" className="button-secondary" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}>
        Önceki
      </button>
      <span aria-live="polite">Sayfa {page}</span>
      <button type="button" className="button-secondary" disabled={disabled || !hasNext} onClick={() => onChange(page + 1)}>
        Sonraki
      </button>
    </nav>
  );
}
