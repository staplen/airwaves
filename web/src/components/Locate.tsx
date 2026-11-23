import type { FeedItem } from '../../../shared/types.ts';
import { focusOnMap, useLocatable, type Focus } from '../mapEvents.ts';

/** What a feed item can point at on the map, or nothing if it carries no place at all. */
export function focusOf(i: FeedItem): Focus | undefined {
  return i.ref || (i.lat !== undefined && i.lon !== undefined) ? { ref: i.ref, lat: i.lat, lon: i.lon, approxKm: i.approxKm, label: i.title } : undefined;
}

/** Map pin for a card: hidden when none of its targets can be found (an aircraft long gone with no position heard). */
export function LocateButton({ targets, label }: { targets: Focus[]; label: string }) {
  const ok = useLocatable(targets);
  if (!ok) return null;
  return (
    <button type="button" className="locate" aria-label={label} title={targets.length > 1 ? 'Show them all on the map' : 'Show on the map'} onClick={() => focusOnMap(targets)}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5a4 4 0 0 0-4 4c0 3 4 7 4 7s4-4 4-7a4 4 0 0 0-4-4Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><circle cx="7" cy="5.5" r="1.4" fill="currentColor" /></svg>
    </button>
  );
}
