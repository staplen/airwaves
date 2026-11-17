import { useEffect, useState } from 'react';
import type { FeedItem, Snapshot } from '../../shared/types.ts';

export interface Live {
  snapshot?: Snapshot;
  feed: FeedItem[];
  connected: boolean;
}

/** Loads the initial state, then follows the collector's event stream. */
export function useLive(): Live {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let closed = false;
    fetch('/api/snapshot')
      .then((r) => r.json())
      .then((d: { snapshot: Snapshot; feed: FeedItem[] }) => {
        if (closed) return;
        setSnapshot(d.snapshot);
        setFeed(d.feed);
      })
      .catch(() => {});

    const es = new EventSource('/api/stream');
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
