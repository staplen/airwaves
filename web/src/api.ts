/**
 * One build serves two ways. The published, read-only copy (nicostaple.com/airwaves) reads the
 * JSON files the collector uploads next to index.html (all URLs relative, so the site can live
 * under a sub-path). Everywhere else (the Pi, a Cloudflare tunnel to it, the dev server) the
 * dashboard talks to the collector's /api live. `?mode=live` or `?mode=static` overrides.
 */
function detectStatic(): boolean {
  const override = new URLSearchParams(location.search).get('mode');
  if (override === 'live') return false;
  if (override === 'static') return true;
  if (import.meta.env.DEV) return false;
  return /(^|\.)nicostaple\.com$/.test(location.hostname) || location.pathname.startsWith('/airwaves');
}

export const isStatic = detectStatic();

export type ApiKind = 'snapshot' | 'feed' | 'spectrum' | 'overlays' | 'stream';

/** URL for a data endpoint: `/api/<kind>` live, `data/<kind>.json` (relative) in the static copy. */
export function apiUrl(kind: ApiKind): string {
  return isStatic ? `data/${kind}.json` : `/api/${kind}`;
}
