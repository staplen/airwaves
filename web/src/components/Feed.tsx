import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Family, FeedItem } from '../../../shared/types.ts';
import { FAMILY_COLOR, FAMILY_LABEL } from '../bands.ts';
import { BundleCard, bundleRows } from './Bundle.tsx';
import { ClipPlayer } from './ClipPlayer.tsx';
import { onShowOnly } from '../feedFilter.ts';

const PLACEHOLDER = /^(Transcript coming soon|Latest 60-second clip)/;
const CLIP_RETENTION_MS = 24 * 3600_000; // matches the collector's audio purge

// Filterable types: each family splits into types by feed item kind, plus a per-family
// catch-all for kinds we don't know yet. Everything is shown until a viewer unticks types.
const CATEGORIES: { family: Family; subs: { id: string; label: string; kinds: string[] }[] }[] = [
  { family: 'air', subs: [{ id: 'atc', label: 'ATC', kinds: ['ATC'] }, { id: 'datalink', label: 'Datalink', kinds: ['Datalink'] }, { id: 'aircraft', label: 'Aircraft', kinds: ['Aircraft'] }] },
  { family: 'sea', subs: [{ id: 'ships', label: 'Ships', kinds: ['Ship'] }] },
  { family: 'wx', subs: [{ id: 'radio', label: 'Weather radio', kinds: ['Weather'] }, { id: 'alerts', label: 'Weather alerts', kinds: ['Weather alert', 'Weather test'] }, { id: 'balloons', label: 'Balloons', kinds: ['Balloon'] }] },
  { family: 'bcast', subs: [{ id: 'radio-hd', label: 'HD Radio', kinds: ['Radio'] }] },
  { family: 'rail', subs: [{ id: 'trains', label: 'Trains', kinds: ['Train'] }] },
  { family: 'home', subs: [{ id: 'street', label: 'Tire sensors', kinds: ['Street'] }, { id: 'sensors', label: 'Sensors', kinds: ['Sensor'] }, { id: 'meter', label: 'Gas meter', kinds: ['Home'] }] },
];
interface TypeOpt { id: string; label: string; family: Family }
const TYPES: TypeOpt[] = CATEGORIES.flatMap((c) => [
  ...c.subs.map((s) => ({ id: s.id, label: s.label, family: c.family })),
  { id: `family:${c.family}`, label: `Other ${FAMILY_LABEL[c.family].toLowerCase()}`, family: c.family },
]);
const TYPE_BY_ID = new Map(TYPES.map((t) => [t.id, t]));
const SUB_OF_KIND = new Map(CATEGORIES.flatMap((c) => c.subs.flatMap((s) => s.kinds.map((k) => [k, s.id] as const))));
const HIDDEN_KEY = 'airwaves.feedHidden';

function readHidden(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[];
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

const listJoin = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

type Opt = { key: string; title: string; kindLabel: string; family: Family; count: number };

const FAMILY_ORDER: Family[] = ['air', 'bcast', 'wx', 'home', 'rail', 'sea'];

export function Feed({ items }: { items: FeedItem[] }) {
  // Types are all shown to start; viewers untick the ones they don't want (remembered per browser).
  const [hidden, setHiddenState] = useState<string[]>(readHidden);
  const setHidden = (next: string[]) => {
    setHiddenState(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {
      /* per-viewer convenience only */
    }
  };
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false); // text suggestions
  const [typesOpen, setTypesOpen] = useState(false); // type checklist
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const typeOk = (i: FeedItem) => !hidden.includes(subOf(i));
  const shown = items.filter((i) => typeOk(i) && (words.length === 0 || words.every((w) => haystack(i).includes(w))));

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(subOf(i), (m.get(subOf(i)) ?? 0) + 1);
    return m;
  }, [items]);

  // Every known type is listed (empty ones dimmed); the per-family catch-alls only when they have items.
  const listed = TYPES.filter((t) => !t.id.startsWith('family:') || (counts.get(t.id) ?? 0) > 0);
  const onTypes = listed.filter((t) => !hidden.includes(t.id));
  const offTypes = listed.filter((t) => hidden.includes(t.id));
  const tokenLabel =
    offTypes.length === 0 ? 'All types' : onTypes.length === 0 ? 'No types' : onTypes.length === 1 ? `Only ${onTypes[0].label}` : offTypes.length === 1 ? `All but ${offTypes[0].label}` : `${onTypes.length} of ${listed.length} types`;
  const toggle = (id: string) => setHidden(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]);
  const only = (id: string) => setHidden(TYPES.map((t) => t.id).filter((x) => x !== id));
  const allOn = () => setHidden([]);

  // While typing: the most common item titles that match, as one-tap searches.
  const opts: Opt[] = useMemo(() => {
    if (words.length === 0) return [];
    const byTitle = new Map<string, Opt>();
    for (const i of items) {
      if (!typeOk(i) || !words.every((w) => i.title.toLowerCase().includes(w))) continue;
      const e = byTitle.get(i.title);
      if (e) e.count++;
      else byTitle.set(i.title, { key: i.title, title: i.title, kindLabel: TYPE_BY_ID.get(subOf(i))?.label ?? i.kind, family: i.family, count: 1 });
    }
    return [...byTitle.values()].sort((a, b) => b.count - a.count).slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, hidden, items]);

  useEffect(() => setActive(-1), [query]);
  // The header loop strip can ask for "only these types" (e.g. clicking the ATC segment).
  useEffect(
    () =>
      onShowOnly((types) => {
        setHidden(TYPES.map((t) => t.id).filter((id) => !types.includes(id)));
        setQuery('');
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    if (!open && !typesOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        setTypesOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setTypesOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, typesOpen]);

  const pick = (o: Opt) => {
    setQuery(o.title);
    setOpen(false);
    input.current?.focus();
  };
  const clearAll = () => {
    setHidden([]);
    setQuery('');
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
    }
  };

  const filtered = offTypes.length > 0 || words.length > 0;
  const onNames = onTypes.map((t) => t.label);
  const menuOpen = open && !typesOpen && opts.length > 0;

  const card = (i: FeedItem) => (
      <article key={i.id} className="card catch">
        <div className="bar" style={{ background: FAMILY_COLOR[i.family] }} />
        {i.image && !i.clip && <img className="catch-art" src={i.image} alt="" loading="lazy" width={56} height={56} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="catch-head">
            <span className="catch-kind" style={{ color: FAMILY_COLOR[i.family] }}>{highlight(i.kind, words)}</span>
            <b style={{ fontSize: 13 }}>{highlight(i.title, words)}</b>
            <span className="mono muted" style={{ fontSize: 11, marginLeft: 'auto' }}>{highlight(metaLine(i), words)}</span>
          </div>
          {i.body && !PLACEHOLDER.test(i.body) && (
            <div className={i.mono ? 'catch-body mono' : 'catch-body'} style={i.tag === 'Station message' ? { color: 'var(--muted)' } : undefined}>
              {i.tag && <span className="catch-tag">{i.tag}</span>}
              {highlight(i.body, words)}
            </div>
          )}
          {i.raw && (
            <details className="raw">
              <summary>Original message</summary>
              <code>{i.raw}</code>
            </details>
          )}
          {i.clip && Date.now() - i.ts < CLIP_RETENTION_MS && (
            <div className="clip-row">
              {i.image && <img className="clip-art" src={i.image} alt="" loading="lazy" width={52} height={52} />}
              <ClipPlayer src={i.clip} color={FAMILY_COLOR[i.family]} label={`${i.title} clip`} />
            </div>
          )}
          {i.clip && Date.now() - i.ts >= CLIP_RETENTION_MS && <span className="muted" style={{ fontSize: 12 }}>Clip expired (audio is kept for 24 hours)</span>}
        </div>
      </article>
  );

  return (
    <section className="feed" aria-label="Feed">
      <div className="fsearch" ref={root}>
        <div className="fsearch-box" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--muted)" strokeWidth="1.5" /><path d="M9.5 9.5 L13 13" stroke="var(--muted)" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <button
            type="button"
            className={offTypes.length ? 'ftoken ftypes on' : 'ftoken ftypes'}
            aria-haspopup="true"
            aria-expanded={typesOpen}
            onClick={() => { setTypesOpen(!typesOpen); setOpen(false); }}
          >
            {tokenLabel}
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-label="Search feed"
            aria-expanded={menuOpen}
            aria-controls="feed-suggest"
            aria-activedescendant={menuOpen && active >= 0 ? `feed-opt-${active}` : undefined}
            aria-autocomplete="list"
            placeholder="Search feed"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); setTypesOpen(false); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
          <span className="fsearch-count" aria-live="polite">{filtered ? `${shown.length} of ${items.length}` : items.length}</span>
          {filtered && <button type="button" className="fsearch-clear" aria-label="Clear search and show all types" onClick={clearAll}>✕</button>}
        </div>
        {typesOpen && (
          <div className="fmenu ftypes-menu" role="group" aria-label="Types to show">
            <label className="fcheck fcheck-all">
              <input
                type="checkbox"
                checked={offTypes.length === 0}
                ref={(el) => { if (el) el.indeterminate = offTypes.length > 0 && onTypes.length > 0; }}
                onChange={() => (offTypes.length === 0 ? setHidden(TYPES.map((t) => t.id)) : allOn())}
              />
              <b>All types</b>
              <span className="fsearch-count">{onTypes.length} of {listed.length}</span>
            </label>
            {FAMILY_ORDER.map((f) => {
              const rows = listed.filter((t) => t.family === f);
              if (rows.length === 0) return null;
              return (
                <div key={f} style={{ display: 'contents' }}>
                  <div className="fmenu-sect" style={{ color: FAMILY_COLOR[f] }}>{FAMILY_LABEL[f]}</div>
                  {rows.map((t) => {
                    const n = counts.get(t.id) ?? 0;
                    return (
                      <div key={t.id} className={n ? 'fcheck' : 'fcheck empty'}>
                        <label>
                          <input type="checkbox" checked={!hidden.includes(t.id)} onChange={() => toggle(t.id)} />
                          <span>{t.label}</span>
                        </label>
                        <button type="button" className="fonly" onClick={() => only(t.id)}>only</button>
                        <span className="fsearch-count">{n}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {menuOpen && (
          <div className="fmenu" id="feed-suggest" role="listbox" aria-label="Suggestions">
            <div className="fmenu-sect">Matches</div>
            {opts.map((o, idx) => (
              <div
                key={o.key}
                id={`feed-opt-${idx}`}
                role="option"
                aria-selected={idx === active}
                className={idx === active ? 'fopt active' : 'fopt'}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(idx)}
                onClick={() => pick(o)}
              >
                <span className="dot" style={{ background: FAMILY_COLOR[o.family] }} />
                <span>{highlight(o.title, words)} <span className="muted">· {o.kindLabel}</span></span>
                <span className="fsearch-count">{o.count}</span>
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
              : onTypes.length === 0
                ? 'Every type is unticked.'
                : words.length > 0
                  ? `Nothing matches “${query.trim()}”${offTypes.length ? ` in ${listJoin(onNames)}` : ''}.`
                  : `No ${listJoin(onNames)} in the last ${items.length} items.`}
            {filtered && <button type="button" className="empty-clear" onClick={clearAll}>Show everything</button>}
          </div>
        )}
        {bundleRows(shown).map((r) => (r.items.length === 1 ? card(r.items[0]) : <BundleCard key={r.key} items={r.items} />))}
      </div>
    </section>
  );
}
