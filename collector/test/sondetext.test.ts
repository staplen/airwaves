import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeBalloon, SondeTracker } from '../src/sonde.ts';

// A real payload summary from last night's flight (Y2123508).
const pkt = (alt: number, vel: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'PAYLOAD_SUMMARY', callsign: 'Y2123508', latitude: 38.99685, longitude: -77.01246, altitude: alt, speed: 119.2, heading: 77.6, model: 'RS41-NG', freq: '405.6000 MHz', temp: -69.5, frame: 3600, datetime: '2026-11-21T00:00:15.004000+00:00', humidity: -1.0, pressure: -1, sats: 11, batt: 2.6, snr: 16.6, vel_v: vel, vel_h: 33.1, ...extra });

test('keeps the readings and writes them into the feed text', () => {
  const t = new SondeTracker();
  const e = t.push(pkt(14290, 4.4), 1000)!;
  assert.equal(e.kind, 'detected');
  const b = e.balloon;
  assert.equal(b.tempC, -69.5);
  assert.equal(b.humidity, undefined); // -1 = not measured
  assert.equal(b.sats, 11);
  assert.equal(b.poweredOnAt, Date.parse('2026-11-21T00:00:15.004Z') - 3600_000);
  assert.equal(describeBalloon('detected', b).body, 'RS41-NG picked up at 14.3 km · climbing 4.4 m/s · -69°C (-93°F) · drifting east at 119 km/h.');
});

test('burst, progress and last-heard cards', () => {
  const t = new SondeTracker();
  t.push(pkt(30000, 5), 0);
  assert.equal(t.push(pkt(31000, 5, { temp: -60 }), 21 * 60_000)!.kind, 'progress');
  const burst = t.push(pkt(29000, -20, { temp: -55 }), 22 * 60_000)!;
  assert.equal(burst.kind, 'burst');
  assert.equal(describeBalloon('burst', burst.balloon).body, 'Reached 31.0 km before bursting; coldest -69°C (-93°F) after about 1 h 0 min aloft. Now falling by parachute at 20 m/s.');
  assert.deepEqual(t.lastHeard(22 * 60_000 + 30 * 60_000), []); // only 30 min quiet
  const [last] = t.lastHeard(22 * 60_000 + 61 * 60_000);
  assert.match(describeBalloon('last', last).body, /^Last heard at 29\.0 km, falling 20 m\/s, near 39\.00, -77\.01/);
  assert.deepEqual(t.lastHeard(22 * 60_000 + 90 * 60_000), []); // once
});
