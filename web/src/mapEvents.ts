import { useSyncExternalStore } from 'react';
import type { Family } from '../../shared/types.ts';

// The feed talks to the map through two window events: "show this on the map" (a card's locate button) and
// "these families are filtered in" (the feed's type filter), so the map can fly to a catch or dim the rest.

export interface Focus {
  ref?: string; // "air:<hex>", "sea:<mmsi>", "aprs:<call>", "balloon:<id>", "site:<id>": the live object, if still on the map
  lat?: number; // where the card says it happened (used when the object isn't on the map any more)
  lon?: number;
  label?: string;
}

const FOCUS = 'airwaves:map-focus';
const FILTER = 'airwaves:map-filter';

/** One target flies to it; several fit the map around all of them. */
export function focusOnMap(f: Focus | Focus[]): void {
  window.dispatchEvent(new CustomEvent<Focus[]>(FOCUS, { detail: Array.isArray(f) ? f : [f] }));
}
export function onMapFocus(handler: (fs: Focus[]) => void): () => void {
  const l = (e: Event) => handler((e as CustomEvent<Focus[]>).detail);
  window.addEventListener(FOCUS, l);
  return () => window.removeEventListener(FOCUS, l);
}

/** null = everything shown (no dimming). */
let lastFilter: Family[] | null = null;
export function setMapFilter(families: Family[] | null): void {
  lastFilter = families;
  window.dispatchEvent(new CustomEvent<Family[] | null>(FILTER, { detail: families }));
}
export function onMapFilter(handler: (families: Family[] | null) => void): () => void {
  const l = (e: Event) => handler((e as CustomEvent<Family[] | null>).detail);
  window.addEventListener(FILTER, l);
  handler(lastFilter); // the map may mount after the feed has set its filter
  return () => window.removeEventListener(FILTER, l);
}

// Where a target is now: the map registers a locator (live object, then where the card says, then the last point of
// its trail) and says when positions change, so a card shows its pin only while there is somewhere to go.
type Locator = (f: Focus) => [number, number] | undefined;
let locator: Locator | null = null;
const posSubs = new Set<() => void>();
export function setLocator(fn: Locator | null): void {
  locator = fn;
  positionsChanged();
}
export function positionsChanged(): void {
  posSubs.forEach((f) => f());
}
const subscribePositions = (fn: () => void) => {
  posSubs.add(fn);
  return () => posSubs.delete(fn);
};
export function locate(f: Focus): [number, number] | undefined {
  if (locator) return locator(f);
  return f.lat !== undefined && f.lon !== undefined ? [f.lon, f.lat] : undefined;
}
/** True while at least one target can be shown on the map. */
export function useLocatable(targets: Focus[]): boolean {
  return useSyncExternalStore(subscribePositions, () => targets.some((t) => locate(t) !== undefined));
}
