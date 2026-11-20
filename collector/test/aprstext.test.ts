import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeAprs, readableComment } from '../src/aprstext.ts';

const base = { packets: 1, firstHeard: 0, lastHeard: 0 };

test('the three stations from the feed read in plain English', () => {
  assert.deepEqual(describeAprs({ ...base, call: 'NA3MD-1', symbol: 'iGate', comment: 'PHG3130NA3MD-1 Fill-in Digi / iGate', via: 'KV3B-2' }), {
    title: 'NA3MD-1',
    body: 'A ham radio station that passes reports heard over the air on to the internet · says “NA3MD-1 Fill-in Digi / iGate” · heard through relay KV3B-2.',
  });
  assert.deepEqual(describeAprs({ ...base, call: 'NS5Z', symbol: 'house', via: 'N3KTX-1' }), { title: 'NS5Z', body: "A ham radio operator's home station · heard through relay N3KTX-1." });
  assert.deepEqual(describeAprs({ ...base, call: '146.955-', object: 'KV3B-2', comment: 'T000 R40m NET730Sun' }), {
    title: 'Repeater 146.955 MHz',
    body: 'Voice repeater on 146.955 MHz (radios transmit lower, listen here) · reaches about 40 miles · weekly on-air meeting Sun 7:30 PM · announced by KV3B-2.',
  });
});

test('codes are stripped from comments; nothing readable means no quote', () => {
  assert.equal(readableComment('_0'), undefined);
  assert.equal(readableComment('PHG5560 Montgomery ARC'), 'Montgomery ARC');
});
