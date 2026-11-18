import { useRef, useState } from 'react';
import type { PinMetric, Snapshot } from '../../../shared/types.ts';
import { apiUrl, isStatic } from '../api.ts';
import { ago } from '../live.ts';

/** Local-only dialog: pick recurring sensors whose temperature or humidity shows with the top stats. */
export function SensorPins({ snapshot }: { snapshot?: Snapshot }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const sensors = snapshot?.sensors ?? [];
  if (isStatic || !snapshot?.sensors) return null;
  const now = snapshot.now;
  const pinned = (key: string, metric: PinMetric) => snapshot.pinned?.find((p) => p.key === key && p.metric === metric);

  const toggle = async (key: string, metric: PinMetric) => {
    setBusy(true);
    const on = pinned(key, metric);
    const label = labels[`${key}|${metric}`] ?? (metric === 'temperatureF' ? 'outdoor temp' : 'outdoor humidity');
    await fetch(apiUrl('pins'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, metric, label, remove: Boolean(on) }) }).catch(() => {});
    setBusy(false);
  };

  return (
    <>
      <button type="button" className="pin-open" onClick={() => dialog.current?.showModal()}>
        Pin a sensor reading…
      </button>
      <dialog ref={dialog} className="about" aria-labelledby="pins-title" onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
        <div className="about-body">
          <h2 id="pins-title">Pin a sensor reading</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Sensors heard over the last day, most frequent first. A sensor heard many times a day (a neighbour's weather station, say) makes a steady reading for
            the stats row. Changes take effect within a few seconds.
          </p>
          {sensors.length === 0 && <p className="muted">No sensors heard in the last day.</p>}
          <div className="pin-list">
            {sensors.map((x) => (
              <div key={x.key} className="pin-row">
                <div style={{ minWidth: 0 }}>
                  <div className="pin-model">{x.model}</div>
                  <div className="muted mono" style={{ fontSize: 11 }}>
                    {x.summary || 'no readings'} · {x.heardToday}× today · {ago(x.lastSeen, now)}
                  </div>
                </div>
                <div className="pin-actions">
                  {(['temperatureF', 'humidity'] as const)
                    .filter((m) => x[m] !== undefined)
                    .map((m) => {
                      const on = pinned(x.key, m);
                      const id = `${x.key}|${m}`;
                      return (
                        <div key={m} className="pin-action">
                          {!on && (
                            <input
                              aria-label="Label"
                              value={labels[id] ?? (m === 'temperatureF' ? 'outdoor temp' : 'outdoor humidity')}
                              onChange={(e) => setLabels({ ...labels, [id]: e.target.value })}
                            />
                          )}
                          <button type="button" className={on ? 'pin-btn on' : 'pin-btn'} disabled={busy} onClick={() => void toggle(x.key, m)}>
                            {on ? `Unpin ${on.label}` : `Pin ${m === 'temperatureF' ? `${Math.round(x.temperatureF!)}°F` : `${x.humidity}%`}`}
                          </button>
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
          <div className="about-actions">
            <button type="button" className="pin-btn" onClick={() => dialog.current?.close()}>Done</button>
          </div>
        </div>
      </dialog>
    </>
  );
}
