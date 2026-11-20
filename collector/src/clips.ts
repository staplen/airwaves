import { readdir, stat } from 'node:fs/promises';

export interface Clip {
  dir: string; // which watched folder ("atc", "noaa")
  file: string;
  template: string; // e.g. DCA_TWR
  ts: number; // transmission start, epoch ms
  bytes: number;
}

// RTLSDR-Airband names files <template>_<YYYYMMDD>_<HHMMSS>.mp3 in UTC.
const NAME = /^(.+?)_(\d{8})_(\d{6})(?:_\d{8}_\d{6})?\.(mp3|wav)$/;

function parseTs(d: string, t: string): number {
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
}

/**
 * Polls folders for new audio clips. Polling (not fs.watch) because the folders are
 * bind mounts on the Pi, where change events are unreliable. A file is reported once
 * its size has stopped changing between two polls, so half-written clips are skipped.
 */
export class ClipWatcher {
  private seen = new Set<string>();
  private sizes = new Map<string, number>();
  private primed = false;
  private dirs: Record<string, string>;
  private onClip: (c: Clip) => void;

  constructor(dirs: Record<string, string>, onClip: (c: Clip) => void) {
    this.dirs = dirs;
    this.onClip = onClip;
  }

  start(intervalMs = 3000) {
    void this.poll();
    setInterval(() => void this.poll(), intervalMs);
  }

  private async poll() {
    for (const [name, path] of Object.entries(this.dirs)) {
      let files: string[];
      try {
        files = await readdir(path);
      } catch {
        continue;
      }
      // Forget files that have been purged, so memory doesn't grow with every clip ever seen.
      const present = new Set(files.map((f) => `${name}/${f}`));
      for (const key of this.seen) if (key.startsWith(`${name}/`) && !present.has(key)) this.seen.delete(key);
      for (const file of files) {
        const key = `${name}/${file}`;
        if (this.seen.has(key)) continue;
        const m = file.match(NAME);
        if (!m) continue;
        let size: number;
        let mtime: number;
        try {
          const st = await stat(`${path}/${file}`);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          continue;
        }
        // Still empty: the encoder hasn't written yet (wait), or the recorder got no audio at all (drop it).
        if (size === 0 && this.primed) {
          if (Date.now() - mtime > 120_000) this.seen.add(key);
          continue;
        }
        // On the first poll, only remember existing files so a restart doesn't replay them all.
        if (!this.primed) {
          this.seen.add(key);
          continue;
        }
        if (this.sizes.get(key) !== size) {
          this.sizes.set(key, size);
          continue;
        }
        this.seen.add(key);
        this.sizes.delete(key);
        this.onClip({ dir: name, file, template: m[1], ts: parseTs(m[2], m[3]), bytes: size });
      }
    }
    this.primed = true;
  }
}
