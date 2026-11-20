// Transmitter sites behind the frequencies Airwaves listens to, looked up once and bundled (no live lookups).
// FM: FCC FM Query licensed (LIC) records, NAD83, fetched 2026-11-20. Airports: published field coordinates.
// Potomac TRACON sector transmitters aren't published per frequency: those are rough, placed by sector name.

export interface SiteChannel {
  label: string;
  freqMhz?: number;
  source: string; // scheduler slot id that tunes this channel
  atc?: string; // rtl_airband channel template (clips carry it), for per-channel activity
  radio?: string; // HD Radio frequency, matches RadioStation.freq
}

export interface Site {
  id: string;
  name: string;
  kind: 'atc' | 'fm' | 'nws';
  lat: number;
  lon: number;
  approx?: boolean; // location is a rough guess
  note?: string;
  channels: SiteChannel[];
}

const fm = (label: string, freq: string): SiteChannel => ({ label, freqMhz: Number(freq), source: 'hdradio', radio: freq });
const atc = (label: string, freq: number, template: string): SiteChannel => ({ label, freqMhz: freq, source: 'atc', atc: template });

export const SITES: Site[] = [
  { id: 'dca', name: 'DCA Tower', kind: 'atc', lat: 38.8521, lon: -77.0377, channels: [atc('DCA Tower', 119.1, 'DCA_TWR')] },
  { id: 'bwi', name: 'BWI Tower', kind: 'atc', lat: 39.1754, lon: -76.6684, channels: [atc('BWI Tower', 119.4, 'BWI_TWR')] },
  { id: 'iad', name: 'IAD Tower', kind: 'atc', lat: 38.9445, lon: -77.4558, channels: [atc('IAD Tower East', 120.1, 'IAD_TWR_E'), atc('IAD Tower Center', 120.25, 'IAD_TWR_C')] },
  { id: 'pct-tyson', name: 'Potomac Departure (Tyson)', kind: 'atc', lat: 38.918, lon: -77.226, approx: true, note: 'Sector transmitter; location approximate.', channels: [atc('Potomac Departure', 118.95, 'DEP_TYSON')] },
  { id: 'pct-luray', name: 'Potomac Approach (Luray)', kind: 'atc', lat: 38.665, lon: -78.459, approx: true, note: 'Sector transmitter; location approximate.', channels: [atc('Potomac Approach', 118.675, 'APP_LURAY')] },
  { id: 'pct-ojaay', name: 'Potomac Approach (OJAAY)', kind: 'atc', lat: 38.744, lon: -77.672, approx: true, note: 'Shown at the Potomac TRACON in Warrenton; transmitter location unknown.', channels: [atc('Potomac Approach', 119.85, 'APP_OJAAY')] },
  { id: 'pct-bwi', name: 'Potomac Approach (BWI)', kind: 'atc', lat: 39.12, lon: -76.74, approx: true, note: 'Sector transmitter; location approximate.', channels: [atc('Potomac Approach (BWI)', 119.0, 'APP_BWI')] },
  { id: 'pct-iad', name: 'Potomac Approach (IAD West)', kind: 'atc', lat: 38.95, lon: -77.56, approx: true, note: 'Sector transmitter; location approximate.', channels: [atc('Potomac Approach (IAD)', 120.45, 'APP_IAD_W')] },
  { id: 'fm-wamu', name: 'WAMU', kind: 'fm', lat: 38.936222, lon: -77.092194, channels: [fm('WAMU', '88.5')] },
  { id: 'fm-wiad-wiht', name: 'WIAD · WIHT', kind: 'fm', lat: 38.963694, lon: -77.104694, note: 'Shared tower.', channels: [fm('WIAD', '94.7'), fm('WIHT (HOT)', '99.5')] },
  { id: 'fm-wpgc', name: 'WPGC', kind: 'fm', lat: 38.863722, lon: -76.910806, channels: [fm('WPGC', '95.5')] },
  { id: 'fm-wmzq-wbig', name: 'WMZQ · WBIG', kind: 'fm', lat: 38.887056, lon: -77.200528, note: 'Shared tower.', channels: [fm('WMZQ', '98.7'), fm('WBIG', '100.3')] },
  { id: 'fm-wwdc', name: 'WWDC (DC101)', kind: 'fm', lat: 38.999833, lon: -77.057194, channels: [fm('DC101', '101.1')] },
  { id: 'fm-wlno', name: 'WLNO', kind: 'fm', lat: 38.618833, lon: -76.843861, note: 'Licensed to Waldorf, MD.', channels: [fm('WLNO', '104.1')] },
  {
    id: 'nws-sterling',
    name: 'NWS Sterling',
    kind: 'nws',
    lat: 38.9763,
    lon: -77.4867,
    note: 'Weather balloons launch here twice a day (about 7 AM and 7 PM).',
    channels: [{ label: 'Weather balloons', freqMhz: 403, source: 'sonde' }],
  },
  {
    id: 'noaa-wx',
    name: 'NOAA Weather Radio',
    kind: 'nws',
    lat: 38.991617,
    lon: -77.029536,
    note: 'Downtown Silver Spring, MD.',
    channels: [{ label: 'NOAA Weather Radio', freqMhz: 162.45, source: 'noaa' }],
  },
];
