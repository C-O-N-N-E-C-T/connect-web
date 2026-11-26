/** OSP-72: account state badge ("Etkin" / "Devre dışı"). */
export function AccountStatus({ active }: { active: boolean }) {
  return active ? (
    <span className="status-pill status-ok">Etkin</span>
  ) : (
    <span className="status-pill status-off">Devre dışı</span>
  );
}
