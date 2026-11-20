import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAcarsdec, parseSquitter } from '../src/acarsdec.ts';

const near = (a: number | undefined, b: number, eps = 0.01) => assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} not within ${eps} of ${b}`);

// Real acarsdec field names (output.c fmt_json).
const line = (o: Record<string, unknown>) =>
  JSON.stringify({ timestamp: 1763676000.25, station_id: 'KDCA', channel: 1, freq: 130.025, level: -23.5, noise: -48.1, error: 0, mode: '2', block_id: '3', ack: false, ...o, app: { name: 'acarsdec', ver: '4.6' } });

test('POSN position report', () => {
  const r = parseAcarsdec(line({ label: 'H1', tail: '.N123AA', flight: 'AA1877', msgno: 'M12A', text: 'POSN37071W077242,GEARS,181558,350,SYFER,182635,JOEPO,M50,25576,139/TS181558,2011265DFC' }))!;
  assert.equal(r.ts, 1763676000250);
  assert.equal(r.freqMhz, 130.025);
  assert.equal(r.reg, 'N123AA');
  assert.equal(r.flight, 'AA1877');
  assert.equal(r.title, 'American 1877');
  assert.equal(r.hex, undefined);
  assert.match(r.body, /35,000 ft.*GEARS/);
  near(r.lat, 37.118);
  near(r.lon, -77.403);
  assert.ok(r.raw?.startsWith('POSN'));
});

test('flight summary yields timed points', () => {
  const r = parseAcarsdec(line({ label: 'H1', tail: '.N8936Q', flight: 'WN2140', msgno: 'M01A', text: '++86501,N8936Q,B7378MAX,261120,WN2140,KAUS,KBWI,1901,SMX34-2502-F320\r\n6\r\nN3837.3,W07729.6,201702,18505,-15.5,004,026,DC,00000,0,\r\n' }))!;
  assert.match(r.body, /flying Austin \(KAUS\) → Baltimore \(KBWI\)/);
  assert.ok(r.points && r.points.length >= 1);
  assert.equal(typeof r.points[0].ts, 'number');
  near(r.lat, 38.622);
});

test('depa/dsta only produces a route headline', () => {
  const r = parseAcarsdec(line({ label: '5Z', tail: '.N55555', flight: 'UA0123', msgno: 'M05A', text: 'ZZZ junk', depa: 'KCLT', dsta: 'KPVD' }))!;
  assert.match(r.body, /^Flying .*\(KCLT\) → .*\(KPVD\)\.$/);
  assert.equal(r.raw, 'ZZZ junk');
});

test('link tests, empty text and garbled frames are dropped', () => {
  assert.equal(parseAcarsdec(line({ label: '_\u007f', tail: '.N1' })), undefined);
  assert.equal(parseAcarsdec(line({ label: 'Q0', tail: '.N1', text: 'x' })), undefined);
  assert.equal(parseAcarsdec(line({ label: 'SQ', text: '02XAIADKIAD0000N38575W077277V136975/' })), undefined);
  assert.equal(parseAcarsdec(line({ label: 'H1', tail: '.N1', text: '' })), undefined);
  assert.equal(parseAcarsdec(line({ label: 'H1', tail: '.N1', error: 1, text: 'garbage ~~', depa: 'KCLT', dsta: 'KPVD' })), undefined);
  assert.equal(parseAcarsdec('not json'), undefined);
  assert.equal(parseAcarsdec('null'), undefined);
});

test('squitter gives station and position', () => {
  const s = parseSquitter(line({ label: 'SQ', freq: 131.55, text: '02XAIADKIAD0000N38575W077277V136975/AUSA' }))!;
  assert.equal(s.station, 'KIAD');
  assert.equal(s.freqMhz, 131.55);
  near(s.lat, 38.9583);
  near(s.lon, -77.4617);
  assert.equal(parseSquitter(line({ label: 'SQ', text: 'garbage' })), undefined);
  assert.equal(parseSquitter(line({ label: 'H1', text: '02XAIADKIAD0000N38575W077277V136975' })), undefined);
  assert.equal(parseSquitter('nope'), undefined);
});
