import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './store.ts';

// Spectrum is stored in log-spaced bins matching the dashboard dial (80–1150 MHz).
export const SPECTRUM_BINS = 120;
const LO = Math.log(80e6);
const HI = Math.log(1150e6);
const binOf = (hz: number) => Math.floor(((Math.log(hz) - LO) / (HI - LO)) * SPECTRUM_BINS);

/** Deletes files in `dir` older than `maxAgeMs` (by modification time). Returns how many. */
export async function purgeOldFiles(dir: string, maxAgeMs: number, exts: string[]): Promise<number> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const f of files) {
    if (!exts.some((e) => f.toLowerCase().endsWith(e))) continue;
    const path = join(dir, f);
    try {
      if ((await stat(path)).mtimeMs < cutoff) {
        await unlink(path);
        removed++;
      }
    } catch {
      /* already gone */
    }
  }
  return removed;
}

/**
 * Folds finished rtl_power sweeps (CSV) into the 7-day spectrum table, then deletes them.
 * rtl_power rows: date, time, hz_low, hz_high, hz_step, samples, dB, dB, …
 */
export async function ingestSpectrum(dir: string, store: Store): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.csv'));
  } catch {
    return 0;
  }
  let ingested = 0;
  for (const f of files) {
    const path = join(dir, f);
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs < 30_000) continue; // still being written
      const bins = new Map<number, number>();
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        const cols = line.split(',').map((c) => c.trim());
        if (cols.length < 7) continue;
        const low = Number(cols[2]);
        const step = Number(cols[4]);
        for (let i = 6; i < cols.length; i++) {
          const db = Number(cols[i]);
          const b = binOf(low + (i - 6) * step);
          if (!Number.isFinite(db) || b < 0 || b >= SPECTRUM_BINS) continue;
          bins.set(b, Math.max(bins.get(b) ?? -Infinity, db));
        }
      }
      if (bins.size) store.addSpectrum(Math.floor(st.mtimeMs / 3600_000), bins);
      await unlink(path);
      ingested++;
    } catch (e) {
      console.warn(`spectrum ${f}:`, (e as Error).message);
    }
  }
  return ingested;
}
