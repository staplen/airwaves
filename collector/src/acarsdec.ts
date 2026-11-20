import { airport, flightName, translateAcars } from './acars.ts';
import { utcOnDay } from './vdl2.ts';
import type { Vdl2Catch } from './vdl2.ts';

// Turns acarsdec (v4.x, f00b4r0 fork) JSON lines (--output json:udp) into the same catch shape the VDL2 path
// produces. Fields come from fmt_json() in acarsdec's output.c: timestamp, station_id, channel, freq (MHz),
// level, noise, error, mode, label, block_id, ack, tail, flight + msgno (downlinks only), text, end, depa/dsta/eta
// and the OOOI times, sublabel, mfi, assstat, libacars, app. Plain VHF ACARS carries no ICAO hex, so `hex` stays unset.

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function read(line: string): Obj | undefined {
  try {
    const o = JSON.parse(line);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Obj) : undefined;
  } catch {
    return undefined;
  }
}

/** Seconds (float) → ms; acarsdec omits the timestamp unless asked, so fall back to now. */
const stamp = (m: Obj): number => (typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? Math.round(m.timestamp * 1000) : Date.now());
const freqOf = (m: Obj): number => (typeof m.freq === 'number' && Number.isFinite(m.freq) ? m.freq : 0);

/** acarsdec prints the "_d" link-test label as "_" + DEL (0x7f). */
const labelOf = (m: Obj): string | undefined => str(typeof m.label === 'string' ? m.label.replace(/\x7f/g, 'd') : undefined);

const LINK_TEST = new Set(['_d', 'Q0']);

export function parseAcarsdec(line: string): Vdl2Catch | undefined {
  try {
    const m = read(line);
    if (!m) return undefined;
    const label = labelOf(m);
    if (label && (LINK_TEST.has(label) || label === 'SQ')) return undefined;
    const text = str(m.text);
    const depa = str(m.depa);
    const dsta = str(m.dsta);
    if (!text && !(depa && dsta)) return undefined;
    const bad = typeof m.error === 'number' && m.error > 0;

    const ts = stamp(m);
    const freqMhz = freqOf(m);
    const flightRaw = str(m.flight)?.replace(/^\.+/, '');
    const flight = flightRaw && !/^[A-Z0-9]{2}0000$/.test(flightRaw) ? flightRaw : undefined;
    const reg = str(m.tail)?.replace(/^\.+/, '') || undefined;
    const title = flightName(flight) ?? (reg ? `Aircraft ${reg}` : 'Aircraft');

    const tr = text ? translateAcars(label, text) : undefined;
    if (tr) {
      return {
        ts, freqMhz, flight, reg, title, body: tr.headline, lat: tr.lat, lon: tr.lon,
        points: tr.points?.map((p) => ({ lat: p.lat, lon: p.lon, altFt: p.altFt, ts: utcOnDay(p.utc, ts) })),
        raw: text && tr.headline !== text ? text : undefined,
      };
    }
    // Corrupt frames that don't parse are dropped; acarsdec's own origin/destination decode is trusted only when clean.
    if (bad || !depa || !dsta) return undefined;
    return { ts, freqMhz, flight, reg, title, body: `Flying ${airport(depa)} → ${airport(dsta)}.`, raw: text };
  } catch {
    return undefined;
  }
}

export interface Squitter {
  station: string;
  lat?: number;
  lon?: number;
  freqMhz: number;
}

// Ground station squitter text, e.g. "02XAIADKIAD0000N38575W077277V136975/...": version "02", two letters
// (network/type flags, meaning unconfirmed), IATA "IAD", ICAO "KIAD", "0000", lat N38°57.5', lon W077°27.7',
// then "V" + the station's VDL2 frequency in kHz (136.975 MHz). Only the id and position are used.
const SQ = /^\d{2}[A-Z]{2}([A-Z]{3})([A-Z]{4})\d{4}([NS])(\d{4,5})([EW])(\d{5,6})V\d{6}/;

export function parseSquitter(line: string): Squitter | undefined {
  try {
    const m = read(line);
    if (!m || labelOf(m) !== 'SQ') return undefined;
    const text = str(m.text);
    if (!text) return undefined;
    const q = text.match(SQ);
    if (!q) return undefined;
    const lat = (Number(q[4].slice(0, 2)) + Number(q[4].slice(2)) / 10 / 60) * (q[3] === 'S' ? -1 : 1);
    const lon = (Number(q[6].slice(0, 3)) + Number(q[6].slice(3)) / 10 / 60) * (q[5] === 'W' ? -1 : 1);
    const ok = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    return {
      station: q[2],
      lat: ok ? Math.round(lat * 10000) / 10000 : undefined,
      lon: ok ? Math.round(lon * 10000) / 10000 : undefined,
      freqMhz: freqOf(m),
    };
  } catch {
    return undefined;
  }
}
