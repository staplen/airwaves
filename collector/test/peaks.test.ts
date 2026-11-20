import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PEAK_BARS, peaksFromSamples, wavSamples } from '../src/peaks.ts';

function wav16(samples: number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('peaks follow the loudness envelope: quiet first half, loud second half', () => {
  const n = 4800;
  const s = Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 3) * (i < n / 2 ? 1000 : 16000)));
  const samples = wavSamples(wav16(s));
  assert.ok(samples);
  assert.equal(samples.length, n);
  const p = peaksFromSamples(samples)!;
  assert.equal(p.length, PEAK_BARS);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const v = [...p].map((c) => A.indexOf(c));
  assert.ok(v.every((x) => x >= 0));
  assert.ok(Math.max(...v.slice(PEAK_BARS / 2)) >= 60); // loud half near the top
  assert.ok(Math.max(...v.slice(0, PEAK_BARS / 2 - 1)) <= 20); // sqrt(1/16) * 63 ≈ 16
});

test('silence and non-WAV give no peaks', () => {
  assert.equal(peaksFromSamples(new Int16Array(4800)), undefined);
  assert.equal(wavSamples(Buffer.from('not a wav file at all, just some text padding padding padding')), undefined);
});
