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
  image?: string; // file name copied into the served art folder
  clip?: string; // mp3 snippet file name, moved into the radio clips folder
}

const LINE = /^(?:\d\d:\d\d:\d\d\s+)?(Station name|Slogan|Title|Artist|Album):\s*(.+)$/;

export interface HdLog {
  station?: string;
  slogan?: string;
  title?: string;
  artist?: string;
  album?: string;
}

/** Parses nrsc5's log text: station name, slogan and the LAST title / artist / album seen. */
export function parseHdLog(text: string): HdLog {
  const r: HdLog = {};
  for (const line of text.split('\n')) {
    const l = line.trim().match(LINE);
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
      const c: HdCatch = { ts: st.mtimeMs, freq: m?.[1] ?? '?', program: Number(m?.[2] ?? 0), ...parseHdLog(await readFile(path, 'utf8')) };
      c.image = await newestImage(join(dir, 'aas', `${c.freq}_${c.program}`), artDir, `${c.freq}_${c.program}`);
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

/** Copies the newest image from nrsc5's AAS folder into the served folder, then empties it. */
async function newestImage(aasDir: string, artDir: string, prefix: string): Promise<string | undefined> {
  let files: string[];
  try {
    files = (await readdir(aasDir)).filter((f) => /\.(jpe?g|png)$/i.test(f));
  } catch {
    return undefined;
  }
  let best: { f: string; t: number } | undefined;
  for (const f of files) {
    const t = (await stat(join(aasDir, f))).mtimeMs;
    if (!best || t > best.t) best = { f, t };
  }
  let name: string | undefined;
  if (best) {
    name = `${prefix}_${Math.round(best.t)}${best.f.slice(best.f.lastIndexOf('.')).toLowerCase()}`;
    await copyFile(join(aasDir, best.f), join(artDir, name));
  }
  for (const f of await readdir(aasDir)) await unlink(join(aasDir, f)).catch(() => {});
  return name;
}
