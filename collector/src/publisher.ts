import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { posix, join, relative, sep } from 'node:path';
import type { FeedItem, Overlays, RadioStation, Snapshot, SpectrumHeat } from '../../shared/types.ts';

// Publishes a read-only copy of the dashboard (static site + JSON snapshots + media) over SFTP.

const DAY_MS = 24 * 3600_000;
const RETENTION_EVERY_MS = 10 * 60_000;
const SPECTRUM_EVERY_MS = 10 * 60_000;
const MEDIA_DIRS = ['clips/atc', 'clips/noaa', 'clips/radio', 'art', 'maps'];

// ---- pure helpers (unit-tested) ---------------------------------------------------------------

/** `/api/clips/x` → `clips/x`, `/api/art/x` → `art/x`, `/api/maps/x` → `maps/x`. Anything else is returned unchanged. */
export function relUrl<T extends string | undefined>(u: T): T {
  if (typeof u !== 'string') return u;
  return u.replace(/^\/api\/(clips|art|maps)\//, '$1/') as T;
}

export function rewriteFeedItem(f: FeedItem): FeedItem {
  const out = { ...f };
  if (out.clip !== undefined) out.clip = relUrl(out.clip);
  if (out.image !== undefined) out.image = relUrl(out.image);
  return out;
}

export function rewriteStation(r: RadioStation): RadioStation {
  const out = { ...r };
  if (out.art !== undefined) out.art = relUrl(out.art);
  if (out.logo !== undefined) out.logo = relUrl(out.logo);
  if (out.clip !== undefined) out.clip = relUrl(out.clip);
  return out;
}

export function rewriteSnapshot(s: Snapshot): Snapshot {
  return { ...s, radio: s.radio.map(rewriteStation) };
}

export function rewriteOverlays(o: Overlays): Overlays {
  const out: Overlays = {};
  if (o.traffic) out.traffic = { ...o.traffic, tiles: o.traffic.tiles.map((t) => ({ ...t, url: relUrl(t.url) })) };
  if (o.radar) out.radar = { ...o.radar, url: relUrl(o.radar.url) };
  return out;
}

const REL_MEDIA = /^(clips|art|maps)\/[^/]/;
const URL_KEYS = new Set(['clip', 'image', 'art', 'logo', 'url']);

/** Every relative media path (`clips/…`, `art/…`, `maps/…`) referenced by already-rewritten data. */
export function referencedMedia(...docs: unknown[]): string[] {
  const found = new Set<string>();
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      if (key && URL_KEYS.has(key) && REL_MEDIA.test(v)) found.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  for (const d of docs) walk(d);
  return [...found];
}

export interface MediaRoots {
  clips?: string; // folder holding atc/, noaa/, radio/
  art: string;
  maps: string;
}

/** Maps a relative URL (`clips/atc/a%20b.mp3`) to the local file and the remote path (decoded, no leading slash). */
export function resolveMedia(rel: string, roots: MediaRoots): { local: string; remote: string } | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  const parts = decoded.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\'))) return undefined;
  const [top, ...rest] = parts;
  const base = top === 'clips' ? roots.clips : top === 'art' ? roots.art : top === 'maps' ? roots.maps : undefined;
  if (!base || rest.length === 0) return undefined;
  return { local: join(base, ...rest), remote: decoded };
}

export interface RemoteFile {
  path: string;
  mtime: number; // epoch ms
}

/** Remote files older than `maxAgeMs` at `now`. */
export function selectExpired(files: RemoteFile[], now: number, maxAgeMs = DAY_MS): string[] {
  return files.filter((f) => now - f.mtime > maxAgeMs).map((f) => f.path);
}

export const HTACCESS = `<IfModule mod_headers.c>
  # Data files change every minute: always revalidate.
  <FilesMatch "\\.json$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
  # Built assets have content hashes in their names: cache for a year.
  SetEnvIf Request_URI "/assets/[^/]+$" LONG_CACHE
  Header set Cache-Control "public, max-age=31536000, immutable" env=LONG_CACHE
</IfModule>
`;

export const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');

/** Version string for a deploy: changes when index.html (which names the hashed assets) or .htaccess changes. */
export function deployVersion(indexHtml: Buffer): string {
  return sha1(Buffer.concat([indexHtml, Buffer.from(HTACCESS)]));
}

/** Backoff after `failures` consecutive errors: 5 s doubling to 5 min. */
export function backoffMs(failures: number): number {
  return Math.min(5 * 60_000, 5000 * 2 ** Math.max(0, failures - 1));
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Files under the built dashboard, as relative posix paths: assets first, index.html last. */
export function deployOrder(paths: string[]): string[] {
  const rank = (p: string) => (p === 'index.html' ? 2 : p.startsWith('assets/') ? 0 : 1);
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ---- the publisher ----------------------------------------------------------------------------

/* The subset of ssh2-sftp-client the publisher uses (the package is loaded lazily). */
interface Sftp {
  connect(o: Record<string, unknown>): Promise<unknown>;
  end(): Promise<unknown>;
  on(ev: string, fn: (...a: unknown[]) => void): unknown;
  list(p: string): Promise<{ name: string; type: string; modifyTime: number }[]>;
  mkdir(p: string, recursive?: boolean): Promise<unknown>;
  put(src: string | Buffer, dest: string): Promise<unknown>;
  get(p: string): Promise<string | Buffer | NodeJS.WritableStream>;
  delete(p: string, noErrorOk?: boolean): Promise<unknown>;
  rename(a: string, b: string): Promise<unknown>;
  posixRename?(a: string, b: string): Promise<unknown>;
  exists(p: string): Promise<false | string>;
}

export interface PublisherOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  dir: string; // remote root, e.g. '/'
  everySec: number;
  webDir?: string;
  roots: MediaRoots;
  /** Public (home-stripped) snapshot, before URL rewriting. */
  snapshot: () => Snapshot;
  /** Public feed items, newest first, before URL rewriting. */
  feed: () => FeedItem[];
  spectrum: () => SpectrumHeat;
  overlays: () => Overlays;
}

export class Publisher {
  private opts: PublisherOptions;
  private client?: Sftp;
  private failures = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private uploaded = new Set<string>(); // remote paths (relative) known to be on the server
  private madeDirs = new Set<string>();
  private seeded = false;
  private deployedVersion?: string;
  private lastSpectrum = 0;
  private lastRetention = 0;
  private lastJson = new Map<string, string>(); // data file → last uploaded body
  private usePosixRename = true;

  constructor(opts: PublisherOptions) {
    this.opts = opts;
  }

  start() {
    console.log(`publisher: user "${this.opts.user ?? ''}" at ${this.opts.host}:${this.opts.port} dir "${this.opts.dir}", password ${this.opts.pass ? `set (${this.opts.pass.length} chars)` : 'MISSING'}, every ${this.opts.everySec}s`);
    void this.loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    void this.client?.end().catch(() => {});
  }

  private async loop() {
    let delay = this.opts.everySec * 1000;
    try {
      await this.cycle();
      this.failures = 0;
    } catch (e) {
      this.failures++;
      delay = Math.max(delay, backoffMs(this.failures));
      console.warn(`publisher: ${(e as Error).message} (retry in ${Math.round(delay / 1000)} s)`);
      await this.drop();
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.loop(), delay);
  }

  private async drop() {
    const c = this.client;
    this.client = undefined;
    this.madeDirs.clear();
    if (c) await c.end().catch(() => {});
  }

  private remote(rel: string): string {
    return posix.join(this.opts.dir, rel);
  }

  private async connect(): Promise<Sftp> {
    if (this.client) return this.client;
    const { default: SftpClient } = await import('ssh2-sftp-client');
    const c = new SftpClient('airwaves') as unknown as Sftp;
    // The client emits 'error' on dropped connections; the next operation fails too and triggers a reconnect.
    c.on('error', (e) => console.warn(`publisher: connection error: ${(e as Error)?.message}`));
    c.on('close', () => {
      if (this.client === c) this.client = undefined;
    });
    // Some hosts (IONOS among them) only offer "keyboard-interactive" login, which desktop clients
    // fall back to automatically; answer its password prompt with the same password.
    const ssh = (c as unknown as { client?: { on: (ev: string, fn: (...a: unknown[]) => void) => void } }).client;
    ssh?.on('keyboard-interactive', (...a: unknown[]) => {
      const prompts = (a[3] as unknown[]) ?? [];
      const finish = a[4] as (answers: string[]) => void;
      finish(prompts.map(() => this.opts.pass ?? ''));
    });
    await c.connect({ host: this.opts.host, port: this.opts.port, username: this.opts.user, password: this.opts.pass, tryKeyboard: true, readyTimeout: 20_000, keepaliveInterval: 30_000 });
    this.client = c;
    console.log('publisher: connected');
    return c;
  }

  private async mkdirs(c: Sftp, relDir: string) {
    if (this.madeDirs.has(relDir)) return;
    await c.mkdir(this.remote(relDir), true);
    this.madeDirs.add(relDir);
  }

  /** Uploads to `<name>.tmp` then renames over the target, so visitors never see a half-written file. */
  private async putAtomic(c: Sftp, rel: string, body: Buffer) {
    await this.mkdirs(c, posix.dirname(rel));
    const dest = this.remote(rel);
    const tmp = `${dest}.tmp`;
    await c.put(body, tmp);
    if (this.usePosixRename && c.posixRename) {
      try {
        await c.posixRename(tmp, dest);
        return;
      } catch (e) {
        // Servers without posix-rename@openssh.com: fall back to delete-then-rename from now on.
        console.warn(`publisher: posixRename unavailable (${(e as Error).message}); using delete + rename`);
        this.usePosixRename = false;
      }
    }
    await c.delete(dest, true);
    await c.rename(tmp, dest);
  }

  private async putJson(c: Sftp, rel: string, data: unknown, skipIfSame = false) {
    const text = JSON.stringify(data);
    if (skipIfSame && this.lastJson.get(rel) === text) return;
    await this.putAtomic(c, rel, Buffer.from(text));
    this.lastJson.set(rel, text);
  }

  private async seed(c: Sftp) {
    for (const d of MEDIA_DIRS) {
      try {
        for (const f of await c.list(this.remote(d))) if (f.type !== 'd') this.uploaded.add(`${d}/${f.name}`);
      } catch {
        /* folder doesn't exist yet */
      }
    }
    this.seeded = true;
  }

  private async cycle() {
    const c = await this.connect();
    if (!this.seeded) await this.seed(c);
    await this.deploySite(c);

    const now = Date.now();
    const snap = rewriteSnapshot(this.opts.snapshot());
    const feed = this.opts.feed().map(rewriteFeedItem);
    const overlays = rewriteOverlays(this.opts.overlays());

    // Media first, so the JSON never points at a file that isn't there yet.
    for (const rel of referencedMedia(snap, feed, overlays)) await this.uploadMedia(c, rel);

    await this.putJson(c, 'data/snapshot.json', { ...snap, publishedAt: now });
    await this.putJson(c, 'data/feed.json', feed, true);
    await this.putJson(c, 'data/overlays.json', overlays, true);
    if (now - this.lastSpectrum >= SPECTRUM_EVERY_MS) {
      await this.putJson(c, 'data/spectrum.json', this.opts.spectrum());
      this.lastSpectrum = now;
    }
    if (now - this.lastRetention >= RETENTION_EVERY_MS) {
      this.lastRetention = now;
      await this.retention(c, now);
    }
  }

  private async uploadMedia(c: Sftp, rel: string) {
    const m = resolveMedia(rel, this.opts.roots);
    if (!m || this.uploaded.has(m.remote)) return;
    try {
      if (!statSync(m.local).isFile()) return;
    } catch {
      return; // purged locally already
    }
    await this.mkdirs(c, posix.dirname(m.remote));
    await c.put(m.local, this.remote(m.remote));
    this.uploaded.add(m.remote);
  }

  private async retention(c: Sftp, now: number) {
    const files: RemoteFile[] = [];
    for (const d of MEDIA_DIRS) {
      try {
        for (const f of await c.list(this.remote(d))) if (f.type !== 'd') files.push({ path: `${d}/${f.name}`, mtime: f.modifyTime });
      } catch {
        /* folder doesn't exist yet */
      }
    }
    const old = selectExpired(files, now);
    for (const p of old) {
      await c.delete(this.remote(p), true);
      this.uploaded.delete(p);
    }
    if (old.length) console.log(`publisher: removed ${old.length} expired remote files`);
  }

  /** Uploads the built dashboard when its version differs from the server's version.txt. */
  private async deploySite(c: Sftp) {
    const webDir = this.opts.webDir;
    if (!webDir || this.deployedVersion) return;
    let index: Buffer;
    try {
      index = readFileSync(join(webDir, 'index.html'));
    } catch {
      console.warn(`publisher: no ${webDir}/index.html to deploy`);
      this.deployedVersion = 'none';
      return;
    }
    const version = deployVersion(index);
    let remoteVersion = '';
    try {
      if (await c.exists(this.remote('version.txt'))) remoteVersion = String(await c.get(this.remote('version.txt'))).trim();
    } catch {
      /* treat as missing */
    }
    if (remoteVersion !== version) {
      const rels = deployOrder(walkFiles(webDir).map((p) => relative(webDir, p).split(sep).join('/')));
      for (const rel of rels) {
        if (rel === 'index.html') continue;
        await this.mkdirs(c, posix.dirname(rel));
        await c.put(join(webDir, rel), this.remote(rel));
      }
      await this.putAtomic(c, '.htaccess', Buffer.from(HTACCESS));
      await this.putAtomic(c, 'index.html', index);
      await this.putAtomic(c, 'version.txt', Buffer.from(version));
      console.log(`publisher: deployed dashboard (${rels.length} files, ${version.slice(0, 8)})`);
    }
    this.deployedVersion = version;
  }
}
