import { groundStation } from './groundstations.ts';
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
  hex?: string; // the aircraft's ICAO address (lowercase, as readsb writes it): joins datalink to ADS-B
  lat?: number;
  lon?: number;
  altFt?: number;
  points?: { lat: number; lon: number; altFt?: number; ts: number }[]; // timed fixes for the trail
  coarse?: boolean; // position only to the nearest ~half degree (check-in frames): not drawn as a trail
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
/** Plain words for a VDL2 link-management (XID) frame type. The aircraft logs on once, then hops between ground
 *  stations: it either asks to switch (handoff request) or accepts a switch the ground asked for (handoff response). */
function xidStep(type: string | undefined): { verb: string; lead: string } {
  if (type?.endsWith('_LE')) return { verb: 'logged on', lead: 'Logged on to datalink via' };
  if (type === 'XID_CMD_HO') return { verb: 'handoff request', lead: 'Asked to switch to' };
  if (type === 'XID_RSP_HO') return { verb: 'handed off', lead: 'Switched, as asked, to' };
  return { verb: 'checked in', lead: 'Checked in with' };
}

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
  // Downlinks come from the aircraft (src), uplinks go to it (dst).
  const hex = str([obj(avlc.src), obj(avlc.dst)].find((x) => x?.type === 'Aircraft')?.addr)?.toLowerCase();
  const flight = str(acars?.flight)?.replace(/^\.+/, '');
  const reg = str(acars?.reg)?.replace(/^\.+/, '');
  const callsign = flight && !/^[A-Z0-9]{2}0000$/.test(flight) ? flight : undefined;
  const who = flightName(callsign) ?? (reg ? `Aircraft ${reg}` : `Aircraft ${str(obj(avlc.src)?.addr) ?? ''}`.trim());

  // Controller–pilot datalink: show the instruction or reply.
  const cpdlc = findKey(avlc, 'cpdlc');
  if (cpdlc) {
    const text = findKey(cpdlc, 'msg_element') ?? findKey(cpdlc, 'msg_data') ?? findKey(cpdlc, 'atc_uplink_msg') ?? findKey(cpdlc, 'atc_downlink_msg');
    const words = JSON.stringify(text ?? cpdlc).match(/"([A-Z][A-Z _/]{2,})"/g)?.map((w) => w.replace(/"/g, '')) ?? [];
    // Which ATC datalink service, and whether this is a connect, a disconnect or a message.
    const a622 = obj(findKey(avlc, 'arinc622'));
    const msgType = str(a622?.msg_type) ?? '';
    const gsAddr = str(a622?.gs_addr);
    const service = gsAddr ? (CPDLC_SERVICES[gsAddr] ?? gsAddr) : 'ATC';
    if (/disconnect/.test(msgType)) return { ts, freqMhz, flight, reg, hex, title: `${who} · datalink with ATC`, body: `Ended its controller–pilot text link with ${service}.`, raw: msgType };
    if (/connect_(confirm|request)$/.test(msgType)) return { ts, freqMhz, flight, reg, hex, title: `${who} · datalink with ATC`, body: `Connected to ${service} for controller–pilot text messages.`, raw: msgType };
    const said = translateCpdlc(words.slice(0, 6));
    return { ts, freqMhz, flight, reg, hex, title: `${who} · controller text`, body: gsAddr ? `${said} Sent over ${service}.` : said, raw: words.join(' ') };
  }

  // Ground station handoffs carry position, altitude and destination.
  const xid = obj(avlc.xid);
  if (xid) {
    const rawDest = str(param(xid, 'dst_airport') ?? findKey(xid, 'dst_airport'));
    const trimmed = rawDest?.replace(/[^A-Z0-9]+$/i, ''); // some aircraft pad short codes: "CHO."
    const dest = trimmed && /^[A-Z0-9]{3,4}$/i.test(trimmed) ? trimmed.toUpperCase() : undefined; // "----" = not filed
    const loc = obj(param(xid, 'ac_location') ?? findKey(xid, 'ac_location'));
    const lat = typeof obj(loc?.loc)?.lat === 'number' ? (obj(loc?.loc)!.lat as number) : undefined;
    const lon = typeof obj(loc?.loc)?.lon === 'number' ? (obj(loc?.loc)!.lon as number) : undefined;
    // Garbled reports sometimes carry impossible altitudes (e.g. 192,000 ft); drop those.
    const altFt = typeof loc?.alt === 'number' && loc.alt > 0 && loc.alt <= 60_000 ? (loc.alt as number) : undefined;
    if (!dest && lat === undefined) return undefined;
    // Which link step this is, and the ground station it is talking to (dumpvdl2 has no names for those, only addresses).
    const dst = obj(avlc.dst);
    const gs = str(dst?.type) === 'Ground station' ? str(dst?.addr) : undefined;
    const step = xidStep(str(xid.type));
    const station = groundStation(gs);
    const link = station ? `${step.lead} the ${station.city} ground station (${station.icao}).` : gs ? `${step.lead} ground station ${gs}.` : `${step.lead.replace(/ (to|via)$/, '')} a ground station.`;
    const trip = [dest ? `Bound for ${airport(dest)}` : undefined, altFt ? `at ${altFt.toLocaleString('en-US')} ft` : undefined].filter(Boolean).join(' ');
    const body = trip ? `${link} ${trip.charAt(0).toUpperCase()}${trip.slice(1)}.` : link;
    return { ts, freqMhz, flight, reg, hex, title: `${who} · ${step.verb}`, body, lat, lon, altFt, coarse: true, raw: [str(xid.type_descr), gs && `ground station ${gs}${station ? ` (${station.icao}, ${station.city})` : ''}`].filter(Boolean).join(' · ') || undefined };
  }

  // ACARS text: translate known formats, drop telemetry and encoded blobs.
  const text = str(acars?.msg_text);
  if (!acars || !text || looksEncoded(text)) return undefined;
  const tr = translateAcars(str(acars.label), text);
  if (!tr) return undefined;
  return { ts, freqMhz, flight, reg, hex, title: who, body: tr.headline, lat: tr.lat, lon: tr.lon, points: tr.points?.map((p) => ({ lat: p.lat, lon: p.lon, altFt: p.altFt, ts: utcOnDay(p.utc, ts) })), raw: tr.headline === text ? undefined : text };
}

// ---- multi-block ACARS: long messages arrive as several frames (`more: true` on all but the last), each block
// lettered A, B, C… in msg_num_seq. Blocks are held per aircraft + message number and joined before translating,
// so a position in block B isn't lost and block A isn't translated half-finished.
const BLOCK_WAIT_MS = 90_000;
interface Pending {
  at: number;
  parts: Map<string, string>;
  last: Obj; // the most recent block's whole frame, reused as the envelope
}
/** "HHMMSS" UTC on the day of `ref` (the day before if that would be in the future). */
export function utcOnDay(hhmmss: string, ref: number): number {
  const d = new Date(ref);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(hhmmss.slice(0, 2)), Number(hhmmss.slice(2, 4)), Number(hhmmss.slice(4, 6)));
  return t > ref + 3600_000 ? t - 86_400_000 : t;
}

/** ARINC 622 ground addresses of ATC datalink services. USADCXA is the FAA's Data Comm service (nationwide, not one facility). */
const CPDLC_SERVICES: Record<string, string> = { USADCXA: 'FAA Data Comm' };

export class AcarsAssembler {
  private pending = new Map<string, Pending>();

  /** Returns the frame(s) ready to translate: none while a message is incomplete, the joined frame once it is. */
  push(raw: string, now = Date.now()): string[] {
    const out = this.flushStale(now);
    let msg: Obj;
    try {
      msg = JSON.parse(raw);
    } catch {
      return [...out, raw];
    }
    const avlc = obj(obj(msg.vdl2)?.avlc);
    const acars = obj(avlc?.acars);
    const num = str(acars?.msg_num);
    if (!avlc || !acars || !num) return [...out, raw];
    const key = `${str(obj(avlc.src)?.addr) ?? ''}:${num}`;
    const seq = str(acars.msg_num_seq) ?? 'A';
    const p = this.pending.get(key);
    if (acars.more === true) {
      const q = p ?? { at: now, parts: new Map(), last: msg };
      q.parts.set(seq, String(acars.msg_text ?? ''));
      q.last = msg;
      this.pending.set(key, q);
      return out;
    }
    if (!p) return [...out, raw];
    this.pending.delete(key);
    p.parts.set(seq, String(acars.msg_text ?? ''));
    return [...out, joined(msg, p.parts)];
  }

  /** Messages whose last block never came: translate what arrived rather than drop it. */
  flushStale(now = Date.now()): string[] {
    const out: string[] = [];
    for (const [k, p] of this.pending) {
      if (now - p.at < BLOCK_WAIT_MS) continue;
      this.pending.delete(k);
      out.push(joined(p.last, p.parts));
    }
    return out;
  }
}

function joined(frame: Obj, parts: Map<string, string>): string {
  const text = [...parts].sort((a, b) => a[0].localeCompare(b[0])).map(([, t]) => t).join('');
  const copy = JSON.parse(JSON.stringify(frame)) as Obj;
  const acars = obj(obj(obj(copy.vdl2)?.avlc)?.acars);
  if (acars) {
    acars.msg_text = text;
    acars.more = false;
    acars.blocks = parts.size;
  }
  return JSON.stringify(copy);
}
