import { useEffect, useRef, useState } from 'react';
import type { Family, FeedItem } from '../../../shared/types.ts';
import { FAMILY_COLOR, FAMILY_LABEL } from '../bands.ts';
import { ClipPlayer } from './ClipPlayer.tsx';

const PLACEHOLDER = /^(Transcript coming soon|Latest 60-second clip)/;
const CLIP_RETENTION_MS = 24 * 3600_000; // matches the collector's audio purge

// Each family splits into sub-categories by feed item kind. Everything starts visible;
// viewers switch off what they don't want (remembered per browser).
const CATEGORIES: { family: Family; subs: { id: string; label: string; kinds: string[] }[] }[] = [
  { family: 'air', subs: [{ id: 'atc', label: 'ATC', kinds: ['ATC'] }, { id: 'datalink', label: 'Datalink', kinds: ['Datalink'] }, { id: 'aircraft', label: 'Aircraft', kinds: ['Aircraft'] }] },
  { family: 'sea', subs: [{ id: 'ships', label: 'Ships', kinds: ['Ship'] }] },
  { family: 'wx', subs: [{ id: 'radio', label: 'Radio', kinds: ['Weather'] }, { id: 'alerts', label: 'Alerts', kinds: ['Weather alert', 'Weather test'] }, { id: 'balloons', label: 'Balloons', kinds: ['Balloon'] }] },
  { family: 'bcast', subs: [{ id: 'radio-hd', label: 'HD Radio', kinds: ['Radio'] }] },
  { family: 'home', subs: [{ id: 'street', label: 'Tire sensors', kinds: ['Street'] }, { id: 'sensors', label: 'Sensors', kinds: ['Sensor'] }, { id: 'meter', label: 'Gas meter', kinds: ['Home'] }] },
];
// Every filter id: each sub-category plus a per-family catch-all for kinds we don't know yet.
const ALL_IDS = CATEGORIES.flatMap((c) => [...c.subs.map((s) => s.id), `family:${c.family}`]);
const SUB_OF_KIND = new Map(CATEGORIES.flatMap((c) => c.subs.flatMap((s) => s.kinds.map((k) => [k, s.id] as const))));
const HIDDEN_KEY = 'airwaves.hiddenCatches';

function readHidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Sub-category id for an item; unknown kinds fall back to their family. */
const subOf = (i: FeedItem) => SUB_OF_KIND.get(i.kind) ?? `family:${i.family}`;

// Older items had the collector's UTC time baked into meta ("119.100 · 20:28:11"); drop it.
const LEGACY_TIME = /\s·\s\d{1,2}:\d{2}(:\d{2})?$/;

/** Frequency or source, then the time in the viewer's own time zone. */
function metaLine(item: FeedItem): string {
  const time = new Date(item.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: item.kind.startsWith('ATC') ? '2-digit' : undefined });
  return `${item.meta.replace(LEGACY_TIME, '')} · ${time}`;
}

export function Feed({ items }: { items: FeedItem[] }) {
  const [hidden, setHidden] = useState<Set<string>>(readHidden);
  const save = (next: Set<string>) => {
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
    } catch {
      /* per-viewer convenience only */
    }
  };
  const toggleSub = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    save(next);
  };
  // A family button hides all its sub-categories, or shows them all if any are hidden.
  const toggleFamily = (f: Family) => {
    const ids = [...CATEGORIES.find((c) => c.family === f)!.subs.map((s) => s.id), `family:${f}`];
    const next = new Set(hidden);
    if (ids.some((id) => !next.has(id))) ids.forEach((id) => next.add(id));
    else ids.forEach((id) => next.delete(id));
    save(next);
  };
  const shown = items.filter((i) => !hidden.has(subOf(i)));

  // Sub-category dropdown: one open at a time; closes on outside click or Escape.
  const [openMenu, setOpenMenu] = useState<Family | null>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRoot.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenMenu(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);
  const count = (id: string) => items.filter((i) => subOf(i) === id).length;

  return (
    <section className="feed" aria-label="Feed">
      <div className="feed-head">
        <h2>Feed</h2>
        <div className="filters" role="group" aria-label="Show or hide catches" ref={menuRoot}>
          <button type="button" className="filt" aria-pressed={hidden.size === 0} onClick={() => save(hidden.size === 0 ? new Set(ALL_IDS) : new Set())} title={hidden.size === 0 ? 'Hide everything, then pick what to show' : 'Show everything'}>
            All
          </button>
          {CATEGORIES.map((c) => {
            const off = c.subs.filter((sub) => hidden.has(sub.id)).length;
            const state = off === 0 ? 'true' : off === c.subs.length ? 'false' : 'mixed';
            const open = openMenu === c.family;
            return (
              <div key={c.family} className="filt-wrap">
                <div className={`filt filt-split${c.subs.length > 1 ? ' has-menu' : ''}`} data-state={state}>
                  <button type="button" className="filt-main" aria-pressed={state} onClick={() => toggleFamily(c.family)}>
                    <span className="dot" style={{ background: FAMILY_COLOR[c.family] }} />
                    {FAMILY_LABEL[c.family]}
                    {state === 'mixed' && <span className="filt-count">{c.subs.length - off}/{c.subs.length}</span>}
                  </button>
                  {c.subs.length > 1 && (
                    <button type="button" className="filt-caret" aria-haspopup="true" aria-expanded={open} aria-label={`${FAMILY_LABEL[c.family]} types`} onClick={() => setOpenMenu(open ? null : c.family)}>
                      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                  )}
                </div>
                {open && (
                  <div className="filt-menu" role="group" aria-label={`${FAMILY_LABEL[c.family]} types`}>
                    {c.subs.map((sub) => (
                      <label key={sub.id} className="filt-option">
                        <input type="checkbox" checked={!hidden.has(sub.id)} onChange={() => toggleSub(sub.id)} />
                        <span>{sub.label}</span>
                        <span className="muted mono">{count(sub.id)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="feed-list">
        {shown.length === 0 &&
          (ALL_IDS.every((id) => hidden.has(id)) ? (
            <div className="card empty">Everything is hidden. Pick a type above to show just that, or click All to show everything.</div>
          ) : hidden.size > 0 ? (
            <div className="card empty">Nothing caught for the selected types yet.</div>
          ) : (
            <div className="card empty">Nothing caught here yet.</div>
          ))}
        {shown.map((i) => (
          <article key={i.id} className="card catch">
            <div className="bar" style={{ background: FAMILY_COLOR[i.family] }} />
            {i.image && <img className="catch-art" src={i.image} alt="" loading="lazy" width={56} height={56} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="catch-head">
                <span className="catch-kind" style={{ color: FAMILY_COLOR[i.family] }}>{i.kind}</span>
                <b style={{ fontSize: 13 }}>{i.title}</b>
                <span className="mono muted" style={{ fontSize: 11, marginLeft: 'auto' }}>{metaLine(i)}</span>
              </div>
              {i.body && !PLACEHOLDER.test(i.body) && <div className={i.mono ? 'catch-body mono' : 'catch-body'}>{i.body}</div>}
              {i.raw && (
                <details className="raw">
                  <summary>Original message</summary>
                  <code>{i.raw}</code>
                </details>
              )}
              {i.clip && Date.now() - i.ts < CLIP_RETENTION_MS && <ClipPlayer src={i.clip} color={FAMILY_COLOR[i.family]} label={`${i.title} clip`} />}
              {i.clip && Date.now() - i.ts >= CLIP_RETENTION_MS && <span className="muted" style={{ fontSize: 12 }}>Clip expired (audio is kept for 24 hours)</span>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
