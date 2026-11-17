/** Ring that empties as data ages. `fraction` 1 = just heard, 0 = stale. */
export function FreshnessRing({ fraction, color, size = 18 }: { fraction: number; color: string; size?: number }) {
  const r = 11;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r={r} fill="none" stroke="#232934" strokeWidth="4" />
      <circle
        cx="14"
        cy="14"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="4"
        strokeDasharray={`${f * c} ${c}`}
        transform="rotate(-90 14 14)"
      />
    </svg>
  );
}
