import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Overlays } from '../../shared/types.ts';

const TRAFFIC_MAX_AGE_MS = 90 * 60_000;
const RADAR_MAX_AGE_MS = 45 * 60_000;

type Bounds = [number, number, number, number];

function stamp(date: string, time: string): number {
  return Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4));
}

function pairs(s: string): [number, number][] {
  return [...s.matchAll(/\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
}

function keyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*?)"(?=;|$)/, '$1');
  }
  return out;
}

const url = (file: string) => `/api/maps/${encodeURIComponent(file)}`;

function readText(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return undefined;
  }
}

function readTraffic(dir: string, files: string[], now: number): Overlays['traffic'] {
  const idx = files.filter((f) => /^TMI_.*\.txt$/.test(f)).sort().at(-1);
  if (!idx) return undefined;
  const text = readText(dir, idx);
  if (!text) return undefined;
  const kv = keyValues(text);
  const mapId = kv.TrafficMapID ?? idx.split('_')[1];
  const rows = Number(kv.NumRows);
  const cols = Number(kv.NumColumns);
  if (!mapId || !(rows > 0) || !(cols > 0)) return undefined;
  const bg = kv.BackgroundRGBColor ? pairsRgb(kv.BackgroundRGBColor) : undefined;

  // newest in-window tile per (row, col)
  const best = new Map<string, { file: string; ts: number }>();
  for (const f of files) {
    const m = f.match(/^TMT_([^_]+)_(\d+)_(\d+)_(\d{8})_(\d{4})_[^.]*\.png$/i);
    if (!m || m[1] !== mapId) continue;
    const ts = stamp(m[4], m[5]);
    if (!Number.isFinite(ts) || now - ts > TRAFFIC_MAX_AGE_MS || ts - now > 10 * 60_000) continue;
    const key = `${m[2]}_${m[3]}`;
    const cur = best.get(key);
    if (!cur || ts > cur.ts) best.set(key, { file: f, ts });
  }

  const tiles: { url: string; bounds: Bounds; row: number; col: number }[] = [];
  let updatedAt = 0;
  for (const [key, { file, ts }] of [...best].sort()) {
    const [r, c] = key.split('_').map(Number);
    if (r < 1 || r > rows || c < 1 || c > cols) continue;
    const pts = pairs(kv[`CoordinatesRow${r}`] ?? '');
    if (pts.length < cols + 1) continue;
    const lons = pts.map((p) => p[1]).sort((a, b) => a - b);
    const lats = pts.map((p) => p[0]);
    // The four longitudes are the column edges, west to east; the row spans min..max latitude.
    const west = lons[c - 1];
    const east = lons[c];
    const bounds: Bounds = [west, Math.min(...lats), east, Math.max(...lats)];
    if (!bounds.every(Number.isFinite)) continue;
    tiles.push({ url: url(file), bounds, row: r, col: c });
    updatedAt = Math.max(updatedAt, ts);
  }
  if (!tiles.length) return undefined;
  return { mapId, updatedAt, rows, cols, tiles, ...(bg ? { background: bg } : {}) };
}

function pairsRgb(s: string): [number, number, number] | undefined {
  const n = s.match(/-?\d+/g)?.map(Number);
  return n && n.length >= 3 && n.slice(0, 3).every((v) => v >= 0 && v <= 255) ? [n[0], n[1], n[2]] : undefined;
}

function readRadar(dir: string, files: string[], now: number): Overlays['radar'] {
  const idx = files.filter((f) => /^DWRI_.*\.txt$/.test(f)).sort().at(-1);
  const text = idx ? readText(dir, idx) : undefined;
  if (!text) return undefined;
  const pts = pairs(keyValues(text).Coordinates ?? '');
  if (pts.length < 2) return undefined;
  const [[north, west], [south, east]] = pts;

  let best: { file: string; ts: number } | undefined;
  for (const f of files) {
    const m = f.match(/^DWRO_[^_]+_[^_]+_(\d{8})_(\d{4})_[^.]*\.png$/i);
    if (!m) continue;
    const ts = stamp(m[1], m[2]);
    if (!Number.isFinite(ts) || now - ts > RADAR_MAX_AGE_MS || ts - now > 10 * 60_000) continue;
    if (!best || ts > best.ts) best = { file: f, ts };
  }
  const bounds: Bounds = [west, south, east, north];
  if (!best || !bounds.every(Number.isFinite)) return undefined;
  return { url: url(best.file), updatedAt: best.ts, bounds };
}

/** Reads the HD Radio traffic tiles and weather radar the collector has stored in `mapsDir`. */
export function readOverlays(mapsDir: string, now: number): Overlays {
  let files: string[];
  try {
    files = readdirSync(mapsDir);
  } catch {
    return {};
  }
  const out: Overlays = {};
  try {
    const traffic = readTraffic(mapsDir, files, now);
    if (traffic) out.traffic = traffic;
  } catch {}
  try {
    const radar = readRadar(mapsDir, files, now);
    if (radar) out.radar = radar;
  } catch {}
  return out;
}
