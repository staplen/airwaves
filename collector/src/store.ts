import { DatabaseSync } from 'node:sqlite';
import type { FeedItem } from '../../shared/types.ts';

/** SQLite storage for the feed and daily aircraft counts. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL; -- fewer fsyncs: kinder to the SD card, still crash-safe with WAL
      CREATE TABLE IF NOT EXISTS feed (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        family TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        meta TEXT NOT NULL,
        body TEXT NOT NULL,
        mono INTEGER NOT NULL DEFAULT 0,
        clip TEXT
      );
      CREATE INDEX IF NOT EXISTS feed_ts ON feed(ts);
      CREATE TABLE IF NOT EXISTS sightings (
        day TEXT NOT NULL,
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        passes INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (day, source, key)
      );
      CREATE TABLE IF NOT EXISTS aircraft_day (
        day TEXT NOT NULL,
        hex TEXT NOT NULL,
        flight TEXT,
        type TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (day, hex)
      );
      -- Small JSON blobs that should survive restarts (ships, buoys, home location).
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Spectrum: strongest level per frequency bin per hour, kept for 7 days.
      CREATE TABLE IF NOT EXISTS spectrum (
        hour INTEGER NOT NULL,
        bin INTEGER NOT NULL,
        db REAL NOT NULL,
        PRIMARY KEY (hour, bin)
      );
    `);
    this.migrate();
  }

  private migrate() {
    const cols = (this.db.prepare('PRAGMA table_info(feed)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('clip')) this.db.exec('ALTER TABLE feed ADD COLUMN clip TEXT');
    if (!cols.includes('raw')) this.db.exec('ALTER TABLE feed ADD COLUMN raw TEXT');
    if (!cols.includes('image')) this.db.exec('ALTER TABLE feed ADD COLUMN image TEXT');
    if (!cols.includes('tag')) this.db.exec('ALTER TABLE feed ADD COLUMN tag TEXT');
    if (!cols.includes('peaks')) this.db.exec('ALTER TABLE feed ADD COLUMN peaks TEXT');
    if (!cols.includes('lat')) this.db.exec('ALTER TABLE feed ADD COLUMN lat REAL');
    if (!cols.includes('lon')) this.db.exec('ALTER TABLE feed ADD COLUMN lon REAL');
    if (!cols.includes('ref')) this.db.exec('ALTER TABLE feed ADD COLUMN ref TEXT');
  }

  addFeed(item: Omit<FeedItem, 'id'>): FeedItem {
    const r = this.db
      .prepare('INSERT INTO feed (ts, family, kind, title, meta, body, mono, clip, raw, image, tag, peaks, lat, lon, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(item.ts, item.family, item.kind, item.title, item.meta, item.body, item.mono ? 1 : 0, item.clip ?? null, item.raw ?? null, item.image ?? null, item.tag ?? null, item.peaks ?? null, item.lat ?? null, item.lon ?? null, item.ref ?? null);
    return { ...item, id: Number(r.lastInsertRowid) };
  }

  /** Feed items since `sinceTs` that have a clip but no waveform yet (for the one-off backfill). */
  clipsWithoutPeaks(sinceTs: number): { id: number; clip: string }[] {
    return this.db.prepare('SELECT id, clip FROM feed WHERE ts >= ? AND clip IS NOT NULL AND peaks IS NULL ORDER BY ts DESC').all(sinceTs) as { id: number; clip: string }[];
  }

  /** Rewrites feed bodies of one kind in place (one-off clean-ups); returns how many changed. */
  rewriteBodies(kind: string, fn: (body: string) => string): number {
    let n = 0;
    for (const r of this.db.prepare('SELECT id, body FROM feed WHERE kind = ?').all(kind) as { id: number; body: string }[]) {
      const next = fn(r.body);
      if (next === r.body) continue;
      this.db.prepare('UPDATE feed SET body = ? WHERE id = ?').run(next, r.id);
      n++;
    }
    return n;
  }

  /** Feed items of one kind, newest first (for one-off re-processing). */
  feedOfKind(kind: string): { id: number; ts: number; title: string; body: string; clip?: string }[] {
    return this.db.prepare('SELECT id, ts, title, body, clip FROM feed WHERE kind = ? ORDER BY ts DESC').all(kind) as { id: number; ts: number; title: string; body: string; clip?: string }[];
  }

  /** Drops the audio from every item of a kind (decoded signals don't keep their recordings). */
  clearClips(kind: string): number {
    return Number(this.db.prepare('UPDATE feed SET clip = NULL, peaks = NULL WHERE kind = ? AND clip IS NOT NULL').run(kind).changes);
  }

  setTitleBody(id: number, title: string, body: string) {
    this.db.prepare('UPDATE feed SET title = ?, body = ? WHERE id = ?').run(title, body, id);
  }

  setPeaks(id: number, peaks: string) {
    this.db.prepare('UPDATE feed SET peaks = ? WHERE id = ?').run(peaks, id);
  }

  recentFeed(limit = 50): FeedItem[] {
    const rows = this.db.prepare('SELECT * FROM feed ORDER BY ts DESC, id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map(toItem);
  }

  /** The newest `perKind` items of each kind, newest first, so busy kinds (ATC) don't push out quiet ones. */
  recentFeedPerKind(perKind = FEED_PER_KIND): FeedItem[] {
    const rows = this.db
      .prepare('SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY ts DESC, id DESC) AS rn FROM feed) WHERE rn <= ? ORDER BY ts DESC, id DESC')
      .all(perKind) as Array<Record<string, unknown>>;
    return rows.map(toItem);
  }


  /** Records an aircraft sighting; returns true if it is the first today. */
  seeAircraft(day: string, hex: string, flight: string | undefined, type: string | undefined, ts: number): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO aircraft_day (day, hex, flight, type, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, hex) DO UPDATE SET last_seen = excluded.last_seen,
           flight = COALESCE(excluded.flight, flight), type = COALESCE(excluded.type, type)`,
      )
      .run(day, hex, flight ?? null, type ?? null, ts, ts);
    // An upsert that inserted reports 1 change either way; check first_seen instead.
    void r;
    const row = this.db.prepare('SELECT first_seen FROM aircraft_day WHERE day = ? AND hex = ?').get(day, hex) as
      | { first_seen: number }
      | undefined;
    return row?.first_seen === ts;
  }

  /**
   * Records that `key` (a tire sensor, ship, meter, clip…) was heard. A sighting more than
   * `passGapMs` after the previous one counts as a new pass, which separates parked cars and
   * neighbours (many passes) from passers-by (one pass). Returns whether it's new today.
   */
  sight(day: string, source: string, key: string, ts: number, passGapMs = 10 * 60_000): { first: boolean; passes: number } {
    const row = this.db.prepare('SELECT last_seen, passes FROM sightings WHERE day = ? AND source = ? AND key = ?').get(day, source, key) as
      | { last_seen: number; passes: number }
      | undefined;
    if (!row) {
      this.db.prepare('INSERT INTO sightings (day, source, key, first_seen, last_seen, passes) VALUES (?, ?, ?, ?, ?, 1)').run(day, source, key, ts, ts);
      return { first: true, passes: 1 };
    }
    const passes = ts - row.last_seen > passGapMs ? row.passes + 1 : row.passes;
    this.db.prepare('UPDATE sightings SET last_seen = ?, passes = ? WHERE day = ? AND source = ? AND key = ?').run(ts, passes, day, source, key);
    return { first: false, passes };
  }

  /** Most recent sighting time for any of these sources (sightings table or aircraft), or undefined. */
  lastSeen(sources: string[]): number | undefined {
    let best = 0;
    for (const src of sources) {
      const row = (src === 'aircraft'
        ? this.db.prepare('SELECT MAX(last_seen) AS t FROM aircraft_day').get()
        : this.db.prepare('SELECT MAX(last_seen) AS t FROM sightings WHERE source = ?').get(src)) as { t: number | null };
      if (row?.t && row.t > best) best = row.t;
    }
    return best || undefined;
  }

  /** On how many different days any of these keys has been seen. */
  daysSeen(source: string, keys: string[]): number {
    if (!keys.length) return 0;
    const row = this.db.prepare(`SELECT COUNT(DISTINCT day) AS n FROM sightings WHERE source = ? AND key IN (${keys.map(() => '?').join(',')})`).get(source, ...keys) as { n: number };
    return Number(row.n);
  }

  countSightings(day: string, source: string, minPasses = 1, maxPasses = 1e9): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM sightings WHERE day = ? AND source = ? AND passes >= ? AND passes <= ?')
      .get(day, source, minPasses, maxPasses) as { n: number };
    return Number(row.n);
  }

  getState<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined;
    try {
      return row ? (JSON.parse(row.value) as T) : undefined;
    } catch {
      return undefined;
    }
  }

  setState(key: string, value: unknown) {
    this.db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  /** Merges one sweep (bin → dB) into its hour, keeping the strongest reading per bin. */
  addSpectrum(hour: number, bins: Map<number, number>) {
    const up = this.db.prepare('INSERT INTO spectrum (hour, bin, db) VALUES (?, ?, ?) ON CONFLICT(hour, bin) DO UPDATE SET db = MAX(db, excluded.db)');
    this.db.exec('BEGIN');
    try {
      for (const [bin, db] of bins) up.run(hour, bin, db);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Spectrum rows for hours >= fromHour, as dense arrays of `bins` values. */
  spectrumSince(fromHour: number, bins: number): { hour: number; db: (number | null)[] }[] {
    const rows = this.db.prepare('SELECT hour, bin, db FROM spectrum WHERE hour >= ? ORDER BY hour').all(fromHour) as { hour: number; bin: number; db: number }[];
    const byHour = new Map<number, (number | null)[]>();
    for (const r of rows) {
      const arr = byHour.get(r.hour) ?? new Array<number | null>(bins).fill(null);
      arr[r.bin] = r.db;
      byHour.set(r.hour, arr);
    }
    return [...byHour].map(([hour, db]) => ({ hour, db }));
  }

  /** Deletes everything older than the retention window. Returns rows removed per table. */
  purge(beforeTs: number, beforeDay: string): Record<string, number> {
    const n = (sql: string, ...args: (string | number)[]) => Number(this.db.prepare(sql).run(...args).changes);
    return {
      feed: n('DELETE FROM feed WHERE ts < ?', beforeTs),
      sightings: n('DELETE FROM sightings WHERE day < ?', beforeDay),
      aircraft: n('DELETE FROM aircraft_day WHERE day < ?', beforeDay),
      spectrum: n('DELETE FROM spectrum WHERE hour < ?', Math.floor(beforeTs / 3600_000)),
    };
  }

  aircraftCount(day: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM aircraft_day WHERE day = ?').get(day) as { n: number };
    return Number(row.n);
  }
}

// "Today" follows the receiver's time zone, not the container's (which is UTC).
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TIMEZONE ?? 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Calendar day in the receiver's time zone, e.g. 2026-11-17. */
export function localDay(ts: number): string {
  return DAY_FORMAT.format(new Date(ts));
}

/** How many of each feed kind the dashboard loads (busy ATC would otherwise crowd out songs and weather). */
export const FEED_PER_KIND = 60;

function toItem(r: Record<string, unknown>): FeedItem {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    family: r.family as FeedItem['family'],
    kind: String(r.kind),
    title: String(r.title),
    meta: String(r.meta),
    body: String(r.body),
    mono: r.mono === 1,
    clip: typeof r.clip === 'string' ? r.clip : undefined,
    image: typeof r.image === 'string' ? r.image : undefined,
    raw: typeof r.raw === 'string' ? r.raw : undefined,
    tag: typeof r.tag === 'string' ? r.tag : undefined,
    peaks: typeof r.peaks === 'string' ? r.peaks : undefined,
    lat: typeof r.lat === 'number' ? r.lat : undefined,
    lon: typeof r.lon === 'number' ? r.lon : undefined,
    ref: typeof r.ref === 'string' ? r.ref : undefined,
  };
}
