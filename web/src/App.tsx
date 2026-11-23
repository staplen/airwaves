import { useEffect, useMemo, useState } from 'react';
import { About } from './components/About.tsx';
import { Dial } from './components/Dial.tsx';
import { Feed } from './components/Feed.tsx';
import { MapView } from './components/MapView.tsx';
import { Scanner } from './components/Scanner.tsx';
import { SensorPins } from './components/SensorPins.tsx';
import { isStatic } from './api.ts';
import { ago, predictRotation, useLive } from './live.ts';

const STALE_MS = 3 * 60_000;
const DIAL_KEY = 'airwaves.dialOpen';

function readOpen(): boolean {
  try {
    return localStorage.getItem(DIAL_KEY) === '1';
  } catch {
    return false;
  }
}

export function App() {
  const { snapshot, feed, connected } = useLive();
  // Tick once a second so countdowns and "heard N min ago" move between data updates
  // (the published copy only refreshes its data every 30 s).
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const view = useMemo(() => {
    if (!snapshot) return undefined;
    const now = Math.max(snapshot.now, tick);
    const freqOf = (id: string) => snapshot.sources.find((x) => x.id === id)?.freqMhz;
    return { ...snapshot, now, rotation: predictRotation(snapshot.rotation, now, freqOf) };
  }, [snapshot, tick]);
  const stale = isStatic && snapshot?.publishedAt !== undefined && Date.now() - snapshot.publishedAt > STALE_MS;
  const [dialOpen, setDialOpen] = useState(readOpen);

  const toggle = () =>
    setDialOpen((v) => {
      try {
        localStorage.setItem(DIAL_KEY, v ? '0' : '1');
      } catch {
        /* per-viewer convenience only */
      }
      return !v;
    });

  const status = !connected ? 'Reconnecting…' : stale ? `Updated ${ago(snapshot.publishedAt, Date.now())}` : undefined;

  // The map fills the window above the scanner footer; the feed floats over its right side, the dial over its bottom.
  return (
    <div className="page">
      <h1 className="sr-only">Airwaves</h1>
      <div className="stage">
        <MapView snapshot={snapshot} />
        <div className="feedfloat">
          <Feed items={feed} />
        </div>
        {dialOpen && (
          <div className="dialpop">
            <Dial snapshot={view} />
            <SensorPins snapshot={view} />
          </div>
        )}
      </div>
      <Scanner snapshot={view} connected={connected} status={status} dialOpen={dialOpen} onToggleDial={toggle} end={<About />} />
    </div>
  );
}
