import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Real waveforms for the feed's clip players: each clip is reduced to PEAK_BARS loudness values when it is
// filed, stored on the feed item as a short string (one character per bar, 0–63), and drawn by the browser
// without downloading the audio. WAV is read directly; anything else (MP3) is decoded with ffmpeg when the
// container has it. Without ffmpeg the item simply has no peaks and the player draws its placeholder.

export const PEAK_BARS = 48;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const RATE = 8000; // plenty for an envelope

/** RMS per bar, scaled to the loudest bar, square-rooted so quiet speech still shows; undefined for silence. */
export function peaksFromSamples(s: Int16Array, bars = PEAK_BARS): string | undefined {
  if (s.length < bars) return undefined;
  const rms: number[] = [];
  for (let b = 0; b < bars; b++) {
    const from = Math.floor((b * s.length) / bars);
    const to = Math.floor(((b + 1) * s.length) / bars);
    let sum = 0;
    for (let i = from; i < to; i++) sum += s[i] * s[i];
    rms.push(Math.sqrt(sum / Math.max(1, to - from)));
  }
  const max = Math.max(...rms);
  if (max < 30) return undefined; // digital silence
  return rms.map((v) => ALPHABET[Math.round(Math.sqrt(v / max) * 63)]).join('');
}

/** Mono 16-bit samples from a PCM WAV (8- or 16-bit, any channel count); undefined for anything else. */
export function wavSamples(buf: Buffer): Int16Array | undefined {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let p = 12;
  let fmt: { format: number; channels: number; bits: number } | undefined;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data' && fmt) {
      if (fmt.format !== 1 || (fmt.bits !== 16 && fmt.bits !== 8) || fmt.channels < 1) return undefined;
      const end = Math.min(buf.length, body + size);
      const step = (fmt.bits / 8) * fmt.channels;
      const n = Math.floor((end - body) / step);
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const o = body + i * step;
        out[i] = fmt.bits === 16 ? buf.readInt16LE(o) : (buf[o] - 128) << 8; // first channel is enough for an envelope
      }
      return out;
    }
    p = body + size + (size & 1);
  }
  return undefined;
}

let ffmpegMissing = false;

function ffmpegSamples(path: string): Promise<Int16Array | undefined> {
  if (ffmpegMissing) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            ffmpegMissing = true;
            console.warn('peaks: ffmpeg not found; MP3 clips get placeholder waveforms');
          }
          return resolve(undefined);
        }
        const b = stdout as Buffer;
        const n = Math.floor(b.length / 2);
        resolve(new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 2))); // copy: the Buffer may not be 2-byte aligned
      },
    );
  });
}

/** The waveform string for an audio file, or undefined if it can't be read. Never throws. */
export async function clipPeaks(path: string): Promise<string | undefined> {
  try {
    if (/\.wav$/i.test(path)) {
      const s = wavSamples(await readFile(path));
      if (s) return peaksFromSamples(s);
    }
    const s = await ffmpegSamples(path);
    return s ? peaksFromSamples(s) : undefined;
  } catch {
    return undefined;
  }
}
