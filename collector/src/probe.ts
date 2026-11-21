import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Beta "identify" probe: a slot records ~45 s of FM audio (12 kHz, 16-bit mono) on one channel the survey keeps
// finding, a different one each visit (probe_<kHz>_<UTC>.raw). This works out roughly what the channel carries, so
// we can decide what to build next. On unsquelched FM, an empty channel is loud hiss; a carrier "quiets" the hiss.
// Per 50 ms window we measure the hiss band (3.5–5.5 kHz) and total power:
//  - carrier present = hiss well below the open-channel level, or audio well above it;
//  - voice = carrier with audio that stops between words (many quiet windows while the carrier stays up);
//  - data / tones = carrier with audio that never pauses, at a steady level (FSK, tones);
//  - carrier only = quieted with almost no audio.

export const PROBE_RATE = 12_000;
const WIN = 600; // 50 ms

export type ProbeGuess = 'idle' | 'voice' | 'data or tones' | 'carrier only' | 'mixed';

export interface ProbeResult {
  mhz: number;
  at: number;
  seconds: number;
  activePct: number; // share of the recording with a carrier on the channel
  guess: ProbeGuess;
  clip?: string; // a WAV sample to listen to (LAN), kept 24 h
}

/** Energy at one frequency over a window (Goertzel). */
function goertzel(x: Int16Array, from: number, n: number, f: number): number {
  const w = (2 * Math.PI * f) / PROBE_RATE;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < from + n; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}
const band = (x: Int16Array, from: number, freqs: number[]) => freqs.reduce((a, f) => a + goertzel(x, from, WIN, f), 0) / freqs.length;
const HISS = [3600, 4200, 4800, 5400];

function power(x: Int16Array, from: number, n: number): number {
  let e = 0;
  for (let i = from; i < from + n; i++) e += x[i] * x[i];
  return e / n;
}

// Calibrated on this receiver's open-channel hiss (rtl_fm -s 12k, gain 44.5): about 950 RMS, and ~1e9 in the hiss
// band per 50 ms window. A carrier either quiets the hiss (≥10 dB down) or, when modulated, plays audio well above it.
const OPEN_POWER = 950 ** 2;
const OPEN_HISS = 1e9;

export function classify(x: Int16Array): { activePct: number; guess: ProbeGuess } {
  const wins: { quiet: boolean; loud: boolean; db: number }[] = [];
  for (let i = 0; i + WIN <= x.length; i += WIN) {
    const total = power(x, i, WIN);
    wins.push({ quiet: band(x, i, HISS) < OPEN_HISS / 10, loud: total > OPEN_POWER * 4, db: 10 * Math.log10((total + 1) / OPEN_POWER) });
  }
  if (wins.length < 10) return { activePct: 0, guess: 'idle' };
  const active = wins.filter((w) => w.quiet || w.loud);
  const activePct = Math.round((active.length / wins.length) * 100);
  if (active.length < wins.length * 0.05) return { activePct, guess: 'idle' };
  const loud = active.filter((w) => w.loud);
  if (loud.length < active.length * 0.1) return { activePct, guess: 'carrier only' };
  const pauses = 1 - loud.length / active.length; // quiet stretches while the carrier stays up
  const mean = loud.reduce((a, w) => a + w.db, 0) / loud.length;
  const sd = Math.sqrt(loud.reduce((a, w) => a + (w.db - mean) ** 2, 0) / loud.length);
  let guess: ProbeGuess;
  if (pauses > 0.2) guess = 'voice'; // speech stops between words and phrases
  else if (pauses < 0.05 && sd < 3) guess = 'data or tones'; // FSK and tones run without gaps at a steady level
  else guess = 'mixed';
  return { activePct, guess };
}

function wav(samples: Int16Array): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + samples.byteLength, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(PROBE_RATE, 24);
  h.writeUInt32LE(PROBE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

/** Classifies finished probe recordings in `dir`, keeps a 20 s WAV sample in `clipsDir`, deletes the raw file. */
export async function ingestProbes(dir: string, clipsDir: string | undefined): Promise<ProbeResult[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /^probe_\d+_.*\.raw$/.test(f));
  } catch {
    return [];
  }
  const out: ProbeResult[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs < 20_000) continue; // still recording
      const buf = await readFile(path);
      const x = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.byteLength / 2) * 2));
      const mhz = Number(/^probe_(\d+)_/.exec(f)![1]) / 1000;
      const r: ProbeResult = { mhz, at: st.mtimeMs, seconds: Math.round(x.length / PROBE_RATE), ...classify(x) };
      if (clipsDir && r.guess !== 'idle') {
        await mkdir(clipsDir, { recursive: true });
        const name = f.replace(/\.raw$/, '.wav');
        await writeFile(join(clipsDir, name), wav(x.slice(0, Math.min(x.length, PROBE_RATE * 20))));
        r.clip = `/api/clips/probe/${encodeURIComponent(name)}`;
      }
      out.push(r);
      await unlink(path);
    } catch (e) {
      console.warn(`probe ${f}:`, (e as Error).message);
    }
  }
  return out;
}
