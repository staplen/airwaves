import type { ReactNode } from 'react';
import type { Family, Snapshot } from '../../../shared/types.ts';
import { FAMILY_COLOR, FAMILY_LABEL } from '../bands.ts';
import { SOURCE_TYPES, showOnlySource, showOnlyTypes } from '../feedFilter.ts';
import { SWITCH_GAP_MS, slotName } from '../live.ts';
import { familyStriation, useSpectrum } from '../spectrum.ts';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.round(s % 60))).padStart(2, '0')}`;
const FAMILY_ORDER: Family[] = ['air', 'sea', 'home', 'rail', 'wx', 'bcast', 'ham'];
// Slots whose family the collector doesn't list (shouldn't happen, but keep them visible).
const FALLBACK_FAMILY: Record<string, Family> = { trains: 'rail', rail: 'rail', aprs: 'ham', survey: 'bcast', spectrum: 'bcast', acars: 'air', uat: 'air' };

interface FamilyBand {
  f: Family;
  slots: string[];
  minutes: number;
  until: number; // minutes until it next comes on (Infinity: not in this pass)
  since: number; // minutes since it last went off
}

/**
 * The footer: the family on air opened into a card in the middle (frequency, countdown, each of its slots), the
 * families heard most recently to its left and the ones coming up to its right, each a bar textured with its last
 * 24 hours of spectrum activity. Bars and slots filter the feed.
 */
export function Scanner({ snapshot, connected, status, dialOpen, onToggleDial, end }: {
  snapshot?: Snapshot;
  connected: boolean;
  status?: string; // "Reconnecting…", "Updated 4 min ago"
  dialOpen: boolean;
  onToggleDial: () => void;
  end?: ReactNode;
}) {
  const heat = useSpectrum();
  const rot = snapshot?.rotation;
  const now = snapshot?.now ?? Date.now();
  const cur = rot?.current;
  const loop = rot?.mode === 'rotating' ? rot.loop ?? [] : [];
  const idx = rot?.index ?? -1;
  const ids = rot?.slots?.length ? [...rot.slots] : [...new Set(loop.map((l) => l.sourceId))];
  if (ids.length === 0 && cur) ids.push(cur.sourceId);
  const familyOf = (id: string): Family => snapshot?.sources.find((s) => s.id === id)?.family ?? FALLBACK_FAMILY[id] ?? 'bcast';
  const nameOf = (id: string) => rot?.names?.[id] ?? snapshot?.sources.find((s) => s.id === id)?.name ?? slotName(id);
  const isBeta = (id: string) => rot?.beta?.includes(id) ?? false;
  const stat = (id: string) => snapshot?.slotStats?.[id];
  const typesOf = (slots: string[]) => [...new Set(slots.flatMap((id) => SOURCE_TYPES[id] ?? []))];

  const onFamily = cur ? familyOf(cur.sourceId) : undefined;
  const switching = rot?.mode === 'rotating' && !!cur?.endsAt && now >= cur.endsAt && now < cur.endsAt + SWITCH_GAP_MS * 2;
  const left = cur?.endsAt ? Math.max(0, (cur.endsAt - now) / 1000) : 0;
  const progress = cur?.endsAt ? Math.min(1, Math.max(0, (now - cur.since) / (cur.endsAt - cur.since))) : 1;

  // Where each family sits in the loop relative to the running slot: minutes until its next turn and since its last.
  const bands: FamilyBand[] = FAMILY_ORDER.map((f) => {
    const slots = ids.filter((id) => familyOf(id) === f);
    let minutes = 0;
    let until = Infinity;
    let since = Infinity;
    if (loop.length && idx >= 0) {
      for (const e of loop) if (familyOf(e.sourceId) === f) minutes += e.minutes;
      let acc = 0;
      for (let k = 1; k < loop.length; k++) {
        const e = loop[(idx + k) % loop.length];
        if (familyOf(e.sourceId) === f) { until = acc; break; }
        acc += e.minutes;
      }
      acc = 0;
      for (let k = 1; k < loop.length; k++) {
        const e = loop[(idx - k + loop.length) % loop.length];
        if (familyOf(e.sourceId) === f) { since = acc; break; }
        acc += e.minutes;
      }
    }
    return { f, slots, minutes, until, since };
  }).filter((b) => b.slots.length && b.f !== onFamily);
  const past = bands.filter((b) => b.since < b.until).sort((a, b) => b.since - a.since);
  const next = bands.filter((b) => !(b.since < b.until)).sort((a, b) => a.until - b.until);

  const onSlots = onFamily ? ids.filter((id) => familyOf(id) === onFamily) : [];
  const onColor = onFamily ? FAMILY_COLOR[onFamily] : 'var(--muted)';
  // The family's slots in loop order, each as wide as its minutes in this pass (a slot outside its time window still
  // gets a sliver so it's listed); curIdx is the running one.
  const slotMinutes = onSlots.map((id) => Math.max(0.4, loop.filter((e) => e.sourceId === id).reduce((a, e) => a + e.minutes, 0) || 0.4));
  // Each column is at least as wide as its own label, with the space left over shared out by minutes; the countdown
  // segments sit in the same grid (second row) so they always line up with the names.
  const slotCols = slotMinutes.map((m) => `minmax(max-content, ${m}fr)`).join(' ');
  const curIdx = cur ? onSlots.indexOf(cur.sourceId) : -1;

  const bar = (b: FamilyBand, side: 'past' | 'next') => {
    const head = b.slots.map(stat).find((s) => s?.value !== undefined && s.value !== '');
    const types = typesOf(b.slots);
    const texture = familyStriation(heat, b.f, b.slots, now);
    const label = `${FAMILY_LABEL[b.f]}: ${b.slots.map((id) => `${nameOf(id)} ${stat(id)?.value ?? '—'}`).join(', ')}`;
    return (
      <button
        key={b.f}
        type="button"
        className={`sc-fam ${side}`}
        style={{ ['--c' as string]: FAMILY_COLOR[b.f], flex: `${Math.max(0.8, b.minutes || 1)} 1 0` }}
        title={`${label}${texture ? '. Bar: last 24 h of activity on these frequencies, oldest on the left' : ''}${types.length ? '. Click to show only these in the feed' : ''}`}
        aria-label={label}
        onClick={() => types.length && showOnlyTypes(types)}
      >
        <span className="sc-name">{FAMILY_LABEL[b.f]}</span>
        <span className="sc-bar" style={texture ? { backgroundImage: texture } : undefined} />
        <span className="sc-sub mono">{head ? `${head.value} ${head.short ?? head.label}` : b.slots.map(nameOf).join(' · ')}</span>
      </button>
    );
  };

  return (
    <footer className="scanner" aria-label="Receiver: what each family of signals has heard today">
      <div className="sc-side sc-past">{past.map((b) => bar(b, 'past'))}</div>

      <section className={`sc-onair${switching ? ' switching-out' : ''}`} style={{ ['--c' as string]: onColor }} aria-label="What the radio is listening to now">
        <div className="sc-top">
          <span className="sc-live" style={{ background: connected ? 'var(--live)' : 'var(--muted)' }} aria-label={connected ? 'Live' : 'Reconnecting'} role="img" />
          {onFamily && <span className="sc-fname">{FAMILY_LABEL[onFamily]}</span>}
          {cur ? (
            <>
              <span className="sc-freq mono">{cur.freqMhz.toFixed(3)}</span>
              <span className="muted sc-slot">
                MHz · {nameOf(cur.sourceId)}
                {isBeta(cur.sourceId) && <span className="beta">beta</span>}
              </span>
            </>
          ) : (
            <span className="muted">Starting up…</span>
          )}
          <span className="sc-left mono">
            {status ? (
              status
            ) : switching ? (
              <span className="switching" role="status">switching<span className="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></span>
            ) : rot?.mode === 'continuous' ? (
              'listening'
            ) : cur?.endsAt ? (
              `${clock(left)} left`
            ) : null}
          </span>
        </div>
        {onSlots.length > 0 && (
          <div className="sc-slots" style={{ gridTemplateColumns: slotCols }}>
            {onSlots.map((id) => {
              const s = stat(id);
              const active = id === cur?.sourceId;
              const beta = isBeta(id);
              const clickable = !beta && !!SOURCE_TYPES[id];
              const inner = (
                <span className="sc-srow">
                  <span className="sc-sname">{nameOf(id)}</span>
                  {beta && <span className="beta" aria-label="beta">β</span>}
                  <b className="mono">{s?.value ?? '—'}</b>
                </span>
              );
              const title = beta
                ? `${nameOf(id)} (beta): scanning to learn what's here; not decoded into the feed or map yet`
                : `${nameOf(id)}${s?.detail ? `: ${s.detail}` : ''}${clickable ? '. Click to show only this in the feed' : ''}`;
              return clickable ? (
                <button key={id} type="button" className={`sc-s${active ? ' now' : ''}`} title={title} onClick={() => showOnlySource(id)}>{inner}</button>
              ) : (
                <div key={id} className={`sc-s${active ? ' now' : ''}`} title={title}>{inner}</div>
              );
            })}
            {/* One countdown along the card's bottom edge, split into the family's slots: played ones dim, the running
                one filling, the rest still to come. */}
            {onSlots.map((id, k) => {
              const state = k < curIdx ? 'done' : k === curIdx ? 'now' : 'todo';
              return (
                <span key={`seg-${id}`} className={`sc-seg ${state}`} style={{ gridColumn: k + 1 }} aria-hidden="true">
                  {state === 'now' && <i style={{ width: `${(rot?.mode === 'rotating' && cur?.endsAt ? progress : 1) * 100}%` }} />}
                </span>
              );
            })}
          </div>
        )}
      </section>

      <div className="sc-side sc-next">{next.map((b) => bar(b, 'next'))}</div>

      <div className="sc-end">
        <button type="button" className="strip-toggle" aria-expanded={dialOpen} aria-label={dialOpen ? 'Hide receiver dial and spectrum' : 'Show receiver dial and spectrum'} title="Receiver dial and spectrum" onClick={onToggleDial}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ transform: dialOpen ? 'rotate(180deg)' : undefined }}>
            <path d="M3 9 L7 5 L11 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {end}
      </div>
    </footer>
  );
}
