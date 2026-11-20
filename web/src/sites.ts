import type { Snapshot } from '../../shared/types.ts';
import { SITES, type Site } from '../../shared/sites.ts';

export const SITE_COLORS: Record<Site['kind'] | 'ais', string> = { atc: '#8fb8ff', fm: '#e58bf0', nws: '#f5b547', ais: '#3cc9b4' };
const ATC_HOT_MS = 90_000; // a clip on the channel this recently
const RADIO_HOT_MS = 150_000; // HD logs are read up to a minute after the sweep

/** Which sites are on air right now: the dongle is tuned to one of their channels, or one just produced data. */
export function sitesFC(snap: Snapshot | undefined): GeoJSON.FeatureCollection {
  const now = snap?.now ?? Date.now();
  const cur = snap?.rotation.current;
  const tuned = cur && (!cur.endsAt || cur.endsAt > now - 5_000) ? cur.sourceId : snap?.rotation.mode === 'continuous' ? 'adsb' : undefined;
  const radio = new Map((snap?.radio ?? []).map((r) => [r.freq, r.updatedAt]));
  const features: GeoJSON.Feature[] = SITES.map((s) => {
    const live = s.channels.map((c) => {
      const recent =
        (c.atc !== undefined && now - (snap?.atcHeard?.[c.atc] ?? 0) < ATC_HOT_MS) || (c.radio !== undefined && now - (radio.get(c.radio) ?? 0) < RADIO_HOT_MS);
      return { c, on: tuned === c.source || recent };
    });
    const on = live.some((l) => l.on);
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        id: s.id,
        name: s.name,
        kind: s.kind,
        color: SITE_COLORS[s.kind],
        on,
        label: on ? s.name : '',
        note: s.note ?? '',
        approx: Boolean(s.approx),
        channels: JSON.stringify(live.map((l) => ({ label: l.c.label, freq: l.c.freqMhz, on: l.on }))),
      },
    };
  });
  // AIS base stations come from our own data; they already have an icon, so only their pulse is added here.
  for (const f of snap?.aisFixed ?? []) {
    if (f.kind !== 'base' || f.lat === undefined || f.lon === undefined) continue;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lon, f.lat] }, properties: { kind: 'ais', color: SITE_COLORS.ais, on: tuned === 'ais', pulseOnly: true } });
  }
  return { type: 'FeatureCollection', features };
}
