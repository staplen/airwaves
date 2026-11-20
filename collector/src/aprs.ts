// APRS packet parser (APRS 1.0.1 + common extensions).
//
// Input is a TNC2 monitor-format frame `SRC>DEST,PATH:payload`, optionally
// prefixed by `APRS: ` (multimon-ng -a AFSK1200 -A) or a direwolf `[0] ` channel tag.
// parseAprs never throws; it returns undefined for lines that are not frames.

export type AprsKind = 'position' | 'weather' | 'object' | 'item' | 'status' | 'message' | 'telemetry' | 'other';

export interface AprsSymbol {
  table: string;
  code: string;
  name?: string;
}

export interface AprsWeather {
  windDir?: number;
  windMph?: number;
  gustMph?: number;
  tempF?: number;
  rainLastHourIn?: number;
  rain24hIn?: number;
  rainSinceMidnightIn?: number;
  humidity?: number;
  pressureMb?: number;
  luminosity?: number;
}

export interface AprsMessage {
  to: string;
  text: string;
  id?: string;
}

export interface AprsPacket {
  raw: string;
  from: string;
  to: string;
  path: string[];
  /** First used digipeater (path entry ending in `*`), without the asterisk. */
  via?: string;
  kind: AprsKind;
  lat?: number;
  lon?: number;
  /** Number of position digits masked by spaces (0-4). Only set when > 0. */
  ambiguity?: number;
  symbol?: AprsSymbol;
  course?: number;
  speedKt?: number;
  altFt?: number;
  comment?: string;
  /** Object / item name. */
  name?: string;
  /** Objects and items: false when killed. */
  alive?: boolean;
  weather?: AprsWeather;
  message?: AprsMessage;
  /** True when the position was base-91 compressed. */
  compressed?: boolean;
  /** Mic-E status message (e.g. 'In Service', 'Emergency', 'Custom 3'). */
  miceMessage?: string;
}

// Primary table ('/') symbol names.
const PRIMARY: Record<string, string> = {
  '!': 'police', '#': 'digipeater', '$': 'phone', '%': 'DX cluster', '&': 'iGate', "'": 'aircraft',
  '(': 'satellite station', ')': 'wheelchair', '*': 'snowmobile', '+': 'red cross', '-': 'house',
  ':': 'fire', ';': 'campground', '<': 'motorcycle', '=': 'train', '>': 'car', '?': 'file server',
  '@': 'hurricane', 'A': 'aid station', 'B': 'BBS', 'C': 'canoe', 'E': 'eyeball', 'F': 'tractor',
  'G': 'grid square', 'H': 'hotel', 'I': 'TCP/IP', 'K': 'school', 'L': 'PC user', 'N': 'NTS station',
  'O': 'balloon', 'P': 'police', 'R': 'RV', 'S': 'shuttle', 'T': 'SSTV', 'U': 'bus', 'V': 'ATV',
  'W': 'NWS site', 'X': 'helicopter', 'Y': 'yacht', '[': 'person', ']': 'mailbox', '^': 'large aircraft',
  '_': 'weather station', 'a': 'ambulance', 'b': 'bike', 'c': 'incident command', 'd': 'fire dept',
  'e': 'horse', 'f': 'fire truck', 'g': 'glider', 'h': 'hospital', 'j': 'jeep', 'k': 'truck',
  'l': 'laptop', 'm': 'Mic-E repeater', 'n': 'node', 'o': 'EOC', 'p': 'rover', 'r': 'antenna',
  's': 'boat', 't': 'truck stop', 'u': 'semi truck', 'v': 'van', 'w': 'water station', 'y': 'yagi',
  'z': 'shelter',
};

// Alternate table ('\\' or overlay) names, a small common subset.
const ALTERNATE: Record<string, string> = {
  '#': 'digipeater', '&': 'iGate', "'": 'crash site', '-': 'house', '>': 'car', '^': 'aircraft',
  '_': 'weather station', 'a': 'ambulance', 'f': 'fire truck', 'j': 'jeep', 'k': 'truck',
  's': 'boat', 'u': 'truck', 'v': 'van', 'O': 'rocket', 'h': 'hospital', '[': 'person',
};

function symbolOf(table: string, code: string): AprsSymbol {
  const name = table === '/' ? PRIMARY[code] : ALTERNATE[code];
  return name ? { table, code, name } : { table, code };
}

const FRAME_RE = /^([A-Za-z0-9]{1,7}(?:-\d{1,2})?)>([A-Za-z0-9]{1,7}(?:-\d{1,2})?)((?:,[^,:>\s]+)*):([\s\S]*)$/;

interface Pos {
  lat: number;
  lon: number;
  ambiguity?: number;
  symbol: AprsSymbol;
  compressed?: boolean;
  /** Course/speed (or wind dir/speed for weather) from the data extension or compressed cs. */
  extA?: number;
  extB?: number;
  hasExt?: boolean;
  altFt?: number;
  rest: string;
}

function b91(s: string): number {
  let v = 0;
  for (let i = 0; i < s.length; i++) v = v * 91 + (s.charCodeAt(i) - 33);
  return v;
}

function round(v: number, dp: number): number {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

function parseCompressed(s: string): Pos | undefined {
  if (s.length < 13) return undefined;
  for (let i = 1; i < 9; i++) {
    const c = s.charCodeAt(i);
    if (c < 33 || c > 123) return undefined;
  }
  const lat = 90 - b91(s.slice(1, 5)) / 380926;
  const lon = -180 + b91(s.slice(5, 9)) / 190463;
  if (lat > 90 || lat < -90 || lon > 180 || lon < -180) return undefined;
  let table = s[0];
  if (table >= 'a' && table <= 'j') table = String(table.charCodeAt(0) - 97); // overlay digit
  const pos: Pos = { lat: round(lat, 6), lon: round(lon, 6), symbol: symbolOf(table, s[9]), compressed: true, rest: s.slice(13) };
  const c = s.charCodeAt(10) - 33;
  const sp = s.charCodeAt(11) - 33;
  const t = s.charCodeAt(12) - 33;
  if (s[10] !== ' ' && c >= 0) {
    if (((t >> 3) & 3) === 2) {
      pos.altFt = Math.round(Math.pow(1.002, c * 91 + sp));
    } else if (c <= 89) {
      pos.extA = c * 4 || undefined;
      pos.extB = round(Math.pow(1.08, sp) - 1, 1);
      pos.hasExt = true;
    }
  }
  return pos;
}

function parseUncompressed(s: string): Pos | undefined {
  const m = /^(\d{2})([\d ]{2})\.([\d ]{2})([NS])(.)(\d{3})([\d ]{2})\.([\d ]{2})([EW])(.)/.exec(s);
  if (!m) return undefined;
  const z = (x: string) => x.replace(/ /g, '0');
  let lat = Number(m[1]) + Number(z(m[2]) + '.' + z(m[3])) / 60;
  let lon = Number(m[6]) + Number(z(m[7]) + '.' + z(m[8])) / 60;
  if (lat > 90 || lon > 180) return undefined;
  if (m[4] === 'S') lat = -lat;
  if (m[9] === 'W') lon = -lon;
  const ambiguity = (m[2] + m[3]).split(' ').length - 1;
  const pos: Pos = { lat: round(lat, 6), lon: round(lon, 6), symbol: symbolOf(m[5], m[10]), rest: s.slice(19) };
  if (ambiguity > 0) pos.ambiguity = ambiguity;
  const e = /^(\d{3}|\.{3}| {3})\/(\d{3}|\.{3}| {3})/.exec(pos.rest);
  if (e) {
    pos.hasExt = true;
    pos.extA = /^\d/.test(e[1]) ? Number(e[1]) : undefined;
    pos.extB = /^\d/.test(e[2]) ? Number(e[2]) : undefined;
    pos.rest = pos.rest.slice(7);
  }
  return pos;
}

function parsePosition(s: string): Pos | undefined {
  if (s.length === 0) return undefined;
  if (/\d/.test(s[0])) return parseUncompressed(s);
  if (/[\/\\A-Za-j]/.test(s[0])) return parseCompressed(s);
  return undefined;
}

const WX_LEN: Record<string, number> = { c: 3, s: 3, g: 3, t: 3, r: 3, p: 3, P: 3, h: 2, b: 5, L: 3, l: 3 };

/** Parse `cXXXsXXXgXXX...` fields, returning the unparsed remainder (software id etc.). */
function parseWxFields(s: string, w: AprsWeather): string {
  let i = 0;
  let seenS = false;
  while (i < s.length) {
    const k = s[i];
    const len = WX_LEN[k];
    if (!len) break;
    const tok = s.slice(i + 1, i + 1 + len);
    if (tok.length < len) break;
    let v: number | undefined;
    if (/^[. ]+$/.test(tok)) v = undefined;
    else if (/^ *-?\d+$/.test(tok)) v = Number(tok.trim());
    else break;
    i += 1 + len;
    if (v === undefined) {
      if (k === 's') seenS = true;
      continue;
    }
    switch (k) {
      case 'c': w.windDir = v; break;
      case 's': if (!seenS) w.windMph = v; seenS = true; break; // second `s` is snowfall
      case 'g': w.gustMph = v; break;
      case 't': w.tempF = v; break;
      case 'r': w.rainLastHourIn = v / 100; break;
      case 'p': w.rain24hIn = v / 100; break;
      case 'P': w.rainSinceMidnightIn = v / 100; break;
      case 'h': w.humidity = v === 0 ? 100 : v; break;
      case 'b': w.pressureMb = v / 10; break;
      case 'L': w.luminosity = v; break;
      case 'l': w.luminosity = v + 1000; break;
    }
  }
  return s.slice(i);
}

function clean(s: string): string | undefined {
  const t = s.trim();
  return t ? t : undefined;
}

/** Apply altitude and !DAO! extraction to a free-text comment; mutates pkt lat/lon/altFt. */
function applyComment(pkt: AprsPacket, rest: string): void {
  let c = rest;
  const alt = /\/A=(-?\d{5,6})/.exec(c);
  if (alt) {
    if (pkt.altFt === undefined) pkt.altFt = Number(alt[1]);
    c = c.replace(alt[0], '');
  }
  const dao = /!([A-Za-z])([\x21-\x7b]{2}|\d{2}| {2})!/.exec(c);
  if (dao && pkt.lat !== undefined && pkt.lon !== undefined && (dao[1] === 'w' || dao[1] === 'W')) {
    let latAdd: number | undefined;
    let lonAdd: number | undefined;
    if (dao[1] === 'w') {
      latAdd = ((dao[2].charCodeAt(0) - 33) / 91) * 0.01;
      lonAdd = ((dao[2].charCodeAt(1) - 33) / 91) * 0.01;
    } else if (/^\d\d$/.test(dao[2])) {
      latAdd = Number(dao[2][0]) * 0.001;
      lonAdd = Number(dao[2][1]) * 0.001;
    }
    if (latAdd !== undefined && lonAdd !== undefined) {
      pkt.lat = round(pkt.lat + Math.sign(pkt.lat || 1) * (latAdd / 60), 7);
      pkt.lon = round(pkt.lon + Math.sign(pkt.lon || 1) * (lonAdd / 60), 7);
      c = c.replace(dao[0], '');
    }
  }
  const t = clean(c);
  if (t) pkt.comment = t;
}

/** Fill position-derived fields on `pkt` from a parsed position. */
function applyPos(pkt: AprsPacket, pos: Pos): void {
  pkt.lat = pos.lat;
  pkt.lon = pos.lon;
  if (pos.ambiguity) pkt.ambiguity = pos.ambiguity;
  pkt.symbol = pos.symbol;
  if (pos.compressed) pkt.compressed = true;
  if (pos.altFt !== undefined) pkt.altFt = pos.altFt;
  if (pos.symbol.code === '_' && pkt.kind !== 'object') {
    pkt.kind = 'weather';
  }
  if (pos.symbol.code === '_') {
    const w: AprsWeather = {};
    if (pos.hasExt) {
      if (pos.extA !== undefined) w.windDir = pos.extA;
      if (pos.extB !== undefined) w.windMph = pos.extB;
    }
    const rest = parseWxFields(pos.rest, w);
    pkt.weather = w;
    applyComment(pkt, rest);
    return;
  }
  if (pos.extA !== undefined) pkt.course = pos.extA;
  if (pos.extB !== undefined) pkt.speedKt = pos.extB;
  applyComment(pkt, pos.rest);
}

const MICE_STD = ['Emergency', 'Priority', 'Special', 'Committed', 'Returning', 'In Service', 'En Route', 'Off Duty'];

function parseMice(pkt: AprsPacket, dest: string, info: string): boolean {
  const d = dest.split('-')[0];
  if (d.length < 6 || info.length < 8 || !/^[0-9A-LP-Z]{6}/.test(d)) return false;
  const digit = (c: string): number => {
    if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
    if (c >= 'A' && c <= 'J') return c.charCodeAt(0) - 65;
    if (c >= 'P' && c <= 'Y') return c.charCodeAt(0) - 80;
    return 0; // K, L, Z are masked digits
  };
  let ambiguity = 0;
  const v: number[] = [];
  for (let i = 0; i < 6; i++) {
    const c = d[i];
    if (c === 'K' || c === 'L' || c === 'Z') ambiguity++;
    v.push(digit(c));
  }
  let lat = v[0] * 10 + v[1] + (v[2] * 10 + v[3] + (v[4] * 10 + v[5]) / 100) / 60;
  if (d[3] < 'P') lat = -lat;
  const offset = d[4] >= 'P';
  const west = d[5] >= 'P';
  let deg = info.charCodeAt(0) - 28 + (offset ? 100 : 0);
  if (deg >= 190) deg -= 190;
  else if (deg >= 180) deg -= 80;
  let min = info.charCodeAt(1) - 28;
  if (min >= 60) min -= 60;
  const hun = info.charCodeAt(2) - 28;
  if (deg < 0 || deg > 180 || min < 0 || hun < 0 || Math.abs(lat) > 90) return false;
  let lon = deg + (min + hun / 100) / 60;
  if (west) lon = -lon;
  const sp = info.charCodeAt(3) - 28;
  const dc = info.charCodeAt(4) - 28;
  const se = info.charCodeAt(5) - 28;
  let speed = sp * 10 + Math.floor(dc / 10);
  let course = (dc % 10) * 100 + se;
  if (speed >= 800) speed -= 800;
  if (course >= 400) course -= 400;
  pkt.lat = round(lat, 6);
  pkt.lon = round(lon, 6);
  if (ambiguity) pkt.ambiguity = ambiguity;
  pkt.symbol = symbolOf(info[7], info[6]);
  if (course > 0 && course <= 360) pkt.course = course;
  if (speed >= 0 && speed < 800) pkt.speedKt = speed;

  // Message bits from the first three destination characters.
  let bits = 0;
  let std = 0;
  let custom = 0;
  for (let i = 0; i < 3; i++) {
    const c = d[i];
    bits <<= 1;
    if (c >= 'P') { bits |= 1; std++; } else if (c >= 'A' && c <= 'K') { bits |= 1; custom++; }
  }
  if (std === 0 || custom === 0) {
    const idx = bits; // 0 = emergency, 7 = off duty
    pkt.miceMessage = custom > 0 ? (idx === 0 ? 'Emergency' : `Custom ${7 - idx}`) : MICE_STD[idx];
  }

  let comment = info.slice(8);
  comment = comment.replace(/^[\]>`']=?/, '');
  const alt = /([\x21-\x7b]{3})\}/.exec(comment);
  if (alt) {
    pkt.altFt = Math.round((b91(alt[1]) - 10000) * 3.28084);
    comment = comment.replace(alt[0], '');
  }
  const t = clean(comment);
  if (t) pkt.comment = t;
  return true;
}

function parsePayload(pkt: AprsPacket, p: string): void {
  const type = p[0];
  switch (type) {
    case '!':
    case '=':
    case '/':
    case '@': {
      let body: string;
      if (type === '/' || type === '@') {
        if (!/^\d{6}[zh/]/.test(p.slice(1, 8))) break;
        body = p.slice(8);
      } else {
        body = p.slice(1);
      }
      const pos = parsePosition(body);
      if (!pos) break;
      pkt.kind = 'position';
      applyPos(pkt, pos);
      return;
    }
    case '`':
    case "'": {
      if (parseMice(pkt, pkt.to, p.slice(1))) {
        pkt.kind = 'position';
        return;
      }
      break;
    }
    case '_': {
      const m = /^_(\d{8})([\s\S]*)$/.exec(p);
      if (!m) break;
      pkt.kind = 'weather';
      const w: AprsWeather = {};
      const rest = parseWxFields(m[2], w);
      pkt.weather = w;
      const c = clean(rest);
      if (c) pkt.comment = c;
      return;
    }
    case ';': {
      if (p.length < 19 || (p[10] !== '*' && p[10] !== '_')) break;
      if (!/^\d{6}[zh/]/.test(p.slice(11, 18))) break;
      const pos = parsePosition(p.slice(18));
      if (!pos) break;
      pkt.kind = 'object';
      pkt.name = p.slice(1, 10).trimEnd();
      pkt.alive = p[10] === '*';
      applyPos(pkt, pos);
      return;
    }
    case ')': {
      let end = -1;
      for (let i = 4; i <= 10 && i < p.length; i++) {
        if (p[i] === '!' || p[i] === '_') { end = i; break; }
      }
      if (end < 0) break;
      const pos = parsePosition(p.slice(end + 1));
      if (!pos) break;
      pkt.kind = 'item';
      pkt.name = p.slice(1, end);
      pkt.alive = p[end] === '!';
      applyPos(pkt, pos);
      return;
    }
    case '>': {
      pkt.kind = 'status';
      const c = clean(p.slice(1));
      if (c) pkt.comment = c;
      return;
    }
    case ':': {
      const m = /^:([\s\S]{9}):([\s\S]*)$/.exec(p);
      if (!m) break;
      pkt.kind = 'message';
      let text = m[2];
      let id: string | undefined;
      const idm = /^([\s\S]*?)\{(\w{1,5})\}?$/.exec(text);
      if (idm) {
        text = idm[1];
        id = idm[2];
      }
      pkt.message = { to: m[1].trim(), text };
      if (id) pkt.message.id = id;
      return;
    }
    case 'T': {
      if (p.startsWith('T#')) {
        pkt.kind = 'telemetry';
        const c = clean(p.slice(2));
        if (c) pkt.comment = c;
        return;
      }
      break;
    }
  }
  // Fallback: unparsed payload. Discard anything a failed branch set.
  pkt.kind = 'other';
  delete pkt.lat;
  delete pkt.lon;
  delete pkt.symbol;
  delete pkt.comment;
  const c = clean(p);
  if (c) pkt.comment = c;
}

export function parseAprs(line: string): AprsPacket | undefined {
  try {
    if (typeof line !== 'string') return undefined;
    const raw = line.replace(/[\r\n]+$/, '').replace(/^\s*APRS:\s*/, '').replace(/^\s*\[\d+(?:\.\d+)?\]\s*/, '').trimStart();
    const m = FRAME_RE.exec(raw);
    if (!m || m[4].length === 0) return undefined;
    const path = m[3] ? m[3].slice(1).split(',') : [];
    const used = path.find((e) => e.endsWith('*'));
    const pkt: AprsPacket = { raw, from: m[1].toUpperCase(), to: m[2].toUpperCase(), path, kind: 'other' };
    if (used) pkt.via = used.slice(0, -1);
    parsePayload(pkt, m[4]);
    return pkt;
  } catch {
    return undefined;
  }
}
