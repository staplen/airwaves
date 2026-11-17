import { DatabaseSync } from 'node:sqlite';
import type { FeedItem } from '../../shared/types.ts';

/** SQLite storage for the feed and daily aircraft counts. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
    `);
    this.migrate();
  }

  private migrate() {
    const cols = (this.db.prepare('PRAGMA table_info(feed)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('clip')) this.db.exec('ALTER TABLE feed ADD COLUMN clip TEXT');
    if (!cols.includes('raw')) this.db.exec('ALTER TABLE feed ADD COLUMN raw TEXT');
  }

  addFeed(item: Omit<FeedItem, 'id'>): FeedItem {
    const r = this.db
      .prepare('INSERT INTO feed (ts, family, kind, title, meta, body, mono, clip, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(item.ts, item.family, item.kind, item.title, item.meta, item.body, item.mono ? 1 : 0, item.clip ?? null, item.raw ?? null);
    return { ...item, id: Number(r.lastInsertRowid) };
  }

  recentFeed(limit = 50): FeedItem[] {
    const rows = this.db
      .prepare('SELECT * FROM feed ORDER BY ts DESC, id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      family: r.family as FeedItem['family'],
      kind: String(r.kind),
      title: String(r.title),
      meta: String(r.meta),
      body: String(r.body),
      mono: r.mono === 1,
      clip: typeof r.clip === 'string' ? r.clip : undefined,
      raw: typeof r.raw === 'string' ? r.raw : undefined,
    }));
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

  countSightings(day: string, source: string, minPasses = 1, maxPasses = 1e9): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM sightings WHERE day = ? AND source = ? AND passes >= ? AND passes <= ?')
      .get(day, source, minPasses, maxPasses) as { n: number };
    return Number(row.n);
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
