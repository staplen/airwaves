import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AisDecoder } from '../src/ais.ts';
import { parseVdl2 } from '../src/vdl2.ts';
import { flightName, translateAcars } from '../src/acars.ts';
import { parseRtl433 } from '../src/rtl433.ts';
import { parseSame } from '../src/eas.ts';
import { SondeTracker } from '../src/sonde.ts';
import { baseName, parseHdLog } from '../src/hdradio.ts';

const near = (a: number | undefined, b: number, eps = 0.01) => assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} not within ${eps} of ${b}`);

test('AIS type 21 aid to navigation', () => {
  const m = new AisDecoder().push('!AIVDM,1,1,,B,ENk`tM<Jh@@@@@@@@@@@@@@@@@@=?g>d;7Vlp00003vP000,2*5C') as any;
  assert.equal(m.type, 21);
  assert.equal(m.aidType, 'Port hand mark');
  assert.equal(m.name, '5');
  near(m.lat, 38.8632);
  near(m.lon, -77.0101);
});

test('AIS type 4 base station', () => {
  const m = new AisDecoder().push('!AIVDM,1,1,,A,403OKA1uM1g:0rNtE2F;=U?02L10,0*5B') as any;
  assert.equal(m.type, 4);
  near(m.lat, 38.754);
});

test('AIS two-part type 5', () => {
  const d = new AisDecoder();
  assert.equal(d.push('!AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0*1C'), undefined);
  const m = d.push('!AIVDM,2,2,1,A,88888888880,2*25') as any;
  assert.equal(m.type, 5);
  assert.equal(m.name, 'EVER DIADEM');
  assert.equal(m.shipType, 70);
});

test('ACARS translations', () => {
  const posn = translateAcars('16', 'POSN38175W077049,HVNNN,201614,370,BAILZ,202033,PALEO,M55,298029,1051560');
  assert.ok(posn);
  assert.match(posn.headline, /37,000 ft/);
  assert.match(posn.headline, /BAILZ/);
  assert.match(translateAcars('5Z', 'ETA RV1637/17/17 YUL 2131Z')?.headline ?? '', /Montreal/);
  assert.match(translateAcars('H1', '++86501,N8748Q,B7378MAX,261117,WN2543,KFLL,KBWI,0410')?.headline ?? '', /Boeing 737 MAX 8/);
  assert.match(translateAcars('H1', 'PAGE 00001\nMDC REPORT: SYSTEM PARAMETERS\nFILENAME: X')?.headline ?? '', /maintenance report/i);
  assert.equal(translateAcars('RA', 'RESREQ/AK,4709A1'), undefined);
  assert.equal(translateAcars('36', '71,M,2015,5,2,KEWR,40.27,-77.17'), undefined);
});

test('flightName', () => {
  assert.equal(flightName('WN2543'), 'Southwest 2543');
});

test('VDL2 XID handoff mentions destination', () => {
  const raw = JSON.stringify({
    vdl2: {
      t: { sec: 1 },
      freq: 136975000,
      avlc: {
        src: { addr: 'A22358' },
        xid: { vdl_params: [{ name: 'dst_airport', value: 'KBOS' }, { name: 'ac_location', value: { loc: { lat: 38.0, lon: -76.9 }, alt: 35000 } }] },
      },
    },
  });
  const c = parseVdl2(raw);
  assert.ok(c);
  assert.match(c.body, /Boston/);
  assert.equal(c.altFt, 35000);
  near(c.freqMhz, 136.975, 0.0001);
});

test('rtl_433 classification', () => {
  const tpms = parseRtl433(JSON.stringify({ time: '2026-01-01 12:00:00', model: 'Toyota', type: 'TPMS', id: 'abcd1234', pressure_kPa: 220.5, temperature_C: 21, freq: 315.0 }));
  assert.equal(tpms?.kind, 'tpms');
  const meter = parseRtl433(JSON.stringify({ model: 'ERT-SCM', id: 12345678, consumption_data: 4321, freq: 912.6 }));
  assert.equal(meter?.kind, 'meter');
  assert.equal(parseRtl433('not json'), undefined);
});

test('SAME header', () => {
  const a = parseSame('EAS: ZCZC-WXR-RWT-011001-024031+0030-3211500-KHB36   -');
  assert.ok(a);
  assert.equal(a.code, 'RWT');
  assert.equal(a.test, true);
  assert.equal(a.durationMin, 30);
  assert.deepEqual(a.areas, ['011001', '024031']);
  assert.equal(a.station, 'KHB36');
});

test('radiosonde tracker: detected then burst', () => {
  const t = new SondeTracker();
  const pkt = (alt: number, v: number, lon = -77.4) => JSON.stringify({ type: 'PAYLOAD_SUMMARY', callsign: 'S123', latitude: 38.9, longitude: lon, altitude: alt, vel_v: v });
  assert.equal(t.push(pkt(6000, 5))?.kind, 'detected');
  for (let alt = 8000; alt <= 20000; alt += 2000) assert.equal(t.push(pkt(alt, 5, -77.4 + alt / 1e5))?.kind, 'update');
  const e = t.push(pkt(19000, -15));
  assert.equal(e?.kind, 'burst');
  assert.equal(e?.balloon.maxAltM, 20000);
  assert.equal(t.push(pkt(17000, -15))?.kind, 'update'); // burst reported once
});

test('HD Radio log keeps the station and the last song', () => {
  const r = parseHdLog(
    ['12:00:01 Station name: WTOP-FM', '12:00:02 Slogan: News', '12:00:05 Title: Song A', '12:00:05 Artist: Band A', '12:01:00 Title: Song B', '12:01:00 Artist: Band B', '12:01:01 Audio bit rate: 40 kbps'].join('\n'),
  );
  assert.equal(r.station, 'WTOP-FM');
  assert.equal(r.slogan, 'News');
  assert.equal(r.title, 'Song B');
  assert.equal(r.artist, 'Band B');
  assert.equal(r.album, undefined);
});

test('HD Radio log finds the album art LOT and trims the station name', () => {
  const r = parseHdLog(
    [
      '15:24:28 Station name: HOT ',
      '15:24:30 Slogan: HOT 99.5',
      '15:24:31 Title: Shy Girl',
      '15:24:31 Artist: Haute & Freddy',
      '15:24:31 XHDR: 0 BE4B7536 40445',
      '15:24:49 LOT file: port=0802 lot=40445 name=WIHTHD029dfd.jpg size=5317 mime=1E653E9C expiry=2026-11-18T17:22:00Z',
      '15:24:59 LOT file: port=0810 lot=896 name=TMT_03ggta_2_2_20261118_1514_0380.png size=6698 mime=4F328CA0 expiry=2026-11-18T15:47:00Z',
      '15:25:19 LOT file: port=0820 lot=1171 name=DWRI_03ggta_rev06_0493.txt size=512 mime=BB492AAC expiry=2026-11-18T15:52:00Z',
    ].join('\n'),
  );
  assert.equal(r.station, 'HOT');
  assert.equal(r.title, 'Shy Girl');
  assert.equal(r.artLot, 40445);
  assert.equal(r.lots.length, 3);
  assert.deepEqual(r.lots.find((l) => l.lot === 40445), { lot: 40445, port: '0802', name: 'WIHTHD029dfd.jpg' });
});

test('nrsc5 dump names carry the LOT id prefix', () => {
  assert.equal(baseName('40448_WIHTHD029e00.jpg'), 'WIHTHD029e00.jpg');
  assert.equal(baseName('50015_SLWIHT$$0111270000.png'), 'SLWIHT$$0111270000.png');
  assert.equal(baseName('883_TMT_03ggta_3_3_20261118_1524_0373.png'), 'TMT_03ggta_3_3_20261118_1524_0373.png');
});
