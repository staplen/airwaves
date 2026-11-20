import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeEot, decodeHot, type EotPacket, type HotPacket } from './eot.ts';

// Train probe. Short scheduler slots run rtl_fm on the end-of-train frequency (457.9375 MHz) and, at night, the
// locomotive's (452.9375 MHz), writing raw audio: 16-bit mono, 12 kHz. End-of-train devices send short
// 1200-baud FFSK bursts (1200 / 1800 Hz tones), so we look for stretches where most of the audio energy
// sits in that band (FM hiss is spread flat up to 6 kHz), decode each burst's end-of-train packet straight from the
// samples, and log a line per run and per burst (with what it decoded to) to review/log.jsonl. No audio is kept:
// the raw recording is deleted once processed.

export const SAMPLE_RATE = 12_000;
const WIN = 240; // 20 ms windows
const TONE_SHARE = 0.6; // share of window energy inside the FFSK band that counts as data (white FM hiss is ~0.3)
const MIN_WINDOWS = 5; // 100 ms of tones
const PAD_S = 0.5;
const REVIEW_KEEP_MS = 7 * 86_400_000;

/** Band-pass (RBJ biquad) around the FFSK tones: keeps roughly 0.7-2.3 kHz. */
function bandpass(x: Int16Array): Float64Array {
  const f0 = 1500;
  const q = 0.9;
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

export interface Burst {
  startS: number;
  endS: number;
  score: number; // mean in-band energy share over the burst
}

/** Finds FFSK-like bursts in 12 kHz mono audio. */
export function findBursts(x: Int16Array): { bursts: Burst[]; noiseRms: number } {
  const n = Math.floor(x.length / WIN);
  const shares = new Float64Array(n);
  const rms: number[] = [];
  const bp = bandpass(x);
  for (let w = 0; w < n; w++) {
    let sumsq = 0;
    let band = 0;
    for (let i = w * WIN; i < (w + 1) * WIN; i++) {
      sumsq += x[i] * x[i];
      band += bp[i] * bp[i];
    }
    rms.push(Math.sqrt(sumsq / WIN));
    shares[w] = sumsq > 0 ? band / sumsq : 0;
  }
  const bursts: Burst[] = [];
  let run = -1;
  for (let w = 0; w <= n; w++) {
    const tonal = w < n && shares[w] >= TONE_SHARE;
    if (tonal && run < 0) run = w;
    if (!tonal && run >= 0) {
      if (w - run >= MIN_WINDOWS) {
        let sum = 0;
        for (let i = run; i < w; i++) sum += shares[i];
        bursts.push({ startS: (run * WIN) / SAMPLE_RATE, endS: (w * WIN) / SAMPLE_RATE, score: sum / (w - run) });
      }
      run = -1;
    }
  }
  rms.sort((a, b) => a - b);
  return { bursts, noiseRms: rms.length ? rms[Math.floor(rms.length / 2)] : 0 };
}

/** "eot_20261118_171200.raw" → epoch ms (UTC). */
function startOf(name: string, fallback: number): number {
  const m = name.match(/(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : fallback;
}

export interface TrainBurst {
  at: number; // epoch ms
  file: string; // burst name (older bursts: a WAV in <dir>/review)
  ms: number;
  score: number;
  packets?: EotPacket[]; // decoded end-of-train packets (empty: too noisy)
  hot?: HotPacket[]; // locomotive commands, when the burst came from the head-of-train side
}

/** Processes finished recordings in `dir`; returns the bursts kept. */
export async function ingestTrains(dir: string): Promise<TrainBurst[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.raw')).sort();
  } catch {
    return [];
  }
  const review = join(dir, 'review');
  const kept: TrainBurst[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs < 30_000) continue; // still recording
      const buf = await readFile(path);
      const x = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      const t0 = startOf(f, st.mtimeMs - (x.length / SAMPLE_RATE) * 1000);
      const { bursts, noiseRms } = findBursts(x);
      await mkdir(review, { recursive: true });
      const lines: object[] = [{ type: 'run', at: new Date(t0).toISOString(), file: f, seconds: Math.round(x.length / SAMPLE_RATE), bursts: bursts.length, noiseRms: Math.round(noiseRms) }];
      for (const b of bursts) {
        const at = new Date(t0 + b.startS * 1000);
        const name = `eot_${at.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)}_${Math.round(b.startS * 10)}.wav`;
        const a = Math.max(0, Math.floor((b.startS - PAD_S) * SAMPLE_RATE));
        const z = Math.min(x.length, Math.ceil((b.endS + PAD_S) * SAMPLE_RATE));
        const audio = x.slice(a, z);
        const packets = decodeEot(audio, SAMPLE_RATE);
        const hot = packets.length ? [] : decodeHot(audio, SAMPLE_RATE);
        const burst = { at: at.getTime(), file: name.replace(/\.wav$/, ''), ms: Math.round((b.endS - b.startS) * 1000), score: Number(b.score.toFixed(2)), packets, hot };
        lines.push({ type: 'burst', ...burst, at: at.toISOString() });
        kept.push(burst);
      }
      await appendFile(join(review, 'log.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      console.log(`trains ${f}: ${bursts.length} burst(s), noise rms ${Math.round(noiseRms)}`);
      await unlink(path);
    } catch (e) {
      console.warn(`trains ${f}:`, (e as Error).message);
    }
  }
  // Keep a week of burst clips for review.
  try {
    for (const f of await readdir(review)) {
      if (!f.endsWith('.wav')) continue;
      const p = join(review, f);
      if (Date.now() - (await stat(p)).mtimeMs > REVIEW_KEEP_MS) await unlink(p);
    }
  } catch {
    /* no review folder yet */
  }
  return kept;
}
