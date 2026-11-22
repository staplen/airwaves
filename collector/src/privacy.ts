import type { Home } from '../../shared/types.ts';

// The public site gets an approximate receiver location: the real one snapped to a ~5 km grid, then
// moved by a fixed secret offset (random once, kept in the collector's state, never published). The
// offset never changes, so averaging many copies of the public point reveals nothing.

const GRID_DEG = 0.05;
const KM_PER_DEG_LAT = 111.32;

export interface Offset {
  northKm: number;
  eastKm: number;
}

/** A random offset 1.5–4 km away in a random direction. */
export function randomOffset(rand: () => number = Math.random): Offset {
  const dist = 1.5 + 2.5 * rand();
  const bearing = rand() * 2 * Math.PI;
  return { northKm: dist * Math.cos(bearing), eastKm: dist * Math.sin(bearing) };
}

export function approxHome(home: Home, off: Offset): Home {
  const lat = Math.round(home.lat / GRID_DEG) * GRID_DEG;
  const lon = Math.round(home.lon / GRID_DEG) * GRID_DEG;
  const outLat = lat + off.northKm / KM_PER_DEG_LAT;
  const outLon = lon + off.eastKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return { lat: Number(outLat.toFixed(3)), lon: Number(outLon.toFixed(3)), approx: true };
}

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((a.lat - b.lat) * KM_PER_DEG_LAT, (a.lon - b.lon) * KM_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180));
export const DISPLAY_MIN_KM = 1;
export const DISPLAY_MAX_KM = 10;

/**
 * A public stand-in you choose (PUBLIC_HOME_LAT/LON, e.g. a nearby landmark or major intersection) instead of the
 * snapped-and-shifted point. Too close to the real location (it would give it away) or too far (the range rings
 * would mislead) and it's refused with the reason, so the caller can fall back to approxHome.
 */
export function displayHome(home: Home, lat: number, lon: number): Home | { refused: string } {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { refused: 'not a number' };
  const d = km(home, { lat, lon });
  if (d < DISPLAY_MIN_KM) return { refused: `only ${d.toFixed(1)} km from the real location (needs ${DISPLAY_MIN_KM}+)` };
  if (d > DISPLAY_MAX_KM) return { refused: `${d.toFixed(1)} km from the real location (keep it within ${DISPLAY_MAX_KM})` };
  return { lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)), approx: true };
}
