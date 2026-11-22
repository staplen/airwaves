import { useSyncExternalStore } from 'react';
import { ago } from '../live.ts';

// One shared clock for every card's "N min ago", so the memoised feed itself never re-renders to keep them current.
let clockNow = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(fn: () => void) {
  subs.add(fn);
  timer ??= setInterval(() => {
    clockNow = Date.now();
    subs.forEach((f) => f());
  }, 1000);
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const noSubscribe = () => () => {};

const HOUR_MS = 3600_000;

/** The current time, ticking each second while `ts` is under an hour old; null once it is older. */
function useRecentNow(ts: number): number | null {
  const recent = Date.now() - ts < HOUR_MS;
  const now = useSyncExternalStore(recent ? subscribe : noSubscribe, () => (recent ? clockNow : 0));
  return recent && now - ts < HOUR_MS ? Math.max(now, ts) : null;
}

export const clockTime = (ts: number, sec = false) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: sec ? '2-digit' : undefined });

/** "5:34–5:36 PM", "11:58 AM–12:04 PM", or just "5:38 PM" when the whole run is within one minute (or second, for ATC). */
export function timeRange(from: number, to: number, sec = false): string {
  const a = clockTime(from, sec);
  const b = clockTime(to, sec);
  if (a === b) return b;
  const suffix = (t: string) => t.match(/\s?[AP]\.?M\.?$/i)?.[0] ?? '';
  const sa = suffix(a);
  return sa && sa === suffix(b) ? `${a.slice(0, -sa.length)}–${b}` : `${a}–${b}`;
}

/** "12–3 min ago", "40 s ago–just now", "7:40 AM–12 min ago": a run whose newest end is within the hour. */
export function agoRange(from: number, to: number, now: number, sec = false): string {
  const b = ago(to, now);
  if (now - from >= HOUR_MS) return `${clockTime(from, sec)}–${b}`;
  const a = ago(from, now);
  if (a === b) return b;
  for (const unit of [' min ago', ' s ago']) {
    if (a.endsWith(unit) && b.endsWith(unit)) return `${a.slice(0, -unit.length)}–${b}`;
  }
  return b === 'just now' ? `${a}–just now` : `${a.replace(/ ago$/, '')}–${b}`;
}

/** "just now", "42 s ago", "12 min ago" for the last hour; the exact time in the viewer's own zone after that. */
export function When({ ts, sec = false }: { ts: number; sec?: boolean }) {
  const now = useRecentNow(ts);
  const exact = clockTime(ts, sec);
  const iso = new Date(ts).toISOString();
  return now === null ? <time dateTime={iso}>{exact}</time> : <time dateTime={iso} title={exact}>{ago(ts, now)}</time>;
}

/** A run of items: relative while its newest is within the hour, a clock range after that. */
export function WhenRange({ from, to, sec = false }: { from: number; to: number; sec?: boolean }) {
  const now = useRecentNow(to);
  const exact = timeRange(from, to, sec);
  return now === null ? <span>{exact}</span> : <span title={exact}>{agoRange(from, to, now, sec)}</span>;
}
