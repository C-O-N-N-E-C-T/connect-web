/**
 * Decorative seismograph trace for the login screen. Drawn as our own SVG,
 * not an official asset. The trace is deterministic, so every render is identical.
 */
export function SeismographBackground() {
  const steps = 260;
  const points: string[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = t * 1000;
    // Amplitude grows toward the right, like a quake building up.
    const amplitude = 12 + 170 * t * t;
    const noise =
      Math.sin(i * 1.7) * Math.cos(i * 0.37) + 0.6 * Math.sin(i * 4.1 + 1) + 0.3 * Math.sin(i * 9.3);
    const y = 330 - amplitude * noise * 0.5;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }

  return (
    <svg
      className="seismograph"
      viewBox="0 0 1000 600"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}
