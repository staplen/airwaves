import type { Snapshot } from '../../../shared/types.ts';
import { FAMILY_COLOR } from '../bands.ts';
import { SOURCE_TYPES, showOnlySource } from '../feedFilter.ts';
import { SWITCH_GAP_MS, slotName } from '../live.ts';

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
  // Between one slot ending and the next starting: shimmer on the finishing tile, pulse on the next.
  const switching = rot?.mode === 'rotating' && !!cur?.endsAt && now >= cur.endsAt && now < cur.endsAt + SWITCH_GAP_MS * 2;
  const nextId = loop.length && idx >= 0 ? loop[(idx + 1) % loop.length]?.sourceId : undefined;
  const left = cur?.endsAt ? Math.max(0, (cur.endsAt - now) / 1000) : 0;
  const progress = cur?.endsAt ? Math.min(1, Math.max(0, (now - cur.since) / (cur.endsAt - cur.since))) : 1;

  return (
    <section className="loopband" aria-label="What the radio is listening to, and what it has heard today">
      {ids.map((id) => {
        const so = snapshot?.sources.find((s) => s.id === id);
        const name = so?.name ?? slotName(id);
        const color = so ? FAMILY_COLOR[so.family] : 'var(--muted)';
        const stat = snapshot?.slotStats?.[id];
        const active = cur?.sourceId === id;
        const when = active ? (rot?.mode === 'continuous' ? 'listening' : `${clock(left)} left`) : '';
        const quiet = !active && (stat?.value === '0' || stat?.value === undefined) && id !== 'spectrum';
        const clickable = !!SOURCE_TYPES[id];
        return (
          <div
            key={id}
            className={`lt${active ? ' now' : ''}${active && switching ? ' switching-out' : ''}${!active && switching && id === nextId ? ' next' : ''}${quiet ? ' quiet' : ''}${clickable ? ' click' : ''}`}
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
              {(stat?.value !== undefined || !stat) && <span className="v">{stat?.value ?? '—'}</span>}
              <span className="k">{active ? stat?.label : stat?.short ?? stat?.label}</span>
            </div>
            <div className="lt-detail">{(active ? stat?.detail : stat?.brief ?? stat?.detail) ?? '\u00a0'}</div>
            {active && (
              <div className="lt-when">
                {switching ? (
                  <span className="switching" role="status">
                    switching<span className="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
                  </span>
                ) : (
                  when
                )}
              </div>
            )}
            {active && cur?.endsAt && <div className="lt-prog" style={{ width: `${progress * 100}%` }} />}
          </div>
        );
      })}
    </section>
  );
}
