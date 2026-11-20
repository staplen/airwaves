import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBits, decodeEot, describeEot } from '../src/eot.ts';

/** Builds a valid 74-bit packet (frame sync … check bits) with fields LSB first. */
function packet(unit: number, psi: number, moving: boolean, marker: boolean): string {
  const p = [...'11100010010', ...'0'.repeat(63)];
  const put = (at: number, width: number, v: number) => {
    for (let i = 0; i < width; i++) p[at + i] = (v >> i) & 1 ? '1' : '0';
  };
  put(13, 2, 0b11); // battery condition OK
  put(18, 17, unit);
  put(35, 7, psi);
  p[53] = moving ? '1' : '0';
  p[55] = marker ? '1' : '0';
  const data = p.slice(11, 56).join('');
  const check = checkBits([...data].reverse().join(''));
  return p.slice(0, 56).join('') + check;
}

/** Continuous-phase FFSK audio at 12 kHz: 1200 Hz for 1, 1800 Hz for 0, with a bit-sync preamble. */
function audio(bits: string, sr = 12_000): Int16Array {
  const all = '1010'.repeat(12) + '101010' + bits + '0101';
  const spb = sr / 1200;
  const out = new Int16Array(Math.ceil(all.length * spb) + 200);
  let phase = 0;
  for (let n = 100; n < out.length - 100; n++) {
    const b = all[Math.floor((n - 100) / spb)] ?? '0';
    phase += (2 * Math.PI * (b === '1' ? 1200 : 1800)) / sr;
    out[n] = Math.round(8000 * Math.sin(phase));
  }
  return out;
}

test('decodes a synthetic end-of-train packet', () => {
  const r = decodeEot(audio(packet(54509, 86, true, true)), 12_000);
  assert.equal(r.length, 1);
  assert.equal(r[0].unit, 54509);
  assert.equal(r[0].brakePsi, 86);
  assert.equal(r[0].bitsFixed, 0);
  assert.equal(describeEot(r[0]), 'End-of-train device 54509 · brake pipe 86 psi · moving · rear marker light on.');
});

test('corrects one flipped bit, rejects garbage', () => {
  const p = packet(4074, 88, false, true);
  const flipped = p.slice(0, 40) + (p[40] === '1' ? '0' : '1') + p.slice(41);
  const r = decodeEot(audio(flipped), 12_000);
  assert.equal(r[0]?.unit, 4074);
  assert.equal(r[0]?.bitsFixed, 1);
  assert.equal(decodeEot(audio('1'.repeat(74)), 12_000).length, 0);
});
