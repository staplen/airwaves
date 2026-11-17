import type { Snapshot } from '../../../shared/types.ts';

interface Tile {
  value?: number;
  label: string;
  color: string;
  sourceId: string;
}

export function Totals({ snapshot }: { snapshot?: Snapshot }) {
  const t = snapshot?.totals;
  const running = new Set(snapshot?.sources.filter((s) => s.running).map((s) => s.id));
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
        const off = !running.has(tile.sourceId) && !tile.value;
        return (
          <div key={tile.label} className="card total">
            <span className="v" style={{ color: off ? 'var(--muted)' : tile.color }}>{off || tile.value === undefined ? '—' : tile.value.toLocaleString('en-US')}</span>
            <span className="k">{tile.label}{off ? ' · not running yet' : ''}</span>
          </div>
        );
      })}
    </section>
  );
}
