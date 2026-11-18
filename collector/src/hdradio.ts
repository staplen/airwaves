import { copyFile, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// The HD Radio slot runs nrsc5 and writes its log to <dir>/<freq>_<ts>.log, plus any
// album art / station logos to <dir>/aas/. After each run we read the log for the station
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
}

const LINE = /^(?:\d\d:\d\d:\d\d\s+)?(Station name|Slogan|Title|Artist|Album):\s*(.+)$/;

export async function ingestHdRadio(dir: string, artDir: string): Promise<HdCatch[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.log'));
  } catch {
    return [];
  }
  const out: HdCatch[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs < 30_000) continue; // slot still running
      const m = f.match(/^([\d.]+)_(\d)_/);
      const c: HdCatch = { ts: st.mtimeMs, freq: m?.[1] ?? '?', program: Number(m?.[2] ?? 0) };
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        const l = line.trim().match(LINE);
        if (!l) continue;
        const v = l[2].trim();
        if (l[1] === 'Station name') c.station = v;
        else if (l[1] === 'Slogan') c.slogan = v;
        else if (l[1] === 'Title') c.title = v; // keep the last one seen
        else if (l[1] === 'Artist') c.artist = v;
        else if (l[1] === 'Album') c.album = v;
      }
      c.image = await newestImage(join(dir, 'aas'), artDir, `${c.freq}_${c.program}`);
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
