import { useEffect, useState } from 'react';
import type { FeedItem, Snapshot } from '../../shared/types.ts';
import { apiUrl, isStatic } from './api.ts';

const STATIC_POLL_MS = 15_000;

export interface Live {
  snapshot?: Snapshot;
  feed: FeedItem[];
  connected: boolean;
}

const newestFirst = (a: FeedItem, b: FeedItem) => b.ts - a.ts || b.id - a.id;

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
            const byId = new Map(f.map((x) => [x.id, x]));
            for (const i of items) byId.set(i.id, i);
            return [...byId.values()].sort(newestFirst).slice(0, 200);
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
      setFeed((f) => (f.some((x) => x.id === item.id) ? f : [item, ...f].slice(0, 200)));
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
