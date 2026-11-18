import { useEffect, useMemo, useState } from 'react';
import type { Snapshot, SpectrumHeat } from '../../../shared/types.ts';
import { apiUrl } from '../api.ts';
import { BANDS, FAMILY_COLOR, dialX } from '../bands.ts';

const TICKS = [100, 200, 300, 500, 700, 1000];

function remaining(endsAt: number, now: number): string {
  const s = Math.max(0, Math.round((endsAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function useSpectrum(): SpectrumHeat | undefined {
  const [heat, setHeat] = useState<SpectrumHeat>();
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(apiUrl('spectrum'))
        .then((r) => (r.ok ? (r.json() as Promise<SpectrumHeat>) : undefined))
        .then((h) => alive && h && setHeat(h))
        .catch(() => {});
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return heat;
}

function Heatmap({ heat }: { heat?: SpectrumHeat }) {
  const cells = useMemo(() => {
    if (!heat || heat.rows.length === 0) return undefined;
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of heat.rows) for (const v of r.db) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const span = hi > lo ? hi - lo : 1;
    return heat.rows.map((r) => ({
      hour: r.hour,
      cols: r.db.map((v) => (v === null ? 'transparent' : `rgba(120,190,255,${(0.06 + 0.94 * ((v - lo) / span)).toFixed(3)})`)),
    }));
  }, [heat]);
  if (!heat || !cells) return <span className="muted" style={{ fontSize: 12 }}>{heat ? 'No sweeps yet' : 'Loading spectrum…'}</span>;
  return (
    <div className="heat" role="img" aria-label="Spectrum activity over the last 24 hours">
      {cells.map((r) => (
        <div key={r.hour} className="heat-row" style={{ gridTemplateColumns: `repeat(${heat.bins}, 1fr)` }}>
          {r.cols.map((c, i) => <i key={i} style={{ background: c }} />)}
        </div>
      ))}
    </div>
  );
}

export function Dial({ snapshot }: { snapshot?: Snapshot }) {
  const current = snapshot?.rotation.current;
  const source = snapshot?.sources.find((s) => s.id === current?.sourceId);
  const running = new Set(snapshot?.sources.filter((s) => s.running).map((s) => s.id));
  const heat = useSpectrum();
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
      <Heatmap heat={heat} />
      <span className="muted" style={{ fontSize: 12 }}>
        Last 24 hours, brighter = busier. Faded bands aren't in the rotation yet.
      </span>
    </section>
  );
}
