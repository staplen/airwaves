import { createConnection } from 'node:net';
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Aircraft, AprsStation, UatStation } from '../../shared/types.ts';
import { parseAprs, type AprsPacket } from './aprs.ts';
import { decodeUplinkStation, parseUatJson, parseUatRaw } from './uat.ts';

// Newer sources: UAT on 978 MHz (dump978-fa over TCP while its slot runs) and APRS on 144.39 MHz (multimon-ng
// lines written to files). State lives here; index.ts wires it into the snapshot, map, feed and raw log.

/** Keeps a TCP line reader connected to host:port, reconnecting every few seconds (the decoder only runs in its slot). */
export function tcpLines(port: number, onLine: (line: string) => void, host = '127.0.0.1'): void {
  const connect = () => {
    const sock = createConnection({ host, port });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
      if (buf.length > 1_000_000) buf = '';
    });
    sock.on('error', () => {}); // refused while the slot is off: expected
    sock.on('close', () => setTimeout(connect, 5000).unref());
  };
  connect();
}

// ---- UAT ---------------------------------------------------------------------------------------------
export class UatState {
  aircraft = new Map<string, Aircraft & { at: number }>();
  stations = new Map<string, UatStation>();
  uplinks = 0; // FIS-B frames today
  downlinks = 0;
  day = '';

  /** A JSON line from dump978-fa's JSON port. Returns the aircraft when it has a usable ICAO address. */
  onJson(line: string, now = Date.now()): (Aircraft & { at: number }) | undefined {
    const u = parseUatJson(line);
    if (!u) return undefined;
    this.downlinks++;
    const icao = u.addressType === 'adsb_icao' || u.addressType === 'tisb_icao';
    const hex = icao ? u.hex : `~${u.hex}`; // non-ICAO addresses can't collide with real ones
    const prev = this.aircraft.get(hex);
    const a: Aircraft & { at: number } = {
      hex,
      flight: u.flight ?? prev?.flight,
      altBaro: u.onGround ? 'ground' : u.altFt ?? (typeof prev?.altBaro === 'number' ? prev.altBaro : undefined),
      baroRate: u.vertRateFpm,
      gs: u.gsKt,
      track: u.trackDeg ?? prev?.track,
      lat: u.lat ?? prev?.lat,
      lon: u.lon ?? prev?.lon,
      rssi: u.rssi,
      category: u.category ?? prev?.category,
      squawk: u.squawk ?? prev?.squawk,
      emergency: u.emergency && u.emergency !== 'none' ? u.emergency : undefined,
      seen: 0,
      via: 'uat',
      at: now,
    };
    this.aircraft.set(hex, a);
    return a;
  }

  /** A line from the raw port: uplinks (FIS-B ground stations) are counted and their positions remembered. */
  onRaw(line: string, now = Date.now()): void {
    const r = parseUatRaw(line);
    if (!r || r.direction !== 'uplink') return;
    this.uplinks++;
    const hex = line.slice(1).split(';')[0];
    const pos = r.groundStation ?? decodeUplinkStation(Buffer.from(hex, 'hex'));
    if (!pos) return;
    const key = `${pos.lat.toFixed(2)},${pos.lon.toFixed(2)}`;
    const s = this.stations.get(key) ?? { lat: pos.lat, lon: pos.lon, frames: 0, lastHeard: now };
    s.frames++;
    s.lastHeard = now;
    this.stations.set(key, s);
  }

  /** Aircraft heard in the last `maxAgeMs`, with `seen` set to seconds since. */
  live(now: number, maxAgeMs = 10 * 60_000): Aircraft[] {
    const out: Aircraft[] = [];
    for (const [k, a] of this.aircraft) {
      if (now - a.at > maxAgeMs) this.aircraft.delete(k);
      else out.push({ ...a, seen: (now - a.at) / 1000 });
    }
    return out;
  }
}

// ---- APRS --------------------------------------------------------------------------------------------
export class AprsState {
  stations = new Map<string, AprsStation>();
  packetsToday = 0;
  day = '';

  /** Folds one packet in; returns the station and whether it's new (for the feed). */
  add(p: AprsPacket, ts: number): { station: AprsStation; isNew: boolean } | undefined {
    const name = p.kind === 'object' || p.kind === 'item' ? p.name ?? p.from : p.from;
    const prev = this.stations.get(name);
    if (p.lat === undefined && !prev && !p.weather) return undefined; // nothing to place or show
    const s: AprsStation = {
      call: name,
      lat: p.lat ?? prev?.lat,
      lon: p.lon ?? prev?.lon,
      symbol: p.symbol?.name ?? prev?.symbol,
      symbolCode: p.symbol ? `${p.symbol.table}${p.symbol.code}` : prev?.symbolCode,
      comment: p.comment?.slice(0, 120) || prev?.comment,
      via: p.via ?? prev?.via,
      speedKt: p.speedKt,
      course: p.course,
      altFt: p.altFt ?? prev?.altFt,
      weather: p.weather ?? prev?.weather,
      object: p.kind === 'object' || p.kind === 'item' ? p.from : undefined,
      packets: (prev?.packets ?? 0) + 1,
      firstHeard: prev?.firstHeard ?? ts,
      lastHeard: ts,
    };
    this.stations.set(name, s);
    this.packetsToday++;
    return { station: s, isNew: !prev };
  }

  recent(now: number, maxAgeMs = 24 * 3600_000): AprsStation[] {
    return [...this.stations.values()].filter((s) => now - s.lastHeard < maxAgeMs);
  }

  load(list: AprsStation[] | undefined, now: number) {
    for (const s of list ?? []) if (now - s.lastHeard < 3 * 86_400_000) this.stations.set(s.call, s);
  }
}

/** Reads finished aprs_*.log files (multimon-ng output): each line parsed; the file is deleted afterwards. */
export async function ingestAprsFiles(dir: string, onPacket: (p: AprsPacket, ts: number, line: string) => void): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith('aprs_') && f.endsWith('.log'));
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of files) {
    const path = join(dir, f);
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs < 20_000) continue; // still being written
      const text = await readFile(path, 'utf8');
      // multimon-ng has no timestamps: spread the lines over the recording, ending at the file's last write.
      const lines = text.split('\n').filter((l) => l.includes('>') && l.includes(':'));
      lines.forEach((line, i) => {
        const p = parseAprs(line);
        if (p) onPacket(p, st.mtimeMs - (lines.length - 1 - i) * 1000, line);
      });
      await unlink(path);
      n++;
    } catch (e) {
      console.warn(`aprs ${f}:`, (e as Error).message);
    }
  }
  return n;
}
