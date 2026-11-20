import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAprs } from '../src/aprs.ts';

const near = (a: number | undefined, b: number, eps = 0.0001) => assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} not within ${eps} of ${b}`);

test('multimon-ng prefixed uncompressed position with course/speed/altitude', () => {
  const p = parseAprs('APRS: N3XYZ-9>APDR16,WIDE1-1,WIDE2-1:=3900.12N/07701.23W>123/045/A=000312 hello')!;
  assert.equal(p.kind, 'position');
  assert.equal(p.from, 'N3XYZ-9');
  assert.equal(p.to, 'APDR16');
  assert.deepEqual(p.path, ['WIDE1-1', 'WIDE2-1']);
  assert.equal(p.via, undefined);
  near(p.lat, 39.002);
  near(p.lon, -77.0205);
  assert.deepEqual(p.symbol, { table: '/', code: '>', name: 'car' });
  assert.equal(p.course, 123);
  assert.equal(p.speedKt, 45);
  assert.equal(p.altFt, 312);
  assert.equal(p.comment, 'hello');
});

test('bare direwolf-style frame, via digipeater, southern/eastern hemisphere', () => {
  const p = parseAprs('VK2ABC-7>APRS,VK2RZ*,WIDE2-1,qAR,VK2XYZ:!3351.50S/15112.00E-Sydney')!;
  assert.equal(p.from, 'VK2ABC-7');
  assert.equal(p.via, 'VK2RZ');
  assert.equal(p.path.length, 4);
  near(p.lat, -(33 + 51.5 / 60));
  near(p.lon, 151 + 12 / 60);
  assert.equal(p.symbol?.name, 'house');
  assert.equal(p.comment, 'Sydney');
  assert.equal(p.course, undefined);
});

test('direwolf channel tag and trailing newline are tolerated', () => {
  const p = parseAprs('[0] N0CALL>APRS:!4903.50N/07201.75W-\r\n')!;
  assert.equal(p.from, 'N0CALL');
  near(p.lat, 49.0583);
});

test('timestamped positions (/ and @)', () => {
  const a = parseAprs('N0CALL>APRS:/092345z4903.50N/07201.75W>')!;
  near(a.lat, 49.0583);
  near(a.lon, -72.0292);
  assert.equal(a.kind, 'position');
  const b = parseAprs('N0CALL>APRS:@092345h4903.50N/07201.75W>088/036 hi')!;
  assert.equal(b.course, 88);
  assert.equal(b.speedKt, 36);
  assert.equal(b.comment, 'hi');
});

test('position ambiguity', () => {
  const p = parseAprs('N0CALL>APRS:!4903.5 N/07201.7 W-')!;
  assert.equal(p.ambiguity, 1);
  near(p.lat, 49.0583);
  const q = parseAprs('N0CALL>APRS:!49  .  N/072  .  W-')!;
  assert.equal(q.ambiguity, 4);
  near(q.lat, 49);
  near(q.lon, -72);
});

test('altitude anywhere in comment and negative altitude', () => {
  const p = parseAprs('N0CALL>APRS:!4903.50N/07201.75W>Mobile /A=001234 on the go')!;
  assert.equal(p.altFt, 1234);
  assert.equal(p.comment, 'Mobile  on the go');
});

test('!DAO! precision extension', () => {
  const p = parseAprs('N0CALL>APRS:!4903.50N/07201.75W>test !w5K!')!;
  assert.ok(p.lat! > 49.05836 && p.lat! < 49.05838);
  assert.equal(p.comment, 'test');
});

test('compressed position with course/speed (APRS101 example)', () => {
  const p = parseAprs('N0CALL>APRS:=/5L!!<*e7>7P[')!;
  assert.equal(p.kind, 'position');
  assert.equal(p.compressed, true);
  near(p.lat, 49.5);
  near(p.lon, -72.75);
  assert.equal(p.course, 88);
  near(p.speedKt, 36.2, 0.05);
  assert.deepEqual(p.symbol, { table: '/', code: '>', name: 'car' });
});

test('compressed position with altitude', () => {
  // cs = 1.002^4610 ft, T byte flags GGA altitude
  const c = String.fromCharCode(50 + 33, 60 + 33);
  const p = parseAprs(`N0CALL>APRS:!/5L!!<*e7O${c}1 note`)!;
  assert.equal(p.compressed, true);
  near(p.altFt, Math.pow(1.002, 4610), 1);
  assert.equal(p.speedKt, undefined);
  assert.equal(p.symbol?.name, 'balloon');
  assert.equal(p.comment, 'note');
});

test('Mic-E (APRS101 example): position, course, speed, message', () => {
  const p = parseAprs('APRS: N0CALL>S32UVT,WIDE1-1*:`(_fn"Oj/]Hello')!;
  assert.equal(p.kind, 'position');
  assert.equal(p.via, 'WIDE1-1');
  near(p.lat, 33 + 25.64 / 60);
  near(p.lon, -(112 + 7.74 / 60));
  assert.equal(p.speedKt, 20);
  assert.equal(p.course, 251);
  assert.equal(p.symbol?.name, 'jeep');
  assert.equal(p.miceMessage, 'Returning');
  assert.equal(p.comment, 'Hello');
});

test('Mic-E altitude in comment', () => {
  // 100 m = base91 10100 -> '"', '4', '{'
  const p = parseAprs('N0CALL>S32UVT:\'(_fn"Oj/]"4{}Hi')!;
  assert.equal(p.altFt, 328);
  assert.equal(p.comment, 'Hi');
});

test('Mic-E southern hemisphere, eastern longitude, emergency, 100+ knots', () => {
  const info = String.fromCharCode(73, 58, 53, 40, 28, 28 + 90) + 'k/';
  const p = parseAprs(`N0CALL>123456:\`${info}`)!;
  assert.equal(p.kind, 'position');
  near(p.lat, -(12 + 34.56 / 60));
  near(p.lon, 45 + 30.25 / 60);
  assert.equal(p.speedKt, 120);
  assert.equal(p.course, 90);
  assert.equal(p.symbol?.name, 'truck');
  assert.equal(p.miceMessage, 'Emergency');
});

test('positionless weather', () => {
  const p = parseAprs('N0CALL>APRS:_10090556c220s004g005t077r001p002P003h50b09900wRSW')!;
  assert.equal(p.kind, 'weather');
  assert.equal(p.lat, undefined);
  assert.deepEqual(p.weather, {
    windDir: 220, windMph: 4, gustMph: 5, tempF: 77,
    rainLastHourIn: 0.01, rain24hIn: 0.02, rainSinceMidnightIn: 0.03,
    humidity: 50, pressureMb: 990,
  });
  assert.equal(p.comment, 'wRSW');
});

test('position weather with wind extension (APRS101 example)', () => {
  const p = parseAprs('N0CALL>APRS:@092345z4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900wRSW')!;
  assert.equal(p.kind, 'weather');
  near(p.lat, 49.0583);
  near(p.lon, -72.0292);
  assert.equal(p.symbol?.name, 'weather station');
  assert.equal(p.weather?.windDir, 220);
  assert.equal(p.weather?.windMph, 4);
  assert.equal(p.weather?.gustMph, 5);
  assert.equal(p.weather?.tempF, 77);
  assert.equal(p.weather?.rainLastHourIn, 0);
  assert.equal(p.weather?.humidity, 50);
  assert.equal(p.weather?.pressureMb, 990);
  assert.equal(p.comment, 'wRSW');
  assert.equal(p.course, undefined);
});

test('weather: missing values, h00 = 100%, negative temp, luminosity', () => {
  const p = parseAprs('N0CALL>APRS:_10090556c...s...g...t-05r...p...P...h00b10132L123l003')!;
  assert.equal(p.weather?.windDir, undefined);
  assert.equal(p.weather?.windMph, undefined);
  assert.equal(p.weather?.gustMph, undefined);
  assert.equal(p.weather?.tempF, -5);
  assert.equal(p.weather?.rainLastHourIn, undefined);
  assert.equal(p.weather?.humidity, 100);
  assert.equal(p.weather?.pressureMb, 1013.2);
  assert.equal(p.weather?.luminosity, 1003);
});

test('compressed weather station', () => {
  const p = parseAprs('N0CALL>APRS:!/5L!!<*e7_   g005t077r000')!;
  assert.equal(p.kind, 'weather');
  near(p.lat, 49.5);
  assert.equal(p.weather?.gustMph, 5);
  assert.equal(p.weather?.tempF, 77);
});

test('objects: alive and killed', () => {
  const a = parseAprs('N0CALL>APRS:;LEADER   *092345z4903.50N/07201.75W>088/036')!;
  assert.equal(a.kind, 'object');
  assert.equal(a.name, 'LEADER');
  assert.equal(a.alive, true);
  near(a.lat, 49.0583);
  assert.equal(a.course, 88);
  assert.equal(a.speedKt, 36);
  const k = parseAprs('N0CALL>APRS:;LEADER   _092345z4903.50N/07201.75W>')!;
  assert.equal(k.kind, 'object');
  assert.equal(k.alive, false);
});

test('compressed object', () => {
  const p = parseAprs('N0CALL>APRS:;WX-STN   *092345z/5L!!<*e7_7P[')!;
  assert.equal(p.kind, 'object');
  assert.equal(p.name, 'WX-STN');
  near(p.lon, -72.75);
});

test('item', () => {
  const p = parseAprs('N0CALL>APRS:)AID #2!4903.50N/07201.75WA')!;
  assert.equal(p.kind, 'item');
  assert.equal(p.name, 'AID #2');
  assert.equal(p.alive, true);
  near(p.lat, 49.0583);
  assert.equal(p.symbol?.code, 'A');
  const k = parseAprs('N0CALL>APRS:)AID #2_4903.50N/07201.75WA')!;
  assert.equal(k.alive, false);
});

test('status, message, telemetry', () => {
  const s = parseAprs('N0CALL>APRS:>IO91SX/G Net tonight')!;
  assert.equal(s.kind, 'status');
  assert.equal(s.comment, 'IO91SX/G Net tonight');

  const m = parseAprs('N0CALL>APRS::WB4APR-5 :Hello World{12345')!;
  assert.equal(m.kind, 'message');
  assert.deepEqual(m.message, { to: 'WB4APR-5', text: 'Hello World', id: '12345' });
  const n = parseAprs('N0CALL>APRS::BLN1     :Meeting at noon')!;
  assert.deepEqual(n.message, { to: 'BLN1', text: 'Meeting at noon' });

  const t = parseAprs('N0CALL>APRS:T#005,199,000,255,073,123,01101001')!;
  assert.equal(t.kind, 'telemetry');
});

test('symbol names', () => {
  const sym = (code: string, table = '/') => parseAprs(`N0CALL>APRS:!4903.50N${table}07201.75W${code}`)!.symbol;
  assert.equal(sym('#')?.name, 'digipeater');
  assert.equal(sym('&')?.name, 'iGate');
  assert.equal(sym('k')?.name, 'truck');
  assert.equal(sym('b')?.name, 'bike');
  assert.equal(sym('[')?.name, 'person');
  assert.equal(sym("'")?.name, 'aircraft');
  assert.equal(sym('s')?.name, 'boat');
  assert.equal(sym('a')?.name, 'ambulance');
  assert.equal(sym('f')?.name, 'fire truck');
  assert.equal(sym('#', '1')?.table, '1');
  assert.equal(sym('~')?.name, undefined);
});

test('unknown payloads are kind other', () => {
  const p = parseAprs('N0CALL>APRS:$GPGGA,123519,4807.038,N')!;
  assert.equal(p.kind, 'other');
  assert.equal(p.comment, '$GPGGA,123519,4807.038,N');
  const q = parseAprs('N0CALL>APRS:!garbage not a position')!;
  assert.equal(q.kind, 'other');
  assert.equal(q.lat, undefined);
  assert.equal(q.comment, '!garbage not a position');
});

test('non-APRS lines return undefined and never throw', () => {
  for (const l of ['', 'multimon-ng 1.3.1', 'APRS: ', 'AFSK1200: hello>world:x', 'APRS: no frame here', 'A>B:', '>>>:::', 'N0CALL>APRS']) {
    assert.equal(parseAprs(l), undefined, l);
  }
  const chars = '!=/@`\':;)_>T#0123456789ABCDEFPQRSZ.NSEW -_*{}[]\\';
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    let s = 'N0CALL>' + (i % 2 ? 'S32UVT' : 'APRS') + ',WIDE1-1*:';
    const n = rnd() % 40;
    for (let j = 0; j < n; j++) s += chars[rnd() % chars.length];
    assert.doesNotThrow(() => parseAprs(s));
  }
  assert.equal(parseAprs(undefined as unknown as string), undefined);
});
