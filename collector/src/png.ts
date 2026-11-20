import { inflateSync } from 'node:zlib';

// Just enough PNG decoding to answer one question: does this overlay image draw anything? The HD Radio weather
// radar is a transparent overlay, and on a dry day every pixel is fully transparent.

/** True if any pixel is visible, false if the image is entirely transparent, undefined if it can't be read. */
export function pngHasVisiblePixels(buf: Buffer): boolean | undefined {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
  let p = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let type = 0;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      if (body[12] !== 0) return undefined; // interlaced: not worth supporting here
    } else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || !w || !h) return undefined;
  // Without an alpha channel or tRNS, every pixel is drawn.
  if ((type === 0 || type === 2 || type === 3) && !trns) return true;
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!bpp) return undefined;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) return undefined;
  let prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      if (type === 4 && line[x * 2 + 1] > 0) return true;
      if (type === 6 && line[x * 4 + 3] > 0) return true;
      if (type === 3 && trns && (line[x] >= trns.length || trns[line[x]] > 0)) return true;
      if (type === 0 && trns && line[x] !== trns.readUInt16BE(0)) return true;
      if (type === 2 && trns && (line[x * 3] !== trns.readUInt16BE(0) || line[x * 3 + 1] !== trns.readUInt16BE(2) || line[x * 3 + 2] !== trns.readUInt16BE(4))) return true;
    }
    prev = Buffer.from(line);
  }
  return false;
}
