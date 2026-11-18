import type { Snapshot } from '../../../shared/types.ts';
import { ago } from '../live.ts';
import { FreshnessRing } from './FreshnessRing.tsx';

interface Tile {
  value?: number;
  label: string;
  color: string;
  sourceId: string;
}

// The ring empties over one rotation loop (about 19 minutes): full = just heard, empty = a loop or more ago.
const LOOP_MS = 19 * 60_000;

export function Totals({ snapshot }: { snapshot?: Snapshot }) {
  const t = snapshot?.totals;
  const now = snapshot?.now ?? Date.now();
  const source = (id: string) => snapshot?.sources.find((s) => s.id === id);
  const tiles: Tile[] = [
    { value: t?.aircraftToday, label: 'aircraft today', color: 'var(--air)', sourceId: 'adsb' },
    { value: t?.atcClipsToday, label: 'ATC transmissions', color: 'var(--air)', sourceId: 'atc' },
    { value: t?.datalinkToday, label: 'flights on datalink', color: 'var(--air)', sourceId: 'vdl2' },
    { value: t?.shipsToday, label: 'ships', color: 'var(--sea)', sourceId: 'ais' },
    { value: t?.tpmsPassersToday, label: `cars passed${t?.tpmsRegularsToday ? ` · ${t.tpmsRegularsToday} regulars` : ''}`, color: 'var(--home)', sourceId: 'ism' },
    { value: t?.metersToday, label: 'utility meters', color: 'var(--home)', sourceId: 'ism' },
  ];
  return (
    <section className="totals" aria-label="Today so far">
      {tiles.map((tile) => {
        const src = source(tile.sourceId);
        const off = !src?.running && !tile.value;
        const heard = src?.lastHeard;
        const live = snapshot?.rotation.current?.sourceId === tile.sourceId;
        return (
          <div key={tile.label} className="card total">
            <span className="v" style={{ color: off ? 'var(--muted)' : tile.color }}>{off || tile.value === undefined ? '—' : tile.value.toLocaleString('en-US')}</span>
            <span className="k">{tile.label}</span>
            <span className="fresh">
              {off ? (
                'not running yet'
              ) : live ? (
                <>
                  <span className="dot" style={{ background: 'var(--live)' }} />
                  listening now
                </>
              ) : (
                <>
                  <FreshnessRing fraction={heard ? 1 - (now - heard) / LOOP_MS : 0} color={tile.color} size={12} />
                  {heard ? `heard ${ago(heard, now)}` : 'not heard yet'}
                </>
              )}
            </span>
          </div>
        );
      })}
    </section>
  );
}
