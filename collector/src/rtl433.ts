// Classifies rtl_433 JSON events (published to MQTT with the events= option).

export type Rtl433Kind = 'tpms' | 'meter' | 'sensor';

export interface Rtl433Event {
  kind: Rtl433Kind;
  model: string;
  id: string;
  ts: number;
  freqMhz?: number;
  fields: Record<string, unknown>;
}

export function parseRtl433(raw: string): Rtl433Event | undefined {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const model = typeof e.model === 'string' ? e.model : undefined;
  if (!model) return undefined;
  const id = String(e.id ?? e.ert_id ?? e.ERTSerialNumber ?? e.channel ?? 'unknown');
  const type = typeof e.type === 'string' ? e.type : '';
  const kind: Rtl433Kind =
    type === 'TPMS' ? 'tpms' : /ERT|SCM|IDM|meter/i.test(model) || e.consumption_data !== undefined || e.Consumption !== undefined ? 'meter' : 'sensor';
  // Events arrive live over MQTT, so the receive time is accurate (rtl_433's own
  // timestamp is local time without a zone, which would be misread in a UTC container).
  const ts = Date.now();
  const freq = typeof e.freq === 'number' ? e.freq : typeof e.freq1 === 'number' ? e.freq1 : undefined;
  return { kind, model, id, ts, freqMhz: freq, fields: e };
}

/**
 * Security-system devices (door/window contacts, motion sensors, alarm keyfobs): their messages say when someone's
 * door opens, so they are counted but never shown, like pagers.
 */
export function isSecurityDevice(model: string, f: Record<string, unknown>): boolean {
  if (/\b(DSC|Interlogix|Honeywell|Ademco|2Gig|Visonic|Kerui|Chuango)\b|Security|Door|Window|Motion|Alarm|Contact|\bPIR\b/i.test(model)) return true;
  return ['closed', 'reed_open', 'contact_open', 'alarm', 'motion', 'tamper'].some((k) => k in f);
}

/** One-line human summary of a sensor's readings. */
export function describeSensor(f: Record<string, unknown>): string {
  const parts: string[] = [];
  const n = (k: string) => (typeof f[k] === 'number' ? (f[k] as number) : undefined);
  const tc = n('temperature_C');
  const tf = n('temperature_F') ?? (tc !== undefined ? tc * 1.8 + 32 : undefined);
  if (tf !== undefined) parts.push(`${tf.toFixed(0)}°F`);
  if (n('humidity') !== undefined) parts.push(`${n('humidity')}%`);
  const wind = n('wind_avg_mi_h') ?? (n('wind_avg_km_h') !== undefined ? n('wind_avg_km_h')! / 1.609 : undefined);
  if (wind !== undefined) parts.push(`${wind.toFixed(0)} mph wind`);
  if (n('rain_in') !== undefined) parts.push(`${n('rain_in')} in rain`);
  if (n('pressure_PSI') !== undefined) parts.push(`${n('pressure_PSI')!.toFixed(1)} PSI`);
  if (n('pressure_kPa') !== undefined && n('pressure_PSI') === undefined) parts.push(`${(n('pressure_kPa')! * 0.145).toFixed(1)} PSI`);
  if (typeof f.button === 'number' || typeof f.event === 'string') parts.push('button press');
  return parts.join(' · ') || 'signal received';
}
