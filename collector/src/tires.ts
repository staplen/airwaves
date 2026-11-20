// Tire-pressure sensors (TPMS) from rtl_433: each wheel has its own sensor and ID, and a passing car's wheels are
// heard within a few seconds of each other. Readings are grouped into cars (same sensor protocol, heard together),
// and each car becomes one feed card: likely make, tire pressures, temperatures, moving or parked.
// The make comes from the sensor protocol, which follows the carmaker's choice of sensor; the model isn't sent.
// Sensor IDs are never shown (they would let anyone follow a particular car).

export interface TireReading {
  model: string; // rtl_433 decoder name, e.g. "Ford", "PMV-107J"
  id: string;
  psi?: number;
  tempC?: number;
  moving?: boolean;
  batteryLow?: boolean;
  ts: number;
}

export interface Car {
  model: string;
  make: string; // "Ford or Lincoln", "Toyota or Lexus", "aftermarket sensor"…
  tires: TireReading[]; // one per wheel heard (latest reading each)
  first: number;
  last: number;
}

/** Likely make from the rtl_433 TPMS protocol name. */
const MAKES: [RegExp, string][] = [
  [/^Ford/i, 'Ford or Lincoln'],
  [/^(Toyota|PMV-107J)/i, 'Toyota or Lexus'],
  [/^(Hyundai|Elantra|Kia)/i, 'Hyundai or Kia'],
  [/^Renault/i, 'Renault or Nissan'],
  [/^Citroen/i, 'Peugeot, Citroën or another PSA/Stellantis car'],
  [/^Abarth/i, 'Fiat or Abarth'],
  [/^(BMW|Bmw)/i, 'BMW or Mini'],
  [/^Porsche/i, 'Porsche'],
  [/^Schrader-EG53MA4/i, 'GM (Chevrolet, GMC, Buick, Cadillac)'],
  [/^Schrader-SMD3MA4/i, 'Subaru or another Schrader-fitted car'],
  [/^Schrader/i, 'GM, Chrysler or another Schrader-fitted car'],
  [/^TRW/i, 'Chrysler, Jeep, Dodge or another TRW-fitted car'],
  [/^(Jansite|Steelmate|Carchet|EezTire|Tyreguard|AVE|TPMS-Solar|Truck)/i, 'aftermarket sensor'],
];
export const makeOf = (model: string) => MAKES.find(([re]) => re.test(model))?.[1] ?? `${model} sensor`;

/** Pulls the useful fields out of an rtl_433 TPMS event. */
export function tireReading(model: string, id: string, f: Record<string, unknown>, ts: number): TireReading {
  const n = (k: string) => (typeof f[k] === 'number' && Number.isFinite(f[k]) ? (f[k] as number) : undefined);
  const psi = n('pressure_PSI') ?? (n('pressure_kPa') !== undefined ? n('pressure_kPa')! * 0.145038 : n('pressure_bar') !== undefined ? n('pressure_bar')! * 14.5038 : undefined);
  const tempC = n('temperature_C') ?? (n('temperature_F') !== undefined ? (n('temperature_F')! - 32) / 1.8 : undefined);
  const moving = n('moving') !== undefined ? n('moving') === 1 : undefined;
  const battery = n('battery_ok');
  return { model, id, psi: psi !== undefined && psi > 0 && psi < 200 ? psi : undefined, tempC: tempC !== undefined && tempC > -50 && tempC < 150 ? tempC : undefined, moving, batteryLow: battery === 0 ? true : undefined, ts };
}

const GROUP_GAP_MS = 20_000; // wheels of one car are heard within seconds of each other
const MAX_WHEELS = 6; // dual rear wheels on a truck

/** Collects readings and hands back cars once they've gone quiet. */
export class TireGrouper {
  private open: Car[] = [];

  add(r: TireReading) {
    let car = this.open.find((c) => c.model === r.model && (c.tires.some((t) => t.id === r.id) || (r.ts - c.last < GROUP_GAP_MS && c.tires.length < MAX_WHEELS)));
    if (!car) this.open.push((car = { model: r.model, make: makeOf(r.model), tires: [], first: r.ts, last: r.ts }));
    const i = car.tires.findIndex((t) => t.id === r.id);
    if (i >= 0) car.tires[i] = { ...car.tires[i], ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) };
    else car.tires.push(r);
    car.last = Math.max(car.last, r.ts);
  }

  /** Cars not heard for a while (they've driven past or the slot ended). */
  flush(now: number, quietMs = 30_000): Car[] {
    const done = this.open.filter((c) => now - c.last >= quietMs);
    this.open = this.open.filter((c) => now - c.last < quietMs);
    return done;
  }
}

const f = (c: number) => Math.round(c * 1.8 + 32);

/** Title and body for a car's feed card. `days` = on how many days any of its sensors has been heard. */
export function describeCar(car: Car, days: number): { title: string; body: string } {
  const psis = car.tires.map((t) => t.psi).filter((v): v is number => v !== undefined);
  const temps = car.tires.map((t) => t.tempC).filter((v): v is number => v !== undefined);
  const moving = car.tires.some((t) => t.moving === true) ? 'moving' : car.tires.some((t) => t.moving === false) ? 'parked' : undefined;
  const n = car.tires.length;
  const parts: string[] = [];
  if (psis.length) parts.push(`${n === 1 ? 'Tire' : 'Tires'} ${psis.map((p) => Math.round(p)).join(', ')} PSI`);
  if (temps.length) parts.push(Math.round(Math.min(...temps)) === Math.round(Math.max(...temps)) ? `${f(temps[0])}°F` : `${f(Math.min(...temps))}–${f(Math.max(...temps))}°F`);
  if (moving) parts.push(moving);
  // Pressure says something about the vehicle: cars run ~30–40 PSI, light trucks 45–80, heavy trucks and RVs more.
  const avg = psis.length ? psis.reduce((a, b) => a + b, 0) / psis.length : undefined;
  if (avg !== undefined) parts.push(avg > 85 ? 'heavy truck or RV pressure' : avg > 50 ? 'van or pickup pressure' : avg < 25 ? 'low: a soft tire or a spare' : '');
  const low = psis.length > 1 ? psis.filter((p) => p < Math.max(...psis) - 6) : [];
  if (low.length) parts.push(`${low.length} tire${low.length === 1 ? '' : 's'} noticeably lower than the others`);
  if (car.tires.some((t) => t.batteryLow)) parts.push('a sensor battery is low');
  parts.push(`${n} of its wheels heard`);
  const regular = days > 1 ? ` · seen on ${days} days` : '';
  return { title: `${car.make.charAt(0).toUpperCase()}${car.make.slice(1)}${regular}`, body: `${parts.filter(Boolean).join(' · ')}.` };
}
