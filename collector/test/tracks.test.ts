import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackStore } from '../src/tracks.ts';

const H = 3600_000;

test('adds points that moved and are 15 s apart, drops old ones', () => {
  const t = new TrackStore(2 * H);
  const t0 = 1_800_000_000_000;
  t.add('air', 'air:abc', -77, 39, 30000, t0, 'UAL1');
  t.add('air', 'air:abc', -77.01, 39, 30000, t0 + 5_000); // too soon
  t.add('air', 'air:abc', -77, 39, 30000, t0 + 20_000); // didn't move
  t.add('air', 'air:abc', -77.02, 39.01, null, t0 + 30_000);
  let x = t.export(t0 + 60_000);
  assert.equal(x.tracks.length, 1);
  assert.equal(x.tracks[0].label, 'UAL1');
  assert.deepEqual(x.tracks[0].pts.map((p) => p[2]), [30000, null]);
  x = t.export(t0 + 2 * H + 10_000);
  assert.deepEqual(x.tracks[0].pts.length, 1);
  assert.equal(t.export(t0 + 3 * H).tracks.length, 0);
});

test('ignores bad positions and round-trips through save/load', () => {
  const t = new TrackStore();
  const now = Date.now();
  t.add('sea', 'sea:1', 0, 0, null, now);
  t.add('sea', 'sea:2', Number.NaN, 38, null, now);
  t.add('dl', 'dl:DAL801', -76.5, 38.5, 21900, now);
  const saved = JSON.parse(JSON.stringify(t.export(now)));
  const u = new TrackStore();
  u.load(saved, now);
  assert.deepEqual(u.export(now).tracks.map((x) => x.id), ['dl:DAL801']);
});

test('datalink and ADS-B positions for the same airframe share one track', () => {
  const t = new TrackStore();
  const now = Date.now();
  t.add('dl', 'air:a1b2c3', -76.0, 38.5, 33000, now - 600_000, 'DAL801');
  t.add('air', 'air:a1b2c3', -76.8, 38.9, 12000, now - 60_000);
  t.add('dl', 'air:a1b2c3', -76.5, 38.7, 20000, now - 300_000); // arrives late: older than the last point
  const x = t.export(now).tracks;
  assert.equal(x.length, 1);
  assert.equal(x[0].kind, 'air');
  assert.equal(x[0].label, 'DAL801');
  assert.equal(x[0].pts.length, 2);
});
