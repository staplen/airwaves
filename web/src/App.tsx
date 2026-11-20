import { useEffect, useMemo, useState } from 'react';
import { About } from './components/About.tsx';
import { Dial } from './components/Dial.tsx';
import { Feed } from './components/Feed.tsx';
import { MapView } from './components/MapView.tsx';
import { LoopBand } from './components/LoopBand.tsx';
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

  return (
    <div className="page">
      <h1 className="sr-only">Airwaves</h1>
      <LoopBand
        part="head"
        snapshot={view}
        start={
          <div className="lb-brand">
            <svg className="logo" width="22" height="22" viewBox="0 0 32 32" role="img" aria-label={connected ? 'Airwaves, live' : 'Airwaves, reconnecting'}>
              <title>Airwaves</title>
              <circle cx="16" cy="16" r="3.2" fill={connected ? '#4ade80' : '#8b93a1'} />
              <path d="M11.76 11.76 A6 6 0 0 0 11.76 20.24 M20.24 11.76 A6 6 0 0 1 20.24 20.24 M8.22 8.22 A11 11 0 0 0 8.22 23.78 M23.78 8.22 A11 11 0 0 1 23.78 23.78" fill="none" stroke="#e6e9ee" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            <span className="lb-title">Airwaves</span>
            {!connected ? <span className="lb-status">Reconnecting…</span> : stale ? <span className="lb-status">Updated {ago(snapshot.publishedAt, Date.now())}</span> : null}
          </div>
        }
        end={
          <div className="lb-end">
            <button type="button" className="strip-toggle" aria-expanded={dialOpen} aria-label={dialOpen ? 'Hide receiver details' : 'Show receiver details'} title="Receiver dial and spectrum" onClick={toggle}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ transform: dialOpen ? 'rotate(180deg)' : undefined }}>
                <path d="M3 5 L7 9 L11 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <About />
          </div>
        }
      />
      {/* Wide screens: the on-air card, dial, pins and map on the left; the feed alongside from the top. */}
      <div className="main">
        <div className="maincol">
          <LoopBand part="onair" snapshot={view} />
          {dialOpen && <Dial snapshot={view} />}
          <SensorPins snapshot={view} />
          <MapView snapshot={snapshot} />
        </div>
        <div className="feedcol">
          <Feed items={feed} />
        </div>
      </div>
    </div>
  );
}
