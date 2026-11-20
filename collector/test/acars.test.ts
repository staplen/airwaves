import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateAcars } from '../src/acars.ts';

const near = (a: number | undefined, b: number, eps = 0.01) => assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} not within ${eps} of ${b}`);

test('POSN with 5-digit wind field', () => {
  const r = translateAcars('H1', 'POSN37071W077242,GEARS,181558,350,SYFER,182635,JOEPO,M50,25576,139/TS181558,2011265DFC')!;
  assert.match(r.headline, /35,000 ft.*GEARS/);
  assert.match(r.headline, /wind from 255° at 76 kt/);
  near(r.lat, 37.118);
  near(r.lon, -77.403);
});

test('POSN with 6-digit wind field still works', () => {
  const r = translateAcars('H1', 'POSN40055W075494,BYRDD,180142,289,SAAME,180559,FLIRT,M40,298030,2147F66')!;
  assert.match(r.headline, /wind from 298° at 30 kt/);
  near(r.lat, 40.092);
  near(r.lon, -75.823);
});

test('flight summary with XXX registration and embedded position', () => {
  const r = translateAcars('H1', '++76502,XXX,B737-800,261120,WN1004,KLAX,KBWI,2656,SW2501\r\n6\r\nN3840.0,W07725.7,201756,17754,-14.0,009,023,DC,00000,0,\r\n')!;
  assert.equal(r.headline, 'Boeing 737-800, flying Los Angeles (KLAX) → Baltimore (KBWI).');
  near(r.lat, 38.667);
  near(r.lon, -77.428);
});

test('flight summary keeps registration', () => {
  const r = translateAcars('H1', '++86501,N8936Q,B7378MAX,261120,WN2140,KAUS,KBWI,1901,SMX34-2502-F320\r\n6\r\nN3837.3,W07729.6,201702,18505,-15.5,004,026,DC,00000,0,\r\n')!;
  assert.match(r.headline, /^Boeing 737 MAX 8 N8936Q, flying Austin \(KAUS\) → Baltimore \(KBWI\)/);
  near(r.lat, 38.622);
  near(r.lon, -77.493);
});

test('numeric-prefixed DF message', () => {
  const r = translateAcars('H1', '74302,7878,B737-700,261120,WN4075,KDCA,KPVD,2745,SW2501\r\n17.16.20,TO,0433,00684,166.7,.255,016.0,019.8,N3852.3,W07702.5,129960\r\n1149,037.8\r\n')!;
  assert.match(r.headline, /^Boeing 737-700, flying .*\(KDCA\) → .*\(KPVD\)/);
  near(r.lat, 38.872);
  near(r.lon, -77.042);
});

test('label 36 with flight level', () => {
  const r = translateAcars('36', '400,A,20,201126,163410,N3841.7,W07519.1,350,0118,KMYR,KBDL,KBDL,24/,33/,,,,,,,0,0,0,0,0,,,126.6,MXY21F751')!;
  assert.match(r.headline, /FL350/);
  assert.match(r.headline, /\(KMYR\) → .*\(KBDL\)/);
  near(r.lat, 38.695);
  near(r.lon, -75.318);
});

test('label 36 with altitude in feet', () => {
  const r = translateAcars('36', '28,E,20NOV26,164341,N3911.9,W07553.1,23701,9475,KDCA,KBOS,KBOS,33L/,/,,,,,,,,0,0,0,0,0,0,0,,122.3,')!;
  assert.match(r.headline, /23,701 ft/);
  near(r.lat, 39.198);
  near(r.lon, -75.885);
});

test('label 30 decimal position', () => {
  const r = translateAcars('30', '182,HG,1815,3,KEWR,N 39.068,W 76.927,,,200')!;
  near(r.lat, 39.068);
  near(r.lon, -76.927);
});

test('label 21 decimal position with destination', () => {
  const r = translateAcars('21', 'POSN 39.067W 76.913, 217,171736,32004,26314,  67,-45,191512,KMCO')!;
  assert.match(r.headline, /Orlando \(KMCO\)/);
  near(r.lat, 39.067);
  near(r.lon, -76.913);
});

test('label 22 ddmmss position agrees with label 21', () => {
  const r = translateAcars('22', 'N 390401W 765446,-------,171736,32004, ,      , ,M 45,26314  67, 217,')!;
  near(r.lat, 39.067);
  near(r.lon, -76.913);
});

test('label 22 takeoff report', () => {
  const r = translateAcars('22', 'OFF02\r\nKDCA,KMCO,1742,21.6')!;
  assert.match(r.headline, /Took off from .*\(KDCA\) for .*\(KMCO\)/);
  assert.equal(r.lat, undefined);
});

test('label 10 slash-delimited position', () => {
  const r = translateAcars('10', '/N39.282/W077.200/10/0.43/204/075/KHEF/1806/0077/00014/SIGBE/MOWAT/1753/HUSEL/1753/')!;
  assert.match(r.headline, /\(KHEF\)/);
  near(r.lat, 39.282);
  near(r.lon, -77.2);
});

test('label 83 ddmm.m position', () => {
  let r = translateAcars('83', '001PR20171806N3857.2W07527.1400399    ')!;
  near(r.lat, 38.953);
  near(r.lon, -75.452);
  r = translateAcars('83', '001PR20175140N3922.7W07559.22404290033')!;
  near(r.lat, 39.378);
  near(r.lon, -75.987);
});

test('label 4N gives the route only (its coordinate encoding is uncertain)', () => {
  const r = translateAcars('4N', '20184N  ABE  ATL1\r\n0091  0088 N039375 W076528   249')!;
  assert.match(r.headline, /\(ABE\) → .*\(ATL\)/);
  assert.equal(r.lat, undefined);
});

test('label 24 and 4L route headers', () => {
  assert.match(translateAcars('24', '201724 KBWI KATL6')!.headline, /Baltimore \(KBWI\) → .*\(KATL\)/);
  assert.match(translateAcars('4L', '20174L KDCA KPIT7\r\n/FN 4763\r\n/ENG 1 RUN 170059/ENG 2 RUN 171058')!.headline, /\(KDCA\) → .*\(KPIT\)/);
});

test('FPN flight plan', () => {
  const r = translateAcars('H1', 'FPN/RP:DA:KCLT:AA:KPVD:CR:KCLTKPVD(23O)..DANGR.Q22.RBV.Q430.CREEL..ORCHA..JORDN:A:JORDN2.HTO:F:VECTOR..DISCO..CFCDV:AP:ILS 23:F:FOSTY6596')!;
  assert.equal(r.headline, 'Flight plan Charlotte (KCLT) → Providence (KPVD).');
});

test('PRG destination and runway', () => {
  assert.equal(translateAcars('H1', 'PRG/FNUAL511/DTKORD,28C,92,193819,2E2B54')!.headline, "Planning to land at Chicago O'Hare (KORD), runway 28C.");
  assert.equal(translateAcars('H1', 'PRG/TS182545,201126/DTKPVD,23O,120,190945,11725D8')!.headline, 'Planning to land at Providence (KPVD), runway 23.');
});

test('5Z requests', () => {
  assert.match(translateAcars('5Z', '/R3 HOWGOZIT REQ   / KIAD KTPA 20 182552 2277 20 KIAD')!.headline, /\(KIAD\) → .*\(KTPA\)/);
  assert.match(translateAcars('5Z', '/B6 LDG DATA REQ   / KRDU KEWR 20 165358 KEWR R22L/---- G1546')!.headline, /Newark \(KEWR\)/);
});

test('implausible positions are rejected', () => {
  const r = translateAcars('83', '001PR20171806N3857.2E07527.1400399    ');
  assert.equal(r?.lat, undefined);
  // out of North America
  assert.equal(translateAcars('30', '182,HG,1815,3,KEWR,N 39.068,W 176.927,,,200')?.lat, undefined);
});
