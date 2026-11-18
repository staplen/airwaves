import type { Snapshot } from '../../../shared/types.ts';
import { FAMILY_COLOR } from '../bands.ts';
import { SOURCE_TYPES, showOnlySource } from '../feedFilter.ts';
import { slotName } from '../live.ts';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.round(s % 60))).padStart(2, '0')}`;

/**
 * The header loop and the stats in one band: one tile per slot, in loop order. The slot on air grows
 * into a larger card with the frequency, countdown and progress; the others show today's number, one
 * line worth reading, and when they're next on air. Clicking a tile filters the feed to that source.
 */
export function LoopBand({ snapshot }: { snapshot?: Snapshot }) {
  const rot = snapshot?.rotation;
  const now = snapshot?.now ?? Date.now();
  const cur = rot?.current;
  const loop = rot?.mode === 'rotating' ? rot.loop ?? [] : [];
  const idx = rot?.index ?? -1;
  const ids = rot?.slots?.length ? rot.slots : [...new Set(loop.map((l) => l.sourceId))];
  if (ids.length === 0 && cur) ids.push(cur.sourceId);
  const switching = rot?.mode === 'rotating' && !!cur?.endsAt && now >= cur.endsAt;
  const left = cur?.endsAt ? Math.max(0, (cur.endsAt - now) / 1000) : 0;
  const progress = cur?.endsAt ? Math.min(1, Math.max(0, (now - cur.since) / (cur.endsAt - cur.since))) : 1;

  /** Seconds until this slot is next on air in the current loop, or undefined if it isn't in it. */
  const nextIn = (id: string): number | undefined => {
    if (idx < 0 || loop.length === 0) return undefined;
    let t = left;
    for (let k = 1; k <= loop.length; k++) {
      const e = loop[(idx + k) % loop.length];
      if (e.sourceId === id) return t;
      t += e.minutes * 60;
    }
    return undefined;
  };

  return (
    <section className="loopband" aria-label="What the radio is listening to, and what it has heard today">
      {ids.map((id) => {
        const so = snapshot?.sources.find((s) => s.id === id);
        const name = so?.name ?? slotName(id);
        const color = so ? FAMILY_COLOR[so.family] : 'var(--muted)';
        const stat = snapshot?.slotStats?.[id];
        const active = cur?.sourceId === id;
        const n = active ? undefined : nextIn(id);
        const when = active
          ? rot?.mode === 'continuous' ? 'listening' : switching ? 'switching…' : `${clock(left)} left`
          : n !== undefined ? `next in ${clock(n)}` : id === 'spectrum' ? 'hourly' : id === 'sonde' ? 'launch windows' : 'not in this loop';
        const quiet = !active && (stat?.value === '0' || stat?.value === undefined) && id !== 'spectrum';
        const clickable = !!SOURCE_TYPES[id];
        return (
          <div
            key={id}
            className={`lt${active ? ' now' : ''}${quiet ? ' quiet' : ''}${clickable ? ' click' : ''}`}
            style={{ ['--c' as string]: color }}
            title={clickable ? `Show only ${name} in the feed` : name}
            {...(clickable && {
              role: 'button',
              tabIndex: 0,
              onClick: () => showOnlySource(id),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  showOnlySource(id);
                }
              },
            })}
          >
            <div className="lt-head">
              <span className="lt-name">{name}</span>
              {active && (
                <span className="lt-live">
                  <span className="dot" style={{ background: 'var(--live)' }} />
                  on air
                </span>
              )}
              {active && cur && <span className="lt-freq">{cur.freqMhz.toFixed(3)} <small>MHz</small></span>}
            </div>
            <div className="lt-val">
              <span className="v">{stat?.value ?? '—'}</span>
              <span className="k">{stat?.label ?? ''}</span>
            </div>
            <div className="lt-detail">{stat?.detail ?? ' '}</div>
            <div className={`lt-when${switching && active ? ' switching' : ''}`}>{when}</div>
            {active && cur?.endsAt && <div className="lt-prog" style={{ width: `${progress * 100}%` }} />}
          </div>
        );
      })}
    </section>
  );
}
