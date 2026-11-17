import { Dial } from './components/Dial.tsx';
import { Feed } from './components/Feed.tsx';
import { MapView } from './components/MapView.tsx';
import { Totals } from './components/Totals.tsx';
import { useLive } from './live.ts';

export function App() {
  const { snapshot, feed, connected } = useLive();
  const time = new Date(snapshot?.now ?? Date.now()).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 28 28" aria-hidden="true">
            <circle cx="14" cy="14" r="3" fill={connected ? '#4ade80' : '#8b93a1'} />
            <path d="M8 8 A8.5 8.5 0 0 0 8 20 M20 8 A8.5 8.5 0 0 1 20 20 M4 4 A14 14 0 0 0 4 24 M24 4 A14 14 0 0 1 24 24" fill="none" stroke="#e6e9ee" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <b>Airwaves</b>
          <span className="muted" style={{ fontSize: 13 }}>Everything floating past the house</span>
        </div>
        <span className="mono muted" style={{ fontSize: 13 }}>
          {connected ? time : 'Reconnecting to collector…'}
        </span>
      </header>
      <Dial snapshot={snapshot} />
      <div className="main">
        <MapView snapshot={snapshot} />
        <Feed items={feed} />
      </div>
      <Totals snapshot={snapshot} />
    </div>
  );
}
