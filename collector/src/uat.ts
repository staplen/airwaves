// Parsers for FlightAware dump978-fa output (--json-port and --raw-port).
// Field names verified against flightaware/dump978 uat_message.cc (AdsbMessage::ToJson,
// operator<< for RawMessage). Uplink header decoding follows mutability/dump978
// uat_decode.c uat_decode_uplink_mdb (DO-282B 2.2.3.2).

export interface UatAircraft {
  hex: string;
  addressType: string;
  flight?: string;
  lat?: number;
  lon?: number;
  altFt?: number;
  gsKt?: number;
  trackDeg?: number;
  vertRateFpm?: number;
  squawk?: string;
  category?: string;
  emergency?: string;
  onGround?: boolean;
  rssi?: number;
  ts?: number;
}

export interface UatRaw {
  direction: 'uplink' | 'downlink';
  bytes: number;
  rssi?: number;
  ts?: number;
  groundStation?: { lat: number; lon: number };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function parseUatJson(line: string): UatAircraft | undefined {
  try {
    const o = JSON.parse(line);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const addr = str(o.address)?.toLowerCase();
    if (!addr || !/^[0-9a-f]{6}$/.test(addr)) return undefined;
    const out: UatAircraft = { hex: addr, addressType: str(o.address_qualifier) ?? 'unknown' };

    const flight = str(o.callsign);
    if (flight) out.flight = flight;
    const p = o.position;
    if (p && typeof p === 'object') {
      const lat = num(p.lat), lon = num(p.lon);
      if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        out.lat = lat;
        out.lon = lon;
      }
    }
    // Feet. pressure_altitude preferred; geometric used as fallback.
    const alt = num(o.pressure_altitude) ?? num(o.geometric_altitude);
    if (alt !== undefined) out.altFt = alt;
    const gs = num(o.ground_speed); // knots
    if (gs !== undefined) out.gsKt = gs;
    const trk = num(o.true_track); // degrees (only a real track, not heading)
    if (trk !== undefined) out.trackDeg = trk;
    const vr = num(o.vertical_velocity_barometric) ?? num(o.vertical_velocity_geometric); // ft/min
    if (vr !== undefined) out.vertRateFpm = vr;
    const sq = str(o.flightplan_id);
    if (sq) out.squawk = sq;
    const cat = str(o.emitter_category);
    if (cat) out.category = cat;
    const em = str(o.emergency);
    if (em) out.emergency = em;
    const ag = str(o.airground_state);
    if (ag === 'ground') out.onGround = true;
    else if (ag === 'airborne' || ag === 'supersonic') out.onGround = false;
    const m = o.metadata;
    if (m && typeof m === 'object') {
      const rssi = num(m.rssi);
      if (rssi !== undefined) out.rssi = rssi;
      const ts = num(m.received_at); // epoch seconds (fractional)
      if (ts !== undefined) out.ts = ts;
    }
    return out;
  } catch {
    return undefined;
  }
}

// Decode the 8-byte uplink header: 23-bit lat, 24-bit lon, angular weighted binary.
export function decodeUplinkStation(b: Uint8Array): { lat: number; lon: number } | undefined {
  if (b.length < 8) return undefined;
  const rawLat = (b[0] << 15) | (b[1] << 7) | (b[2] >> 1);
  const rawLon = ((b[2] & 1) << 23) | (b[3] << 15) | (b[4] << 7) | (b[5] >> 1);
  let lat = (rawLat * 360) / 16777216;
  if (lat > 90) lat -= 180;
  let lon = (rawLon * 360) / 16777216;
  if (lon > 180) lon -= 360;
  return { lat, lon };
}

export function parseUatRaw(line: string): UatRaw | undefined {
  try {
    const s = line.trim();
    const dir = s[0];
    if (dir !== '-' && dir !== '+') return undefined;
    const semi = s.indexOf(';');
    if (semi < 0) return undefined;
    const hex = s.slice(1, semi);
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
    const bytes = hex.length / 2;
    const out: UatRaw = { direction: dir === '+' ? 'uplink' : 'downlink', bytes };
    for (const kv of s.slice(semi + 1).split(';')) {
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const k = kv.slice(0, eq), v = Number(kv.slice(eq + 1));
      if (!Number.isFinite(v)) continue;
      if (k === 'rssi') out.rssi = v;
      else if (k === 't') out.ts = v;
    }
    if (dir === '+' && bytes >= 8) {
      const hdr = Uint8Array.from(Buffer.from(hex.slice(0, 16), 'hex'));
      const gs = decodeUplinkStation(hdr);
      if (gs && Math.abs(gs.lat) <= 90 && Math.abs(gs.lon) <= 180) out.groundStation = gs;
    }
    return out;
  } catch {
    return undefined;
  }
}
