import { copyFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// The HD Radio slot runs nrsc5 and writes its log to <dir>/<freq>_<prog>_<ts>.log (and an .mp3
// snippet), plus any album art / station logos to <dir>/aas/<freq>_<prog>/. After each run we read the log for the station
// name and what's playing, keep the newest image, and delete the rest.

export interface HdCatch {
  ts: number;
  freq: string; // "97.1"
  program: number; // 0 = HD1
  station?: string;
  slogan?: string;
  title?: string;
  artist?: string;
  album?: string;
  image?: string; // album art file name copied into the served art folder
  logo?: string; // station logo file name copied into the served art folder
  clip?: string; // mp3 snippet file name, moved into the radio clips folder
  textKind?: 'song' | 'message'; // what the title text looks like: a song, or an ad / promo / station ID
  textSynced?: boolean; // false when the text changed while the clip was being recorded
}

const LINE = /^(?:\d\d:\d\d:\d\d\s+)?(Station name|Slogan|Title|Artist|Album):\s*(.+)$/;
const LOT_LINE = /^(?:\d\d:\d\d:\d\d\s+)?LOT file:\s+port=(\w+)\s+lot=(\d+)\s+name=(\S+)/;
const XHDR_LINE = /^(?:\d\d:\d\d:\d\d\s+)?XHDR:\s+.*?(\d+)\s*$/;

export interface HdLog {
  station?: string;
  slogan?: string;
  title?: string;
  artist?: string;
  album?: string;
  lots: { lot: number; port: string; name: string }[]; // completed LOT files
  artLot?: number; // LOT id of the current song's album art (last XHDR line)
  titleSince?: number; // seconds of day when the last title first appeared
  firstTitle?: boolean; // the last title is the first one heard on this visit (already playing when we tuned in)
  endAt?: number; // seconds of day the recording stopped ("Clip end" marker, else the last timestamp)
}

const TIME = /^(\d\d):(\d\d):(\d\d)\s/;
const CLIP_END = /^(?:\d\d:\d\d:\d\d\s+)?Clip end\b/;

/** Parses nrsc5's log text: station name, slogan, the LAST title / artist / album, and the LOT files. */
export function parseHdLog(text: string): HdLog {
  const r: HdLog = { lots: [] };
  let titles = 0;
  let lastTs: number | undefined;
  for (const line of text.split('\n')) {
    const t = line.trim();
    const tm = t.match(TIME);
    const sec = tm ? Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]) : undefined;
    if (sec !== undefined) lastTs = sec;
    if (CLIP_END.test(t)) {
      r.endAt = sec;
      continue;
    }
    const lot = t.match(LOT_LINE);
    if (lot) {
      r.lots.push({ lot: Number(lot[2]), port: lot[1], name: lot[3] });
      continue;
    }
    const x = t.match(XHDR_LINE);
    if (x) {
      const n = Number(x[1]);
      if (Number.isInteger(n) && n > 0) r.artLot = n;
      continue;
    }
    const l = t.match(LINE);
    if (!l) continue;
    const v = l[2].trim();
    if (l[1] === 'Station name') r.station = v;
    else if (l[1] === 'Slogan') r.slogan = v;
    else if (l[1] === 'Title') {
      if (v !== r.title) {
        titles++;
        r.titleSince = sec;
      }
      r.title = v;
    }
    else if (l[1] === 'Artist') r.artist = v;
    else if (l[1] === 'Album') r.album = v;
  }
  r.firstTitle = titles === 1;
  r.endAt ??= lastTs;
  return r;
}

/**
 * Whether the title text belongs to the audio clip (the last `snipSec` seconds before endAt). The first
 * title of a visit was already playing when we tuned in; a later one must have started before the clip did.
 */
export function textMatchesClip(log: HdLog, snipSec: number): boolean {
  if (!log.title || log.firstTitle) return true;
  if (log.titleSince === undefined || log.endAt === undefined) return true;
  let clipStart = log.endAt - snipSec;
  if (clipStart < 0) clipStart += 86400;
  return log.titleSince <= clipStart;
}

const PHONE = /\b1[-\s.]?8\d\d\b|\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;
const PROMO = /https?:|www\.|\.(com|org|net|fm)\b|\bapp\b|download|stream|podcast|call now|text \w+ to|listen live|win\b|tickets|sponsored|attorney|injur/i;
const STATION_ID = /\b\d{2,3}[.\-]\d\b|\bHD\d\b/; // "94.7", "88-5", "HD2"

/** Rough guess whether the title text is a song or a station message (ad, promo, station ID). */
export function classifyText(title: string | undefined, artist: string | undefined, station?: string, slogan?: string): 'song' | 'message' {
  if (!title) return 'message';
  const both = `${title} ${artist ?? ''}`;
  if (PHONE.test(both) || PROMO.test(both)) return 'message';
  if (!artist) return 'message';
  const norm = (x?: string) => (x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(artist);
  if (STATION_ID.test(both) || (a && (a === norm(slogan) || (norm(station).length > 2 && a.includes(norm(station)))))) return 'message';
  if (norm(station).length > 2 && norm(title).includes(norm(station))) return 'message';
  return 'song';
}

/** `onLog` receives each nrsc5 log's file name and full text before the log is deleted (for the parsing audit). */
export async function ingestHdRadio(dir: string, artDir: string, clipsRadioDir?: string, snipSec = 12, onLog?: (name: string, text: string) => void): Promise<HdCatch[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.log'));
  } catch {
    return [];
  }
  files.sort(); // names carry a UTC timestamp, so this is oldest first per station
  const out: HdCatch[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs < 30_000) continue; // slot still running
      const m = f.match(/^([\d.]+)_(\d)_/);
      const text = await readFile(path, 'utf8');
      onLog?.(f, text);
      const log = parseHdLog(text);
      const { station, slogan, title, artist, album, lots, artLot } = log;
      const c: HdCatch = { ts: st.mtimeMs, freq: m?.[1] ?? '?', program: Number(m?.[2] ?? 0), station, slogan, title, artist, album };
      if (title) {
        c.textKind = classifyText(title, artist, station, slogan);
        c.textSynced = textMatchesClip(log, snipSec);
      }
      const artName = artLot !== undefined ? lots.find((l) => l.lot === artLot)?.name : undefined;
      console.log(`hdradio ${c.freq}_${c.program}: ${lots.length} LOT files, art lot ${artLot ?? 'none announced'}${artLot !== undefined ? (artName ? ` (${artName}, received)` : ' (not received in time)') : ''}`);
      Object.assign(c, await collectImages(join(dir, 'aas', `${c.freq}_${c.program}`), artDir, `${c.freq}_${c.program}`, artName, join(dir, 'maps')));
      const mp3 = f.replace(/\.log$/, '.mp3');
      if (clipsRadioDir) {
        try {
          await mkdir(clipsRadioDir, { recursive: true });
          await copyFile(join(dir, mp3), join(clipsRadioDir, mp3)); // copy + delete: rename fails across mounts
          await unlink(join(dir, mp3));
          c.clip = mp3;
        } catch {
          /* no snippet for this run (dwell, no signal, or lame failed) */
        }
      }
      await unlink(path);
      if (c.station || c.title) out.push(c);
    } catch (e) {
      console.warn(`hdradio ${f}:`, (e as Error).message);
    }
  }
  return out;
}

const IMAGE = /\.(jpe?g|png)$/i;
const MAP_FILE = /^(TMT_|TMI_|DWRI?_|DWR)/i;
/** nrsc5 --dump-aas-files saves each file as "<lot>_<name>"; this returns the broadcast name. */
export const baseName = (f: string) => f.replace(/^\d+_/, '');

/**
 * Picks album art (the file named by the song's LOT entry) and the station logo (newest SL* file) out of
 * nrsc5's AAS folder and copies them to the served folder. Traffic / weather files are moved to mapsDir
 * for later; everything else is deleted.
 */
async function collectImages(aasDir: string, artDir: string, prefix: string, artName: string | undefined, mapsDir: string): Promise<{ image?: string; logo?: string }> {
  let files: string[];
  try {
    files = await readdir(aasDir);
  } catch {
    return {};
  }
  const ext = (f: string) => f.slice(f.lastIndexOf('.')).toLowerCase();
  let logoBest: { f: string; t: number } | undefined;
  for (const f of files) {
    const b = baseName(f);
    if (MAP_FILE.test(b) || !/^SL/i.test(b) || !IMAGE.test(b)) continue;
    const t = (await stat(join(aasDir, f))).mtimeMs;
    if (!logoBest || t > logoBest.t) logoBest = { f, t };
  }
  const res: { image?: string; logo?: string } = {};
  const artFile = artName && IMAGE.test(artName) && !MAP_FILE.test(artName) ? files.find((f) => baseName(f) === artName) : undefined;
  if (artFile) {
    const t = (await stat(join(aasDir, artFile))).mtimeMs;
    res.image = `${prefix}_${Math.round(t)}${ext(artFile)}`;
    await copyFile(join(aasDir, artFile), join(artDir, res.image));
  }
  if (logoBest) {
    res.logo = `${prefix}_logo_${Math.round(logoBest.t)}${ext(logoBest.f)}`;
    await copyFile(join(aasDir, logoBest.f), join(artDir, res.logo));
  }
  for (const f of files) {
    const from = join(aasDir, f);
    if (MAP_FILE.test(baseName(f))) {
      try {
        await mkdir(mapsDir, { recursive: true });
        await copyFile(from, join(mapsDir, baseName(f)));
      } catch {
        /* keep going; the original is removed below */
      }
    }
    await unlink(from).catch(() => {});
  }
  return res;
}
