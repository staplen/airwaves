import { useEffect, useMemo, useRef, useState } from 'react';

const BARS = 48;
const PEAK_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Only one clip plays at a time across the whole feed.
let playing: HTMLAudioElement | null = null;

/** Real loudness per bar from the collector (one character each, 0–63), if this clip has them. */
function decodePeaks(peaks: string | undefined): number[] | undefined {
  if (!peaks || peaks.length < 8) return undefined;
  return [...peaks].map((c) => Math.max(0.08, Math.max(0, PEAK_ALPHABET.indexOf(c)) / 63));
}

/** Placeholder bar heights from the clip URL, for clips filed before waveforms were measured. */
function fakeBars(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507)), ((h >>> 0) % 1000) / 1000);
  const out: number[] = [];
  let level = 0.4;
  for (let i = 0; i < BARS; i++) {
    if (rnd() < 0.18) level = 0.15 + rnd() * 0.2;
    else level = Math.min(1, Math.max(0.2, level + (rnd() - 0.45) * 0.5));
    const taper = Math.min(1, (i + 1) / 5, (BARS - i) / 5);
    out.push(Math.max(0.12, level * taper));
  }
  return out;
}

/** All bars as one SVG path (viewBox: one unit per bar, 20 high, centred), so a waveform is one element, not 48. */
function wavePath(heights: number[]): string {
  return heights
    .map((v, i) => {
      const h = Math.max(1.2, v * 20);
      return `M${i + 0.18} ${(10 - h / 2).toFixed(2)}h0.64v${h.toFixed(2)}h-0.64z`;
    })
    .join('');
}

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const t = Math.floor(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Play button + waveform. The audio element is only created on first play (in the tap itself, which iOS requires),
 * so a long feed doesn't hold hundreds of media players. `onEnded` fires when the clip finishes; `autoPlay` starts it
 * on mount (used to chain a bundle's clips). `playlist` shows the play-queue icon (the button plays a series);
 * `onPlayingChange` reports play/pause to the parent.
 */
export function ClipPlayer({ src, color, label, peaks, compact, onEnded, autoPlay, playlist, onPlayingChange }: { src: string; color: string; label: string; peaks?: string; compact?: boolean; onEnded?: () => void; autoPlay?: boolean; playlist?: boolean; onPlayingChange?: (playing: boolean) => void }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const cleanup = useRef<() => void>(undefined);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const playingChanged = useRef(onPlayingChange);
  playingChanged.current = onPlayingChange;
  const [isPlaying, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const path = useMemo(() => wavePath(decodePeaks(peaks) ?? fakeBars(src)), [peaks, src]);

  /** The clip's audio element, created and wired up on first use. */
  const ensure = (): HTMLAudioElement => {
    if (audio.current) return audio.current;
    const a = new Audio();
    a.preload = 'auto';
    a.src = src;
    let raf = 0;
    // Duration can be Infinity when the server doesn't send a length; fall back to how much has loaded.
    const knownDuration = () => (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0);
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
      playingChanged.current?.(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      setPlaying(false);
      playingChanged.current?.(false);
      cancelAnimationFrame(raf);
    };
    const onEnd = () => {
      stop();
      setProgress(0);
      ended.current?.();
    };
    const onMeta = () => setDuration(knownDuration());
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', stop);
    a.addEventListener('ended', onEnd);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta);
    cleanup.current = () => {
      cancelAnimationFrame(raf);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', stop);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onMeta);
      a.pause();
      if (playing === a) playing = null;
      a.removeAttribute('src');
      a.load(); // releases the media resource
    };
    audio.current = a;
    return a;
  };
  useEffect(
    () => () => {
      cleanup.current?.();
      cleanup.current = undefined;
      audio.current = null;
    },
    [],
  );

  const start = () => {
    const a = ensure();
    if (!a.paused) return;
    if (playing && playing !== a) playing.pause();
    playing = a;
    void a.play().catch(() => {});
  };
  const toggle = () => {
    const a = audio.current;
    if (a && !a.paused) a.pause();
    else start();
  };
  useEffect(() => {
    if (autoPlay) start(); // idempotent: safe if effects run twice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const a = ensure();
    const go = () => {
      a.currentTime = f * a.duration;
      setProgress(f);
    };
    if (Number.isFinite(a.duration) && a.duration > 0) go();
    else a.addEventListener('loadedmetadata', go, { once: true });
    if (a.paused) start();
  };

  // The played part is the same waveform drawn bright on top, clipped to the progress.
  const pct = (progress * 100).toFixed(2);
  return (
    <div className={`clipper${isPlaying ? ' playing' : ''}${compact ? ' compact' : ''}`} style={{ ['--clip-color' as string]: color }}>
      <button type="button" className="clipper-btn" onClick={toggle} aria-label={`${isPlaying ? 'Pause' : 'Play'} ${label}`}>
        {isPlaying ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor" /><rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor" /></svg>
        ) : playlist ? (
          <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><path d="M1 2h8M1 6h8M1 10h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M10 7.5 L15 10.5 L10 13.5 Z" fill="currentColor" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5 L10.5 6 L3 10.5 Z" fill="currentColor" /></svg>
        )}
      </button>
      {!compact && (
        <div className="clipper-wave" onClick={seek} role="presentation">
          <svg viewBox={`0 0 ${BARS} 20`} preserveAspectRatio="none" aria-hidden="true">
            <path d={path} opacity={0.28} />
          </svg>
          {progress > 0 && (
            <svg viewBox={`0 0 ${BARS} 20`} preserveAspectRatio="none" aria-hidden="true" style={{ clipPath: `inset(0 ${(100 - Number(pct)).toFixed(2)}% 0 0)` }}>
              <path d={path} />
            </svg>
          )}
        </div>
      )}
      <span className="clipper-time mono">
        {fmt(progress * duration)}
        <span className="muted">/{duration ? fmt(duration) : '–:––'}</span>
      </span>
    </div>
  );
}
