import { useEffect, useMemo, useRef, useState } from 'react';

const BARS = 48;

// Only one clip plays at a time across the whole feed.
let playing: HTMLAudioElement | null = null;

/** Deterministic bar heights from the clip URL: looks like speech, costs nothing. */
function bars(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507)), ((h >>> 0) % 1000) / 1000);
  const out: number[] = [];
  let level = 0.4;
  for (let i = 0; i < BARS; i++) {
    // Speech-like: words (louder runs) separated by short dips, tapering at both ends.
    if (rnd() < 0.18) level = 0.15 + rnd() * 0.2;
    else level = Math.min(1, Math.max(0.2, level + (rnd() - 0.45) * 0.5));
    const taper = Math.min(1, (i + 1) / 5, (BARS - i) / 5);
    out.push(Math.max(0.12, level * taper));
  }
  return out;
}

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const t = Math.floor(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export function ClipPlayer({ src, color, label, compact }: { src: string; color: string; label: string; compact?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [isPlaying, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const heights = useMemo(() => bars(src), [src]);

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    let raf = 0;
    // Duration can be Infinity when the server doesn't send a length; fall back to how much
    // has loaded (these clips are a few KB, so that's the whole clip almost immediately).
    const knownDuration = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) return a.duration;
      return a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0;
    };
    const tick = () => {
      const d = knownDuration();
      if (d > 0) {
        setDuration(d);
        setProgress(Math.min(1, a.currentTime / d));
      }
      raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      setPlaying(false);
      cancelAnimationFrame(raf);
    };
    const onEnd = () => {
      stop();
      setProgress(0);
    };
    const onMeta = () => setDuration(knownDuration());
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', stop);
    a.addEventListener('ended', onEnd);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta);
    return () => {
      a.removeEventListener('durationchange', onMeta);
      cancelAnimationFrame(raf);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', stop);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('loadedmetadata', onMeta);
    };
  }, []);

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) {
      if (playing && playing !== a) playing.pause();
      playing = a;
      void a.play();
    } else a.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audio.current;
    if (!a) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const go = () => {
      a.currentTime = f * a.duration;
      setProgress(f);
    };
    if (Number.isFinite(a.duration) && a.duration > 0) go();
    else a.addEventListener('loadedmetadata', go, { once: true });
    if (a.paused) toggle();
  };

  // Bars brighten progressively: played bars full, the bar under the playhead part-way, the rest dim.
  const pos = progress * BARS;
  return (
    <div className={`clipper${isPlaying ? ' playing' : ''}${compact ? ' compact' : ''}`} style={{ ['--clip-color' as string]: color }}>
      <button type="button" className="clipper-btn" onClick={toggle} aria-label={`${isPlaying ? 'Pause' : 'Play'} ${label}`}>
        {isPlaying ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor" /><rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5 L10.5 6 L3 10.5 Z" fill="currentColor" /></svg>
        )}
      </button>
      {!compact && (
        <div className="clipper-wave" onClick={seek} role="presentation">
          {heights.map((v, i) => {
            const lit = Math.min(1, Math.max(0, pos - i)); // 0 = not reached, 1 = played
            return <span key={i} className="bar" style={{ height: `${v * 100}%`, opacity: 0.28 + 0.72 * lit }} />;
          })}
        </div>
      )}
      <span className="clipper-time mono">
        {fmt(progress * duration)}
        <span className="muted">/{duration ? fmt(duration) : '–:––'}</span>
      </span>
      <audio ref={audio} src={src} preload="metadata" />
    </div>
  );
}
