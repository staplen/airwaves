import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, PROBE_RATE } from '../src/probe.ts';

let seed = 11;
const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
/** 30 s: open hiss for the first 10 s, then 20 s of `signal` (quieted channel with a little residual hiss). */
function recording(signal: (t: number) => number): Int16Array {
  const x = new Int16Array(PROBE_RATE * 30);
  for (let i = 0; i < x.length; i++) {
    const t = i / PROBE_RATE;
    x[i] = Math.round(t < 10 ? noise() * 1650 : signal(t) + noise() * 50); // open hiss ~950 RMS, like the real receiver
  }
  return x;
}

test('an empty channel is idle', () => {
  const x = new Int16Array(PROBE_RATE * 30).map(() => Math.round(noise() * 1650));
  assert.equal(classify(x).guess, 'idle');
});

test('speech-like bursts are voice; steady FSK is data; a bare carrier is a carrier', () => {
  // Syllables: a 900 Hz tone switched on and off 4 times a second, with longer pauses.
  const voice = classify(recording((t) => (Math.sin(2 * Math.PI * 4 * t) > 0.2 && t % 3 < 2 ? 6000 * Math.sin(2 * Math.PI * 900 * t) : 0)));
  assert.equal(voice.guess, 'voice');
  assert.ok(voice.activePct >= 60 && voice.activePct <= 70, String(voice.activePct));
  // 1200-baud AFSK: alternating 1200 / 2200 Hz, never pausing.
  const data = classify(recording((t) => 6000 * Math.sin(2 * Math.PI * (Math.floor(t * 1200) % 2 ? 1200 : 2200) * t)));
  assert.equal(data.guess, 'data or tones');
  assert.equal(classify(recording(() => 0)).guess, 'carrier only');
  // A carrier on for the whole recording (no open hiss to compare with) still reads as a carrier.
  assert.equal(classify(new Int16Array(PROBE_RATE * 30).map(() => Math.round(noise() * 50))).guess, 'carrier only');
});
