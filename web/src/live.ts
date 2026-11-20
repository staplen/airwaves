import { useEffect, useState } from 'react';
import type { FeedItem, Rotation, Snapshot } from '../../shared/types.ts';
import { apiUrl, isStatic } from './api.ts';

const STATIC_POLL_MS = 15_000;

export interface Live {
  snapshot?: Snapshot;
  feed: FeedItem[];
  connected: boolean;
}

const newestFirst = (a: FeedItem, b: FeedItem) => b.ts - a.ts || b.id - a.id;

/** Matches the collector: the newest 60 items of each kind, so busy ATC doesn't push out songs and weather. */
const PER_KIND = 60;
function trimPerKind(items: FeedItem[]): FeedItem[] {
  const seen = new Map<string, number>();
  return items.filter((i) => {
    const n = (seen.get(i.kind) ?? 0) + 1;
    seen.set(i.kind, n);
    return n <= PER_KIND;
  });
}

/** Loads the initial state, then follows the collector's event stream (or polls the published JSON files). */
export function useLive(): Live {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let closed = false;
    if (isStatic) {
      const poll = async () => {
        const bust = `?t=${Date.now()}`;
        try {
          const [snap, items] = await Promise.all([
            fetch(apiUrl('snapshot') + bust).then((r) => (r.ok ? (r.json() as Promise<Snapshot>) : Promise.reject(new Error(String(r.status))))),
            fetch(apiUrl('feed') + bust).then((r) => (r.ok ? (r.json() as Promise<FeedItem[]>) : Promise.reject(new Error(String(r.status))))),
          ]);
          if (closed) return;
          setSnapshot(snap);
          setFeed((f) => {
            // Keep the existing objects for unchanged items, and the same array if nothing changed at all,
            // so a poll that brings nothing new doesn't re-render the feed.
            const byId = new Map(f.map((x) => [x.id, x]));
            let changed = false;
            for (const i of items) {
              const old = byId.get(i.id);
              if (old && JSON.stringify(old) === JSON.stringify(i)) continue;
              byId.set(i.id, i);
              changed = true;
            }
            if (!changed) return f;
            const next = trimPerKind([...byId.values()].sort(newestFirst));
            return next.length === f.length && next.every((x, k) => x === f[k]) ? f : next;
          });
          setConnected(true);
        } catch {
          if (!closed) setConnected(false);
        }
      };
      void poll();
      const t = setInterval(poll, STATIC_POLL_MS);
      return () => {
        closed = true;
        clearInterval(t);
      };
    }
    fetch(apiUrl('snapshot'))
      .then((r) => r.json())
      .then((d: { snapshot: Snapshot; feed: FeedItem[] }) => {
        if (closed) return;
        setSnapshot(d.snapshot);
        setFeed(d.feed);
      })
      .catch(() => {});

    const es = new EventSource(apiUrl('stream'));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('snapshot', (e) => setSnapshot(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('feed', (e) => {
      const item = JSON.parse((e as MessageEvent).data) as FeedItem;
      setFeed((f) => (f.some((x) => x.id === item.id) ? f : trimPerKind([item, ...f])));
    });
    return () => {
      closed = true;
      es.close();
    };
  }, []);

  return { snapshot, feed, connected };
}

export function ago(ts: number | undefined, now: number): string {
  if (!ts) return 'not heard yet';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/** Slot length: "30 s" under a minute, else "3 min". */
export function dur(minutes: number): string {
  return minutes < 1 ? `${Math.round(minutes * 60)} s` : `${minutes} min`;
}

/** Display name for a slot whose source the collector doesn't list (e.g. "trains" → "Trains"). */
export const slotName = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** Typical pause between one slot ending and the next starting (stop, remove, start). */
export const SWITCH_GAP_MS = 5000;

/**
 * Moves the rotation forward on the viewer's clock when data is late. The published copy only
 * refreshes every 15–45 s, longer than most slots, so without this it would sit on "0:00" or
 * "switching" for most of each slot. Real data replaces the guess as soon as it arrives.
 */
export function predictRotation(rot: Rotation, now: number, freqOf: (id: string) => number | undefined): Rotation {
  const loop = rot.loop;
  if (rot.mode !== 'rotating' || !loop?.length || rot.index === undefined || !rot.current?.endsAt) return rot;
  let index = rot.index;
  let since = rot.current.since;
  let endsAt = rot.current.endsAt;
  let moved = false;
  for (let guard = 0; now >= endsAt + SWITCH_GAP_MS && guard < loop.length * 3; guard++) {
    index = (index + 1) % loop.length;
    since = endsAt + SWITCH_GAP_MS;
    endsAt = since + loop[index].minutes * 60_000;
    moved = true;
  }
  if (!moved) return rot;
  const e = loop[index];
  return {
    ...rot,
    index,
    current: { sourceId: e.sourceId, freqMhz: e.freqMhz ?? freqOf(e.sourceId) ?? rot.current.freqMhz, since, endsAt },
    upNext: [1, 2, 3, 4].map((k) => loop[(index + k) % loop.length]).map((x) => ({ sourceId: x.sourceId, minutes: x.minutes })),
  };
}
