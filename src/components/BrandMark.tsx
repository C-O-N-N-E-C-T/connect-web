/** CONNECT mark: a seismic wave inside a circle. Our own design, not an official emblem. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="32" cy="32" r="30" fill="#b42328" />
      <polyline
        points="8,34 18,34 23,22 29,46 35,16 41,38 46,34 56,34"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
