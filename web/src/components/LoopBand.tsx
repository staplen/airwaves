import type { ReactNode } from 'react';
import type { Family, Snapshot } from '../../../shared/types.ts';
import { FAMILY_COLOR, FAMILY_LABEL } from '../bands.ts';
import { SOURCE_TYPES, showOnlySource, showOnlyTypes } from '../feedFilter.ts';
import { SWITCH_GAP_MS, slotName } from '../live.ts';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.round(s % 60))).padStart(2, '0')}`;
const FAMILY_ORDER: Family[] = ['air', 'sea', 'home', 'rail', 'wx', 'bcast', 'ham'];

// Slots whose family the collector doesn't list (shouldn't happen, but keep them visible).
const FALLBACK_FAMILY: Record<string, Family> = { trains: 'rail', rail: 'rail', aprs: 'ham', survey: 'bcast', spectrum: 'bcast', acars: 'air', uat: 'air' };

/**
 * The header: the Airwaves mark with one chip per family that isn't on air (its headline number), then the family
 * on air opened into a card: the frequency, the slot and its countdown, every slot of that family with today's
 * number, and what's up next. Chips and slot tiles filter the feed.
 */
export function LoopBand({ snapshot, start, end, part }: { snapshot?: Snapshot; start?: ReactNode; end?: ReactNode; part: 'head' | 'onair' }) {
  const rot = snapshot?.rotation;
  const now = snapshot?.now ?? Date.now();
  const cur = rot?.current;
  const loop = rot?.mode === 'rotating' ? rot.loop ?? [] : [];
  const idx = rot?.index ?? -1;
  const ids = rot?.slots?.length ? rot.slots : [...new Set(loop.map((l) => l.sourceId))];
  if (ids.length === 0 && cur) ids.push(cur.sourceId);
  const familyOf = (id: string): Family => snapshot?.sources.find((s) => s.id === id)?.family ?? FALLBACK_FAMILY[id] ?? 'bcast';
  const nameOf = (id: string) => rot?.names?.[id] ?? snapshot?.sources.find((s) => s.id === id)?.name ?? slotName(id);
  const isBeta = (id: string) => rot?.beta?.includes(id) ?? false;
  const stat = (id: string) => snapshot?.slotStats?.[id];

  const switching = rot?.mode === 'rotating' && !!cur?.endsAt && now >= cur.endsAt && now < cur.endsAt + SWITCH_GAP_MS * 2;
  const left = cur?.endsAt ? Math.max(0, (cur.endsAt - now) / 1000) : 0;
  const progress = cur?.endsAt ? Math.min(1, Math.max(0, (now - cur.since) / (cur.endsAt - cur.since))) : 1;
  const onFamily = cur ? familyOf(cur.sourceId) : undefined;

  const families = FAMILY_ORDER.map((f) => ({ f, slots: ids.filter((id) => familyOf(id) === f) })).filter((x) => x.slots.length);
  const typesOf = (slots: string[]) => [...new Set(slots.flatMap((id) => SOURCE_TYPES[id] ?? []))];

  const chip = (f: Family, slots: string[]) => {
    const head = slots.map(stat).find((s) => s?.value !== undefined && s.value !== '');
    const types = typesOf(slots);
    const label = `${FAMILY_LABEL[f]}: ${slots.map((id) => `${nameOf(id)} ${stat(id)?.value ?? '—'}`).join(', ')}`;
    return (
      <button key={f} type="button" className="fam" style={{ ['--c' as string]: FAMILY_COLOR[f] }} title={types.length ? `${label}. Show only these in the feed` : label} aria-label={label} onClick={() => types.length && showOnlyTypes(types)}>
        <span className="dot" aria-hidden="true" />
        {FAMILY_LABEL[f]}
        {head && <span className="n">{head.value}</span>}
        {slots.some(isBeta) && <span className="beta" aria-hidden="true">β</span>}
      </button>
    );
  };

  const onSlots = onFamily ? families.find((x) => x.f === onFamily)?.slots ?? [] : [];
  const color = onFamily ? FAMILY_COLOR[onFamily] : 'var(--muted)';

  if (part === 'head')
    return (
      <header className="lb-head" aria-label="Airwaves, and what each family of signals has heard today">
        {start}
        <div className="lb-chips">{families.filter((x) => x.f !== onFamily).map((x) => chip(x.f, x.slots))}</div>
        {end}
      </header>
    );
  if (!cur) return null;
  return (
    <section className={`onair${switching ? ' switching-out' : ''}`} style={{ ['--c' as string]: color }} aria-label="What the radio is listening to now">
          <div className="onair-top">
            <span className="onair-freq">{cur.freqMhz.toFixed(3)}</span>
            <span className="muted">MHz</span>
            <span className="onair-chip">
              <span className="dot" style={{ background: 'var(--live)' }} aria-hidden="true" />
              {nameOf(cur.sourceId)}
              {isBeta(cur.sourceId) && <span className="beta">beta</span>}
              <span className="muted">
                ·{' '}
                {switching ? (
                  <span className="switching" role="status">
                    switching<span className="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
                  </span>
                ) : rot?.mode === 'continuous' ? (
                  'listening'
                ) : (
                  `${clock(left)} left`
                )}
              </span>
            </span>
          </div>
          <div className="onair-slots">
            {onSlots.map((id) => {
              const s = stat(id);
              const active = id === cur.sourceId;
              const beta = isBeta(id);
              const clickable = !beta && !!SOURCE_TYPES[id];
              const body = (
                <>
                  <span className="k">
                    {nameOf(id)}
                    {beta ? ' · beta' : ''}
                  </span>
                  <span className="v">{s?.value ?? '—'}</span>
                  <span className="d">{active ? s?.detail ?? s?.label ?? 'on air' : s?.brief ?? s?.short ?? s?.label ?? ' '}</span>
                </>
              );
              const cls = `slot${active ? ' now' : ''}${beta ? ' is-beta' : ''}`;
              return clickable ? (
                <button key={id} type="button" className={cls} onClick={() => showOnlySource(id)} title={`Show only ${nameOf(id)} in the feed`}>
                  {body}
                </button>
              ) : (
                <div key={id} className={cls} title={beta ? `${nameOf(id)} (beta): scanning to learn what's here; not decoded into the feed or map yet` : nameOf(id)}>
                  {body}
                </div>
              );
            })}
          </div>
          {cur.endsAt && <div className="onair-prog" style={{ width: `${progress * 100}%` }} />}
    </section>
  );
}
