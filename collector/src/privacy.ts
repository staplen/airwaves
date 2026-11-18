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
