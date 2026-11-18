import type { Aircraft, Home } from '../../shared/types.ts';

import { readFile, stat } from 'node:fs/promises';

/**
 * Reads aircraft from readsb's JSON output. Prefers JSON files written by the
 * lightweight readsb slot (`fileDir`), falling back to Ultrafeeder's HTTP endpoint.
 */
export class AdsbSource {
  aircraft: Aircraft[] = [];
  home?: Home;
  lastHeard?: number;
  lastError?: string;
  private lastMessages = -1;
  lastOk = 0;
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
      this.aircraft = d.aircraft
        .filter((a) => typeof a.seen === 'number' && (a.seen as number) < 60)
        .map(toAircraft)
        .map((a) => (a.distNm === undefined && this.home && a.lat !== undefined && a.lon !== undefined ? { ...a, distNm: distanceNm(this.home, a.lat, a.lon) } : a));
      // The counter resets whenever the readsb slot restarts, so any change (not just growth) means new data.
      if (d.messages > 0 && d.messages !== this.lastMessages && this.lastMessages >= 0) this.lastHeard = Date.now();
      this.lastMessages = d.messages;
      this.lastError = undefined;
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

function toAircraft(a: Record<string, unknown>): Aircraft {
  const flight = typeof a.flight === 'string' ? a.flight.trim() || undefined : undefined;
  return {
    hex: String(a.hex),
    flight,
    type: typeof a.t === 'string' ? a.t : undefined,
    altBaro: a.alt_baro === 'ground' ? 'ground' : num(a.alt_baro),
    baroRate: num(a.baro_rate),
    gs: num(a.gs),
    track: num(a.track),
    lat: num(a.lat),
    lon: num(a.lon),
    distNm: num(a.r_dst),
    rssi: num(a.rssi),
    seen: num(a.seen) ?? 0,
  };
}

/** Great-circle distance in nautical miles (readsb only computes it when given the receiver location). */
export function distanceNm(home: Home, lat: number, lon: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat - home.lat) * rad;
  const dLon = (lon - home.lon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(home.lat * rad) * Math.cos(lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}
