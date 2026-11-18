import { createServer, type ServerResponse } from 'node:http';
import { createSocket } from 'node:dgram';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { connect as mqttConnect } from 'mqtt';
import type { Aircraft, AisFixed, Balloon, FeedItem, Overlays, RadioStation, SchedulerState, Snapshot, SourceStatus, SpectrumHeat, Vessel } from '../../shared/types.ts';
import { AdsbSource } from './adsb.ts';
import { AisDecoder, shipTypeName } from './ais.ts';
import { ClipWatcher, type Clip } from './clips.ts';
import { parseSame } from './eas.ts';
import { ingestSpectrum, purgeOldFiles, SPECTRUM_BINS } from './housekeeping.ts';
import { ingestHdRadio } from './hdradio.ts';
import { readOverlays } from './overlays.ts';
import { Publisher } from './publisher.ts';
import { SondeTracker } from './sonde.ts';
import { describeSensor, parseRtl433 } from './rtl433.ts';
import { Store, localDay } from './store.ts';
import { parseVdl2 } from './vdl2.ts';

// ---- configuration (environment variables) --------------------------------------------
const env = process.env;
const PI_HOST = env.PI_HOST ?? 'homeassistant.local';
const ADSB_URL = env.ADSB_URL ?? `http://${PI_HOST}:8080/data`;
const PORT = Number(env.PORT ?? 4000);
const DATA_DIR = env.DATA_DIR ?? 'data';
const MQTT_URL = env.MQTT_URL; // e.g. mqtt://127.0.0.1:1883; ingest is off without it
const AIS_UDP_PORT = Number(env.AIS_UDP_PORT ?? 4100);
const VDL2_UDP_PORT = Number(env.VDL2_UDP_PORT ?? 4101);
const CLIPS_ROOT = env.CLIPS_ROOT; // folder holding atc/, noaa/ and radio/ clip folders
// rtl_power sweeps land here; default is a "spectrum" folder next to DATA_DIR (/airwaves/spectrum on the Pi).
const SPECTRUM_DIR = env.SPECTRUM_DIR ?? join(dirname(env.DATA_DIR ?? 'data'), 'spectrum');
const HD_DIR = env.HD_DIR ?? join(dirname(env.DATA_DIR ?? 'data'), 'hdradio'); // nrsc5 logs + album art
const ART_DIR = join(HD_DIR, 'art');
const SONDE_UDP_PORT = Number(env.SONDE_UDP_PORT ?? 55673);
const CLIP_RETENTION_MS = 24 * 3600_000; // audio files and album art
const DB_RETENTION_DAYS = 7; // feed, daily sightings, spectrum
const WEB_DIR = env.WEB_DIR; // built dashboard (web/dist) to serve, if set
const GAS_METER_ID = env.GAS_METER_ID; // your own meter's ERT id, to call it out in the feed
const SUMMARY_EVERY_MS = 5 * 60_000;

mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(`${DATA_DIR}/airwaves.db`);
// The readsb slot writes JSON here; Ultrafeeder's HTTP endpoint is the fallback.
const READSB_DIR = env.READSB_DIR ?? join(dirname(env.DATA_DIR ?? 'data'), 'readsb');
const adsb = new AdsbSource(ADSB_URL, READSB_DIR);
// The site is shown without the home location when reached through a public tunnel
// (Cloudflare adds cf-* headers) or when PUBLIC=1.
const FORCE_PUBLIC = env.PUBLIC === '1';

// Slot ids match the scheduler's slots.json.
const SOURCES: Omit<SourceStatus, 'lastHeard' | 'running'>[] = [
  { id: 'adsb', name: 'ADS-B', family: 'air', freqMhz: 1090 },
  { id: 'atc', name: 'ATC', family: 'air', freqMhz: 119.25 },
  { id: 'ais', name: 'Ships', family: 'sea', freqMhz: 162.0 },
  { id: 'vdl2', name: 'Datalink', family: 'air', freqMhz: 136.8 },
  { id: 'ism', name: 'Sensors', family: 'home', freqMhz: 315 },
  { id: 'noaa', name: 'NOAA', family: 'wx', freqMhz: 162.45 },
  { id: 'sonde', name: 'Balloons', family: 'wx', freqMhz: 403 },
  { id: 'hdradio', name: 'HD Radio', family: 'bcast', freqMhz: 98 },
  { id: 'spectrum', name: 'Spectrum', family: 'bcast', freqMhz: 500 },
  { id: 'uat', name: 'UAT', family: 'air', freqMhz: 978, note: 'Needs the attic 1090/978 antenna' },
];

const ATC_NAMES: Record<string, { name: string; freq: string }> = {
  DCA_TWR: { name: 'DCA Tower', freq: '119.100' },
  DEP_TYSON: { name: 'Potomac Departure', freq: '118.950' },
  APP_LURAY: { name: 'Potomac Approach', freq: '118.675' },
  APP_OJAAY: { name: 'Potomac Approach', freq: '119.850' },
};

const startedAt = Date.now();
const lastHeard = new Map<string, number>();
const vessels = new Map<number, Vessel>();
const aisFixed = new Map<number, AisFixed>();
const sondes = new SondeTracker();
let scheduler: SchedulerState | undefined;
let lastSummary = 0;
let tpmsNewSinceSummary = 0;
const lastVdl2PerFlight = new Map<string, number>();
const lastSensorPost = new Map<string, number>();
const lastAircraftSave = new Map<string, number>();
const clients = new Map<ServerResponse, boolean>(); // response → is public viewer

const rotating = () => scheduler !== undefined && Date.now() - scheduler.updatedAt < 15 * 60_000;

const radio = new Map<string, RadioStation>(); // HD Radio stations by "<freq>_<program>"

function heard(source: string, ts = Date.now()) {
  lastHeard.set(source, Math.max(lastHeard.get(source) ?? 0, ts));
}

// ---- snapshot & streaming ---------------------------------------------------------------
function snapshot(): Snapshot {
  const now = Date.now();
  const day = localDay(now);
  const rot = rotating();
  const planned = new Set(scheduler?.slots ?? [...(scheduler?.upNext.map((u) => u.slotId) ?? []), scheduler?.current?.slotId]);
  // Between ADS-B passes, age each aircraft by the time since the last successful poll.
  const gapS = adsb.lastOk ? Math.max(0, (now - adsb.lastOk) / 1000) : 0;
  const aircraft = adsb.aircraft.map((a) => ({ ...a, seen: a.seen + gapS }));
  const withPos = aircraft.filter((a) => a.distNm !== undefined);
  const rssis = aircraft.map((a) => a.rssi).filter((v): v is number => v !== undefined);
  const adsbExpected = !rot || scheduler?.current?.slotId === 'adsb';
  return {
    now,
    home: adsb.home,
    rotation: rot
      ? {
          mode: 'rotating',
          current: scheduler!.current && { sourceId: scheduler!.current.slotId, freqMhz: scheduler!.current.freqMhz, since: scheduler!.current.since, endsAt: scheduler!.current.endsAt },
          upNext: scheduler!.upNext.map((u) => ({ sourceId: u.slotId, minutes: u.minutes })),
          loop: scheduler!.loop?.map((u) => ({ sourceId: u.slotId, minutes: u.minutes })),
          index: scheduler!.index,
        }
      : { mode: 'continuous', current: { sourceId: 'adsb', freqMhz: 1090, since: startedAt }, upNext: [] },
    sources: SOURCES.map((s) => ({
      ...s,
      running: s.id === 'adsb' || planned.has(s.id),
      lastHeard: s.id === 'adsb' ? adsb.lastHeard : lastHeard.get(s.id),
      error:
        s.id === 'adsb' && adsb.lastError && adsbExpected
          ? `Receiver unreachable (${adsb.lastError})`
          : slotFailure(s.id, now),
    })),
    aircraft,
    vessels: [...vessels.values()].filter((v) => now - v.lastSeen < 3 * 3600_000),
    aisFixed: [...aisFixed.values()],
    balloons: sondes.recent(now),
    radio: [...radio.values()].sort((a, b) => Number(a.freq) - Number(b.freq) || a.program - b.program),
    totals: {
      aircraftToday: store.aircraftCount(day),
      atcClipsToday: store.countSightings(day, 'atc'),
      shipsToday: store.countSightings(day, 'ship'),
      tpmsPassersToday: store.countSightings(day, 'tpms', 1, 1),
      tpmsRegularsToday: store.countSightings(day, 'tpms', 2),
      metersToday: store.countSightings(day, 'meter'),
      datalinkToday: store.countSightings(day, 'vdl2'),
    },
    stats: {
      maxRangeNm: Math.max(0, ...withPos.map((a) => a.distNm ?? 0)),
      avgRssi: rssis.length ? rssis.reduce((a, b) => a + b, 0) / rssis.length : undefined,
    },
  };
}

/** A slot failure reported by the scheduler within the last loop, as a short message. */
function slotFailure(id: string, now: number): string | undefined {
  const f = scheduler?.failures?.[id];
  const loopMs = (scheduler?.loopMinutes ?? 19) * 60_000 * 1.2;
  return f && now - f.at < loopMs ? `Slot failed: ${f.reason}` : undefined;
}

// ---- public view: no home location, no distances --------------------------------------------
const DISTANCE_TEXT = /,?\s*(?:at\s+)?[\d.]+\s*nm\b/g;
function publicSnapshot(s: Snapshot): Snapshot {
  return { ...s, home: undefined, aircraft: s.aircraft.map((a) => ({ ...a, distNm: undefined })), stats: { ...s.stats, maxRangeNm: 0 } };
}
function publicItem(f: FeedItem): FeedItem {
  return f.kind === 'Aircraft' ? { ...f, body: f.body.replace(DISTANCE_TEXT, '') } : f;
}
const isPublic = (req: { headers: Record<string, string | string[] | undefined> }) => FORCE_PUBLIC || Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);

function send(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: 'snapshot' | 'feed', data: Snapshot | FeedItem) {
  for (const [c, pub] of clients) {
    if (!pub) send(c, event, data);
    else send(c, event, event === 'snapshot' ? publicSnapshot(data as Snapshot) : publicItem(data as FeedItem));
  }
}

function publishFeed(item: Omit<FeedItem, 'id'>) {
  broadcast('feed', store.addFeed(item));
}

// ---- ADS-B (polls readsb's JSON while the ADS-B slot is on) ------------------------------
function fmtAlt(a: Aircraft): string {
  if (a.altBaro === 'ground') return 'on the ground';
  if (a.altBaro === undefined) return 'altitude unknown';
  return a.altBaro >= 18000 ? `FL${Math.round(a.altBaro / 100)}` : `${a.altBaro.toLocaleString('en-US')} ft`;
}

function summarizeAircraft(now: number) {
  if (!adsb.lastOk || now - adsb.lastOk > 30_000 || adsb.aircraft.length === 0) return;
  const placed = adsb.aircraft.filter((a) => a.distNm !== undefined).sort((x, y) => x.distNm! - y.distNm!);
  const near = placed[0];
  const far = placed[placed.length - 1];
  const parts: string[] = [];
  if (near) parts.push(`Closest ${near.flight ?? near.hex} at ${fmtAlt(near)}, ${near.distNm!.toFixed(1)} nm.`);
  if (far && far !== near) parts.push(`Farthest ${far.flight ?? far.hex} at ${far.distNm!.toFixed(1)} nm.`);
  publishFeed({ ts: now, family: 'air', kind: 'Aircraft', title: `${adsb.aircraft.length} aircraft in range`, meta: `1090`, body: parts.join(' ') || 'No positions yet.' });
}

function summarizeStreet(now: number) {
  for (const [mmsi, firstSeen] of shipsToAnnounce) {
    const v = vessels.get(mmsi);
    if (v && now - firstSeen > 3 * 60_000) announceShip(v);
  }
  if (tpmsNewSinceSummary === 0) return;
  const day = localDay(now);
  publishFeed({
    ts: now,
    family: 'home',
    kind: 'Street',
    title: `${tpmsNewSinceSummary} new tire sensor${tpmsNewSinceSummary === 1 ? '' : 's'}`,
    meta: `315`,
    body: `${store.countSightings(day, 'tpms', 1, 1)} passers-by and ${store.countSightings(day, 'tpms', 2)} regulars today.`,
  });
  tpmsNewSinceSummary = 0;
}

// While rotating, ADS-B is on only during its slot, so summarize once per visit
// (90 s in, once Ultrafeeder has a picture). Otherwise every 5 minutes.
let lastAdsbVisitSummarized = 0;
function maybeSummarizeAircraft(now: number) {
  if (rotating()) {
    const cur = scheduler?.current;
    if (cur?.slotId === 'adsb' && now - cur.since > 90_000 && lastAdsbVisitSummarized !== cur.since) {
      lastAdsbVisitSummarized = cur.since;
      summarizeAircraft(now);
    }
  } else if (now - lastSummary >= SUMMARY_EVERY_MS) {
    summarizeAircraft(now);
  }
}

async function tick() {
  if (!adsb.home) await adsb.loadReceiver().catch(() => {});
  adsb.keepOnFailure = rotating();
  const ok = await adsb.poll();
  const now = Date.now();
  if (ok) {
    const day = localDay(now);
    // Record each aircraft at most once a minute: a write per aircraft every 2 s wears the SD card.
    for (const a of adsb.aircraft) {
      if (now - (lastAircraftSave.get(a.hex) ?? 0) < 60_000) continue;
      lastAircraftSave.set(a.hex, now);
      store.seeAircraft(day, a.hex, a.flight, a.type, now);
    }
  }
  maybeSummarizeAircraft(now);
  if (now - lastSummary >= SUMMARY_EVERY_MS) {
    lastSummary = now;
    summarizeStreet(now);
  }
  broadcast('snapshot', snapshot());
}

// ---- AIS (AIS-catcher sends NMEA over UDP) -----------------------------------------------
const ais = new AisDecoder();
function onAisLine(line: string) {
  const m = ais.push(line);
  if (!m) return;
  const now = Date.now();
  heard('ais', now);
  if (m.type === 21 && 'lat' in m && m.lat !== undefined && m.lon !== undefined) {
    aisFixed.set(m.mmsi, { mmsi: m.mmsi, kind: 'aid', name: 'name' in m ? m.name : undefined, aidType: 'aidType' in m ? m.aidType : undefined, lat: m.lat, lon: m.lon, lastSeen: now });
    return;
  }
  if (m.type === 4 && 'lat' in m && m.lat !== undefined && m.lon !== undefined) {
    aisFixed.set(m.mmsi, { mmsi: m.mmsi, kind: 'base', lat: m.lat, lon: m.lon, lastSeen: now });
    return;
  }
  if (![1, 2, 3, 5, 18, 19, 24].includes(m.type)) return;
  const v = vessels.get(m.mmsi) ?? { mmsi: m.mmsi, lastSeen: now };
  v.lastSeen = now;
  if ('name' in m && m.name) v.name = m.name;
  if ('shipType' in m && m.shipType) v.shipType = shipTypeName(m.shipType) ?? v.shipType;
  if ('lat' in m && m.lat !== undefined) {
    v.lat = m.lat;
    v.lon = m.lon;
  }
  if ('sog' in m && m.sog !== undefined) v.sog = m.sog;
  if ('cog' in m && m.cog !== undefined) v.cog = m.cog;
  vessels.set(m.mmsi, v);
  const { first } = store.sight(localDay(now), 'ship', String(m.mmsi), now);
  if (first) shipsToAnnounce.set(m.mmsi, now);
  // Names arrive in separate, slower messages: announce once named, or after 3 minutes without one.
  const firstSeen = shipsToAnnounce.get(m.mmsi);
  if (firstSeen !== undefined && (v.name || now - firstSeen > 3 * 60_000)) announceShip(v);
}

const shipsToAnnounce = new Map<number, number>();
function announceShip(v: Vessel) {
  shipsToAnnounce.delete(v.mmsi);
  const motion = v.sog !== undefined ? (v.sog < 0.5 ? 'stopped' : `${v.sog.toFixed(1)} kn`) : 'no speed yet';
  publishFeed({ ts: Date.now(), family: 'sea', kind: 'Ship', title: v.name ?? `MMSI ${v.mmsi}`, meta: 'AIS', body: `${v.shipType ?? 'Vessel'} · ${motion} · first seen today` });
}

// ---- VDL2 (dumpvdl2 sends JSON over UDP) -------------------------------------------------
function onVdl2(raw: string) {
  heard('vdl2');
  const c = parseVdl2(raw);
  if (!c) return;
  const key = c.flight ?? c.reg ?? c.title;
  store.sight(localDay(c.ts), 'vdl2', key, c.ts);
  // At most one feed item per flight every 10 minutes, except controller datalink.
  const last = lastVdl2PerFlight.get(key) ?? 0;
  if (!c.title.includes('controller') && c.ts - last < 5 * 60_000) return;
  lastVdl2PerFlight.set(key, c.ts);
  publishFeed({ ts: c.ts, family: 'air', kind: 'Datalink', title: c.title, meta: `${c.freqMhz.toFixed(3)}`, body: c.body, raw: c.raw });
}

// ---- weather balloons (radiosonde_auto_rx payload summaries over UDP) -----------------------
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
function onSonde(raw: string) {
  const e = sondes.push(raw);
  if (!e) return;
  heard('sonde');
  const b = e.balloon;
  const freq = b.freqMhz ? b.freqMhz.toFixed(3) : '400–406';
  if (e.kind === 'detected') {
    publishFeed({ ts: Date.now(), family: 'wx', kind: 'Balloon', title: `Weather balloon ${b.id}`, meta: freq, body: `${b.model ?? 'Radiosonde'} picked up at ${km(b.altM)}${b.vertMps !== undefined ? `, ${b.vertMps > 0 ? 'climbing' : 'descending'} ${Math.abs(b.vertMps).toFixed(1)} m/s` : ''}.` });
  } else if (e.kind === 'burst') {
    publishFeed({ ts: Date.now(), family: 'wx', kind: 'Balloon', title: `Balloon ${b.id} burst`, meta: freq, body: `Reached ${km(b.maxAltM)} before bursting; now falling by parachute.` });
  }
}

// ---- rtl_433 and NOAA alerts (MQTT) -------------------------------------------------------
function onRtl433(raw: string) {
  const e = parseRtl433(raw);
  if (!e) return;
  heard('ism', e.ts);
  const day = localDay(e.ts);
  if (e.kind === 'tpms') {
    const { first } = store.sight(day, 'tpms', `${e.model}:${e.id}`, e.ts);
    if (first) tpmsNewSinceSummary++;
    return;
  }
  if (e.kind === 'meter') {
    store.sight(day, 'meter', e.id, e.ts);
    if (GAS_METER_ID && e.id === GAS_METER_ID) {
      const reading = e.fields.consumption_data ?? e.fields.Consumption ?? e.fields.consumption;
      publishFeed({ ts: e.ts, family: 'home', kind: 'Home', title: 'Your gas meter', meta: `915`, body: `Reading ${reading ?? '—'}`, mono: true });
    }
    return;
  }
  // Other sensors: post the first reading of the day, then at most hourly per device.
  const key = `${e.model}:${e.id}`;
  store.sight(day, 'sensor', key, e.ts);
  if (e.ts - (lastSensorPost.get(key) ?? 0) < 3600_000) return;
  lastSensorPost.set(key, e.ts);
  publishFeed({ ts: e.ts, family: 'home', kind: 'Sensor', title: e.model.replace(/-/g, ' '), meta: `${e.freqMhz ? e.freqMhz.toFixed(2) : 'ISM'}`, body: describeSensor(e.fields) });
}

function onEas(line: string) {
  heard('noaa');
  const a = parseSame(line);
  if (!a) return;
  publishFeed({
    ts: Date.now(),
    family: 'wx',
    kind: a.test ? 'Weather test' : 'Weather alert',
    title: a.event,
    meta: '162.450',
    body: `${a.areas.length} area${a.areas.length === 1 ? '' : 's'} · ${a.durationMin} min · from ${a.station}`,
  });
}

if (MQTT_URL) {
  const client = mqttConnect(MQTT_URL, { username: env.MQTT_USER, password: env.MQTT_PASS, reconnectPeriod: 5000 });
  client.on('connect', () => {
    console.log('mqtt connected');
    client.subscribe(['airwaves/rtl_433', 'airwaves/noaa/eas', 'airwaves/scheduler/state']);
  });
  client.on('error', (e) => console.warn('mqtt:', e.message));
  client.on('message', (topic, payload) => onMqtt(topic, payload.toString()));
}

function onMqtt(topic: string, text: string) {
  if (topic === 'airwaves/rtl_433') onRtl433(text);
  else if (topic === 'airwaves/noaa/eas') for (const l of text.split('\n')) onEas(l);
  else if (topic === 'airwaves/scheduler/state') {
    try {
      // An empty retained message means the scheduler shut down cleanly.
      scheduler = text ? (JSON.parse(text) as SchedulerState) : undefined;
    } catch {
      /* ignore malformed state */
    }
  }
}

// ---- UDP listeners --------------------------------------------------------------------------
function udp(port: number, onLine: (l: string) => void) {
  const s = createSocket('udp4');
  s.on('message', (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) onLine(line);
  });
  s.on('error', (e) => console.warn(`udp ${port}:`, e.message));
  s.bind(port);
}
udp(AIS_UDP_PORT, onAisLine);
udp(SONDE_UDP_PORT, onSonde);
udp(VDL2_UDP_PORT, onVdl2);

// ---- audio clips (ATC and weather radio) -----------------------------------------------------
function onClip(c: Clip) {
  const url = `/api/clips/${c.dir}/${encodeURIComponent(c.file)}`;
  if (c.dir === 'atc') {
    heard('atc', c.ts);
    store.sight(localDay(c.ts), 'atc', c.file, c.ts);
    const ch = ATC_NAMES[c.template] ?? { name: c.template.replace(/_/g, ' '), freq: '' };
    publishFeed({ ts: c.ts, family: 'air', kind: 'ATC', title: ch.name, meta: `${ch.freq}`, body: '', clip: url });
  } else if (c.dir === 'noaa') {
    heard('noaa', c.ts);
    publishFeed({ ts: c.ts, family: 'wx', kind: 'Weather', title: 'NOAA Weather Radio', meta: `162.450`, body: '', clip: url });
  }
}
if (CLIPS_ROOT) new ClipWatcher({ atc: join(CLIPS_ROOT, 'atc'), noaa: join(CLIPS_ROOT, 'noaa') }, onClip).start();

function currentOverlays(): Overlays {
  try {
    return readOverlays(join(HD_DIR, 'maps'), Date.now());
  } catch {
    return {};
  }
}

function currentSpectrum(): SpectrumHeat {
  return { bins: SPECTRUM_BINS, rows: store.spectrumSince(Math.floor(Date.now() / 3600_000) - 23, SPECTRUM_BINS) };
}

// ---- HTTP -------------------------------------------------------------------------------------
const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json' };

/** Serves a file under `root`, with Content-Length and byte ranges so audio shows a duration and can seek. */
function serveFile(res: ServerResponse, root: string, rel: string, range?: string): boolean {
  const path = normalize(join(root, rel));
  if (!path.startsWith(normalize(root)) || !existsSync(path) || !statSync(path).isFile()) return false;
  const size = statSync(path).size;
  const type = TYPES[extname(path)] ?? 'application/octet-stream';
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return true;
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
    createReadStream(path, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  createReadStream(path).pipe(res);
  return true;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  if (p === '/api/snapshot') {
    res.writeHead(200, { 'content-type': 'application/json' });
    const pub = isPublic(req);
    const snap = snapshot();
    const feed = store.recentFeed(200);
    res.end(JSON.stringify(pub ? { snapshot: publicSnapshot(snap), feed: feed.map(publicItem) } : { snapshot: snap, feed }));
    return;
  }
  if (p === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const pub = isPublic(req);
    clients.set(res, pub);
    send(res, 'snapshot', pub ? publicSnapshot(snapshot()) : snapshot());
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, adsbError: adsb.lastError ?? null, mqtt: Boolean(MQTT_URL), rotating: rotating(), clients: clients.size }));
    return;
  }
  if (p === '/api/spectrum') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(currentSpectrum()));
    return;
  }
  if (p === '/api/overlays') {
    const o = currentOverlays();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(o));
    return;
  }
  if (p.startsWith('/api/maps/')) {
    if (serveFile(res, join(HD_DIR, 'maps'), p.slice('/api/maps/'.length))) return;
  }
  if (p.startsWith('/api/art/')) {
    if (serveFile(res, ART_DIR, p.slice('/api/art/'.length))) return;
  }
  if (p.startsWith('/api/clips/') && CLIPS_ROOT) {
    if (serveFile(res, CLIPS_ROOT, p.slice('/api/clips/'.length), req.headers.range)) return;
  }
  if (WEB_DIR && !p.startsWith('/api/')) {
    if (serveFile(res, WEB_DIR, p === '/' ? 'index.html' : p) || serveFile(res, WEB_DIR, 'index.html')) return;
  }
  res.writeHead(404).end();
});

// ---- housekeeping: bounded storage on the Pi ---------------------------------------------------
async function housekeeping() {
  const now = Date.now();
  const files = CLIPS_ROOT
    ? (await purgeOldFiles(join(CLIPS_ROOT, 'atc'), CLIP_RETENTION_MS, ['.mp3', '.wav'])) + (await purgeOldFiles(join(CLIPS_ROOT, 'noaa'), CLIP_RETENTION_MS, ['.mp3', '.wav'])) + (await purgeOldFiles(join(CLIPS_ROOT, 'radio'), CLIP_RETENTION_MS, ['.mp3', '.wav']))
    : 0;
  const art = await purgeOldFiles(ART_DIR, CLIP_RETENTION_MS, ['.jpg', '.jpeg', '.png']);
  const maps = await purgeOldFiles(join(HD_DIR, 'maps'), 86_400_000, ['.png', '.jpg', '.jpeg', '.txt', '.gif']);
  const cutoff = now - DB_RETENTION_DAYS * 86_400_000;
  const rows = store.purge(cutoff, localDay(cutoff));
  const removedRows = Object.values(rows).reduce((a, b) => a + b, 0);
  if (files || art || maps || removedRows) console.log(`housekeeping: ${files} clips and ${art + maps} images deleted, rows removed ${JSON.stringify(rows)}`);
  // Small in-memory maps: drop entries older than a day.
  for (const m of [lastVdl2PerFlight, lastSensorPost, lastAircraftSave]) for (const [k, t] of m) if (now - t > 86_400_000) m.delete(k);
  for (const [k, v] of vessels) if (now - v.lastSeen > 86_400_000) vessels.delete(k);
}
// Results that land as files (spectrum sweeps, HD Radio logs) are picked up every minute.
async function ingestFiles() {
  const now = Date.now();
  if (await ingestSpectrum(SPECTRUM_DIR, store)) heard('spectrum', now);
  mkdirSync(ART_DIR, { recursive: true });
  const radioClips = CLIPS_ROOT ? join(CLIPS_ROOT, 'radio') : undefined;
  for (const c of await ingestHdRadio(HD_DIR, ART_DIR, radioClips)) {
    heard('hdradio', c.ts);
    const key = `${c.freq}_${c.program}`;
    const prev = radio.get(key);
    const art = c.image ? `/api/art/${encodeURIComponent(c.image)}` : undefined;
    const logo = c.logo ? `/api/art/${encodeURIComponent(c.logo)}` : undefined;
    const clip = c.clip ? `/api/clips/radio/${encodeURIComponent(c.clip)}` : undefined;
    const titleChanged = c.title !== undefined && c.title !== prev?.title;
    const st: RadioStation = {
      key,
      freq: c.freq,
      program: c.program,
      name: c.station ?? prev?.name,
      slogan: c.slogan ?? prev?.slogan,
      title: c.title ?? prev?.title,
      artist: c.title !== undefined ? c.artist : prev?.artist,
      album: c.title !== undefined ? c.album : prev?.album,
      art: art ?? (titleChanged ? undefined : prev?.art),
      logo: logo ?? prev?.logo,
      clip: clip ?? prev?.clip,
      updatedAt: c.ts,
      songAt: titleChanged ? c.ts : prev?.songAt,
    };
    radio.set(key, st);
    // Post to the feed on a song change, or the first time we see a station today.
    if (titleChanged || !prev || localDay(prev.updatedAt) !== localDay(c.ts)) {
      const playing = c.title ? `${c.title}${c.artist ? ` — ${c.artist}` : ''}` : c.slogan ?? 'No song information';
      publishFeed({ ts: c.ts, family: 'bcast', kind: 'Radio', title: `${st.name ?? `${c.freq} FM`} HD${c.program + 1}`, meta: c.freq, body: playing, image: art, clip });
    }
  }
}
setInterval(() => void ingestFiles(), 60_000);

// ---- state that survives restarts: ships, buoys, home location ------------------------------------
function saveState() {
  store.setState('vessels', [...vessels.values()]);
  store.setState('aisFixed', [...aisFixed.values()]);
  if (adsb.home) store.setState('home', adsb.home);
  store.setState('balloons', [...sondes.flights.values()]);
  store.setState('radio', [...radio.values()]);
}
function loadState() {
  const day = Date.now() - 86_400_000;
  for (const v of store.getState<Vessel[]>('vessels') ?? []) if (v.lastSeen > day) vessels.set(v.mmsi, v);
  for (const f of store.getState<AisFixed[]>('aisFixed') ?? []) aisFixed.set(f.mmsi, f);
  adsb.home ??= store.getState('home');
  for (const r of store.getState<RadioStation[]>('radio') ?? []) if (r.updatedAt > day) radio.set(r.key, r);
  for (const b of store.getState<Balloon[]>('balloons') ?? []) if (b.lastSeen > day) sondes.flights.set(b.id, b);
}
loadState();
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => {
    saveState();
    process.exit(0);
  });

void housekeeping();
setInterval(() => {
  saveState();
  void housekeeping();
}, 10 * 60_000);

// Public, read-only copy of the dashboard on a web host (always the public view).
if (env.PUBLISH_HOST) {
  new Publisher({
    host: env.PUBLISH_HOST,
    port: Number(env.PUBLISH_PORT ?? 22),
    user: env.PUBLISH_USER,
    pass: env.PUBLISH_PASS,
    dir: env.PUBLISH_DIR || '/',
    everySec: Number(env.PUBLISH_EVERY_SEC ?? 60) || 60,
    webDir: WEB_DIR,
    roots: { clips: CLIPS_ROOT, art: ART_DIR, maps: join(HD_DIR, 'maps') },
    snapshot: () => publicSnapshot(snapshot()),
    feed: (n) => store.recentFeed(n).map(publicItem),
    spectrum: currentSpectrum,
    overlays: currentOverlays,
  }).start();
}

await adsb.loadReceiver().catch((e) => console.warn('receiver.json unavailable:', e.message));
await tick();
setInterval(tick, 2000);
server.listen(PORT, () => console.log(`collector on http://localhost:${PORT} · adsb ${ADSB_URL} · mqtt ${MQTT_URL ? 'on' : 'off'} · clips ${CLIPS_ROOT ?? 'off'}`));
