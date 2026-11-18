import type { Balloon } from '../../shared/types.ts';

// radiosonde_auto_rx "payload summary" UDP packets (JSON), one per decoded frame.
// Fields used: callsign (serial), latitude, longitude, altitude (m), vel_v (m/s), model, freq.

export interface SondeEvent {
  kind: 'detected' | 'burst' | 'update';
  balloon: Balloon;
}

const MAX_TRACK = 600;

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

    const prev = this.flights.get(id);
    if (!prev) {
      const b: Balloon = { id, model: str(p.model), freqMhz: freq, lat, lon, altM: alt, maxAltM: alt, vertMps: vert, burst: false, firstSeen: now, lastSeen: now, track: [[lon, lat]] };
      this.flights.set(id, b);
      return { kind: 'detected', balloon: b };
    }
    const wasBurst = prev.burst;
    prev.lat = lat;
    prev.lon = lon;
    prev.altM = alt;
    prev.vertMps = vert ?? prev.vertMps;
    prev.lastSeen = now;
    prev.maxAltM = Math.max(prev.maxAltM, alt);
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
    return { kind: 'update', balloon: prev };
  }

  /** Flights heard in the last `maxAgeMs`. */
  recent(now = Date.now(), maxAgeMs = 12 * 3600_000): Balloon[] {
    for (const [k, b] of this.flights) if (now - b.lastSeen > 2 * maxAgeMs) this.flights.delete(k);
    return [...this.flights.values()].filter((b) => now - b.lastSeen < maxAgeMs);
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
