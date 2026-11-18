import { useEffect, useMemo, useState } from 'react';
import { About } from './components/About.tsx';
import { Dial } from './components/Dial.tsx';
import { Feed } from './components/Feed.tsx';
import { MapView } from './components/MapView.tsx';
import { RadioNow } from './components/RadioNow.tsx';
import { RotationStrip } from './components/RotationStrip.tsx';
import { Totals } from './components/Totals.tsx';
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
        <svg className="logo" width="26" height="26" viewBox="0 0 28 28" role="img" aria-label={connected ? 'Airwaves, live' : 'Airwaves, reconnecting'}>
          <title>Airwaves</title>
          <circle cx="14" cy="14" r="3" fill={connected ? '#4ade80' : '#8b93a1'} />
          <path d="M8 8 A8.5 8.5 0 0 0 8 20 M20 8 A8.5 8.5 0 0 1 20 20 M4 4 A14 14 0 0 0 4 24 M24 4 A14 14 0 0 1 24 24" fill="none" stroke="#e6e9ee" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <RotationStrip snapshot={view} expanded={dialOpen} onToggle={toggle} />
        {stale && <span className="muted top-time">Last updated {ago(snapshot.publishedAt, Date.now())}</span>}
        {!connected && <span className="muted top-time">Reconnecting…</span>}
        <About />
      </header>
      {dialOpen && <Dial snapshot={view} />}
      <Totals snapshot={view} />
      <RadioNow snapshot={view} />
      <div className="main">
        <MapView snapshot={snapshot} />
        <Feed items={feed} />
      </div>
    </div>
  );
}
