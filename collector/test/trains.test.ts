import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBursts, SAMPLE_RATE } from '../src/trains.ts';

test('finds a 1200-baud FFSK burst in FM hiss', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const x = new Int16Array(SAMPLE_RATE * 6);
  for (let i = 0; i < x.length; i++) x[i] = Math.round(rand() * 9000); // squelch-open FM noise
  // 0.4 s burst at 2.0 s: random bits at 1200 baud, 1200 Hz = mark, 1800 Hz = space, continuous phase.
  let phase = 0;
  const a = 2 * SAMPLE_RATE;
  for (let i = 0; i < 0.4 * SAMPLE_RATE; i++) {
    const bit = Math.floor((i * 1200) / SAMPLE_RATE);
    const f = (bit * 2654435761) % 3 === 0 ? 1800 : 1200;
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    x[a + i] = Math.round(8000 * Math.sin(phase) + rand() * 400);
  }
  const { bursts } = findBursts(x);
  assert.equal(bursts.length, 1);
  assert.ok(Math.abs(bursts[0].startS - 2) < 0.1, `start ${bursts[0].startS}`);
  assert.ok(bursts[0].endS - bursts[0].startS > 0.25);
});

test('pure noise has no bursts', () => {
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const x = new Int16Array(SAMPLE_RATE * 20).map(() => Math.round(rand() * 9000));
  assert.equal(findBursts(x).bursts.length, 0);
});

test('reads logged bursts whose WAV still exists', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loggedBursts } = await import('../src/trains.ts');
  const dir = await mkdtemp(join(tmpdir(), 'trains-'));
  await mkdir(join(dir, 'review'));
  await writeFile(join(dir, 'review', 'a.wav'), '');
  const lines = [
    { type: 'run', at: '2026-11-20T03:00:00Z', bursts: 1 },
    { type: 'burst', at: '2026-11-20T03:20:00.820Z', file: 'a.wav', ms: 100, score: 0.71 },
    { type: 'burst', at: '2026-11-20T04:00:00Z', file: 'gone.wav', ms: 90, score: 0.7 },
    { type: 'burst', at: '2026-11-01T00:00:00Z', file: 'a.wav', ms: 90, score: 0.7 },
  ];
  await writeFile(join(dir, 'review', 'log.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"partial');
  const got = await loggedBursts(dir, Date.parse('2026-11-15T00:00:00Z'));
  assert.deepEqual(got, [{ at: Date.parse('2026-11-20T03:20:00.820Z'), file: 'a.wav', ms: 100, score: 0.71 }]);
});
