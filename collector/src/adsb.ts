import type { Aircraft, Home } from '../../shared/types.ts';

/** Reads aircraft from readsb's JSON output (served by the ultrafeeder container). */
export class AdsbSource {
  aircraft: Aircraft[] = [];
  home?: Home;
  lastHeard?: number;
  lastError?: string;
  private lastMessages = -1;
  lastOk = 0;
  keepOnFailure = false;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async loadReceiver(): Promise<void> {
    const r = await fetch(`${this.baseUrl}/receiver.json`, { signal: AbortSignal.timeout(5000) });
    const d = (await r.json()) as { lat?: number; lon?: number };
    if (typeof d.lat === 'number' && typeof d.lon === 'number') this.home = { lat: d.lat, lon: d.lon };
  }

  /** Fetches the current aircraft list. Returns true on success. */
  async poll(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/aircraft.json`, { signal: AbortSignal.timeout(5000) });
      const d = (await r.json()) as { now: number; messages: number; aircraft: Record<string, unknown>[] };
      this.aircraft = d.aircraft
        .filter((a) => typeof a.seen === 'number' && (a.seen as number) < 60)
        .map(toAircraft);
      if (d.messages > this.lastMessages && this.lastMessages >= 0) this.lastHeard = Date.now();
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
