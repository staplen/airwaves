import { appendFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Train probe (not on the dashboard yet). A short scheduler slot runs rtl_fm on the end-of-train
// frequency (457.9375 MHz) and writes raw audio: 16-bit mono, 12 kHz. End-of-train devices send short
// 1200-baud FFSK bursts (1200 / 1800 Hz tones), so we look for stretches where most of the audio energy
// sits in that band (FM hiss is spread flat up to 6 kHz), keep each burst (with a little padding) as a WAV for later decoding, and
// log a line per run and per burst to review/log.jsonl. The raw recording is then deleted.

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

function wav(samples: Int16Array): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + samples.byteLength, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

/** "eot_20261118_171200.raw" → epoch ms (UTC). */
function startOf(name: string, fallback: number): number {
  const m = name.match(/(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : fallback;
}

export interface TrainBurst {
  at: number; // epoch ms
  file: string; // WAV in <dir>/review
  ms: number;
  score: number;
}

/** Bursts logged in <dir>/review/log.jsonl since `sinceMs` whose WAV is still there (for backfilling the feed). */
export async function loggedBursts(dir: string, sinceMs: number): Promise<TrainBurst[]> {
  const review = join(dir, 'review');
  let text = '';
  try {
    text = await readFile(join(review, 'log.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const have = new Set(await readdir(review));
  const out: TrainBurst[] = [];
  for (const line of text.split('\n')) {
    try {
      const l = JSON.parse(line) as { type?: string; at?: string; file?: string; ms?: number; score?: number };
      const at = l.at ? Date.parse(l.at) : NaN;
      if (l.type === 'burst' && l.file && have.has(l.file) && at >= sinceMs) out.push({ at, file: l.file, ms: l.ms ?? 0, score: l.score ?? 0 });
    } catch {
      /* partial line */
    }
  }
  return out;
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
        await writeFile(join(review, name), wav(x.slice(a, z)));
        lines.push({ type: 'burst', at: at.toISOString(), file: name, ms: Math.round((b.endS - b.startS) * 1000), score: Number(b.score.toFixed(2)) });
        kept.push({ at: at.getTime(), file: name, ms: Math.round((b.endS - b.startS) * 1000), score: Number(b.score.toFixed(2)) });
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
