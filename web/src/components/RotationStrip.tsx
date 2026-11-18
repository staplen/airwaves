import type { Snapshot } from '../../../shared/types.ts';
import { FAMILY_COLOR } from '../bands.ts';

function remaining(endsAt: number, now: number): string {
  const s = Math.max(0, Math.round((endsAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Compact header strip: what the radio is tuned to now, a countdown, and a bar of the
 * next few slots (width ∝ minutes, coloured by signal family). The full dial opens below.
 */
export function RotationStrip({ snapshot, expanded, onToggle }: { snapshot?: Snapshot; expanded: boolean; onToggle: () => void }) {
  const rot = snapshot?.rotation;
  const cur = rot?.current;
  const now = snapshot?.now ?? Date.now();
  const src = (id?: string) => snapshot?.sources.find((s) => s.id === id);
  const curSrc = src(cur?.sourceId);
  const curColor = curSrc ? FAMILY_COLOR[curSrc.family] : 'var(--muted)';

  // Current slot first (with progress), then what's next.
  const curMin = cur?.endsAt ? Math.max(0.5, (cur.endsAt - cur.since) / 60_000) : 3;
  const progress = cur?.endsAt ? Math.min(1, Math.max(0, (now - cur.since) / (cur.endsAt - cur.since))) : 1;
  const segments = rot?.mode === 'rotating' ? rot.upNext.map((n) => ({ id: n.sourceId, minutes: n.minutes })) : [];

  return (
    <div className="strip">
      <div className="strip-now" title={curSrc ? `Tuned to ${curSrc.name}` : 'Waiting for the receiver'}>
        <span className="strip-freq">{cur ? cur.freqMhz.toFixed(3) : '—'}</span>
        <span className="strip-unit">MHz</span>
        {curSrc && (
          <span className="strip-chip" style={{ color: curColor }}>
            <span className="dot" style={{ background: 'var(--live)' }} />
            <span className="strip-name">{curSrc.name}</span>
            <span className="mono">{rot?.mode === 'continuous' || !cur?.endsAt ? '∞' : remaining(cur.endsAt, now)}</span>
          </span>
        )}
      </div>

      <div className="strip-bar" aria-label="Rotation: now and up next">
        <div className="seg seg-now" style={{ flexGrow: curMin, borderColor: curColor }} title={curSrc?.name}>
          <div className="seg-fill" style={{ width: `${progress * 100}%`, background: curColor }} />
        </div>
        {segments.map((s, i) => {
          const so = src(s.id);
          const color = so ? FAMILY_COLOR[so.family] : 'var(--muted)';
          return (
            <div key={i} className="seg" style={{ flexGrow: s.minutes, background: `${color}33`, color }} title={`${so?.name ?? s.id} · ${s.minutes} min`}>
              <span className="seg-label">{so?.name ?? s.id}</span>
            </div>
          );
        })}
      </div>

      <button type="button" className="strip-toggle" aria-expanded={expanded} aria-label={expanded ? 'Hide receiver details' : 'Show receiver details'} onClick={onToggle}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ transform: expanded ? 'rotate(180deg)' : undefined }}>
          <path d="M3 5 L7 9 L11 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
