import { useEffect, useRef, useState } from 'react';
import type { WwtAnswer, WwtCandidate } from '../../../shared/types.ts';
import { LocateButton } from './Locate.tsx';

// "What was that?": one tap asks the collector to put the radio on aircraft right now, then shows
// what came lowest and closest around the moment of the tap. Live dashboard only (it changes what
// the radio listens to, so the public copy never shows it).

const POLL_MS = 1000;
const KEEP_POLLING_MS = 60_000; // keep refining while the card is open, then settle
const DONE = new Set<WwtAnswer['status']>(['answer', 'nothing', 'no-radio']);

const STATUS: Record<WwtAnswer['status'], string> = {
  tuning: 'Tuning to aircraft',
  listening: 'Listening',
  answer: 'Best match',
  nothing: 'Nothing close',
  'no-radio': 'No answer',
};

function line(c: WwtCandidate): string {
  const name = c.typeDesc ?? c.flight ?? c.reg ?? c.hex.toUpperCase();
  const alt = c.altFt !== undefined ? `${c.altFt.toLocaleString('en-US')} ft` : 'alt ?';
  const where = c.positioned ? `${c.groundMi} mi${c.bearing ? ` ${c.bearing}` : ''}` : `~${c.slantMi} mi (signal)`;
  return `${name} · ${alt} · ${where}`;
}

export function WhatWasThat() {
  const [answer, setAnswer] = useState<WwtAnswer>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const run = useRef(0); // bumps on each new ask, so an older poll loop stops

  const ask = async () => {
    const id = ++run.current;
    setOpen(true);
    setError(undefined);
    setAnswer(undefined);
    try {
      const r = await fetch('/api/wwt', { method: 'POST' });
      if (!r.ok) throw new Error(r.status === 403 ? 'Only works on the home network.' : `Error ${r.status}`);
      let a = (await r.json()) as WwtAnswer;
      while (run.current === id) {
        setAnswer(a);
        if (Date.now() - a.at > KEEP_POLLING_MS || (a.status === 'no-radio')) break;
        await new Promise((res) => setTimeout(res, POLL_MS));
        if (run.current !== id) break;
        const g = await fetch(`/api/wwt?at=${a.at}`);
        if (!g.ok) throw new Error(`Error ${g.status}`);
        a = (await g.json()) as WwtAnswer;
      }
    } catch (e) {
      if (run.current === id) setError(e instanceof Error ? e.message : String(e));
    }
  };

  const close = () => {
    run.current++;
    setOpen(false);
  };
  useEffect(() => () => void run.current++, []);

  const best = answer?.candidates[0];
  const others = answer?.status === 'answer' ? answer.candidates.slice(1) : answer?.candidates ?? [];
  const busy = !error && (!answer || !DONE.has(answer.status));

  return (
    <div className="wwt">
      {open && (
        <div className="wwt-card card" role="status" aria-live="polite">
          <div className="wwt-head">
            <span className="lbl">
              {busy && <span className="wwt-pulse" aria-hidden="true" />}
              {error ? 'No answer' : answer ? STATUS[answer.status] : 'Asking'}
              {answer && answer.heard > 0 && <span className="wwt-heard"> · {answer.heard} aircraft heard</span>}
            </span>
            <button type="button" className="wwt-x" aria-label="Close" onClick={close}>×</button>
          </div>
          <p className="wwt-say">{error ?? answer?.say ?? 'Asking…'}</p>
          {answer?.status === 'answer' && best && (
            <div className="wwt-best">
              <span className="muted mono">{[best.flight, best.reg, best.hex.toUpperCase()].filter(Boolean).join(' · ')}</span>
              {best.positioned && <LocateButton targets={[{ ref: `air:${best.hex}`, label: best.typeDesc ?? best.flight }]} label="Show it on the map" />}
            </div>
          )}
          {others.length > 0 && (
            <ul className="wwt-others">
              {others.map((c) => (
                <li key={c.hex}>
                  <span>{line(c)}</span>
                  {c.positioned && <LocateButton targets={[{ ref: `air:${c.hex}`, label: c.typeDesc ?? c.flight }]} label="Show it on the map" />}
                </li>
              ))}
            </ul>
          )}
          {!busy && (
            <button type="button" className="tog wwt-again" onClick={ask}>
              Ask again
            </button>
          )}
        </div>
      )}
      <button type="button" className="tog wwt-btn" onClick={ask} title="Put the radio on aircraft now and find what's lowest and closest">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.5 9.4 6l4.6 1.5-4.6 1.5L8 13.5 6.6 9 2 7.5 6.6 6Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
        What was that?
      </button>
    </div>
  );
}
