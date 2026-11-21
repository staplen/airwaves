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

export function focusOnMap(f: Focus): void {
  window.dispatchEvent(new CustomEvent<Focus>(FOCUS, { detail: f }));
}
export function onMapFocus(handler: (f: Focus) => void): () => void {
  const l = (e: Event) => handler((e as CustomEvent<Focus>).detail);
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
