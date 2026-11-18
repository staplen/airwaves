import { airport, flightName, translateAcars, translateCpdlc } from './acars.ts';

// Turns dumpvdl2 JSON (decoded:json:udp output) into feed items worth showing.
// Most VDL2 frames are link-layer housekeeping; we keep only messages with content.

export interface Vdl2Catch {
  ts: number;
  freqMhz: number;
  flight?: string;
  reg?: string;
  title: string;
  body: string;
  lat?: number;
  lon?: number;
  altFt?: number;
  raw?: string; // the original message text, shown on request
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Finds a nested key anywhere in a decoded message (CPDLC/XID trees vary a lot). */
function findKey(o: unknown, key: string, depth = 0): unknown {
  if (depth > 8 || !o || typeof o !== 'object') return undefined;
  if (Array.isArray(o)) {
    for (const x of o) {
      const r = findKey(x, key, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === key) return v;
    const r = findKey(v, key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** dumpvdl2 encodes XID parameters as [{ name, value }] lists; finds one by name. */
function param(o: unknown, name: string, depth = 0): unknown {
  if (depth > 8 || !o || typeof o !== 'object') return undefined;
  if (Array.isArray(o)) {
    for (const x of o) {
      const xo = obj(x);
      if (xo && xo.name === name && 'value' in xo) return xo.value;
      const r = param(x, name, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  for (const v of Object.values(o)) {
    const r = param(v, name, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

// Free text that is really base64/compressed airline data: long, no spaces, mixed case.
function looksEncoded(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  return compact.length > 60 && !/\s/.test(text.trim().slice(0, 60)) && /[a-z]/.test(compact) && /[A-Z]/.test(compact);
}

export function parseVdl2(raw: string): Vdl2Catch | undefined {
  let msg: Obj;
  try {
    msg = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const v = obj(msg.vdl2);
  if (!v) return undefined;
  const t = obj(v.t);
  const ts = t && typeof t.sec === 'number' ? t.sec * 1000 : Date.now();
  const freqMhz = typeof v.freq === 'number' ? v.freq / 1e6 : 0;
  const avlc = obj(v.avlc);
  if (!avlc) return undefined;
  const acars = obj(avlc.acars);
  const flight = str(acars?.flight)?.replace(/^\.+/, '');
  const reg = str(acars?.reg)?.replace(/^\.+/, '');
  const callsign = flight && !/^[A-Z0-9]{2}0000$/.test(flight) ? flight : undefined;
  const who = flightName(callsign) ?? (reg ? `Aircraft ${reg}` : `Aircraft ${str(obj(avlc.src)?.addr) ?? ''}`.trim());

  // Controller–pilot datalink: show the instruction or reply.
  const cpdlc = findKey(avlc, 'cpdlc');
  if (cpdlc) {
    const text = findKey(cpdlc, 'msg_element') ?? findKey(cpdlc, 'msg_data') ?? findKey(cpdlc, 'atc_uplink_msg') ?? findKey(cpdlc, 'atc_downlink_msg');
    const words = JSON.stringify(text ?? cpdlc).match(/"([A-Z][A-Z _/]{2,})"/g)?.map((w) => w.replace(/"/g, '')) ?? [];
    return { ts, freqMhz, flight, reg, title: `${who} · controller text`, body: translateCpdlc(words.slice(0, 6)), raw: words.join(' ') };
  }

  // Ground station handoffs carry position, altitude and destination.
  const xid = obj(avlc.xid);
  if (xid) {
    const rawDest = str(param(xid, 'dst_airport') ?? findKey(xid, 'dst_airport'));
    const dest = rawDest && /[A-Z0-9]/i.test(rawDest) ? rawDest : undefined; // "----" = not filed
    const loc = obj(param(xid, 'ac_location') ?? findKey(xid, 'ac_location'));
    const lat = typeof obj(loc?.loc)?.lat === 'number' ? (obj(loc?.loc)!.lat as number) : undefined;
    const lon = typeof obj(loc?.loc)?.lon === 'number' ? (obj(loc?.loc)!.lon as number) : undefined;
    // Garbled reports sometimes carry impossible altitudes (e.g. 192,000 ft); drop those.
    const altFt = typeof loc?.alt === 'number' && loc.alt > 0 && loc.alt <= 60_000 ? (loc.alt as number) : undefined;
    if (!dest && lat === undefined) return undefined;
    const body = [dest ? `Bound for ${airport(dest)}` : 'Connected to a new ground station', altFt ? `at ${altFt.toLocaleString('en-US')} ft` : undefined].filter(Boolean).join(' ') + '.';
    return { ts, freqMhz, flight, reg, title: `${who} · checked in`, body, lat, lon, altFt };
  }

  // ACARS text: translate known formats, drop telemetry and encoded blobs.
  const text = str(acars?.msg_text);
  if (!acars || !text || looksEncoded(text)) return undefined;
  const tr = translateAcars(str(acars.label), text);
  if (!tr) return undefined;
  return { ts, freqMhz, flight, reg, title: who, body: tr.headline, lat: tr.lat, lon: tr.lon, raw: tr.headline === text ? undefined : text };
}
