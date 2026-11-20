import { useState } from 'react';
import type { FeedItem } from '../../../shared/types.ts';
import { FAMILY_COLOR } from '../bands.ts';
import { ClipPlayer } from './ClipPlayer.tsx';

// Bursty clip types fold into one card: ATC per slot visit (clips close together), NOAA weather radio per hour.
// `gap` = the most time between neighbouring clips; `span` = the most a card may cover.
const RULES: Record<string, { gap: number; span: number; noun: [string, string] }> = {
  ATC: { gap: 3 * 60_000, span: 15 * 60_000, noun: ['transmission', 'transmissions'] },
  Weather: { gap: 30 * 60_000, span: 60 * 60_000, noun: ['clip', 'clips'] },
};
const CLIP_RETENTION_MS = 24 * 3600_000;

export type Row = { key: string; items: FeedItem[] };

/** Groups newest-first items: bursty kinds into bundles placed where their newest item was, everything else alone. */
export function bundleRows(items: FeedItem[]): Row[] {
  const rows: Row[] = [];
  const open = new Map<string, Row>();
  for (const i of items) {
    const rule = RULES[i.kind];
    const g = rule && open.get(i.kind);
    if (g && rule) {
      const newest = g.items[0].ts;
      const oldest = g.items[g.items.length - 1].ts;
      if (oldest - i.ts <= rule.gap && newest - i.ts <= rule.span) {
        g.items.push(i);
        continue;
      }
    }
    const row = { key: `${i.kind}:${i.id}`, items: [i] };
    rows.push(row);
    if (rule) open.set(i.kind, row);
  }
  return rows;
}

const time = (ts: number, sec = false) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: sec ? '2-digit' : undefined });

/** One card for a burst of clips: a summary, a player that plays them in order, and the clips one by one on request. */
export function BundleCard({ items }: { items: FeedItem[] }) {
  const first = items[0];
  const rule = RULES[first.kind];
  const color = FAMILY_COLOR[first.family];
  const playable = [...items].reverse().filter((i) => i.clip && Date.now() - i.ts < CLIP_RETENTION_MS); // oldest first
  const [idx, setIdx] = useState(0);
  const [chain, setChain] = useState(false); // keep going after a clip ends
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.title, (counts.get(i.title) ?? 0) + 1);
  const who = [...counts].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' · ');
  const newest = items[0].ts;
  const oldest = items[items.length - 1].ts;
  const cur = playable[Math.min(idx, playable.length - 1)];
  const sec = first.kind === 'ATC';

  return (
    <article className="card catch">
      <div className="bar" style={{ background: color }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="catch-head">
          <span className="catch-kind" style={{ color }}>{first.kind}</span>
          <b style={{ fontSize: 13 }}>
            {items.length} {rule?.noun[1] ?? 'items'}
          </b>
          <span className="mono muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
            {time(oldest, sec)}–{time(newest, sec)}
          </span>
        </div>
        {counts.size > 1 || first.kind === 'ATC' ? <div className="catch-body">{who}</div> : null}
        {cur ? (
          <div className="clip-row">
            <ClipPlayer
              key={cur.id}
              src={cur.clip!}
              color={color}
              label={`${cur.title} clip ${idx + 1} of ${playable.length}`}
              autoPlay={chain}
              onEnded={() => {
                if (idx + 1 < playable.length) {
                  setChain(true);
                  setIdx(idx + 1);
                } else {
                  setChain(false);
                  setIdx(0);
                }
              }}
            />
          </div>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>Clips expired (audio is kept for 24 hours)</span>
        )}
        {cur && (
          <div className="muted" style={{ fontSize: 11 }}>
            Plays all {playable.length} in order · now {idx + 1}: {cur.title} at {time(cur.ts, sec)}
          </div>
        )}
        <details className="raw">
          <summary>Each {rule?.noun[0] ?? 'item'}</summary>
          <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
            {items.map((i) => (
              <div key={i.id} style={{ display: 'grid', gap: 2 }}>
                <span style={{ fontSize: 12 }}>
                  {i.title} <span className="mono muted">· {i.meta} · {time(i.ts, sec)}</span>
                </span>
                {i.clip && Date.now() - i.ts < CLIP_RETENTION_MS && <ClipPlayer src={i.clip} color={color} label={`${i.title} clip`} />}
              </div>
            ))}
          </div>
        </details>
      </div>
    </article>
  );
}
