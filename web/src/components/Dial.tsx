import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot, SpectrumHeat } from '../../../shared/types.ts';
import { dur, slotName } from '../live.ts';
import { useSpectrum } from '../spectrum.ts';
import { BANDS, FAMILY_COLOR, REF_BANDS, bandAt, dialFreq, dialX } from '../bands.ts';

const TICKS = [100, 200, 300, 500, 700, 1000];
const BAND_H = 18;
const LANE_H = 16;
const LABEL_PX = 6.8; // rough width of one 11 px semibold character
const LANES = [-1, 1, -2, 2, -3, 3]; // above the axis, then below, then further out

type Align = 'left' | 'center' | 'right';

/** Where a label sits: centred on its x, or pinned to the dial's edge when centring would push it off. */
function edgeAlign(xPx: number, textPx: number, widthPx: number): Align {
  if (xPx - textPx / 2 < 0) return 'left';
  if (xPx + textPx / 2 > widthPx) return 'right';
  return 'center';
}

/** Absolute position for a label at x% with the given alignment. */
function labelPos(x: number, align: Align): React.CSSProperties {
  if (align === 'left') return { left: 0 };
  if (align === 'right') return { right: 0 };
  return { left: `${x}%`, transform: 'translateX(-50%)' };
}

/**
 * Greedy lane assignment, left to right: each label takes the first lane (above, below, then further out) where it
 * doesn't touch a label already placed there.
 */
function placeLabels(items: { key: string; text: string; x: number }[], widthPx: number, charPx: number): Map<string, { lane: number; align: Align }> {
  const out = new Map<string, { lane: number; align: Align }>();
  const taken = new Map<number, [number, number][]>();
  for (const it of [...items].sort((a, b) => a.x - b.x)) {
    const w = it.text.length * charPx + 6;
    const px = (it.x / 100) * widthPx;
    const align = edgeAlign(px, w, widthPx);
    const span: [number, number] = align === 'left' ? [0, w] : align === 'right' ? [widthPx - w, widthPx] : [px - w / 2, px + w / 2];
    const lane = LANES.find((l) => !(taken.get(l) ?? []).some(([a, b]) => span[0] < b + 8 && span[1] > a - 8)) ?? LANES[LANES.length - 1];
    taken.set(lane, [...(taken.get(lane) ?? []), span]);
    out.set(it.key, { lane, align });
  }
  return out;
}

/** Reference bands grouped by kind when they sit close together ("Cell 600–850"), with one label per group. */
function groupRefs(widthPx: number): { label: string; x: number; align: Align }[] {
  const groups: { kind: string; names: string[]; lo: number; hi: number }[] = [];
  for (const b of REF_BANDS) {
    const kind = b.name.split(' ')[0];
    const last = groups[groups.length - 1];
    if (last && last.kind === kind && dialX(b.lo) - dialX(last.hi) < 4) {
      last.names.push(b.name);
      last.hi = b.hi;
    } else groups.push({ kind, names: [b.name], lo: b.lo, hi: b.hi });
  }
  return groups.map((g) => {
    const label = g.names.length > 1 ? `${g.kind} ${g.names[0].split(' ')[1]}–${g.names[g.names.length - 1].split(' ')[1]}` : g.names[0];
    const x = (dialX(g.lo) + dialX(g.hi)) / 2;
    return { label, x, align: edgeAlign((x / 100) * widthPx, label.length * 5.8 + 4, widthPx) };
  });
}

function remaining(endsAt: number, now: number): string {
  const s = Math.max(0, Math.round((endsAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Heatmap({ heat, onHover }: { heat?: SpectrumHeat; onHover: (text?: string) => void }) {
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
  // Hover readout: frequency, hour, level and what lives there.
  const readout = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - box.left) / box.width;
    const fy = (e.clientY - box.top) / box.height;
    const row = heat.rows[Math.min(heat.rows.length - 1, Math.max(0, Math.floor(fy * heat.rows.length)))];
    const bin = Math.min(heat.bins - 1, Math.max(0, Math.floor(fx * heat.bins)));
    const mhz = dialFreq((bin + 0.5) / heat.bins);
    const db = row?.db[bin];
    const when = row ? new Date(row.hour * 3600_000).toLocaleTimeString([], { hour: 'numeric' }) : '';
    const what = bandAt(mhz);
    onHover(`≈${mhz < 200 ? mhz.toFixed(1) : Math.round(mhz)} MHz${what ? ` (${what})` : ''} · around ${when} · ${db === null || db === undefined ? 'no reading' : `${db.toFixed(1)} dB`}`);
  };
  return (
    <div className="heat" role="img" aria-label="Spectrum activity over the last 24 hours" onMouseMove={readout} onMouseLeave={() => onHover(undefined)}>
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
  const sourceName = source?.name ?? (current ? slotName(current.sourceId) : undefined);
  const running = new Set(snapshot?.sources.filter((s) => s.running).map((s) => s.id));
  const heat = useSpectrum();
  const [hover, setHover] = useState<string>();
  const continuous = !snapshot || snapshot.rotation.mode === 'continuous';

  // Lay the band names out in lanes above and below the axis so none overlap, at whatever width the dial is.
  const ribbonRef = useRef<HTMLDivElement>(null);
  const [widthPx, setWidthPx] = useState(900);
  useEffect(() => {
    const el = ribbonRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidthPx(e.contentRect.width || 900));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bands = BANDS.map((b) => {
    const left = dialX(b.lo);
    return { name: b.name, left, width: Math.max(0.9, dialX(b.hi) - left), active: b.sourceIds.some((id) => running.has(id)), color: FAMILY_COLOR[b.family] };
  });
  const placed = placeLabels(bands.map((b) => ({ key: b.name, text: b.name, x: b.left + b.width / 2 })), widthPx, LABEL_PX);
  const above = Math.max(0, ...[...placed.values()].map((p) => -p.lane));
  const below = Math.max(0, ...[...placed.values()].map((p) => p.lane));
  const bandTop = 4 + above * LANE_H;
  const laneTop = (lane: number) => (lane < 0 ? bandTop - 2 + lane * LANE_H : bandTop + BAND_H + 2 + (lane - 1) * LANE_H);
  const tickTop = bandTop + BAND_H + 4 + below * LANE_H;
  const ribbonH = tickTop + 14;
  // Reference bands: neighbours of one kind (the three cell bands) share one label, centred over the group.
  const refGroups = groupRefs(widthPx);

  return (
    <section className="card dial" aria-label="Receiver dial">
      <div className="dial-head">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12 }}>
          <span className="freq">{current ? current.freqMhz.toFixed(3) : '—'}</span>
          <span className="muted">MHz</span>
          {sourceName && (
            <span className="chip">
              <span className="dot" style={{ background: 'var(--live)' }} />
              {sourceName}
              {continuous ? ' · continuous' : current?.endsAt ? (snapshot!.now >= current.endsAt ? ' · switching…' : ` · ${remaining(current.endsAt, snapshot!.now)} left`) : ''}
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
                    {s?.name ?? slotName(n.sourceId)} {dur(n.minutes)}
                  </span>
                );
              })}
            </>
          )}
        </div>
      </div>

      <div className="ribbon" ref={ribbonRef} style={{ height: ribbonH }}>
        <div className="ribbon-axis" style={{ top: bandTop + BAND_H / 2 }} />
        {bands.map((b) => (
          <div
            key={b.name}
            className={b.active ? 'band' : 'band idle'}
            style={{ left: `${b.left}%`, width: `${b.width}%`, top: bandTop, background: b.color }}
            title={b.active ? `${b.name}: decoding` : `${b.name}: not running yet`}
          />
        ))}
        {bands.map((b) => {
          const p = placed.get(b.name)!;
          return (
            <span key={b.name} className={b.active ? 'band-label' : 'band-label idle'} aria-hidden="true" style={{ ...labelPos(b.left + b.width / 2, p.align), top: laneTop(p.lane), color: b.color }}>
              {b.name}
            </span>
          );
        })}
        {TICKS.map((t) => (
          <span key={t} className="tick" style={{ left: `${dialX(t)}%`, top: tickTop }}>
            {t}
          </span>
        ))}
        {current && <div className="playhead" style={{ left: `${dialX(current.freqMhz)}%`, top: bandTop - 6, height: BAND_H + 12 }} />}
      </div>
      <div className="ref-row" aria-hidden="true">
        {REF_BANDS.map((b) => (
          <span key={b.name} className="ref-band" style={{ left: `${dialX(b.lo)}%`, width: `${dialX(b.hi) - dialX(b.lo)}%` }} title={`${b.name}: ${b.lo}–${b.hi} MHz, not decoded`} />
        ))}
        {refGroups.map((g) => (
          <span key={g.label} className="ref-label" style={labelPos(g.x, g.align)}>{g.label}</span>
        ))}
      </div>
      <Heatmap heat={heat} onHover={setHover} />
      <span className={hover ? 'mono heat-readout' : 'muted'} style={{ fontSize: 12 }} aria-live="polite">
        {hover ?? 'Last 24 hours, brighter = busier. Grey bands are TV and cell towers (not decoded). Hover for details.'}
      </span>
    </section>
  );
}
