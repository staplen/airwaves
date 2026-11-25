import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Aircraft } from '../../shared/types.ts';
import { aircraftName, modelNumberWords } from '../src/aircraftNames.ts';
import { describe, rangeFromRssi, rankCandidates, shortModel, shortOwner, speak } from '../src/wwt.ts';

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
  assert.ok(rangeFromRssi(-18) < 1, 'about −18 dBFS is within a mile on this antenna');
  assert.ok(rangeFromRssi(-33) > 5);
  assert.ok(Math.abs(rangeFromRssi(-24) - Math.sqrt(1.2 * 3)) < 0.01); // halfway between points, in log distance
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

test('short owner and model names for speech', () => {
  assert.equal(shortOwner('United States Army'), 'Army');
  assert.equal(shortOwner('United States Marine Corps'), 'Marines');
  assert.equal(shortOwner('American Airlines Inc', 'AAL1234'), 'American');
  assert.equal(shortOwner('Delta Air Lines Inc', 'DAL55'), 'Delta');
  assert.equal(shortOwner('United Parcel Service Co', 'UPS2901'), 'UPS');
  assert.equal(shortOwner('Wells Fargo Trust Co Na Trustee', 'EJA22'), undefined);
  assert.equal(shortOwner('Some Holdings Llc', 'N123AB'), undefined); // private flight: owner not said
  assert.equal(shortOwner('American Airlines Inc'), undefined); // no airline callsign
  assert.equal(shortOwner('Prince Georges County'), 'Prince Georges County');
  assert.equal(shortOwner('United States Park Police'), 'Park Police');
  assert.equal(shortModel('Sikorsky UH-60 Black Hawk'), 'Black Hawk');
  assert.equal(shortModel('Airbus A-321'), 'Airbus three-twenty-one');
  assert.equal(shortModel('Airbus A-319'), 'Airbus three-nineteen');
  assert.equal(shortModel('Airbus A-350-900'), 'Airbus three-fifty');
  assert.equal(shortModel('Embraer E-175'), 'Embraer one-seventy-five');
  assert.equal(shortModel('Boeing 737-800'), 'Boeing seven-thirty-seven');
  assert.equal(shortModel('Boeing 777-300ER'), 'Boeing triple seven');
  assert.equal(shortModel('Bell 407'), 'Bell four-oh-seven');
  assert.equal(shortModel('Embraer EMB-505 Phenom 300'), 'Phenom three hundred');
});

test('the spoken answer is short', () => {
  const [heli] = rankCandidates([plane({ hex: 'aaa', category: 'A7', military: true, altBaro: 900, lat: home.lat + 0.5 * NM_LAT, lon: home.lon, typeDesc: 'Sikorsky UH-60 Black Hawk', owner: 'United States Army', flight: 'PAT21', track: 135, gs: 0 })], home, now, now);
  assert.equal(speak(heli), 'Army Black Hawk helicopter, under 1,000 feet, just north.');
  assert.equal(speak(heli, true), 'Maybe an Army Black Hawk helicopter, under 1,000 feet, just north.');
  const [jet] = rankCandidates([plane({ hex: 'bbb', category: 'A3', altBaro: 3100, lat: home.lat, lon: home.lon + 1 / (60 * Math.cos((home.lat * Math.PI) / 180)), typeDesc: 'Airbus A-321', owner: 'American Airlines Inc', flight: 'AAL123' })], home, now, now);
  assert.equal(speak(jet), 'American Airbus three-twenty-one, about 3,000 feet, a mile east.');
  const [unknown] = rankCandidates([plane({ hex: 'ccc', category: 'A1', altBaro: 2000, lat: home.lat, lon: home.lon })], home, now, now);
  assert.equal(speak(unknown), 'A light plane, about 2,000 feet, overhead.');
  const [dark] = rankCandidates([plane({ hex: 'ddd', altBaro: 1100, rssi: -4, typeDesc: 'Sikorsky UH-60 Black Hawk', owner: 'United States Army', military: true })], home, now, now);
  assert.equal(speak(dark), 'Army Black Hawk, about 1,000 feet, no position, but close.');
});

test('model numbers are said the way people say them', () => {
  assert.equal(modelNumberWords(220), 'two-twenty');
  assert.equal(modelNumberWords(737), 'seven-thirty-seven');
  assert.equal(modelNumberWords(407), 'four-oh-seven');
  assert.equal(modelNumberWords(777), 'triple seven');
  assert.equal(modelNumberWords(300), 'three hundred');
  assert.equal(modelNumberWords(175), 'one-seventy-five');
});

test('common names and nicknames from the type code and description', () => {
  assert.equal(aircraftName('B212', 'Bell UH-1N Iroquois')?.say, 'Twin Huey');
  assert.equal(aircraftName('B212', 'BELL 212', true)?.say, 'Twin Huey'); // military 212 with a plain description
  assert.equal(aircraftName('B212', 'BELL 212')?.say, 'Bell two-twelve');
  assert.equal(aircraftName('BCS3', undefined)?.say, 'Airbus two-twenty'); // no description in the database
  assert.equal(aircraftName('H60', 'SIKORSKY MH-60T Jayhawk')?.say, 'Jayhawk');
  assert.equal(aircraftName('B737', 'Boeing C-40C')?.say, 'C forty');
  assert.equal(aircraftName('ZZZZ', 'Something Else 12'), undefined);
  const [huey] = rankCandidates([plane({ hex: 'aaa', type: 'B212', category: 'A7', military: true, altBaro: 1200, lat: home.lat + 0.5 * NM_LAT, lon: home.lon, typeDesc: 'Bell UH-1N Iroquois', owner: 'United States Air Force' })], home, now, now);
  assert.equal(speak(huey), 'Air Force Twin Huey helicopter, about 1,000 feet, just north.');
  assert.match(describe(huey), /Bell UH-1N Iroquois \("Twin Huey"\)/);
  const [a220] = rankCandidates([plane({ hex: 'bbb', type: 'BCS3', category: 'A3', altBaro: 4000, lat: home.lat, lon: home.lon, owner: 'Delta Air Lines Inc', flight: 'DAL1' })], home, now, now);
  assert.equal(speak(a220), 'Delta Airbus two-twenty, about 4,000 feet, overhead.');
});

test('size words and private owners stay out of the spoken name', () => {
  const [jet] = rankCandidates([plane({ hex: 'aaa', type: 'C25B', category: 'A1', altBaro: 2500, lat: home.lat, lon: home.lon, typeDesc: 'Cessna 525B Citation CJ3', owner: 'Knausenberger Erich', flight: 'N525XX' })], home, now, now);
  assert.equal(speak(jet), 'Citation C J, about 2,500 feet, overhead.');
  const [dolphin] = rankCandidates([plane({ hex: 'bbb', type: 'AS65', category: 'A7', military: true, altBaro: 800, lat: home.lat, lon: home.lon, typeDesc: 'Eurocopter MH-65D Dolphin' })], home, now, now);
  assert.equal(speak(dolphin), 'Dolphin helicopter, under 1,000 feet, overhead.');
  const [county] = rankCandidates([plane({ hex: 'ccc', category: 'A7', altBaro: 900, lat: home.lat, lon: home.lon, owner: 'Prince Georges County' })], home, now, now);
  assert.equal(speak(county), 'Prince Georges County helicopter, under 1,000 feet, overhead.');
});
