import { useEffect, useState } from 'react';
import type { Family, SpectrumHeat } from '../../shared/types.ts';
import { apiUrl } from './api.ts';
import { BANDS, dialX } from './bands.ts';

const REFRESH_MS = 5 * 60_000;

// One fetch shared by every component that wants the heatmap (the dial and the scanner footer).
let cache: SpectrumHeat | undefined;
let inflight: Promise<void> | undefined;
let lastLoad = 0;
const listeners = new Set<(h: SpectrumHeat) => void>();

function load(): void {
  if (inflight || Date.now() - lastLoad < REFRESH_MS / 2) return;
  inflight = fetch(apiUrl('spectrum'))
    .then((r) => (r.ok ? (r.json() as Promise<SpectrumHeat>) : undefined))
    .then((h) => {
      if (!h) return;
      cache = h;
      lastLoad = Date.now();
      for (const l of listeners) l(h);
    })
    .catch(() => {})
    .finally(() => (inflight = undefined));
}

/** The last 24 hours of spectrum sweeps, refreshed every 5 minutes. */
export function useSpectrum(): SpectrumHeat | undefined {
  const [heat, setHeat] = useState<SpectrumHeat | undefined>(cache);
  useEffect(() => {
    listeners.add(setHeat);
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      listeners.delete(setHeat);
      clearInterval(t);
    };
  }, []);
  return heat;
}

/** Heatmap bins covering a family's bands: its own bands plus any band one of its slots listens in (AIS sits in NOAA·AIS). */
function familyBins(family: Family, slotIds: string[], bins: number): number[] {
  const out = new Set<number>();
  for (const b of BANDS) {
    if (b.family !== family && !b.sourceIds.some((id) => slotIds.includes(id))) continue;
    const lo = Math.max(0, Math.floor((dialX(b.lo) / 100) * bins));
    const hi = Math.min(bins - 1, Math.max(lo, Math.ceil((dialX(b.hi) / 100) * bins) - 1));
    for (let i = lo; i <= hi; i++) out.add(i);
  }
  return [...out];
}

const HOURS = 24;
// The smallest swing (dB) treated as the full range, so a quiet, flat band doesn't get its noise blown up into stripes.
const MIN_SPAN_DB = 6;

/**
 * A family's last 24 hours as a CSS gradient, oldest hour on the left: the strongest reading in its bins each hour,
 * scaled to the family's own range. Busy hours leave the family colour bright, quiet hours shade it; hours with no
 * sweep sit in between. `depth` is how dark the quietest hour gets. Undefined when there's no sweep at all for these bins.
 */
export function familyStriation(heat: SpectrumHeat | undefined, family: Family, slotIds: string[], nowMs = Date.now(), depth = 0.68): string | undefined {
  if (!heat?.rows.length) return undefined;
  const idx = familyBins(family, slotIds, heat.bins);
  if (!idx.length) return undefined;
  const byHour = new Map(heat.rows.map((r) => [r.hour, r.db]));
  const nowHour = Math.floor(nowMs / 3600_000);
  const vals: (number | null)[] = [];
  for (let h = nowHour - HOURS + 1; h <= nowHour; h++) {
    const row = byHour.get(h);
    let best: number | null = null;
    if (row) for (const i of idx) { const v = row[i]; if (v !== null && v !== undefined && (best === null || v > best)) best = v; }
    vals.push(best);
  }
  const real = vals.filter((v): v is number => v !== null);
  if (!real.length) return undefined;
  const lo = Math.min(...real);
  const span = Math.max(Math.max(...real) - lo, MIN_SPAN_DB);
  const stops = vals.map((v, i) => {
    const shade = v === null ? depth * 0.62 : depth * (1 - (v - lo) / span);
    return `rgba(11,14,19,${shade.toFixed(2)}) ${((i / (HOURS - 1)) * 100).toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
