import type { TrackKind, Tracks } from '../../shared/types.ts';

// Recent positions per aircraft, datalink flight and ship, for the map's fading "contrails".
// A ring buffer in memory (saved with the other state so deploys don't wipe it): points older than
// the window are dropped, and a point is only added when the object has moved or some time has passed.

interface Track {
  kind: TrackKind;
  label?: string;
  pts: [number, number, number | null, number][]; // lon, lat, altitude ft (null = unknown or ground), unix seconds
}

const MIN_GAP_S = 15; // at most one point per object every 15 s
const MIN_MOVE_DEG = 0.002; // ~200 m: a stationary object doesn't pile up points
const MAX_PTS = 400;

export class TrackStore {
  private tracks = new Map<string, Track>();
  private windowS: number;

  constructor(windowMs = 24 * 3600_000) {
    this.windowS = windowMs / 1000;
  }

  add(kind: TrackKind, id: string, lon: number, lat: number, altFt: number | null | undefined, ts: number, label?: string) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;
    const key = `${kind}:${id}`;
    let t = this.tracks.get(key);
    if (!t) this.tracks.set(key, (t = { kind, pts: [] }));
    if (label) t.label = label;
    const s = Math.round(ts / 1000);
    const last = t.pts[t.pts.length - 1];
    if (last && (s - last[3] < MIN_GAP_S || Math.abs(last[0] - lon) + Math.abs(last[1] - lat) < MIN_MOVE_DEG)) return;
    t.pts.push([Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5, altFt == null || !Number.isFinite(altFt) ? null : Math.round(altFt), s]);
    if (t.pts.length > MAX_PTS) t.pts.shift();
  }

  prune(now = Date.now()) {
    const cutoff = now / 1000 - this.windowS;
    for (const [k, t] of this.tracks) {
      let i = 0;
      while (i < t.pts.length && t.pts[i][3] < cutoff) i++;
      if (i) t.pts.splice(0, i);
      if (!t.pts.length) this.tracks.delete(k);
    }
  }

  /** The map's view: every track with points in the window. */
  export(now = Date.now()): Tracks {
    this.prune(now);
    return { now, tracks: [...this.tracks].map(([k, t]) => ({ id: k, kind: t.kind, label: t.label, pts: t.pts })) };
  }

  load(saved: Tracks | undefined, now = Date.now()) {
    for (const t of saved?.tracks ?? []) this.tracks.set(t.id, { kind: t.kind, label: t.label, pts: t.pts });
    this.prune(now);
  }
}
