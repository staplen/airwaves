// Parses SAME alert headers printed by multimon-ng, e.g.
// "EAS: ZCZC-WXR-RWT-011001-024031+0030-3211500-KHB36   -"

const EVENTS: Record<string, string> = {
  RWT: 'Required weekly test',
  RMT: 'Required monthly test',
  TOR: 'Tornado warning',
  TOA: 'Tornado watch',
  SVR: 'Severe thunderstorm warning',
  SVA: 'Severe thunderstorm watch',
  SVS: 'Severe weather statement',
  FFW: 'Flash flood warning',
  FFA: 'Flash flood watch',
  FLW: 'Flood warning',
  FLA: 'Flood watch',
  WSW: 'Winter storm warning',
  WSA: 'Winter storm watch',
  BZW: 'Blizzard warning',
  HUW: 'Hurricane warning',
  HUA: 'Hurricane watch',
  TRW: 'Tropical storm warning',
  HWW: 'High wind warning',
  SPS: 'Special weather statement',
  EWW: 'Extreme wind warning',
  CEM: 'Civil emergency message',
  EAN: 'National emergency',
};

export interface SameAlert {
  event: string;
  code: string;
  areas: string[];
  durationMin: number;
  station: string;
  test: boolean;
}

export function parseSame(line: string): SameAlert | undefined {
  const m = line.match(/ZCZC-([A-Z]{3})-([A-Z]{3})-([\d-]+)\+(\d{4})-(\d{7})-([^-]+)-/);
  if (!m) return undefined;
  const [, , code, areas, dur, , station] = m;
  return {
    code,
    event: EVENTS[code] ?? `Alert (${code})`,
    areas: areas.split('-').filter(Boolean),
    durationMin: Number(dur.slice(0, 2)) * 60 + Number(dur.slice(2)),
    station: station.trim(),
    test: code === 'RWT' || code === 'RMT',
  };
}
