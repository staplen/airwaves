import { appendFileSync, mkdirSync } from 'node:fs';
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

// Durable raw decoder log: every message, one JSON line each ({ ts, kind, text }), in hourly files per source:
// <dir>/<source>/<YYYYMMDD-HH>.jsonl (UTC hour). Lines are buffered and appended every few seconds (kinder to the
// SD card); finished hours are gzipped; files older than the retention window are deleted.

const gz = promisify(gzip);
const FLUSH_MS = 10_000;

export const hourKey = (ts: number) => new Date(ts).toISOString().slice(0, 13).replace(/-/g, '').replace('T', '-');

export class RawLog {
  private dir: string;
  private keepMs: number;
  private buf = new Map<string, string[]>(); // "<source>/<hour>" → lines
  private timer?: NodeJS.Timeout;

  constructor(dir: string, keepMs = 72 * 3600_000) {
    this.dir = dir;
    this.keepMs = keepMs;
  }

  start() {
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref();
    return this;
  }

  write(source: string, kind: string, text: string, ts = Date.now()) {
    const key = `${source}/${hourKey(ts)}`;
    let lines = this.buf.get(key);
    if (!lines) this.buf.set(key, (lines = []));
    lines.push(JSON.stringify({ ts, kind, text }));
  }

  /** Appends buffered lines to their hourly files. Synchronous so it can run on shutdown. */
  flush() {
    for (const [key, lines] of this.buf) {
      const [source, hour] = key.split('/');
      try {
        mkdirSync(join(this.dir, source), { recursive: true });
        appendFileSync(join(this.dir, source, `${hour}.jsonl`), lines.join('\n') + '\n');
      } catch (e) {
        console.warn(`rawlog ${key}:`, (e as Error).message);
      }
    }
    this.buf.clear();
  }

  /** Gzips finished hours and deletes files past the retention window. */
  async rotate(now = Date.now()): Promise<{ zipped: number; deleted: number }> {
    this.flush();
    const current = hourKey(now);
    let zipped = 0;
    let deleted = 0;
    for (const source of await readdir(this.dir).catch(() => [] as string[])) {
      const d = join(this.dir, source);
      for (const f of await readdir(d).catch(() => [] as string[])) {
        const p = join(d, f);
        try {
          if (now - (await stat(p)).mtimeMs > this.keepMs) {
            await unlink(p);
            deleted++;
          } else if (f.endsWith('.jsonl') && f.slice(0, -6) < current) {
            await writeFile(`${p}.gz`, await gz(await readFile(p)));
            await unlink(p);
            zipped++;
          }
        } catch (e) {
          console.warn(`rawlog rotate ${source}/${f}:`, (e as Error).message);
        }
      }
    }
    return { zipped, deleted };
  }

  /** Every log file with its size, newest first. */
  async list(): Promise<{ path: string; bytes: number; mtime: number }[]> {
    const out: { path: string; bytes: number; mtime: number }[] = [];
    for (const source of await readdir(this.dir).catch(() => [] as string[])) {
      for (const f of await readdir(join(this.dir, source)).catch(() => [] as string[])) {
        const s = await stat(join(this.dir, source, f)).catch(() => undefined);
        if (s?.isFile()) out.push({ path: `${source}/${f}`, bytes: s.size, mtime: s.mtimeMs });
      }
    }
    return out.sort((a, b) => b.path.localeCompare(a.path));
  }
}
