// End-of-train (EOT) device packets on 457.9375 MHz: 1200-baud FFSK, 1200 Hz = 1, 1800 Hz = 0.
// Layout (public, from Eric Reuter's DEF CON 26 talk on EOT telemetry): bit sync …101010, 11-bit frame sync
// 11100010010, a 45-bit data block, then 18 BCH check bits (generator 1111001101000001111) XORed with
// 101011011101110000. Multi-bit fields are sent least significant bit first. Written from that description.
// Checked against the talk's slides: same tones (mark 1200 Hz = 1), FFSK at 1200 baud, BCH (63,45) with an XOR
// cipher, trailing 1 bit. The slides list the frame sync and generator in the opposite bit order, and put message
// type before battery condition; real packets here validate with this order (chaining 11, battery 11 = OK, message
// type 000), which is also the order in the talk author's PyEOT code.

const BAUD = 1200;
const SYNC = '10101011100010010'; // last 6 bits of the bit sync + the frame sync
const GEN = '1111001101000001111';
const KEY = '101011011101110000';
const PACKET_BITS = 74; // from the frame sync to the end of the check bits

export interface EotPacket {
  unit: number; // the device's address (unique per EOT box)
  brakePsi: number; // brake pipe pressure at the rear of the train
  batteryPct?: number; // undefined when the device reports 0 (not monitored)
  batteryCondition: 'OK' | 'Low' | 'Very low' | 'Not monitored';
  moving: boolean;
  markerLight: boolean; // the flashing light on the back of the last car
  arming: boolean; // message type 111: pairing with the locomotive's head-of-train device
  replying: boolean; // confirmation bit: answering a status request from the locomotive
  markerBatteryWeak: boolean;
  bitsFixed: number; // bit errors corrected by the checksum (0 or 1)
}

const rev = (s: string) => [...s].reverse().join('');

export function checkBits(data45: string): string {
  const reg = [...data45, ...'0'.repeat(GEN.length - 1)];
  for (let i = 0; i < data45.length; i++) {
    if (reg[i] !== '1') continue;
    for (let j = 0; j < GEN.length; j++) reg[i + j] = reg[i + j] === GEN[j] ? '0' : '1';
  }
  return reg.slice(-(GEN.length - 1)).map((b, i) => (b === KEY[i] ? '0' : '1')).join('');
}

// Chaining bits are 11 for a single-block message (the only kind an EOT sends).
const valid = (p: string) => p.slice(11, 13) === '11' && checkBits(rev(p.slice(11, 56))) === p.slice(56, 74);

function fields(p: string, bitsFixed: number): EotPacket {
  const num = (a: number, b: number) => parseInt(rev(p.slice(a, b)), 2);
  const battery = Math.round((num(42, 49) / 127) * 100);
  const cond = rev(p.slice(13, 15));
  return {
    unit: num(18, 35),
    brakePsi: num(35, 42),
    batteryPct: battery > 0 ? battery : undefined,
    batteryCondition: cond === '11' ? 'OK' : cond === '10' ? 'Low' : cond === '01' ? 'Very low' : 'Not monitored',
    moving: p[53] === '1',
    markerLight: p[55] === '1',
    arming: p.slice(15, 18) === '111',
    replying: p[51] === '1',
    markerBatteryWeak: p[54] === '1',
    bitsFixed,
  };
}

/** Checks the packet, or corrects a single flipped bit; undefined if neither works. */
function repair(p: string): { p: string; fixed: number } | undefined {
  if (valid(p)) return { p, fixed: 0 };
  for (let i = 11; i < PACKET_BITS; i++) {
    const q = p.slice(0, i) + (p[i] === '1' ? '0' : '1') + p.slice(i + 1);
    if (valid(q)) return { p: q, fixed: 1 };
  }
  return undefined;
}

/** Energy at `f` Hz over `n` samples starting at `i`. */
function tone(x: Int16Array, i: number, n: number, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr;
  let re = 0;
  let im = 0;
  for (let k = 0; k < n; k++) {
    re += x[i + k] * Math.cos(w * k);
    im -= x[i + k] * Math.sin(w * k);
  }
  return re * re + im * im;
}

function bitsAt(x: Int16Array, sr: number, phase: number): string {
  const spb = sr / BAUD;
  const n = Math.floor(spb);
  let out = '';
  for (let t = phase; t + n < x.length; t += spb) {
    const i = Math.floor(t);
    out += tone(x, i, n, 1200, sr) > tone(x, i, n, 1800, sr) ? '1' : '0';
  }
  return out;
}

/** Every distinct valid packet in a recording (an EOT repeats its packet, so duplicates are merged). */
export function decodeEot(x: Int16Array, sr: number): EotPacket[] {
  const found = new Map<string, EotPacket>();
  const spb = sr / BAUD;
  for (let phase = 0; phase < spb; phase += 2) {
    const bits = bitsAt(x, sr, phase);
    for (let i = bits.indexOf(SYNC); i >= 0 && i + 6 + PACKET_BITS <= bits.length; i = bits.indexOf(SYNC, i + 1)) {
      const r = repair(bits.slice(i + 6, i + 6 + PACKET_BITS));
      if (!r) continue;
      const f = fields(r.p, r.fixed);
      const key = `${f.unit}:${f.brakePsi}:${f.moving}:${f.markerLight}`;
      const prev = found.get(key);
      if (!prev || f.bitsFixed < prev.bitsFixed) found.set(key, f);
    }
  }
  return [...found.values()];
}

/** One line for the feed: what the end-of-train device reported. */
export function describeEot(p: EotPacket): string {
  const parts = [
    `End-of-train device ${p.unit}`,
    p.arming ? 'pairing with the locomotive' : p.replying ? 'answering the locomotive' : undefined,
    `brake pipe ${p.brakePsi} psi`,
    p.moving ? 'moving' : 'stopped',
    p.markerLight ? 'rear marker light on' : 'marker light off',
    p.markerBatteryWeak ? 'marker light battery weak' : undefined,
    p.batteryCondition === 'Low' || p.batteryCondition === 'Very low' ? `battery ${p.batteryCondition.toLowerCase()}` : p.batteryPct !== undefined ? `battery ${p.batteryPct}%` : undefined,
  ].filter(Boolean);
  return `${parts.join(' · ')}.`;
}

// ---- head-of-train (locomotive → rear device) on 452.9375 MHz ----------------------------------------------------
// Same modulation. Layout as described by RIT's "Detector-Station" senior project (from the ES protocol ICD): a 30-bit
// sync (the last 6 bits of the bit sync + a 24-bit frame sync), then 64 bits: 5 bits, the 17-bit unit address of the
// rear device being talked to, an 8-bit command, 33 BCH check bits (no cipher), and an odd-parity bit over all 64.
// Written from that description; not yet confirmed on a real capture here.
const HOT_SYNC = '010101100011110001000100101001';
const HOT_GEN = '1110011011010111000010110011111011';
const HOT_COMMANDS: Record<number, 'status request' | 'emergency brake'> = { 0b10101010: 'emergency brake', 0b01010101: 'status request' };

export interface HotPacket {
  unit: number; // the rear device it is addressing (matches EotPacket.unit)
  command: 'status request' | 'emergency brake';
}

function mod2(dividend: string, gen: string): string {
  const reg = [...dividend, ...'0'.repeat(gen.length - 1)];
  for (let i = 0; i < dividend.length; i++) {
    if (reg[i] !== '1') continue;
    for (let j = 0; j < gen.length; j++) reg[i + j] = reg[i + j] === gen[j] ? '0' : '1';
  }
  return reg.slice(-(gen.length - 1)).join('');
}

/** Checks a 64-bit head-of-train block (after the frame sync); undefined unless BCH and parity both pass. */
export function parseHot(block: string): HotPacket | undefined {
  if (block.length < 64) return undefined;
  const info = block.slice(0, 30);
  if (mod2(rev(info), HOT_GEN) !== block.slice(30, 63)) return undefined;
  if ([...block.slice(0, 64)].filter((b) => b === '1').length % 2 !== 1) return undefined;
  const command = HOT_COMMANDS[parseInt(rev(block.slice(22, 30)), 2)];
  if (!command) return undefined;
  return { unit: parseInt(rev(block.slice(5, 22)), 2), command };
}

/** Builds a valid head-of-train block (for tests). */
export function hotBlock(unit: number, command: HotPacket['command']): string {
  const bits = (v: number, w: number) => [...Array(w)].map((_, i) => ((v >> i) & 1 ? '1' : '0')).join(''); // LSB first
  const code = Number(Object.entries(HOT_COMMANDS).find(([, c]) => c === command)![0]);
  const info = '00000' + bits(unit, 17) + bits(code, 8);
  const body = info + mod2(rev(info), HOT_GEN);
  return body + ([...body].filter((b) => b === '1').length % 2 === 0 ? '1' : '0');
}

/** Every distinct valid head-of-train packet in a recording. */
export function decodeHot(x: Int16Array, sr: number): HotPacket[] {
  const found = new Map<string, HotPacket>();
  const spb = sr / BAUD;
  for (let phase = 0; phase < spb; phase += 2) {
    const bits = bitsAt(x, sr, phase);
    for (let i = bits.indexOf(HOT_SYNC); i >= 0 && i + HOT_SYNC.length + 64 <= bits.length; i = bits.indexOf(HOT_SYNC, i + 1)) {
      const h = parseHot(bits.slice(i + HOT_SYNC.length, i + HOT_SYNC.length + 64));
      if (h) found.set(`${h.unit}:${h.command}`, h);
    }
  }
  return [...found.values()];
}

export function describeHot(h: HotPacket): string {
  return h.command === 'emergency brake'
    ? `Locomotive sent an EMERGENCY BRAKE command to end-of-train device ${h.unit} (it vents the brake pipe from the rear).`
    : `Locomotive asked end-of-train device ${h.unit} for a status update.`;
}

// ---- beta: distributed power (lead ↔ helper locomotives) --------------------------------------------------------
// RIT's Detector-Station lists a DPU frame sync but no decoder; we only note bursts that carry it (raw log, count).
const DPU_SYNC = '0011101100010110';
export function hasDpuSync(x: Int16Array, sr: number): boolean {
  const spb = sr / BAUD;
  for (let phase = 0; phase < spb; phase += 2) if (bitsAt(x, sr, phase).includes(DPU_SYNC)) return true;
  return false;
}

