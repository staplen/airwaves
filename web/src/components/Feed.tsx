import { useState } from 'react';
import type { Family, FeedItem } from '../../../shared/types.ts';
import { FAMILY_COLOR, FAMILY_LABEL } from '../bands.ts';

const FILTERS: (Family | 'all')[] = ['all', 'air', 'sea', 'wx', 'home'];

// Older items had the collector's UTC time baked into meta ("119.100 · 20:28:11"); drop it.
const LEGACY_TIME = /\s·\s\d{1,2}:\d{2}(:\d{2})?$/;

/** Frequency or source, then the time in the viewer's own time zone. */
function metaLine(item: FeedItem): string {
  const time = new Date(item.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: item.kind.startsWith('ATC') ? '2-digit' : undefined });
  return `${item.meta.replace(LEGACY_TIME, '')} · ${time}`;
}

export function Feed({ items }: { items: FeedItem[] }) {
  const [filter, setFilter] = useState<Family | 'all'>('all');
  const shown = filter === 'all' ? items : items.filter((i) => i.family === filter);

  return (
    <section className="feed" aria-label="Catches">
      <div className="feed-head">
        <h2>Catches</h2>
        <div className="filters">
          {FILTERS.map((f) => (
            <button key={f} type="button" className="filt" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f !== 'all' && <span className="dot" style={{ background: FAMILY_COLOR[f] }} />}
              {f === 'all' ? 'All' : FAMILY_LABEL[f]}
            </button>
          ))}
        </div>
      </div>
      <div className="feed-list">
        {shown.length === 0 && <div className="card empty">Nothing caught here yet.</div>}
        {shown.map((i) => (
          <article key={i.id} className="card catch">
            <div className="bar" style={{ background: FAMILY_COLOR[i.family] }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="catch-head">
                <span className="catch-kind" style={{ color: FAMILY_COLOR[i.family] }}>{i.kind}</span>
                <b style={{ fontSize: 13 }}>{i.title}</b>
                <span className="mono muted" style={{ fontSize: 11, marginLeft: 'auto' }}>{metaLine(i)}</span>
              </div>
              <div className={i.mono ? 'catch-body mono' : 'catch-body'}>{i.body}</div>
              {i.raw && (
                <details className="raw">
                  <summary>Original message</summary>
                  <code>{i.raw}</code>
                </details>
              )}
              {i.clip && <audio className="clip" controls preload="none" src={i.clip} aria-label={`${i.title} clip`} />}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
