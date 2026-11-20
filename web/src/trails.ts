import type { Tracks } from '../../shared/types.ts';

// Contrails: recent positions as short line segments that fade with age. Points from separate passes
// aren't joined (ADS-B listens ~30 s every ~12 min), except sparse datalink reports, which are.
const JOIN_GAP_S: Record<string, number> = { air: 120, dl: 30 * 60, sea: 30 * 60, ham: 30 * 60 };

export function tracksFC(t: Tracks | undefined, nowMs = Date.now()): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const now = nowMs / 1000;
  for (const tr of t?.tracks ?? []) {
    const gap = JOIN_GAP_S[tr.kind] ?? 120;
    for (let i = 0; i < tr.pts.length; i++) {
      const p = tr.pts[i];
      const q = tr.pts[i + 1];
      const joined = q && q[3] - p[3] <= gap;
      const prevJoined = i > 0 && p[3] - tr.pts[i - 1][3] <= gap;
      if (joined) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[p[0], p[1]], [q[0], q[1]]] },
          properties: { id: tr.id, kind: tr.kind, alt: q[2] ?? p[2] ?? -1, age: Math.max(0, (now - q[3]) / 60), t: q[3] },
        });
      } else if (!prevJoined) {
        // A lone point (one report in a pass): a dot instead of a line.
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p[0], p[1]] }, properties: { id: tr.id, kind: tr.kind, alt: p[2] ?? -1, age: Math.max(0, (now - p[3]) / 60), t: p[3] } });
      }
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Opacity by age in minutes: bright for the last few minutes, faint after a day. */
export const AGE_OPACITY = ['interpolate', ['linear'], ['get', 'age'], 0, 0.9, 30, 0.55, 180, 0.3, 720, 0.14, 1440, 0.05] as const;

/** Aircraft by altitude (low warm, high cool); datalink reports violet; ships teal. */
export const TRAIL_COLOR = [
  'match',
  ['get', 'kind'],
  'dl',
  '#c084fc',
  'sea',
  '#3cc9b4',
  'ham',
  '#9be35a',
  ['case', ['<', ['get', 'alt'], 0], '#8b93a1', ['interpolate', ['linear'], ['get', 'alt'], 0, '#ffb46b', 8000, '#f7e27a', 18000, '#5ab0ff', 36000, '#8f7cff']],
] as const;
