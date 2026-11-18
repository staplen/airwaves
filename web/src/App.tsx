import { useEffect, useMemo, useState } from 'react';
import { About } from './components/About.tsx';
import { Dial } from './components/Dial.tsx';
import { Feed } from './components/Feed.tsx';
import { MapView } from './components/MapView.tsx';
import { RotationStrip } from './components/RotationStrip.tsx';
import { Totals } from './components/Totals.tsx';
import { SensorPins } from './components/SensorPins.tsx';
import { isStatic } from './api.ts';
import { ago, useLive } from './live.ts';

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
  const view = useMemo(() => (snapshot ? { ...snapshot, now: Math.max(snapshot.now, tick) } : undefined), [snapshot, tick]);
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

  return (
    <div className="page">
      <header className="top">
        <svg className="logo" width="28" height="28" viewBox="0 0 32 32" role="img" aria-label={connected ? 'Airwaves, live' : 'Airwaves, reconnecting'}>
          <title>Airwaves</title>
          <circle cx="16" cy="16" r="3.2" fill={connected ? '#4ade80' : '#8b93a1'} />
          <path d="M11.76 11.76 A6 6 0 0 0 11.76 20.24 M20.24 11.76 A6 6 0 0 1 20.24 20.24 M8.22 8.22 A11 11 0 0 0 8.22 23.78 M23.78 8.22 A11 11 0 0 1 23.78 23.78" fill="none" stroke="#e6e9ee" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        <RotationStrip snapshot={view} expanded={dialOpen} onToggle={toggle} />
        {stale && <span className="muted top-time">Last updated {ago(snapshot.publishedAt, Date.now())}</span>}
        {!connected && <span className="muted top-time">Reconnecting…</span>}
        <About />
      </header>
      {dialOpen && <Dial snapshot={view} />}
      <Totals snapshot={view} />
      <SensorPins snapshot={view} />
      <div className="main">
        <MapView snapshot={snapshot} />
        <Feed items={feed} />
      </div>
    </div>
  );
}
