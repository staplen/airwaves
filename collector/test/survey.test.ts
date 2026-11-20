import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChannels, isTv } from '../src/survey.ts';

/** One rtl_power line from lowHz in 12.5 kHz steps, flat at -50 dB except where `at` says. */
function csv(lowHz: number, n: number, at: (hz: number) => number | undefined): string {
  const vals = Array.from({ length: n }, (_, i) => at(lowHz + i * 12_500) ?? -50);
  return `2026-11-20, 20:00:00, ${lowHz}, ${lowHz + n * 12_500}, 12500, 10, ${vals.join(', ')}\n`;
}

test('a narrowband channel is found; a broad hump and TV are not', () => {
  const r = findChannels(csv(160_000_000, 400, (hz) => (hz === 160_225_000 ? -20 : hz >= 162_000_000 && hz < 162_400_000 ? -25 : undefined)));
  assert.ok(r);
  assert.deepEqual(r.peaks.map((p) => p.mhz), [160.225]); // the 400 kHz wide hump at 162.0–162.4 is dropped
  const tv = findChannels(csv(174_000_000, 400, (hz) => (hz === 175_000_000 ? -20 : undefined)));
  assert.deepEqual(tv?.peaks, []);
  assert.ok(isTv(177) && isTv(500) && !isTv(160.23) && !isTv(457.9375));
});

test('a very strong narrow signal is kept despite its skirts; bands label by the narrowest match', async () => {
  const { bandOf } = await import('../src/survey.ts');
  // NOAA-like: +55 dB at the centre, skirts falling 8 dB per bin.
  const r = findChannels(csv(162_000_000, 400, (hz) => { const k = Math.abs(hz - 162_450_000) / 12_500; return k <= 5 ? 5 - k * 8 : undefined; }));
  assert.deepEqual(r?.peaks.map((p) => p.mhz), [162.45]);
  assert.equal(bandOf(160.23)?.use, 'Railroad (AAR channels)');
  assert.equal(bandOf(161.975)?.use, 'AIS');
  assert.equal(bandOf(162.45)?.use, 'NOAA Weather Radio');
});
