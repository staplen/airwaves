import type { Aircraft, Home } from '../../shared/types.ts';

import { readFile, stat } from 'node:fs/promises';

/**
 * Reads aircraft from readsb's JSON output. Prefers JSON files written by the
 * lightweight readsb slot (`fileDir`), falling back to Ultrafeeder's HTTP endpoint.
 */
export class AdsbSource {
  aircraft: Aircraft[] = [];
  raw: Record<string, unknown>[] = []; // readsb's aircraft objects from the last poll, unmodified
  home?: Home;
  lastHeard?: number;
  lastError?: string;
  private lastMessages = -1;
  lastOk = 0;
  okSince = 0; // when the current unbroken run of successful polls began
  keepOnFailure = false;
  private baseUrl: string;
  private fileDir?: string;

  constructor(baseUrl: string, fileDir?: string) {
    this.baseUrl = baseUrl;
    this.fileDir = fileDir;
  }

  /** Reads a readsb JSON document from the slot's files if they're fresh, else over HTTP. */
  private async readJson(name: string): Promise<unknown> {
    if (this.fileDir) {
      try {
        const path = `${this.fileDir}/${name}`;
        if (Date.now() - (await stat(path)).mtimeMs < 10_000) return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        /* no fresh file: fall through to HTTP */
      }
    }
    const r = await fetch(`${this.baseUrl}/${name}`, { signal: AbortSignal.timeout(5000) });
    return r.json();
  }

  async loadReceiver(): Promise<void> {
    const d = (await this.readJson('receiver.json')) as { lat?: number; lon?: number };
    if (typeof d.lat === 'number' && typeof d.lon === 'number') this.home = { lat: d.lat, lon: d.lon };
  }

  /** Fetches the current aircraft list. Returns true on success. */
  async poll(): Promise<boolean> {
    try {
      const d = (await this.readJson('aircraft.json')) as { now: number; messages: number; aircraft: Record<string, unknown>[] };
      this.raw = d.aircraft;
      this.aircraft = d.aircraft
        .filter((a) => typeof a.seen === 'number' && (a.seen as number) < 60)
        .map(toAircraft);
      // The counter resets whenever the readsb slot restarts, so any change (not just growth) means new data.
      if (d.messages > 0 && d.messages !== this.lastMessages && this.lastMessages >= 0) this.lastHeard = Date.now();
      this.lastMessages = d.messages;
      this.lastError = undefined;
      if (Date.now() - this.lastOk > 6000) this.okSince = Date.now(); // a new run of fresh data (e.g. the ADS-B slot just started)
      this.lastOk = Date.now();
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      // Don't keep showing old positions once the receiver has been gone for a minute,
      // unless ADS-B is rotating, where gaps are expected and the last pass stays on the map.
      if (!this.keepOnFailure && Date.now() - this.lastOk > 60_000) this.aircraft = [];
      return false;
    }
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
/** "BOEING 737-800" → "Boeing 737-800" (the database shouts); words with digits keep their case ("UH-60", "A-321"). */
const titleCase = (s: string | undefined) =>
  s
    ?.split(' ')
    .map((w) => (/\d/.test(w) ? w : w.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())))
    .join(' ').replace(/\b(Ii|Iii|Iv|Er|Lr|Xwb|Max|Neo)\b/g, (w) => w.toUpperCase());

export function toAircraft(a: Record<string, unknown>): Aircraft {
  const flight = text(a.flight);
  const emergency = text(a.emergency);
  const dbFlags = num(a.dbFlags) ?? 0;
  return {
    hex: String(a.hex),
    flight,
    type: text(a.t),
    reg: text(a.r),
    typeDesc: titleCase(text(a.desc)),
    owner: titleCase(text(a.ownOp)),
    military: (dbFlags & 1) === 1 || undefined,
    category: text(a.category),
    squawk: text(a.squawk),
    emergency: emergency && emergency !== 'none' ? emergency : undefined,
    selAltFt: num(a.nav_altitude_mcp) ?? num(a.nav_altitude_fms),
    altBaro: a.alt_baro === 'ground' ? 'ground' : num(a.alt_baro),
    baroRate: num(a.baro_rate),
    gs: num(a.gs),
    track: num(a.track),
    lat: num(a.lat),
    lon: num(a.lon),
    rssi: num(a.rssi),
    seen: num(a.seen) ?? 0,
  };
}
