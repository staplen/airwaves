import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Family, FeedItem } from '../../../shared/types.ts';
import { FAMILY_COLOR, FAMILY_LABEL } from '../bands.ts';
import { ClipPlayer } from './ClipPlayer.tsx';

const PLACEHOLDER = /^(Transcript coming soon|Latest 60-second clip)/;
const CLIP_RETENTION_MS = 24 * 3600_000; // matches the collector's audio purge

// Filterable types: each family splits into types by feed item kind, plus a per-family
// catch-all for kinds we don't know yet. Picked types are OR'd; none picked = everything.
const CATEGORIES: { family: Family; subs: { id: string; label: string; kinds: string[] }[] }[] = [
  { family: 'air', subs: [{ id: 'atc', label: 'ATC', kinds: ['ATC'] }, { id: 'datalink', label: 'Datalink', kinds: ['Datalink'] }, { id: 'aircraft', label: 'Aircraft', kinds: ['Aircraft'] }] },
  { family: 'sea', subs: [{ id: 'ships', label: 'Ships', kinds: ['Ship'] }] },
  { family: 'wx', subs: [{ id: 'radio', label: 'Weather radio', kinds: ['Weather'] }, { id: 'alerts', label: 'Weather alerts', kinds: ['Weather alert', 'Weather test'] }, { id: 'balloons', label: 'Balloons', kinds: ['Balloon'] }] },
  { family: 'bcast', subs: [{ id: 'radio-hd', label: 'HD Radio', kinds: ['Radio'] }] },
  { family: 'home', subs: [{ id: 'street', label: 'Tire sensors', kinds: ['Street'] }, { id: 'sensors', label: 'Sensors', kinds: ['Sensor'] }, { id: 'meter', label: 'Gas meter', kinds: ['Home'] }] },
];
interface TypeOpt { id: string; label: string; family: Family }
const TYPES: TypeOpt[] = CATEGORIES.flatMap((c) => [
  ...c.subs.map((s) => ({ id: s.id, label: s.label, family: c.family })),
  { id: `family:${c.family}`, label: `Other ${FAMILY_LABEL[c.family].toLowerCase()}`, family: c.family },
]);
const TYPE_BY_ID = new Map(TYPES.map((t) => [t.id, t]));
const SUB_OF_KIND = new Map(CATEGORIES.flatMap((c) => c.subs.flatMap((s) => s.kinds.map((k) => [k, s.id] as const))));
const TYPES_KEY = 'airwaves.feedTypes';

function readTypes(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TYPES_KEY) ?? '[]') as string[];
    return v.filter((id) => TYPE_BY_ID.has(id));
  } catch {
    return [];
  }
}

/** Type id for an item; unknown kinds fall back to their family. */
const subOf = (i: FeedItem) => SUB_OF_KIND.get(i.kind) ?? `family:${i.family}`;
const haystack = (i: FeedItem) => `${i.kind} ${i.title} ${i.meta} ${i.body}`.toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wraps every occurrence of the search words in <mark>. */
function highlight(text: string, words: string[]): ReactNode {
  if (words.length === 0 || !text) return text;
  const parts = text.split(new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi'));
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
}

// Older items had the collector's UTC time baked into meta ("119.100 · 20:28:11"); drop it.
const LEGACY_TIME = /\s·\s\d{1,2}:\d{2}(:\d{2})?$/;

/** Frequency or source, then the time in the viewer's own time zone. */
function metaLine(item: FeedItem): string {
  const time = new Date(item.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: item.kind.startsWith('ATC') ? '2-digit' : undefined });
  return `${item.meta.replace(LEGACY_TIME, '')} · ${time}`;
}

type Opt = { key: string; type: TypeOpt; count: number } | { key: string; title: string; kindLabel: string; family: Family; count: number };

const listJoin = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

export function Feed({ items }: { items: FeedItem[] }) {
  const [types, setTypesState] = useState<string[]>(readTypes);
  const setTypes = (next: string[]) => {
    setTypesState(next);
    try {
      localStorage.setItem(TYPES_KEY, JSON.stringify(next));
    } catch {
      /* per-viewer convenience only */
    }
  };
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const typeOk = (i: FeedItem) => types.length === 0 || types.includes(subOf(i));
  const shown = items.filter((i) => typeOk(i) && (words.length === 0 || words.every((w) => haystack(i).includes(w))));

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(subOf(i), (m.get(subOf(i)) ?? 0) + 1);
    return m;
  }, [items]);

  // Suggestions: with an empty box, every type that has items (by count); while typing,
  // types whose name matches plus the most common item titles that match.
  const opts: Opt[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const typeOpts = TYPES.filter((t) => !types.includes(t.id) && (counts.get(t.id) ?? 0) > 0 && (!q || t.label.toLowerCase().includes(q)))
      .map((t) => ({ key: `t:${t.id}`, type: t, count: counts.get(t.id) ?? 0 }))
      .sort((a, b) => b.count - a.count);
    if (!q) return typeOpts;
    const byTitle = new Map<string, { title: string; kindLabel: string; family: Family; count: number }>();
    for (const i of items) {
      if (!typeOk(i) || !words.every((w) => i.title.toLowerCase().includes(w))) continue;
      const e = byTitle.get(i.title);
      if (e) e.count++;
      else byTitle.set(i.title, { title: i.title, kindLabel: TYPE_BY_ID.get(subOf(i))?.label ?? i.kind, family: i.family, count: 1 });
    }
    const matchOpts = [...byTitle.values()].sort((a, b) => b.count - a.count).slice(0, 5).map((m) => ({ key: `m:${m.title}`, ...m }));
    return [...typeOpts.slice(0, 4), ...matchOpts];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, types, items, counts]);

  useEffect(() => setActive(-1), [query, types]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (o: Opt) => {
    if ('type' in o) {
      setTypes([...types, o.type.id]);
      // A typed type name ("atc") becomes the token, so clear it from the text.
      if (query.trim() && o.type.label.toLowerCase().includes(query.trim().toLowerCase())) setQuery('');
    } else {
      setQuery(o.title);
    }
    setOpen(false);
    input.current?.focus();
  };
  const clearAll = () => {
    setTypes([]);
    setQuery('');
    input.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(opts.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(-1, a - 1));
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && opts[active]) pick(opts[active]);
      else setOpen(false);
    } else if (e.key === 'Escape') {
      if (open) setOpen(false);
      else if (query) setQuery('');
    } else if (e.key === 'Backspace' && query === '' && types.length > 0) {
      setTypes(types.slice(0, -1));
    }
  };

  const filtered = types.length > 0 || words.length > 0;
  const typeNames = types.map((id) => TYPE_BY_ID.get(id)?.label ?? id);
  const menuOpen = open && opts.length > 0;
  const firstMatch = opts.findIndex((o) => !('type' in o));

  return (
    <section className="feed" aria-label="Feed">
      <div className="fsearch" ref={root}>
        <div className="fsearch-box" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); setOpen(true); } }}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--muted)" strokeWidth="1.5" /><path d="M9.5 9.5 L13 13" stroke="var(--muted)" strokeWidth="1.5" strokeLinecap="round" /></svg>
          {types.map((id) => {
            const t = TYPE_BY_ID.get(id);
            return (
              <span key={id} className="ftoken">
                <span className="dot" style={{ background: t ? FAMILY_COLOR[t.family] : undefined }} />
                {t?.label ?? id}
                <button type="button" aria-label={`Remove ${t?.label ?? id} filter`} onClick={() => setTypes(types.filter((x) => x !== id))}>✕</button>
              </span>
            );
          })}
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-label="Search or filter feed"
            aria-expanded={menuOpen}
            aria-controls="feed-suggest"
            aria-activedescendant={menuOpen && active >= 0 ? `feed-opt-${active}` : undefined}
            aria-autocomplete="list"
            placeholder={types.length ? 'Search within these' : 'Search or filter feed'}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
          <span className="fsearch-count" aria-live="polite">{filtered ? `${shown.length} of ${items.length}` : items.length}</span>
          {filtered && <button type="button" className="fsearch-clear" aria-label="Clear search and filters" onClick={clearAll}>✕</button>}
        </div>
        {menuOpen && (
          <div className="fmenu" id="feed-suggest" role="listbox" aria-label="Suggestions">
            {opts.map((o, idx) => (
              <div key={o.key} style={{ display: 'contents' }}>
                {idx === 0 && 'type' in o && <div className="fmenu-sect">Filter by type</div>}
                {idx === firstMatch && <div className="fmenu-sect">Matches</div>}
                <div
                  id={`feed-opt-${idx}`}
                  role="option"
                  aria-selected={idx === active}
                  className={idx === active ? 'fopt active' : 'fopt'}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => pick(o)}
                >
                  <span className="dot" style={{ background: FAMILY_COLOR['type' in o ? o.type.family : o.family] }} />
                  {'type' in o ? o.type.label : <span>{highlight(o.title, words)} <span className="muted">· {o.kindLabel}</span></span>}
                  <span className="fsearch-count">{o.count}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="feed-list">
        {shown.length === 0 && (
          <div className="card empty">
            {!filtered
              ? 'Nothing caught here yet.'
              : words.length > 0
                ? `Nothing matches “${query.trim()}”${types.length ? ` in ${listJoin(typeNames)}` : ''}.`
                : `No ${listJoin(typeNames)} in the last ${items.length} items.`}
            {filtered && <button type="button" className="empty-clear" onClick={clearAll}>Clear filters</button>}
          </div>
        )}
        {shown.map((i) => (
          <article key={i.id} className="card catch">
            <div className="bar" style={{ background: FAMILY_COLOR[i.family] }} />
            {i.image && <img className="catch-art" src={i.image} alt="" loading="lazy" width={56} height={56} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="catch-head">
                <span className="catch-kind" style={{ color: FAMILY_COLOR[i.family] }}>{highlight(i.kind, words)}</span>
                <b style={{ fontSize: 13 }}>{highlight(i.title, words)}</b>
                <span className="mono muted" style={{ fontSize: 11, marginLeft: 'auto' }}>{highlight(metaLine(i), words)}</span>
              </div>
              {i.body && !PLACEHOLDER.test(i.body) && <div className={i.mono ? 'catch-body mono' : 'catch-body'}>{highlight(i.body, words)}</div>}
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
