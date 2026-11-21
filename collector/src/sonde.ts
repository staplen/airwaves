import type { Balloon } from '../../shared/types.ts';

// radiosonde_auto_rx "payload summary" UDP packets (JSON), one per decoded frame.
// Fields used: callsign (serial), latitude, longitude, altitude (m), vel_v and vel_h (m/s), speed (km/h), heading,
// temp (°C), humidity (%; -1 when not measured), sats, batt (V), snr, frame (seconds since power-on), model, freq.
// RS41s carry no pressure sensor, so `pressure` is always -1.

export interface SondeEvent {
  kind: 'detected' | 'burst' | 'progress' | 'update';
  balloon: Balloon;
}

const MAX_TRACK = 600;
const PROGRESS_EVERY_MS = 20 * 60_000; // a mid-flight card at most this often

export class SondeTracker {
  flights = new Map<string, Balloon>();

  /** Feeds one packet; returns a noteworthy event (first sighting, burst) or a plain update. */
  push(raw: string, now = Date.now()): SondeEvent | undefined {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (p.type !== undefined && p.type !== 'PAYLOAD_SUMMARY') return undefined;
    const id = typeof p.callsign === 'string' ? p.callsign.trim() : '';
    const lat = Number(p.latitude);
    const lon = Number(p.longitude);
    const alt = Number(p.altitude);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt) || (lat === 0 && lon === 0)) return undefined;
    const freq = typeof p.freq === 'string' ? Number.parseFloat(p.freq) : typeof p.freq === 'number' ? p.freq : undefined;
    const vert = Number.isFinite(Number(p.vel_v)) ? Number(p.vel_v) : undefined;
    const num = (k: string, ok: (v: number) => boolean) => (typeof p[k] === 'number' && Number.isFinite(p[k]) && ok(p[k] as number) ? (p[k] as number) : undefined);
    const readings = {
      tempC: num('temp', (v) => v > -150 && v < 60),
      humidity: num('humidity', (v) => v >= 0 && v <= 100),
      speedKmh: num('speed', (v) => v >= 0 && v < 1000),
      heading: num('heading', (v) => v >= 0 && v <= 360),
      sats: num('sats', (v) => v >= 0 && v < 50),
      battV: num('batt', (v) => v > 0 && v < 10),
      snrDb: num('snr', (v) => v > -50 && v < 100),
    };
    const frame = num('frame', (v) => v > 0);
    const at = typeof p.datetime === 'string' ? Date.parse(p.datetime) : NaN;
    const pktAt = Number.isFinite(at) ? at : now; // the sonde's own clock, comparable with poweredOnAt

    const prev = this.flights.get(id);
    if (!prev) {
      const b: Balloon = { id, model: str(p.model), freqMhz: freq, lat, lon, altM: alt, maxAltM: alt, maxAltAt: pktAt, vertMps: vert, burst: false, firstSeen: now, lastSeen: now, track: [[lon, lat]], ...defined(readings), minTempC: readings.tempC, frames: 1, poweredOnAt: frame && Number.isFinite(at) ? at - frame * 1000 : undefined };
      this.flights.set(id, b);
      this.progressAt.set(id, now);
      return { kind: 'detected', balloon: b };
    }
    Object.assign(prev, defined(readings));
    prev.frames = (prev.frames ?? 0) + 1;
    if (readings.tempC !== undefined) prev.minTempC = Math.min(prev.minTempC ?? readings.tempC, readings.tempC);
    if (frame && Number.isFinite(at) && !prev.poweredOnAt) prev.poweredOnAt = at - frame * 1000;
    prev.lastHeardPosted = false;
    const wasBurst = prev.burst;
    prev.lat = lat;
    prev.lon = lon;
    prev.altM = alt;
    prev.vertMps = vert ?? prev.vertMps;
    prev.lastSeen = now;
    if (alt > prev.maxAltM) {
      prev.maxAltM = alt;
      prev.maxAltAt = pktAt;
    }
    if (freq) prev.freqMhz = freq;
    const last = prev.track[prev.track.length - 1];
    if (!last || Math.abs(last[0] - lon) + Math.abs(last[1] - lat) > 0.002) {
      prev.track.push([lon, lat]);
      if (prev.track.length > MAX_TRACK) prev.track.splice(0, prev.track.length - MAX_TRACK);
    }
    // Burst: now well below the peak and falling.
    if (!wasBurst && prev.maxAltM > 5000 && alt < prev.maxAltM - 300 && (vert === undefined || vert < -2)) {
      prev.burst = true;
      return { kind: 'burst', balloon: prev };
    }
    if (now - (this.progressAt.get(id) ?? 0) >= PROGRESS_EVERY_MS) {
      this.progressAt.set(id, now);
      return { kind: 'progress', balloon: prev };
    }
    return { kind: 'update', balloon: prev };
  }

  private progressAt = new Map<string, number>();

  /** Flights that have gone quiet on the way down (or low): time for a "last heard" card, once each. */
  lastHeard(now = Date.now(), quietMs = 60 * 60_000): Balloon[] {
    const out: Balloon[] = [];
    for (const b of this.flights.values()) {
      if (b.lastHeardPosted || now - b.lastSeen < quietMs || now - b.lastSeen > 6 * 3600_000) continue;
      if (!(b.burst || b.altM < 3000 || (b.vertMps ?? 0) < 0)) continue; // still climbing when we lost it: likely just out of the listening window
      b.lastHeardPosted = true;
      out.push(b);
    }
    return out;
  }

  /** Flights heard in the last `maxAgeMs`. Flights are forgotten after 3 days. */
  recent(now = Date.now(), maxAgeMs = 12 * 3600_000): Balloon[] {
    for (const [k, b] of this.flights) if (now - b.lastSeen > 3 * 86_400_000) this.flights.delete(k);
    return [...this.flights.values()].filter((b) => now - b.lastSeen < maxAgeMs);
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const f = (c: number) => Math.round(c * 1.8 + 32);
const dur = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** The readings worth reading: temperature, humidity, drift. */
export function readingsLine(b: Balloon): string {
  return [
    b.tempC !== undefined ? `${Math.round(b.tempC)}°C (${f(b.tempC)}°F)` : '',
    b.humidity !== undefined ? `${Math.round(b.humidity)}% humidity` : '',
    b.speedKmh !== undefined && b.heading !== undefined ? `drifting ${COMPASS[Math.round(b.heading / 45) % 8]} at ${Math.round(b.speedKmh)} km/h` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Feed card text for a flight event. */
export function describeBalloon(kind: 'detected' | 'burst' | 'progress' | 'last', b: Balloon, now = Date.now()): { title: string; body: string } {
  const model = b.model ?? 'Radiosonde';
  const climb = b.vertMps !== undefined ? `${b.vertMps > 0 ? 'climbing' : 'falling'} ${Math.abs(b.vertMps).toFixed(1)} m/s` : '';
  const r = readingsLine(b);
  const flying = b.poweredOnAt && now > b.poweredOnAt && now - b.poweredOnAt < 6 * 3600_000 ? ` · aloft about ${dur(now - b.poweredOnAt)}` : '';
  if (kind === 'detected') return { title: `Weather balloon ${b.id}`, body: [`${model} picked up at ${km(b.altM)}`, climb, r].filter(Boolean).join(' · ') + '.' };
  if (kind === 'progress') return { title: `Balloon ${b.id} at ${km(b.altM)}`, body: [climb, r].filter(Boolean).join(' · ') + `${flying}.` };
  if (kind === 'burst')
    return {
      title: `Balloon ${b.id} burst`,
      body: `Reached ${km(b.maxAltM)} before bursting${b.minTempC !== undefined ? `; coldest ${Math.round(b.minTempC)}°C (${f(b.minTempC)}°F)` : ''}${b.poweredOnAt && b.maxAltAt && b.maxAltAt > b.poweredOnAt && b.maxAltAt - b.poweredOnAt < 6 * 3600_000 ? ` after about ${dur(b.maxAltAt - b.poweredOnAt)} aloft` : ''}. Now falling by parachute${b.vertMps !== undefined ? ` at ${Math.abs(b.vertMps).toFixed(0)} m/s` : ''}.`,
    };
  return {
    title: `Balloon ${b.id} last heard`,
    body: `Last heard at ${km(b.altM)}${b.vertMps !== undefined && b.vertMps < 0 ? `, falling ${Math.abs(b.vertMps).toFixed(0)} m/s` : ''}, near ${b.lat.toFixed(2)}, ${b.lon.toFixed(2)} (its track is on the map). Peak ${km(b.maxAltM)}${b.minTempC !== undefined ? `, coldest ${Math.round(b.minTempC)}°C` : ''}; ${b.frames ?? 0} packets heard.`,
  };
}

