// Lets other parts of the page (the header loop strip) set the feed's type filter.

/** Feed types each decoder slot produces. Slots with no feed items (spectrum) aren't listed. */
export const SOURCE_TYPES: Record<string, string[]> = {
  adsb: ['aircraft'],
  atc: ['atc'],
  vdl2: ['datalink'],
  ais: ['ships', 'family:sea'],
  ism: ['street', 'sensors', 'meter', 'family:home'],
  noaa: ['radio', 'alerts'],
  sonde: ['balloons'],
  hdradio: ['radio-hd', 'family:bcast'],
  trains: ['trains', 'family:rail'],
};

const EVENT = 'airwaves:feed-only';

/** Show only the feed types that come from this slot. */
export function showOnlySource(sourceId: string): void {
  const types = SOURCE_TYPES[sourceId];
  if (types) window.dispatchEvent(new CustomEvent<string[]>(EVENT, { detail: types }));
}

export function onShowOnly(handler: (types: string[]) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<string[]>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
