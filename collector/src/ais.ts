// Minimal AIS NMEA decoder for the message types the dashboard uses.
// AIS-catcher forwards raw !AIVDM sentences over UDP; we decode them here.

export type AisMessage =
  | { type: 1 | 2 | 3 | 18 | 19; mmsi: number; lat?: number; lon?: number; sog?: number; cog?: number; name?: string; shipType?: number }
  | { type: 5 | 24; mmsi: number; name?: string; shipType?: number }
  | { type: 4; mmsi: number; lat?: number; lon?: number }
  | { type: 21; mmsi: number; name?: string; aidType?: string; lat?: number; lon?: number; virtual: boolean }
  | { type: number; mmsi: number };

const SIXBIT_TEXT = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?';

const AID_TYPES = [
  'Unspecified', 'Reference point', 'RACON', 'Fixed structure', 'Spare', 'Light', 'Light with sectors',
  'Leading light front', 'Leading light rear', 'Cardinal beacon N', 'Cardinal beacon E', 'Cardinal beacon S',
  'Cardinal beacon W', 'Port beacon', 'Starboard beacon', 'Preferred channel port beacon',
  'Preferred channel starboard beacon', 'Isolated danger beacon', 'Safe water beacon', 'Special mark beacon',
  'Cardinal mark N', 'Cardinal mark E', 'Cardinal mark S', 'Cardinal mark W', 'Port hand mark',
  'Starboard hand mark', 'Preferred channel port', 'Preferred channel starboard', 'Isolated danger',
  'Safe water', 'Special mark', 'Light vessel',
];

class Bits {
  private s: string;
  constructor(payload: string, fillBits: number) {
    let s = '';
    for (const ch of payload) {
      let v = ch.charCodeAt(0) - 48;
      if (v > 40) v -= 8;
      s += v.toString(2).padStart(6, '0');
    }
    this.s = fillBits ? s.slice(0, s.length - fillBits) : s;
  }
  get length() {
    return this.s.length;
  }
  u(start: number, len: number): number {
    if (start + len > this.s.length) return NaN;
    return parseInt(this.s.slice(start, start + len), 2);
  }
  i(start: number, len: number): number {
    const v = this.u(start, len);
    return this.s[start] === '1' ? v - 2 ** len : v;
  }
  text(start: number, len: number): string | undefined {
    if (start + len > this.s.length) return undefined;
    let out = '';
    for (let k = 0; k < len; k += 6) out += SIXBIT_TEXT[this.u(start + k, 6)];
    const t = out.replace(/@.*$/, '').trim();
    return t || undefined;
  }
}

function pos(lon: number, lat: number): { lat?: number; lon?: number } {
  const la = lat / 600000;
  const lo = lon / 600000;
  // 91° / 181° mean "not available".
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return {};
  return { lat: la, lon: lo };
}

function decodePayload(payload: string, fill: number): AisMessage | undefined {
  const b = new Bits(payload, fill);
  const type = b.u(0, 6);
  const mmsi = b.u(8, 30);
  if (!Number.isFinite(type) || !Number.isFinite(mmsi)) return undefined;
  switch (type) {
    case 1:
    case 2:
    case 3: {
      const sog = b.u(50, 10);
      const cog = b.u(116, 12);
      return { type, mmsi, ...pos(b.i(61, 28), b.i(89, 27)), sog: sog === 1023 ? undefined : sog / 10, cog: cog === 3600 ? undefined : cog / 10 };
    }
    case 18:
    case 19: {
      const sog = b.u(46, 10);
      const cog = b.u(112, 12);
      const base = { type, mmsi, ...pos(b.i(57, 28), b.i(85, 27)), sog: sog === 1023 ? undefined : sog / 10, cog: cog === 3600 ? undefined : cog / 10 };
      return type === 19 ? { ...base, name: b.text(143, 120), shipType: b.u(263, 8) } : base;
    }
    case 4:
      return { type, mmsi, ...pos(b.i(79, 28), b.i(107, 27)) };
    case 5:
      return { type, mmsi, name: b.text(112, 120), shipType: b.u(232, 8) };
    case 24: {
      const part = b.u(38, 2);
      return part === 0 ? { type, mmsi, name: b.text(40, 120) } : { type, mmsi, shipType: b.u(40, 8) };
    }
    case 21:
      return { type, mmsi, aidType: AID_TYPES[b.u(38, 5)], name: b.text(43, 120), ...pos(b.i(164, 28), b.i(192, 27)), virtual: b.u(269, 1) === 1 };
    default:
      return { type, mmsi };
  }
}

/** Reassembles multi-sentence messages and decodes complete ones. */
export class AisDecoder {
  private pending = new Map<string, { parts: string[]; count: number; at: number }>();

  /** Feed one NMEA line; returns a decoded message when one is complete. */
  push(line: string): AisMessage | undefined {
    const m = line.trim().match(/^!AIVD[MO],(\d),(\d),(\d*),([AB12]?),([^,]*),(\d)\*[0-9A-F]{2}/i);
    if (!m) return undefined;
    const [, totalS, numS, seq, chan, payload, fillS] = m;
    const total = Number(totalS);
    const num = Number(numS);
    const fill = Number(fillS);
    if (total === 1) return decodePayload(payload, fill);
    const key = `${seq}:${chan}`;
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > 10_000) this.pending.delete(k);
    const entry = this.pending.get(key) ?? { parts: new Array<string>(total).fill(''), count: 0, at: now };
    if (!entry.parts[num - 1]) entry.count++;
    entry.parts[num - 1] = payload;
    this.pending.set(key, entry);
    if (entry.count < total) return undefined;
    this.pending.delete(key);
    return decodePayload(entry.parts.join(''), fill);
  }
}

/** Plain-English ship category from the AIS ship type code. */
export function shipTypeName(code?: number): string | undefined {
  if (code === undefined || !Number.isFinite(code) || code === 0) return undefined;
  if (code >= 20 && code <= 29) return 'Wing in ground';
  if (code === 30) return 'Fishing';
  if (code === 31 || code === 32 || code === 52) return 'Tug';
  if (code === 33) return 'Dredger';
  if (code === 35) return 'Military';
  if (code === 36) return 'Sailing';
  if (code === 37) return 'Pleasure craft';
  if (code >= 40 && code <= 49) return 'High-speed craft';
  if (code === 50) return 'Pilot';
  if (code === 51) return 'Search and rescue';
  if (code === 55) return 'Law enforcement';
  if (code >= 60 && code <= 69) return 'Passenger';
  if (code >= 70 && code <= 79) return 'Cargo';
  if (code >= 80 && code <= 89) return 'Tanker';
  return 'Other';
}
