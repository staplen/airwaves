import { readFile, stat, writeFile } from 'node:fs/promises';

// VDL2 ground station names: address (e.g. "11204A") → airport. The list is ACARS Hub's ground-stations.json
// (community-maintained, ~2,300 stations). It is GPL-licensed, so it is downloaded at runtime and cached next to
// the database rather than copied into this repository. Refreshed weekly; without it, stations show as addresses.

const URL_ = 'https://raw.githubusercontent.com/sdr-enthusiasts/docker-acarshub/main/rootfs/webapp/data/ground-stations.json';
const REFRESH_MS = 7 * 86_400_000;

export interface GroundStation {
  icao: string;
  city: string; // "Baltimore, MD"
  lat?: number;
  lon?: number;
}

let stations = new Map<string, GroundStation>();

/** "39.175N" / "76.668W" → signed degrees. */
function coord(v: unknown): number | undefined {
  const m = typeof v === 'string' ? /^([\d.]+)\s*([NSEW])$/i.exec(v.trim()) : null;
  if (!m) return undefined;
  const n = Number(m[1]);
  return /[SW]/i.test(m[2]) ? -n : n;
}

export function parseGroundStations(json: string): Map<string, GroundStation> {
  const out = new Map<string, GroundStation>();
  const d = JSON.parse(json) as { ground_stations?: { id?: string; airport?: Record<string, unknown> }[] };
  for (const g of d.ground_stations ?? []) {
    const a = g.airport;
    if (!g.id || !a || typeof a.icao !== 'string') continue;
    // "Baltimore (MD)" → "Baltimore, MD"; fall back to the airport name.
    const city = typeof a.city === 'string' && a.city ? a.city.replace(/\s*\(([^)]+)\)\s*$/, ', $1') : String(a.name ?? a.icao);
    out.set(g.id.toUpperCase(), { icao: a.icao, city, lat: coord(a.latitude), lon: coord(a.longitude) });
  }
  return out;
}

/** Loads the cached list, downloading a fresh copy when there is none or it is over a week old. Never throws. */
export async function loadGroundStations(cachePath: string): Promise<number> {
  let text: string | undefined;
  const age = await stat(cachePath).then((s) => Date.now() - s.mtimeMs).catch(() => Infinity);
  if (age > REFRESH_MS) {
    try {
      const r = await fetch(URL_, { signal: AbortSignal.timeout(20_000) });
      if (r.ok) {
        text = await r.text();
        parseGroundStations(text); // only cache what parses
        await writeFile(cachePath, text);
      }
    } catch (e) {
      console.warn('ground stations: download failed:', (e as Error).message);
      text = undefined;
    }
  }
  text ??= await readFile(cachePath, 'utf8').catch(() => undefined);
  if (!text) return 0;
  try {
    stations = parseGroundStations(text);
  } catch {
    /* keep whatever we had */
  }
  return stations.size;
}

export const groundStation = (addr: string | undefined) => (addr ? stations.get(addr.toUpperCase()) : undefined);

/** For tests: install a list directly. */
export function setGroundStations(m: Map<string, GroundStation>) {
  stations = m;
}
