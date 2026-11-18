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
}

/** Parses nrsc5's log text: station name, slogan, the LAST title / artist / album, and the LOT files. */
export function parseHdLog(text: string): HdLog {
  const r: HdLog = { lots: [] };
  for (const line of text.split('\n')) {
    const t = line.trim();
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
    else if (l[1] === 'Title') r.title = v;
    else if (l[1] === 'Artist') r.artist = v;
    else if (l[1] === 'Album') r.album = v;
  }
  return r;
}

export async function ingestHdRadio(dir: string, artDir: string, clipsRadioDir?: string): Promise<HdCatch[]> {
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
      const { lots, artLot, ...info } = parseHdLog(await readFile(path, 'utf8'));
      const c: HdCatch = { ts: st.mtimeMs, freq: m?.[1] ?? '?', program: Number(m?.[2] ?? 0), ...info };
      const artName = artLot !== undefined ? lots.find((l) => l.lot === artLot)?.name : undefined;
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
