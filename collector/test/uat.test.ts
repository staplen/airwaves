import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUatJson, parseUatRaw } from '../src/uat.ts';

const near = (a: number | undefined, b: number, eps = 0.001) => assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} not within ${eps} of ${b}`);

// inverse of the decoder: lat/lon -> 8-byte header hex
function header(lat: number, lon: number): string {
  const rawLat = Math.round(((lat < 0 ? lat + 180 : lat) * 16777216) / 360);
  const rawLon = Math.round(((lon < 0 ? lon + 360 : lon) * 16777216) / 360);
  const b = [
    (rawLat >> 15) & 0xff, (rawLat >> 7) & 0xff, ((rawLat << 1) & 0xfe) | ((rawLon >> 23) & 1),
    (rawLon >> 15) & 0xff, (rawLon >> 7) & 0xff, (rawLon << 1) & 0xfe, 0x80, 0x00,
  ];
  return b.map((x) => x.toString(16).padStart(2, '0')).join('');
}

test('uat json full ADS-B message', () => {
  const a = parseUatJson(JSON.stringify({
    address_qualifier: 'adsb_icao', address: 'A1B2C3', position: { lat: 38.85, lon: -77.04 },
    pressure_altitude: 3500, geometric_altitude: 3600, airground_state: 'airborne',
    ground_speed: 120.5, true_track: 270.2, vertical_velocity_barometric: -64,
    emitter_category: 'A1', callsign: 'N123AB ', flightplan_id: '1200', emergency: 'none',
    metadata: { rssi: -18.4, errors: 0, received_at: 1700000000.5 },
  }))!;
  assert.equal(a.hex, 'a1b2c3');
  assert.equal(a.addressType, 'adsb_icao');
  assert.equal(a.flight, 'N123AB');
  near(a.lat, 38.85); near(a.lon, -77.04);
  assert.equal(a.altFt, 3500);
  assert.equal(a.gsKt, 120.5);
  assert.equal(a.trackDeg, 270.2);
  assert.equal(a.vertRateFpm, -64);
  assert.equal(a.squawk, '1200');
  assert.equal(a.category, 'A1');
  assert.equal(a.emergency, 'none');
  assert.equal(a.onGround, false);
  assert.equal(a.rssi, -18.4);
  assert.equal(a.ts, 1700000000.5);
});

test('uat json minimal, ground, non-ICAO and geometric fallback', () => {
  const a = parseUatJson('{"address_qualifier":"adsb_other","address":"f00001","geometric_altitude":900,"airground_state":"ground","metadata":{"rssi":-20.0,"errors":0}}')!;
  assert.equal(a.hex, 'f00001');
  assert.equal(a.addressType, 'adsb_other');
  assert.equal(a.altFt, 900);
  assert.equal(a.onGround, true);
  assert.equal(a.lat, undefined);
  assert.equal(a.ts, undefined);
  assert.equal(parseUatJson('{"address_qualifier":"tisb_trackfile","address":"00abcd"}')!.addressType, 'tisb_trackfile');
});

test('uat json garbage', () => {
  for (const g of ['', 'nope', '[]', 'null', '{}', '{"address":"xyz"}', '{"address":12}', '{"address":"abc"}']) {
    assert.equal(parseUatJson(g), undefined, g);
  }
});

test('uat raw downlink', () => {
  const r = parseUatRaw('-00a66ef135445d525a0c0519119021204800;rs=1;rssi=-12.5;t=1700000000.250;')!;
  assert.equal(r.direction, 'downlink');
  assert.equal(r.bytes, 18);
  assert.equal(r.rssi, -12.5);
  assert.equal(r.ts, 1700000000.25);
  assert.equal(r.groundStation, undefined);
  assert.equal(parseUatRaw('-00a66ef135445d525a0c0519119021204800;')!.rssi, undefined);
});

test('uat raw uplink header, Washington DC encoded round-trip', () => {
  const hex = header(38.95, -77.45) + '00'.repeat(424);
  const r = parseUatRaw(`+${hex};rssi=-30.1;t=1700000001.000;`)!;
  assert.equal(r.direction, 'uplink');
  assert.equal(r.bytes, 432);
  near(r.groundStation?.lat, 38.95, 0.0001);
  near(r.groundStation?.lon, -77.45, 0.0001);
});

test('uat raw uplink southern/eastern hemispheres', () => {
  const r = parseUatRaw(`+${header(-33.9, 151.2)}00;`)!;
  near(r.groundStation?.lat, -33.9, 0.0001);
  near(r.groundStation?.lon, 151.2, 0.0001);
});

test('uat raw uplink real frame (dump978 sample-data.txt)', () => {
  const r = parseUatRaw('+3514c952d65ca7b0158000210de09082102d30cb00082f0d1e012d30cb000000000000000fd900011710120118173ba9c9635e4c00158000210e9e;')!;
  assert.equal(r.direction, 'uplink');
  near(r.groundStation?.lat, 37.32, 0.05); // California ground station
  near(r.groundStation?.lon, -121.8, 0.1);
});

test('uat raw garbage', () => {
  for (const g of ['', 'x', '-', '-zz;', '-abc;', '+;', '-0011', '!rssi=1;', 'hello;world']) {
    assert.equal(parseUatRaw(g), undefined, g);
  }
});
