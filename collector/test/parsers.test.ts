import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AisDecoder } from '../src/ais.ts';
import { parseVdl2 } from '../src/vdl2.ts';
import { airport, flightName, translateAcars } from '../src/acars.ts';
import { parseRtl433 } from '../src/rtl433.ts';
import { parseSame } from '../src/eas.ts';
import { SondeTracker } from '../src/sonde.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOverlays } from '../src/overlays.ts';
import { baseName, classifyText, parseHdLog, textMatchesClip } from '../src/hdradio.ts';

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
        src: { addr: 'A22358', type: 'Aircraft' },
        dst: { addr: '11108A', type: 'Ground station' },
        xid: { type: 'XID_CMD_HO', type_descr: 'Handoff Request', vdl_params: [{ name: 'dst_airport', value: 'KBOS' }, { name: 'ac_location', value: { loc: { lat: 38.0, lon: -76.9 }, alt: 35000 } }] },
      },
    },
  });
  const c = parseVdl2(raw);
  assert.ok(c);
  assert.match(c.body, /Boston/);
  assert.match(c.title, /handoff request$/);
  assert.match(c.body, /^Asked to switch to ground station 11108A\. Bound for Boston/);
  assert.equal(c.raw, 'Handoff Request · ground station 11108A');
  assert.equal(c.altFt, 35000);
  assert.equal(c.hex, 'a22358'); // joins to the ADS-B aircraft with the same ICAO address
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

test('overlays: traffic tiles and radar from HD Radio sample files', () => {
  // Synthetic copies of a real capture: the index files' coordinates verbatim, empty images.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlays-'));
  try {
    fs.writeFileSync(path.join(dir, 'TMI_03ggta_rev3_007e.txt'), [
      'TrafficMapProtocolVersionID="1.3"', 'TrafficMapID="03ggta"', 'NumRows="3"', 'NumColumns="3"',
      'CoordinatesRow1="(39.46860,-77.74783)";"(39.11168,-77.39091)";"(39.46860,-77.03399)";"(39.11168,-76.67707)"',
      'CoordinatesRow2="(39.11168,-77.74783)";"(38.75476,-77.39091)";"(39.11168,-77.03399)";"(38.75476,-76.67707)"',
      'CoordinatesRow3="(38.75476,-77.74783)";"(38.39784,-77.39091)";"(38.75476,-77.03399)";"(38.39784,-76.67707)"',
      'BackgroundRGBColor="(194,187,96)"',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'DWRI_03ggta_rev06_0493.txt'), 'DWR_Area_ID="03ggta"\nCoordinates="(40.90135,-79.98062)";"(36.70309,-74.59073)"\n');
    for (const rc of ['3_3_20261118_1524_0373', '3_2_20261118_1524_0374', '3_1_20261118_1524_0375', '2_3_20261118_1524_0376', '1_2_20261118_1524_037a', '1_1_20261118_1524_037b'])
      fs.writeFileSync(path.join(dir, `TMT_03ggta_${rc}.png`), '');
    fs.writeFileSync(path.join(dir, 'DWRO_03ggta_rev06_20261118_1518_0756.png'), '');
    const now = Date.UTC(2026, 10, 18, 15, 40);
    const o = readOverlays(dir, now);
    assert.equal(o.traffic?.mapId, '03ggta');
    assert.equal(o.traffic?.tiles.length, 6);
    const t = o.traffic!.tiles.find((x) => x.url.includes('_1_1_'))!;
    assert.equal(o.traffic?.rows, 3);
    assert.equal(o.traffic?.cols, 3);
    assert.deepEqual([t.row, t.col], [1, 1]);
    const want = [-77.74783, 39.11168, -77.39091, 39.4686];
    want.forEach((w, i) => near(t.bounds[i], w, 1e-4));
    const want2 = [-79.98062, 36.70309, -74.59073, 40.90135];
    want2.forEach((w, i) => near(o.radar?.bounds[i], w, 1e-4));
    assert.deepEqual(o.traffic?.background, [194, 187, 96]);
    assert.deepEqual(readOverlays(dir, now + 3 * 3600_000), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HD Radio text vs clip timing', () => {
  // Title already playing at tune-in: matches.
  const a = parseHdLog(['12:00:01 Station name: HOT', '12:00:04 Title: Taste', '12:00:04 Artist: Sabrina Carpenter', '12:00:16 Clip end: last 12 s'].join('\n'));
  assert.equal(a.firstTitle, true);
  assert.equal(textMatchesClip(a, 12), true);
  // Title changed 4 s before the end: the clip mostly holds the previous audio.
  const b = parseHdLog(['12:00:04 Title: Song A', '12:00:04 Artist: X', '12:00:12 Title: Injured? Call 1-800-HURT123', '12:00:16 Clip end: last 12 s'].join('\n'));
  assert.equal(b.titleSince, 12 * 3600 + 12);
  assert.equal(textMatchesClip(b, 12), false);
  // Changed before the clip started: matches. Repeated title lines don't count as changes.
  const c = parseHdLog(['12:00:00 Title: A', '12:00:02 Title: B', '12:00:10 Title: B', '12:00:20 Clip end: last 12 s'].join('\n'));
  assert.equal(textMatchesClip(c, 12), true);
});

test('HD Radio text: songs vs station messages', () => {
  assert.equal(classifyText('Love You, Miss You, Mean It', 'Luke Bryan', 'WMZQ', '98.7 WMZQ'), 'song');
  assert.equal(classifyText('California Gurls', 'Katy Perry', 'HOT', 'HOT 99.5'), 'song');
  assert.equal(classifyText('Injured? Attorney BIG AL 1-800-HURT123', undefined, 'HOT', 'HOT 99.5'), 'message');
  assert.equal(classifyText("Nobody Plays More '80s!", '94.7 The Drive', 'WIAD', 'HD1'), 'message');
  assert.equal(classifyText("Poe's Village Day On Wpgc With Dj Dubwise", 'Stream The Shenanigans On The Free Audacy App!!', 'WPGC', 'HD1'), 'message');
  assert.equal(classifyText('WAMU 88-5 American University Radio', 'WAMU 88.5', 'WAMU', 'HD1'), 'message');
  assert.equal(classifyText('BIG 100.3', undefined, 'BIG', 'HD1'), 'message');
  assert.equal(classifyText('Turn to 92.7 & 95.9', 'Looking For Praise? Tune in', 'WLNO', 'HD1'), 'message');
});

test('airport names: short names for majors, city + state from the bundled list', () => {
  assert.equal(airport('KBOS'), 'Boston (KBOS)');
  assert.equal(airport('KJNX'), 'Smithfield, NC (KJNX)');
  assert.equal(airport('ZZZZ'), 'ZZZZ');
});

test('VDL2 check-in names the ground station when the list knows it', async () => {
  const { setGroundStations, parseGroundStations } = await import('../src/groundstations.ts');
  setGroundStations(parseGroundStations(JSON.stringify({ ground_stations: [{ id: '11204A', airport: { icao: 'KBWI', city: 'Baltimore (MD)', name: 'BWI', latitude: '39.175N', longitude: '76.668W' } }] })));
  const raw = JSON.stringify({
    vdl2: { t: { sec: 1 }, freq: 136975000, avlc: { src: { addr: 'A240DC', type: 'Aircraft' }, dst: { addr: '11204A', type: 'Ground station' }, xid: { type: 'XID_CMD_LE', type_descr: 'Link Establishment', vdl_params: [{ name: 'dst_airport', value: 'KBOS' }] } } },
  });
  const c = parseVdl2(raw)!;
  assert.match(c.title, /logged on$/);
  assert.match(c.body, /^Logged on to datalink via the Baltimore, MD ground station \(KBWI\)\./);
  setGroundStations(new Map());
});

test('CPDLC connect and disconnect name the ATC datalink service', () => {
  const frame = (msgType: string) =>
    JSON.stringify({ vdl2: { t: { sec: 1 }, freq: 136975000, avlc: { src: { addr: 'A1B2C3', type: 'Aircraft' }, dst: { addr: '11204A', type: 'Ground station' }, acars: { flight: 'WN1662', reg: '.N244WN', label: 'H1', msg_text: 'USADCXA.DR1.N244WN3559', arinc622: { msg_type: msgType, gs_addr: 'USADCXA', cpdlc: { err: false } } } } } });
  assert.match(parseVdl2(frame('fans1a_cpdlc_disconnect_request'))!.body, /^Ended its controller–pilot text link with FAA Data Comm\./);
  assert.match(parseVdl2(frame('fans1a_cpdlc_connect_confirm'))!.body, /^Connected to FAA Data Comm/);
});

test('multi-block ACARS messages are joined before translating', async () => {
  const { AcarsAssembler } = await import('../src/vdl2.ts');
  const block = (seq: string, more: boolean, text: string) =>
    JSON.stringify({ vdl2: { t: { sec: 1 }, freq: 136975000, avlc: { src: { addr: 'ABADC0', type: 'Aircraft' }, dst: { addr: '11204A', type: 'Ground station' }, acars: { flight: 'WN1004', reg: '.N123WN', label: 'H1', msg_num: 'D49', msg_num_seq: seq, more, msg_text: text } } } });
  const a = new AcarsAssembler();
  assert.deepEqual(a.push(block('A', true, '++76502,XXX,B737-800,261120,WN1004,KLAX,KBWI,2656,SW2501\r\n6\r\n'), 1000), []);
  const out = a.push(block('B', false, 'N3840.0,W07725.7,201756,17754,-14.0,009,023,DC,00000,0,\r\n'), 2000);
  assert.equal(out.length, 1);
  const c = parseVdl2(out[0])!;
  assert.match(c.body, /Los Angeles \(KLAX\) → Baltimore \(KBWI\)/);
  assert.equal(c.points?.length, 1);
  assert.equal(c.points?.[0].altFt, 17754);
});
