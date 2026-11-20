import { useState, type ReactNode } from 'react';
import type { FeedItem } from '../../../shared/types.ts';
import { FAMILY_COLOR } from '../bands.ts';
import { ClipPlayer } from './ClipPlayer.tsx';

// Runs of the same kind fold into one collapsed card: by default one card per slot visit (items close together),
// and per hour or so for kinds that report once a loop. `gap` = the most time between neighbouring items;
// `span` = the most a card may cover. A lone item stays a normal card.
type Rule = { gap: number; span: number; noun: [string, string] };
const MIN = 60_000;
const PER_LOOP = { gap: 3 * MIN, span: 15 * MIN };
const PER_HOUR = { gap: 30 * MIN, span: 60 * MIN };
const RULES: Record<string, Rule> = {
  ATC: { ...PER_LOOP, noun: ['transmission', 'transmissions'] },
  Datalink: { ...PER_LOOP, noun: ['message', 'messages'] },
  Radio: { ...PER_LOOP, noun: ['station', 'stations'] },
  Train: { ...PER_LOOP, noun: ['burst', 'bursts'] },
  Ship: { ...PER_LOOP, noun: ['ship', 'ships'] },
  Weather: { ...PER_HOUR, noun: ['clip', 'clips'] },
  Aircraft: { ...PER_HOUR, noun: ['update', 'updates'] },
  Sensor: { ...PER_HOUR, noun: ['reading', 'readings'] },
  Street: { ...PER_LOOP, noun: ['car', 'cars'] },
  Home: { ...PER_HOUR, noun: ['reading', 'readings'] },
  Balloon: { gap: 30 * MIN, span: 120 * MIN, noun: ['update', 'updates'] },
  Emergency: { gap: -1, span: -1, noun: ['alert', 'alerts'] }, // never folded: each one matters
  APRS: { ...PER_LOOP, noun: ['station', 'stations'] },
  'APRS weather': { ...PER_HOUR, noun: ['report', 'reports'] },
};
const DEFAULT_RULE: Rule = { ...PER_LOOP, noun: ['item', 'items'] };
const ruleOf = (kind: string) => RULES[kind] ?? DEFAULT_RULE;
const CLIP_RETENTION_MS = 24 * 3600_000;

export type Row = { key: string; items: FeedItem[] };

/** Groups newest-first items: runs of a kind into bundles placed where their newest item was. */
export function bundleRows(items: FeedItem[]): Row[] {
  const rows: Row[] = [];
  const open = new Map<string, Row>();
  for (const i of items) {
    const rule = ruleOf(i.kind);
    const g = open.get(i.kind);
    if (g) {
      const newest = g.items[0].ts;
      const oldest = g.items[g.items.length - 1].ts;
      if (oldest - i.ts <= rule.gap && newest - i.ts <= rule.span) {
        g.items.push(i);
        continue;
      }
    }
    const row = { key: '', items: [i] };
    rows.push(row);
    open.set(i.kind, row);
  }
  // Keyed by the oldest item: new items join at the top of a bundle, so its key (and its state) survive them.
  for (const r of rows) r.key = `${r.items[0].kind}:${r.items[r.items.length - 1].id}`;
  return rows;
}

const time = (ts: number, sec = false) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: sec ? '2-digit' : undefined });

/** "United 210 · Republic 3698 ×2 · +4 more": who is in the bundle, most frequent first. */
function whoLine(items: FeedItem[], max = 4): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.title, (counts.get(i.title) ?? 0) + 1);
  const all = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = all.slice(0, max).map(([t, n]) => (n > 1 ? `${t} ×${n}` : t));
  if (all.length > max) shown.push(`+${all.length - max} more`);
  return shown.join(' · ');
}

/**
 * One collapsed card for a run of items: a summary, a play-all player when they have clips, and every item as its
 * normal card on request (`renderItem`, built only when opened).
 */
export function BundleCard({ items, renderItem }: { items: FeedItem[]; renderItem: (i: FeedItem) => ReactNode }) {
  const first = items[0];
  const rule = ruleOf(first.kind);
  const color = FAMILY_COLOR[first.family];
  const playable = [...items].reverse().filter((i) => i.clip && Date.now() - i.ts < CLIP_RETENTION_MS); // oldest first
  const hadClips = items.some((i) => i.clip);
  const [idx, setIdx] = useState(0);
  const [chain, setChain] = useState(false); // keep going after a clip ends
  const [listOpen, setListOpen] = useState(false);
  const [isPlaying, setPlaying] = useState(false);
  const titles = new Set(items.map((i) => i.title));
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
            {titles.size === 1 && first.kind !== 'ATC' ? `${first.title} · ` : ''}
            {items.length} {rule.noun[1]}
          </b>
          <span className="mono muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
            {time(oldest, sec)}–{time(newest, sec)}
          </span>
        </div>
        {titles.size > 1 || first.kind === 'ATC' ? (
          <div className="catch-body">{whoLine(items)}</div>
        ) : first.body ? (
          <div className="catch-body">
            <span className="muted">Latest: </span>
            {first.body}
          </div>
        ) : null}
        {cur ? (
          <>
            <div className="clip-row">
              <ClipPlayer
                key={cur.id}
                src={cur.clip!}
                peaks={cur.peaks}
                color={color}
                label={`${cur.title} clip ${idx + 1} of ${playable.length}`}
                autoPlay={chain}
                playlist={playable.length > 1}
                onPlayingChange={setPlaying}
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
            <div className="muted" style={{ fontSize: 11 }}>
              {isPlaying
                ? `Playing ${idx + 1} of ${playable.length}: ${cur.title}`
                : idx > 0
                  ? `Paused at ${idx + 1} of ${playable.length}: ${cur.title}`
                  : `Plays ${playable.length} clips starting with ${cur.title}`}
            </div>
          </>
        ) : hadClips ? (
          <span className="muted" style={{ fontSize: 12 }}>Clips expired (audio is kept for 24 hours)</span>
        ) : null}
        <details className="raw" onToggle={(e) => setListOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            Show all {items.length} {rule.noun[1]}
          </summary>
          {listOpen && <div className="bundle-items">{items.map((i) => renderItem(i))}</div>}
        </details>
      </div>
    </article>
  );
}
