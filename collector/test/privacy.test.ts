import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approxHome, displayHome, randomOffset } from '../src/privacy.ts';

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const dy = (a.lat - b.lat) * 111.32;
  const dx = (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
};

test('approximate home is stable, and within ~8 km', () => {
  const home = { lat: 38.91234, lon: -77.04321 };
  for (let i = 0; i < 200; i++) {
    const off = randomOffset();
    const a = approxHome(home, off);
    assert.deepEqual(approxHome(home, off), a); // same offset, same answer
    assert.equal(a.approx, true);
    const d = km(home, a);
    assert.ok(d < 8, `distance ${d}`);
  }
  // Nearby real locations in the same grid cell publish the same point.
  const off = { northKm: 2, eastKm: -1 };
  assert.deepEqual(approxHome({ lat: 38.905, lon: -77.04 }, off), approxHome({ lat: 38.92, lon: -77.06 }, off));
});

test('a chosen public stand-in is used only when it is 1–10 km from the real location', () => {
  const home = { lat: 38.91234, lon: -77.04321 };
  assert.deepEqual(displayHome(home, 38.94, -77.02), { lat: 38.94, lon: -77.02, approx: true }); // ~3.6 km
  assert.ok('refused' in displayHome(home, 38.913, -77.044)); // ~0.1 km: would give it away
  assert.ok('refused' in displayHome(home, 39.2, -77.04)); // ~32 km: rings would mislead
  assert.ok('refused' in displayHome(home, Number(''), Number.NaN));
});
