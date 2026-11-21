import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeResult } from './probe.ts';

// Beta "survey": fine rtl_power sweeps (12.5 kHz bins, one-second passes for ~20 s per band) of bands where we might
// find more to decode. Each sweep is max-held per bin (bursty signals count) and compared with the band's noise
// floor; channels that stand out are remembered across surveys, so over days a picture builds of what is really
// on the air here. Nothing here reaches the feed or map: it's for deciding what to build next (/api/survey).

const MIN_OVER_DB = 10; // above the band's floor
const CHANNEL_HZ = 12_500;
const MAX_WIDTH_BINS = 4; // wider than ~50 kHz above the threshold: broadband (TV, data), not a narrowband channel
// Broadcast TV (VHF low/high, UHF) and its spill-over: strong, wide and already known; not what we're looking for.
const TV_MHZ: [number, number][] = [[54, 88], [173.5, 216.5], [469.5, 608.5]];
export const isTv = (mhz: number) => TV_MHZ.some(([lo, hi]) => mhz >= lo && mhz < hi);

/** What a frequency is probably used for (US allocations near Washington, DC). */
const BANDS: { lo: number; hi: number; use: string; note?: string }[] = [
  { lo: 128.0, hi: 136.975, use: 'Airband (ATC / ACARS)' },
  { lo: 136.975, hi: 137.0, use: 'VDL2 datalink' },
  { lo: 137.0, hi: 138.0, use: 'Weather satellites' },
  { lo: 144.0, hi: 148.0, use: 'Amateur 2 m (APRS 144.39)' },
  { lo: 150.8, hi: 152.0, use: 'Land mobile' },
  { lo: 152.0, hi: 152.85, use: 'Paging / land mobile', note: 'pagers are not decoded on purpose (personal data)' },
  { lo: 152.85, hi: 157.0, use: 'Public safety / land mobile' },
  { lo: 156.0, hi: 162.0, use: 'Marine VHF' },
  { lo: 157.45, hi: 158.0, use: 'Paging', note: 'not decoded on purpose' },
  { lo: 159.81, hi: 161.565, use: 'Railroad (AAR channels)' },
  { lo: 161.9, hi: 162.1, use: 'AIS' },
  { lo: 162.4, hi: 162.55, use: 'NOAA Weather Radio' },
  { lo: 162.0, hi: 174.0, use: 'Federal' },
  { lo: 216.0, hi: 220.0, use: 'Maritime / AMTS' },
  { lo: 220.0, hi: 222.0, use: 'Railroad PTC (220 MHz)', note: 'encrypted' },
  { lo: 222.0, hi: 225.0, use: 'Amateur 1.25 m' },
  { lo: 440.0, hi: 450.0, use: 'Amateur 70 cm' },
  { lo: 450.0, hi: 452.9, use: 'Land mobile / business' },
  { lo: 452.9, hi: 452.95, use: 'Railroad: locomotive (HOT) / distributed power' },
  { lo: 457.9, hi: 457.95, use: 'Railroad: end-of-train (EOT) / distributed power' },
  { lo: 462.55, hi: 462.725, use: 'FRS / GMRS' },
  { lo: 467.55, hi: 467.725, use: 'FRS / GMRS' },
  { lo: 450.0, hi: 470.0, use: 'Land mobile' },
  { lo: 896.0, hi: 901.0, use: 'Railroad ATCS / business (900 MHz)' },
  { lo: 902.0, hi: 928.0, use: 'ISM 900 (meters, sensors)' },
  { lo: 929.0, hi: 932.0, use: 'Paging', note: 'not decoded on purpose' },
  { lo: 935.0, hi: 941.0, use: 'Railroad ATCS / business (900 MHz)' },
  { lo: 941.0, hi: 960.0, use: 'Fixed links / studio-transmitter' },
];
// Narrowest match wins (railroad and AIS sit inside the marine band, paging inside land mobile…).
const BY_WIDTH = [...BANDS].sort((a, b) => a.hi - a.lo - (b.hi - b.lo));
export const bandOf = (mhz: number) => BY_WIDTH.find((b) => mhz >= b.lo && mhz < b.hi);

export interface SurveyChannel {
  mhz: number; // channel centre (12.5 kHz grid)
  use?: string;
  note?: string;
  seen: number; // surveys it stood out in
  surveys: number; // surveys of its band since it was first seen
  peakDb: number; // best dB above floor
  first: number;
  last: number;
}
export interface SurveyState {
  v?: number; // format version (2: TV and broadband filtered)
  /** Identify-probe results per probed frequency (kHz key): the latest run and a tally of guesses. */
  probes?: Record<string, { latest: ProbeResult; runs: number; guesses: Record<string, number> }>;
  surveys: Record<string, number>; // band label → survey count
  channels: Record<string, SurveyChannel>; // key = channel MHz (3 decimals)
}

/** Per-bin max over all passes, then channels standing out from the band's median floor. */
export function findChannels(csv: string): { band: string; peaks: { mhz: number; overDb: number }[] } | undefined {
  const max = new Map<number, number>();
  let lo = Infinity;
  let hi = -Infinity;
  for (const line of csv.split('\n')) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 7) continue;
    const low = Number(cols[2]);
    const step = Number(cols[4]);
    if (!Number.isFinite(low) || !(step > 0)) continue;
    for (let i = 6; i < cols.length; i++) {
      const db = Number(cols[i]);
      if (!Number.isFinite(db)) continue;
      const hz = Math.round((low + (i - 6) * step) / CHANNEL_HZ) * CHANNEL_HZ;
      max.set(hz, Math.max(max.get(hz) ?? -Infinity, db));
      lo = Math.min(lo, hz);
      hi = Math.max(hi, hz);
    }
  }
  if (max.size < 20) return undefined;
  const sorted = [...max.values()].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length / 2)];
  // Local maxima above the threshold (one per signal, not one per bin it spills into).
  const peaks: { mhz: number; overDb: number }[] = [];
  for (const [hz, db] of max) {
    const over = db - floor;
    if (over < MIN_OVER_DB) continue;
    const l = max.get(hz - CHANNEL_HZ) ?? -Infinity;
    const r = max.get(hz + CHANNEL_HZ) ?? -Infinity;
    if (!(db >= l && db > r) || isTv(hz / 1e6)) continue;
    // How wide the signal is above the threshold: narrowband channels are 1–3 bins.
    let width = 1;
    // Measured at 15 dB down from the peak too, so a strong narrow signal's skirts don't count as width.
    const edge = Math.max(floor + MIN_OVER_DB, db - 15);
    for (const dir of [-1, 1]) for (let k = 1; k <= MAX_WIDTH_BINS && (max.get(hz + dir * k * CHANNEL_HZ) ?? -Infinity) >= edge; k++) width++;
    if (width > MAX_WIDTH_BINS) continue;
    peaks.push({ mhz: Math.round(hz / 1000) / 1000, overDb: Math.round(over * 10) / 10 });
  }
  return { band: `${(lo / 1e6).toFixed(0)}-${(hi / 1e6).toFixed(0)} MHz`, peaks: peaks.sort((a, b) => a.mhz - b.mhz) };
}

export function addSurvey(state: SurveyState, band: string, peaks: { mhz: number; overDb: number }[], now: number): void {
  state.surveys[band] = (state.surveys[band] ?? 0) + 1;
  const [blo, bhi] = band.split(/[- ]/).map(Number);
  for (const c of Object.values(state.channels)) if (c.mhz >= blo && c.mhz <= bhi) c.surveys++;
  for (const p of peaks) {
    const key = p.mhz.toFixed(4);
    const b = bandOf(p.mhz);
    const c = (state.channels[key] ??= { mhz: p.mhz, use: b?.use, note: b?.note, seen: 0, surveys: 1, peakDb: p.overDb, first: now, last: now });
    c.seen++;
    c.peakDb = Math.max(c.peakDb, p.overDb);
    c.last = now;
  }
}

/** Reads finished survey_*.csv files, folds them into `state`, hands the text to `onRaw` (for the raw log), deletes them. */
export async function ingestSurvey(dir: string, state: SurveyState, onRaw?: (file: string, text: string) => void): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith('survey_') && f.endsWith('.csv'));
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of files) {
    const path = join(dir, f);
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs < 30_000) continue;
      const text = await readFile(path, 'utf8');
      onRaw?.(f, text);
      const r = findChannels(text);
      if (r) addSurvey(state, r.band, r.peaks, st.mtimeMs);
      await unlink(path);
      n++;
    } catch (e) {
      console.warn(`survey ${f}:`, (e as Error).message);
    }
  }
  return n;
}

export function addProbe(state: SurveyState, r: ProbeResult): void {
  const key = String(Math.round(r.mhz * 1000));
  const p = ((state.probes ??= {})[key] ??= { latest: r, runs: 0, guesses: {} });
  p.latest = r;
  p.runs++;
  p.guesses[r.guess] = (p.guesses[r.guess] ?? 0) + 1;
}

/** The interesting part: channels seen in more than one survey (or once, strongly), most regular first. */
export function surveyReport(state: SurveyState) {
  return Object.values(state.channels)
    .filter((c) => !isTv(c.mhz) && (c.seen >= 2 || c.peakDb >= 20))
    .sort((a, b) => b.seen / b.surveys - a.seen / a.surveys || b.peakDb - a.peakDb)
    .slice(0, 300);
}
