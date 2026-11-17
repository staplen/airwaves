import type { Snapshot } from '../../../shared/types.ts';
import { BANDS, FAMILY_COLOR, dialX } from '../bands.ts';

const TICKS = [100, 200, 300, 500, 700, 1000];

function remaining(endsAt: number, now: number): string {
  const s = Math.max(0, Math.round((endsAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function Dial({ snapshot }: { snapshot?: Snapshot }) {
  const current = snapshot?.rotation.current;
  const source = snapshot?.sources.find((s) => s.id === current?.sourceId);
  const running = new Set(snapshot?.sources.filter((s) => s.running).map((s) => s.id));
  const continuous = !snapshot || snapshot.rotation.mode === 'continuous';

  return (
    <section className="card dial" aria-label="Receiver dial">
      <div className="dial-head">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12 }}>
          <span className="freq">{current ? current.freqMhz.toFixed(3) : '—'}</span>
          <span className="muted">MHz</span>
          {source && (
            <span className="chip">
              <span className="dot" style={{ background: 'var(--live)' }} />
              {source.name}
              {continuous ? ' · continuous' : current?.endsAt ? ` · ${remaining(current.endsAt, snapshot!.now)} left` : ''}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          {continuous ? (
            <span className="muted" style={{ fontSize: 13 }}>
              Rotation starts once the scheduler is running
            </span>
          ) : (
            <>
              <span className="lbl" style={{ marginRight: 4 }}>Up next</span>
              {snapshot?.rotation.upNext.map((n, i) => {
                const s = snapshot.sources.find((x) => x.id === n.sourceId);
                return (
                  <span key={i} className="chip" style={{ color: s ? FAMILY_COLOR[s.family] : undefined }}>
                    {s?.name ?? n.sourceId} {n.minutes} min
                  </span>
                );
              })}
            </>
          )}
        </div>
      </div>

      <div className="ribbon">
        <div className="ribbon-axis" />
        {BANDS.map((b, i) => {
          const left = dialX(b.lo);
          const width = Math.max(0.9, dialX(b.hi) - left);
          const active = b.sourceIds.some((id) => running.has(id));
          const color = FAMILY_COLOR[b.family];
          return (
            <div
              key={b.name}
              className={active ? 'band' : 'band idle'}
              style={{ left: `${left}%`, width: `${width}%`, background: color }}
              title={active ? `${b.name}: decoding` : `${b.name}: not running yet`}
            >
              <span style={{ color, top: i % 2 === 0 ? -22 : 24 }}>{b.name}</span>
            </div>
          );
        })}
        {TICKS.map((t) => (
          <span key={t} className="tick" style={{ left: `${dialX(t)}%` }}>
            {t}
          </span>
        ))}
        {current && <div className="playhead" style={{ left: `${dialX(current.freqMhz)}%` }} />}
      </div>
      <span className="muted" style={{ fontSize: 12 }}>
        Faded bands aren't in the rotation yet. The 24-hour heatmap will appear here once spectrum sweeps are ingested.
      </span>
    </section>
  );
}
