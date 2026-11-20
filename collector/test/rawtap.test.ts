import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawTap, vdl2Kind } from '../src/rawtap.ts';

test('keeps the newest messages per kind and counts all of them', () => {
  const tap = new RawTap({ s: { perKind: 2, maxKinds: 5 } });
  for (let i = 0; i < 4; i++) tap.add('s', 'a', `a${i}`, i);
  tap.add('s', 'b', 'b0', 10);
  assert.deepEqual(tap.get('s').a.map((e) => e.text), ['a2', 'a3']);
  assert.deepEqual(tap.summary().s.map((k) => [k.kind, k.total, k.kept]), [['a', 4, 2], ['b', 1, 1]]);
});

test('drops the least recently heard kind when full', () => {
  const tap = new RawTap({ s: { perKind: 1, maxKinds: 2 } });
  tap.add('s', 'old', 'x', 1);
  tap.add('s', 'mid', 'x', 2);
  tap.add('s', 'new', 'x', 3);
  assert.deepEqual(Object.keys(tap.get('s')).sort(), ['mid', 'new']);
});

test('rate-limits per kind and truncates long text', () => {
  const tap = new RawTap({ s: { perKind: 10, maxKinds: 2, minIntervalMs: 60_000, maxChars: 5 } });
  tap.add('s', 'k', '0123456789', 0);
  tap.add('s', 'k', 'skipped', 30_000);
  tap.add('s', 'k', 'kept', 61_000);
  const e = tap.get('s').k;
  assert.equal(e.length, 2);
  assert.match(e[0].text, /^01234\n…\[5 more chars\]$/);
  assert.equal(tap.summary().s[0].total, 3);
});

test('names dumpvdl2 messages by ACARS label or nested message', () => {
  assert.equal(vdl2Kind(JSON.stringify({ vdl2: { avlc: { src: {}, acars: { label: 'H1' } } } })), 'acars H1');
  assert.equal(vdl2Kind(JSON.stringify({ vdl2: { avlc: { src: {}, dst: {}, xid: { pub_params: [] } } } })), 'xid');
  assert.equal(vdl2Kind(JSON.stringify({ vdl2: { avlc: { src: {}, frame_type: 'S' } } })), 'frame S');
  assert.equal(vdl2Kind('not json'), 'other');
});
