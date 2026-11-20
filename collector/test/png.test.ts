import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { pngHasVisiblePixels } from '../src/png.ts';

function chunk(kind: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, Buffer.from(kind, 'ascii'), body, Buffer.alloc(4)]); // CRC isn't checked
}
/** 2×2 gray+alpha PNG with the given alpha values (filter 0 rows). */
function grayAlpha(alphas: number[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 4;
  const raw = Buffer.from([0, 0, alphas[0], 0, alphas[1], 0, 0, alphas[2], 0, alphas[3]]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('fully transparent radar is empty, one visible pixel is not', () => {
  assert.equal(pngHasVisiblePixels(grayAlpha([0, 0, 0, 0])), false);
  assert.equal(pngHasVisiblePixels(grayAlpha([0, 0, 0, 200])), true);
  assert.equal(pngHasVisiblePixels(Buffer.from('not a png at all, just text padding')), undefined);
});
