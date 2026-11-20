import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCar, makeOf, TireGrouper, tireReading } from '../src/tires.ts';

test('a real Ford reading: make, pressure, temperature, moving', () => {
  const f = { model: 'Ford', type: 'TPMS', id: '60eaab81', pressure_PSI: 76.25, temperature_C: 37.0, moving: 1, learn: 0 };
  const g = new TireGrouper();
  g.add(tireReading('Ford', '60eaab81', f, 1000));
  assert.deepEqual(g.flush(20_000), []); // still within the quiet period
  const [car] = g.flush(40_000);
  const d = describeCar(car, 1);
  assert.equal(d.title, 'Ford or Lincoln');
  assert.equal(d.body, 'Tire 76 PSI · 99°F · moving · van or pickup pressure · 1 of its wheels heard.');
  assert.ok(!d.body.includes('60eaab81')); // sensor IDs never shown
});

test('wheels heard together become one car; a low tire and repeat visits are noted', () => {
  const g = new TireGrouper();
  [['a', 35], ['b', 34], ['c', 26], ['d', 35]].forEach(([id, psi], i) => g.add(tireReading('PMV-107J', String(id), { pressure_kPa: (psi as number) / 0.145038, temperature_C: 20 }, 1000 + i * 2000)));
  g.add(tireReading('PMV-107J', 'a', { pressure_kPa: 35 / 0.145038, temperature_C: 21 }, 9000)); // repeat of wheel a
  const cars = g.flush(60_000);
  assert.equal(cars.length, 1);
  assert.equal(cars[0].tires.length, 4);
  const d = describeCar(cars[0], 3);
  assert.equal(d.title, 'Toyota or Lexus · seen on 3 days');
  assert.match(d.body, /^Tires 35, 34, 26, 35 PSI · 68–70°F · 1 tire noticeably lower than the others · 4 of its wheels heard\.$/);
  assert.equal(makeOf('Jansite'), 'aftermarket sensor');
});
