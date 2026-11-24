import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Aircraft } from '../../shared/types.ts';
import { describe, rangeFromRssi, rankCandidates } from '../src/wwt.ts';

const home = { lat: 40, lon: -75 }; // a made-up spot, not the receiver
const NM_LAT = 1 / 60; // degrees of latitude per nautical mile
const now = 1_800_000_000_000;
const plane = (p: Partial<Aircraft> & { hex: string }): Aircraft => ({ seen: 1, ...p });

test('a low helicopter nearby beats a jet higher up but closer on the ground', () => {
  const heli = plane({ hex: 'aaa', category: 'A7', altBaro: 900, lat: home.lat + 0.6 * NM_LAT, lon: home.lon, typeDesc: 'Sikorsky UH-60 Black Hawk', owner: 'US Army', military: true, track: 135, gs: 0 });
  const jet = plane({ hex: 'bbb', category: 'A3', altBaro: 9000, lat: home.lat, lon: home.lon, track: 0, gs: 0 });
  const [first, second] = rankCandidates([jet, heli], home, now, now);
  assert.equal(first.hex, 'aaa');
  assert.equal(second.hex, 'bbb');
  assert.equal(first.kind, 'military helicopter');
  assert.equal(first.bearing, 'N');
  assert.equal(first.heading, 'SE');
  assert.ok(first.close);
});

test('scores a plane that already went by at its closest point, not where it is now', () => {
  // 150 kt due east, now 1.25 nm east of the house; 30 s ago it was right overhead.
  const passed = plane({ hex: 'ccc', altBaro: 1500, gs: 150, track: 90, lat: home.lat, lon: home.lon + 1.25 / (60 * Math.cos((home.lat * Math.PI) / 180)) });
  const steady = plane({ hex: 'ddd', altBaro: 1500, gs: 0, track: 90, lat: home.lat + 0.8 * NM_LAT, lon: home.lon });
  const [first] = rankCandidates([steady, passed], home, now - 2000, now);
  assert.equal(first.hex, 'ccc');
  assert.ok(first.groundMi! < 0.2, `closest ground distance ${first.groundMi}`);
  assert.ok(first.closestAt! < now - 20_000);
});

test('places an aircraft with no position by signal strength', () => {
  const r = rankCandidates([plane({ hex: 'eee', altBaro: 1100, rssi: -4 })], home, now, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].positioned, false);
  assert.ok(r[0].close);
  assert.ok(rangeFromRssi(-3) < rangeFromRssi(-20));
  assert.match(describe(r[0]), /no position sent/);
});

test('skips aircraft on the ground and stale fixes; flags far ones as not close', () => {
  const r = rankCandidates(
    [
      plane({ hex: 'g', altBaro: 'ground', lat: home.lat, lon: home.lon }),
      plane({ hex: 's', altBaro: 1000, lat: home.lat, lon: home.lon, seen: 120 }),
      plane({ hex: 'f', altBaro: 35000, lat: home.lat + 20 * NM_LAT, lon: home.lon }),
    ],
    home,
    now,
    now,
  );
  assert.deepEqual(r.map((c) => c.hex), ['f']);
  assert.equal(r[0].close, false);
  assert.match(describe(r[0]), /^Nothing close/);
});

test('describes the best match in one sentence', () => {
  const [c] = rankCandidates([plane({ hex: 'aaa', category: 'A7', altBaro: 900, lat: home.lat + 0.6 * NM_LAT, lon: home.lon, typeDesc: 'Sikorsky UH-60 Black Hawk', owner: 'US Army', track: 135, gs: 0 })], home, now, now);
  assert.equal(describe(c), 'Probably a helicopter: Sikorsky UH-60 Black Hawk, US Army. 900 feet, 0.7 miles north, heading southeast.');
});
