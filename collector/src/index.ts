import { createServer, type ServerResponse } from 'node:http';
import { createSocket } from 'node:dgram';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { connect as mqttConnect } from 'mqtt';
import type { Aircraft, AisFixed, Balloon, FeedItem, Overlays, Pin, PinMetric, RadioStation, SchedulerState, SensorInfo, SlotStat, Snapshot, SourceStatus, SpectrumHeat, Tracks, Vessel } from '../../shared/types.ts';
import { AdsbSource } from './adsb.ts';
import { AisDecoder, shipTypeName } from './ais.ts';
import { ClipWatcher, existingClips, type Clip } from './clips.ts';
import { parseSame } from './eas.ts';
import { ingestSpectrum, purgeOldFiles, SPECTRUM_BINS } from './housekeeping.ts';
import { ingestHdRadio } from './hdradio.ts';
import { ingestTrains, SAMPLE_RATE as TRAIN_RATE, type TrainBurst } from './trains.ts';
import { decodeEot, describeEot, describeHot } from './eot.ts';
import { clipPeaks, wavSamples } from './peaks.ts';
import { describeCar, TireGrouper, tireReading } from './tires.ts';
import { loadGroundStations } from './groundstations.ts';
import { AprsState, ingestAprsFiles, tcpLines, UatState } from './extra.ts';
import { parseAcarsdec } from './acarsdec.ts';
import { addProbe, ingestSurvey, surveyReport, type SurveyState } from './survey.ts';
import { ingestProbes } from './probe.ts';
import type { AprsPacket } from './aprs.ts';
import { describeAprs, weatherLine } from './aprstext.ts';
import { approxHome, randomOffset, type Offset } from './privacy.ts';
import { readOverlays } from './overlays.ts';
import { Publisher } from './publisher.ts';
import { describeBalloon, SondeTracker } from './sonde.ts';
import { SITES } from '../../shared/sites.ts';
import { TrackStore } from './tracks.ts';
import { RawTap, tryJson, vdl2Kind } from './rawtap.ts';
import { RawLog } from './rawlog.ts';
import { describeSensor, isSecurityDevice, parseRtl433 } from './rtl433.ts';
import { Store, localDay } from './store.ts';
import { AcarsAssembler, parseVdl2 } from './vdl2.ts';

// ---- configuration (environment variables) --------------------------------------------
const env = process.env;
const PI_HOST = env.PI_HOST ?? 'homeassistant.local';
const ADSB_URL = env.ADSB_URL ?? `http://${PI_HOST}:8080/data`;
const PORT = Number(env.PORT ?? 4000);
const DATA_DIR = env.DATA_DIR ?? 'data';
const MQTT_URL = env.MQTT_URL; // e.g. mqtt://127.0.0.1:1883; ingest is off without it
const AIS_UDP_PORT = Number(env.AIS_UDP_PORT ?? 4100);
const VDL2_UDP_PORT = Number(env.VDL2_UDP_PORT ?? 4101);
const ACARS_UDP_PORT = Number(env.ACARS_UDP_PORT ?? 5551); // acarsdec (plain VHF ACARS) JSON
const UAT_JSON_PORT = Number(env.UAT_JSON_PORT ?? 30979); // dump978-fa, while the UAT slot runs
const UAT_RAW_PORT = Number(env.UAT_RAW_PORT ?? 30978);
const APRS_DIR = env.APRS_DIR ?? join(dirname(env.DATA_DIR ?? 'data'), 'aprs'); // multimon-ng APRS lines
const PROBE_DIR = env.PROBE_DIR ?? join(dirname(env.DATA_DIR ?? 'data'), 'probe'); // beta identify-probe recordings
const CLIPS_ROOT = env.CLIPS_ROOT; // folder holding atc/, noaa/ and radio/ clip folders
// rtl_power sweeps land here; default is a "spectrum" folder next to DATA_DIR (/airwaves/spectrum on the Pi).
const SPECTRUM_DIR = env.SPECTRUM_DIR ?? join(dirname(env.DATA_DIR ?? 'data'), 'spectrum');
const RAW_DIR = env.RAW_DIR ?? join(dirname(env.DATA_DIR ?? 'data'), 'raw'); // durable raw decoder logs (hourly, 72 h)
const TRAINS_DIR = env.TRAINS_DIR ?? join(dirname(env.DATA_DIR ?? 'data'), 'trains'); // train probe recordings + review/
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
  { id: 'atc', name: 'ATC', family: 'air', freqMhz: 119.55 },
  { id: 'ais', name: 'Ships', family: 'sea', freqMhz: 162.0 },
  { id: 'vdl2', name: 'Datalink', family: 'air', freqMhz: 136.8 },
  { id: 'ism', name: 'Sensors', family: 'home', freqMhz: 315 },
  { id: 'noaa', name: 'NOAA', family: 'wx', freqMhz: 162.45 },
  { id: 'sonde', name: 'Balloons', family: 'wx', freqMhz: 403 },
  { id: 'hdradio', name: 'HD Radio', family: 'bcast', freqMhz: 98 },
  { id: 'spectrum', name: 'Spectrum', family: 'bcast', freqMhz: 500 },
  { id: 'uat', name: 'UAT', family: 'air', freqMhz: 978 },
  { id: 'trains', name: 'Trains', family: 'rail', freqMhz: 457.9375 },
  { id: 'aprs', name: 'APRS', family: 'ham', freqMhz: 144.39 },
  { id: 'acars', name: 'ACARS', family: 'air', freqMhz: 130.8 },
  { id: 'rail', name: 'Rail radio', family: 'rail', freqMhz: 160.6875 },
  { id: 'survey', name: 'Survey', family: 'bcast', freqMhz: 500 },
  { id: 'probe', name: 'Identify', family: 'bcast', freqMhz: 500 },
];

const ATC_NAMES: Record<string, { name: string; freq: string }> = {
  DCA_TWR: { name: 'DCA Tower', freq: '119.100' },
  DEP_TYSON: { name: 'Potomac Departure', freq: '118.950' },
  APP_LURAY: { name: 'Potomac Approach', freq: '118.675' },
  APP_OJAAY: { name: 'Potomac Approach', freq: '119.850' },
  APP_BWI: { name: 'Potomac Approach (BWI)', freq: '119.000' },
  BWI_TWR: { name: 'BWI Tower', freq: '119.400' },
  IAD_TWR_E: { name: 'IAD Tower', freq: '120.100' },
  IAD_TWR_C: { name: 'IAD Tower', freq: '120.250' },
  APP_IAD_W: { name: 'Potomac Approach (IAD)', freq: '120.450' },
  // 133.9 slice: unofficial frequency lists put these on Washington Center (en-route), not Potomac; unconfirmed, but named anyway.
  AIR_133900: { name: 'Washington Center', freq: '133.900' },
  AIR_133975: { name: 'Washington Center', freq: '133.975' },
  AIR_134500: { name: 'Washington Center', freq: '134.500' },
};

const startedAt = Date.now();
const lastHeard = new Map<string, number>();
const vessels = new Map<number, Vessel>();
const aisFixed = new Map<number, AisFixed>();
const sondes = new SondeTracker();
const tracks = new TrackStore(); // 24 h of positions for the map's contrails
const uat = new UatState(); // 978 MHz aircraft and FIS-B ground stations
const aprs = new AprsState(); // 144.39 MHz stations
let survey: SurveyState = { v: 2, surveys: {}, channels: {} }; // beta: what the fine sweeps keep finding
const dlNames = new Map<string, { name: string; ts: number }>(); // ICAO hex → flight/registration seen on datalink
const DL_NAME_MS = 12 * 3600_000;
const dlName = (hex: string, now: number) => {
  const n = dlNames.get(hex);
  return n && now - n.ts < DL_NAME_MS ? n.name : undefined;
};
// Raw decoder output for the parsing audit (local network only, memory only): see /api/raw.
const rawLog = new RawLog(RAW_DIR).start();
let lastAdsbRaw = 0;
/** One raw decoder message: to the in-memory samples (/api/raw) and the durable hourly log files. */
function logRaw(source: string, kind: string, text: string, ts = Date.now()) {
  rawTap.add(source, kind, text, ts);
  rawLog.write(source, kind, text, ts);
}
const rawTap = new RawTap({
  rtl433: { perKind: 5, maxKinds: 80 }, // per rtl_433 model
  ais: { perKind: 5, maxKinds: 30 }, // per AIS message type
  vdl2: { perKind: 5, maxKinds: 80 }, // per ACARS label / frame kind
  sonde: { perKind: 60, maxKinds: 10, minIntervalMs: 60_000 }, // per balloon, one frame a minute
  eas: { perKind: 50, maxKinds: 1 },
  hdradio: { perKind: 2, maxKinds: 12, maxChars: 200_000 }, // whole nrsc5 logs, per station
  adsb: { perKind: 10, maxKinds: 10, minIntervalMs: 60_000 }, // per readsb position source (adsb_icao, mlat, tisb...)
});
const sensors = new Map<string, SensorInfo>(); // rtl_433 sensors by "<model>:<id>"
let pins: Pin[] = []; // sensor readings shown with the top stats
let scheduler: SchedulerState | undefined;
let lastSummary = 0;
let tpmsNewSinceSummary = 0;
const lastVdl2PerFlight = new Map<string, number>();
const lastSensorPost = new Map<string, number>();
const atcHeard = new Map<string, number>(); // rtl_airband channel template → newest clip time (map sites pulse)
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
  // No callsign on ADS-B? Use the flight number datalink reported for the same airframe (ICAO hex).
  const onAdsb = adsb.aircraft.map((a) => ({ ...a, flight: a.flight ?? dlName(a.hex, now), seen: a.seen + gapS }));
  // UAT (978 MHz) planes that 1090 didn't also hear.
  const have = new Set(onAdsb.map((a) => a.hex));
  const aircraft = [...onAdsb, ...uat.live(now).filter((a) => !have.has(a.hex)).map((a) => ({ ...a, flight: a.flight ?? dlName(a.hex, now) }))];
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
          loop: scheduler!.loop?.map((u) => ({ sourceId: u.slotId, minutes: u.minutes, freqMhz: u.freqMhz })),
          index: scheduler!.index,
          slots: scheduler!.slots,
          beta: scheduler!.beta,
          names: scheduler!.names,
        }
      : { mode: 'continuous', current: { sourceId: 'adsb', freqMhz: 1090, since: startedAt }, upNext: [] },
    sources: SOURCES.map((s) => ({
      ...s,
      running: s.id === 'adsb' || planned.has(s.id),
      lastHeard: lastHeardFor(s.id, now),
      error:
        s.id === 'adsb' && adsb.lastError && adsbExpected && now - adsb.lastOk > 30_000
          ? `Receiver unreachable (${adsb.lastError})`
          : slotFailure(s.id, now),
    })),
    aircraft,
    vessels: [...vessels.values()].filter((v) => now - v.lastSeen < 3 * 3600_000),
    aisFixed: [...aisFixed.values()],
    balloons: sondes.recent(now, 48 * 3600_000), // older flights stay on the map, fading
    atcHeard: Object.fromEntries(atcHeard),
    aprs: aprs.recent(now),
    uatStations: [...uat.stations.values()].filter((st) => now - st.lastHeard < 7 * 86_400_000),
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
      avgRssi: rssis.length ? rssis.reduce((a, b) => a + b, 0) / rssis.length : undefined,
    },
    sensors: [...sensors.values()].filter((x) => now - x.lastSeen < 86_400_000).sort((a, b) => (localDay(b.lastSeen) === day ? b.heardToday : 0) - (localDay(a.lastSeen) === day ? a.heardToday : 0) || b.lastSeen - a.lastSeen).slice(0, 40),
    slotStats: slotStats(now, aircraft),
    pinned: pins.map((p) => {
      const x = sensors.get(p.key);
      return { ...p, value: x?.[p.metric], unit: p.metric === 'temperatureF' ? '°F' : '%', lastSeen: x?.lastSeen };
    }),
  };
}

/** A slot failure reported by the scheduler within the last loop, as a short message. */
function slotFailure(id: string, now: number): string | undefined {
  const f = scheduler?.failures?.[id];
  const loopMs = (scheduler?.loopMinutes ?? 19) * 60_000 * 1.2;
  // Shown for about one loop, and cleared as soon as the source is heard again after the failure.
  if (!f || now - f.at >= loopMs || (lastHeardFor(id, now) ?? 0) > f.at) return undefined;
  return `Slot failed: ${f.reason}`;
}


// ---- header tiles: one headline number + one interesting line per slot ---------------------
let trainsToday: { day: string; bursts: number; units?: number[]; dpu?: number } = { day: '', bursts: 0, units: [] };
let statsCache: { at: number; value: Record<string, SlotStat> } | undefined;
const fmtAltFt = (ft: number) => (ft >= 18000 ? `FL${Math.round(ft / 100)}` : `${ft.toLocaleString('en-US')} ft`);
const top = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function slotStats(now: number, aircraft: Aircraft[]): Record<string, SlotStat> {
  // Cheap parts (live aircraft) are recomputed every call; the feed-derived parts every 15 s.
  const day = localDay(now);
  if (!statsCache || now - statsCache.at > 15_000) {
    const today = store.recentFeed(1500).filter((f) => localDay(f.ts) === day);
    const hourAgo = now - 3600_000;
    const atc = today.filter((f) => f.kind === 'ATC');
    const atcHour = atc.filter((f) => f.ts >= hourAgo);
    const airlines = today.filter((f) => f.kind === 'Datalink').map((f) => f.title.match(/^([A-Za-z][A-Za-z&'. ()-]*?)\s\d/)?.[1]).filter((x): x is string => !!x && !/^Aircraft/.test(x));
    const songs = today.filter((f) => f.kind === 'Radio');
    const lastSong = songs.find((f) => f.tag !== 'Station message') ?? songs[0];
    const wxClips = today.filter((f) => f.kind === 'Weather').length;
    const alerts = today.filter((f) => f.kind === 'Weather alert').length;
    const tests = today.filter((f) => f.kind === 'Weather test');
    const ships = store.countSightings(day, 'ship');
    const lastShip = [...vessels.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
    const cars = store.countSightings(day, 'tpms', 1, 1);
    const pinnedTemp = pins.find((p) => p.metric === 'temperatureF');
    const temp = pinnedTemp && sensors.get(pinnedTemp.key)?.temperatureF;
    const balloons = sondes.recent(now);
    const v: Record<string, SlotStat> = {
      atc: { value: atc.length.toLocaleString('en-US'), label: 'calls today', short: 'calls', brief: atcHour.length ? `${atcHour.length} this hour` : undefined, detail: atcHour.length ? `${atcHour.length} this hour · busiest ${top(atcHour.map((f) => f.title))}` : undefined },
      ais: { value: String(ships), label: 'ships today', short: 'ships', brief: aisFixed.size ? plural(aisFixed.size, 'marker') : undefined, detail: lastShip && now - lastShip.lastSeen < 86_400_000 ? `latest: ${lastShip.name ?? lastShip.mmsi}` : aisFixed.size ? `${plural(aisFixed.size, 'channel marker')} heard` : undefined },
      vdl2: { value: store.countSightings(day, 'vdl2').toLocaleString('en-US'), label: 'flights on datalink', short: 'flights', brief: top(airlines), detail: top(airlines) ? `top airline: ${top(airlines)}` : undefined },
      ism:
        temp !== undefined
          ? { value: `${Math.round(temp)}°F`, label: pinnedTemp!.label, short: 'outside', brief: plural(cars, 'car'), detail: plural(cars, 'car') + ' passed today' }
          : { value: String(cars), label: 'cars passed', short: 'cars', brief: sensors.size ? plural(sensors.size, 'sensor') : undefined, detail: sensors.size ? `${plural(sensors.size, 'sensor')} heard` : undefined },
      uat: (() => {
        const n = store.countSightings(day, 'uat');
        const gs = [...uat.stations.values()].filter((st) => now - st.lastHeard < 86_400_000).length;
        return { value: n.toLocaleString('en-US'), label: 'aircraft on 978 today', short: 'on 978', brief: gs ? `${gs} ground station${gs === 1 ? '' : 's'}` : undefined, detail: `${uat.uplinks.toLocaleString('en-US')} FIS-B frames${gs ? ` from ${gs} ground station${gs === 1 ? '' : 's'}` : ''}` };
      })(),
      aprs: (() => {
        const n = store.countSightings(day, 'aprs');
        const wx = aprs.recent(now).filter((st) => st.weather).length;
        return { value: n.toLocaleString('en-US'), label: 'APRS stations today', short: 'stations', brief: wx ? `${wx} weather` : undefined, detail: wx ? `${wx} weather station${wx === 1 ? '' : 's'}` : 'amateur radio on 144.39 MHz' };
      })(),
      acars: { value: store.countSightings(day, 'acars').toLocaleString('en-US'), label: 'flights on VHF ACARS', short: 'flights', brief: '130–131.5 MHz', detail: 'plain ACARS beside VDL2 datalink' },
      rail: railStat(),
      probe: (() => {
        const ps = Object.values(survey.probes ?? {});
        const named = ps.filter((x) => x.latest.guess !== 'idle').length;
        return { value: String(ps.length), label: 'channels identified', short: 'channels', brief: `${named} active`, detail: ps.length ? ps.slice(-3).map((x) => `${x.latest.mhz.toFixed(3)}: ${x.latest.guess}`).join(' · ') : 'listening to survey finds, one per visit' };
      })(),
      survey: (() => {
        const found = surveyReport(survey).length;
        const runs = Object.values(survey.surveys).reduce((a, b) => a + b, 0);
        return { value: String(found), label: 'channels found', short: 'channels', brief: `${runs} sweeps`, detail: `${runs} fine sweeps so far · /api/survey` };
      })(),
      trains: (() => {
        const t = trainsToday.day === day ? trainsToday : { bursts: 0, units: [] as number[] };
        const units = t.units?.length ?? 0;
        // Decoded end-of-train devices count as trains; bursts too noisy to decode are listed beside them.
        return units
          ? { value: String(units), label: units === 1 ? 'train' : 'trains', short: 'trains', brief: `${t.bursts} bursts`, detail: `${t.bursts} bursts on 457.94 MHz${'dpu' in t && t.dpu ? ` · ${t.dpu} distributed-power (beta)` : ''}` }
          : { value: String(t.bursts), label: 'train bursts', short: 'bursts', brief: 'probe', detail: 'probe on 457.94 MHz' };
      })(),
      noaa: { value: String(wxClips), label: 'weather radio clips', short: 'clips', brief: alerts ? plural(alerts, 'alert') : 'no alerts', detail: alerts ? plural(alerts, 'alert') + ' today' : tests.length ? `weekly test at ${new Date(tests[0].ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: env.TIMEZONE ?? 'America/New_York' })}` : 'no alerts today' },
      sonde: { value: String(balloons.length), label: balloons.length === 1 ? 'balloon' : 'balloons', short: 'balloons', brief: balloons[0]?.id, detail: balloons[0] ? `${balloons[0].id} at ${(balloons[0].altM / 1000).toFixed(1)} km` : 'launches ~7 AM & 7 PM' },
      hdradio: { value: String(songs.length), label: 'songs today', short: 'songs', brief: lastSong?.title.replace(/ HD\d$/, ''), detail: lastSong ? `${lastSong.body} · ${lastSong.title.replace(/ HD\d$/, '')}` : undefined },
      spectrum: { label: 'spectrum sweep', short: 'sweep', brief: 'hourly', detail: 'hourly · 80–1150 MHz' },
    };
    statsCache = { at: now, value: v };
  }
  const live = aircraft.filter((a) => a.seen < 60 && a.lat !== undefined);
  const highest = Math.max(0, ...live.map((a) => (typeof a.altBaro === 'number' ? a.altBaro : 0)));
  return {
    ...statsCache.value,
    adsb: { value: store.aircraftCount(day).toLocaleString('en-US'), label: 'aircraft today', short: 'aircraft', brief: live.length ? `${live.length} up now` : undefined, detail: live.length ? `${live.length} overhead${highest ? ` · highest ${fmtAltFt(highest)}` : ''}` : undefined },
  };
}

// ---- public view: approximate home location, no distances -----------------------------------
let publicOffset: Offset | undefined; // set in loadState
const DISTANCE_TEXT = /,?\s*(?:at\s+)?[\d.]+\s*nm\b/g;
function publicSnapshot(s: Snapshot): Snapshot {
  return { ...s, sensors: undefined, pinned: s.pinned?.map((p) => ({ ...p, key: '' })), home: s.home && publicOffset ? approxHome(s.home, publicOffset) : undefined, };
}
// Older aircraft summaries said how far planes were from the receiver; strip that from the stored feed too.
{
  const n = store.rewriteBodies('Aircraft', (b) => b.replace(DISTANCE_TEXT, '').replace(/\.\s*Farthest [^.]*\.?/, '.').trim());
  if (n) console.log(`privacy: removed distances from ${n} older aircraft summaries`);
}
function publicItem(f: FeedItem): FeedItem {
  return f.kind === 'Aircraft' ? { ...f, body: f.body.replace(DISTANCE_TEXT, '') } : f;
}
const isPublic = (req: { headers: Record<string, string | string[] | undefined> }) => FORCE_PUBLIC || Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);

// "Last heard" per source: live value if we have one, else the newest sighting in the database
// (so a collector restart doesn't turn sources with data back into "not heard yet").
const DB_SOURCES: Record<string, string[]> = { adsb: ['aircraft'], atc: ['atc'], vdl2: ['vdl2'], ais: ['ship'], ism: ['tpms', 'meter', 'sensor'] };
let dbLastCache: { at: number; values: Record<string, number | undefined> } = { at: 0, values: {} };
function lastHeardFor(id: string, now: number): number | undefined {
  const live = id === 'adsb' ? adsb.lastHeard : lastHeard.get(id);
  if (now - dbLastCache.at > 60_000) {
    const values: Record<string, number | undefined> = {};
    for (const [k, srcs] of Object.entries(DB_SOURCES)) values[k] = store.lastSeen(srcs);
    dbLastCache = { at: now, values };
  }
  const db = dbLastCache.values[id];
  return Math.max(live ?? 0, db ?? 0) || undefined;
}

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
  publishFeed({ ts: now, family: 'air', kind: 'Aircraft', title: `${adsb.aircraft.length} aircraft in range`, meta: `1090`, body: aircraftHighlights(adsb.aircraft) });
}

// Bigger airframes first (emitter category A5 heavy … A1 light), then military, then by altitude.
const CATEGORY_RANK: Record<string, number> = { A5: 5, A4: 4, A3: 3, A6: 3, A2: 2, A1: 1, A7: 1 };
/** "Boeing 777-300ER UAL921 at FL370 · Airbus A321 AAL1877 at 12,000 ft · plus a military C-17." No distances (privacy). */
function aircraftHighlights(list: Aircraft[]): string {
  const named = list.filter((a) => a.typeDesc).sort((x, y) => (CATEGORY_RANK[y.category ?? ''] ?? 0) - (CATEGORY_RANK[x.category ?? ''] ?? 0) || Number(Boolean(y.military)) - Number(Boolean(x.military)) || (typeof y.altBaro === 'number' ? y.altBaro : 0) - (typeof x.altBaro === 'number' ? x.altBaro : 0));
  const parts = named.slice(0, 3).map((a) => `${a.military ? 'Military ' : ''}${a.typeDesc} ${a.flight ?? a.reg ?? a.hex} at ${fmtAlt(a)}`);
  const mil = named.slice(3).filter((a) => a.military).length;
  if (mil) parts.push(`plus ${mil} more military`);
  if (parts.length) return `${parts.join(' · ')}.`;
  const placed = list.filter((a) => a.lat !== undefined).length;
  return placed ? `${placed} with positions.` : 'No positions yet.';
}

// ---- emergencies: squawk 7500/7600/7700 or an ADS-B emergency status, confirmed on two polls a few seconds apart ----
const EMERGENCY_SQUAWK: Record<string, string> = { '7500': 'unlawful interference (hijack code)', '7600': 'radio failure', '7700': 'general emergency' };
const EMERGENCY_STATUS: Record<string, string> = { general: 'general emergency', lifeguard: 'medical (lifeguard) flight priority', minfuel: 'minimum fuel', nordo: 'radio failure', unlawful: 'unlawful interference', downed: 'downed aircraft' };
const emergencySeen = new Map<string, { first: number; last: number; announced?: number }>();
function checkEmergencies(now: number) {
  for (const a of adsb.aircraft) {
    const what = (a.squawk && EMERGENCY_SQUAWK[a.squawk]) || (a.emergency && (EMERGENCY_STATUS[a.emergency] ?? a.emergency));
    if (!what || a.seen > 10) continue;
    let e = emergencySeen.get(a.hex);
    if (!e || now - e.last > 10_000) e = { first: now, last: now, announced: e?.announced }; // a one-off garbled squawk doesn't count
    e.last = now;
    emergencySeen.set(a.hex, e);
    if (now - e.first < 4_000 || (e.announced && now - e.announced < 2 * 3600_000)) continue;
    e.announced = now;
    const name = a.flight ?? dlName(a.hex, now) ?? a.reg ?? a.hex;
    const climb = a.baroRate && a.baroRate < -500 ? ', descending' : a.baroRate && a.baroRate > 500 ? ', climbing' : '';
    publishFeed({
      ts: now,
      family: 'air',
      kind: 'Emergency',
      title: `${name} · ${a.squawk && EMERGENCY_SQUAWK[a.squawk] ? `squawking ${a.squawk}` : 'emergency'}`,
      meta: '1090',
      body: `${what.charAt(0).toUpperCase()}${what.slice(1)}. ${[a.typeDesc, `at ${fmtAlt(a)}${climb}`].filter(Boolean).join(' ')}.`,
      lat: a.lat,
      lon: a.lon,
      ref: `air:${a.hex}`,
    });
  }
  for (const [hex, e] of emergencySeen) if (now - (e.announced ?? e.first) > 3 * 3600_000) emergencySeen.delete(hex);
}

function summarizeStreet(now: number) {
  for (const [mmsi, firstSeen] of shipsToAnnounce) {
    const v = vessels.get(mmsi);
    if (v && now - firstSeen > 3 * 60_000) announceShip(v);
  }
  // Tire sensors are posted per car as they pass (see the tire section), not as a count.
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
    // Audit sample: the most detailed aircraft object per position source, at most one a minute each.
    for (const a of [...adsb.raw].sort((x, y) => Object.keys(y).length - Object.keys(x).length)) rawTap.add('adsb', String(a.type ?? '?'), JSON.stringify(a), now);
    // The file log gets the whole aircraft list once a minute (every 2 s would be ~1 GB a day).
    if (now - lastAdsbRaw >= 60_000) {
      lastAdsbRaw = now;
      rawLog.write('adsb', 'aircraft.json', JSON.stringify(adsb.raw), now);
    }
    for (const a of adsb.aircraft) if (a.seen < 15 && a.lat !== undefined && a.lon !== undefined) tracks.add('air', `air:${a.hex}`, a.lon, a.lat, typeof a.altBaro === 'number' ? a.altBaro : null, now - a.seen * 1000, a.flight, { reg: a.reg, type: a.typeDesc, owner: a.owner, sources: ['ADS-B'] });
    // Record each aircraft at most once a minute: a write per aircraft every 2 s wears the SD card.
    for (const a of adsb.aircraft) {
      if (now - (lastAircraftSave.get(a.hex) ?? 0) < 60_000) continue;
      lastAircraftSave.set(a.hex, now);
      store.seeAircraft(day, a.hex, a.flight, a.type, now);
    }
  }
  if (ok) checkEmergencies(now);
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
  logRaw('ais', `type ${m.type}`, line);
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
  if ('lat' in m && m.lat !== undefined && m.lon !== undefined) tracks.add('sea', `sea:${m.mmsi}`, m.lon, m.lat, null, now, v.name, { type: v.shipType, sources: ['AIS'] });
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
  publishFeed({ ts: Date.now(), family: 'sea', kind: 'Ship', title: v.name ?? `MMSI ${v.mmsi}`, meta: 'AIS', body: `${v.shipType ?? 'Vessel'} · ${motion} · first seen today${v.lat === undefined ? ' · no position heard yet' : ''}`, lat: v.lat, lon: v.lon, ref: `sea:${v.mmsi}` });
}

// ---- VDL2 (dumpvdl2 sends JSON over UDP) -------------------------------------------------
const acarsBlocks = new AcarsAssembler();
function onVdl2(raw: string) {
  heard('vdl2');
  logRaw('vdl2', vdl2Kind(raw), raw);
  for (const frame of acarsBlocks.push(raw)) onVdl2Frame(frame);
}
function onVdl2Frame(raw: string) {
  const c = parseVdl2(raw);
  if (c) onDatalink(c);
}
/** One translated datalink message, from VDL2 or plain VHF ACARS: names, trails, sightings, feed. */
function onDatalink(c: NonNullable<ReturnType<typeof parseVdl2>>) {
  const key = c.flight ?? c.reg ?? c.title;
  if (c.hex && (c.flight || c.reg)) dlNames.set(c.hex, { name: (c.flight ?? c.reg)!, ts: c.ts });
  const trackKey = c.hex ? `air:${c.hex}` : `dl:${key}`;
  const dlInfo = { reg: c.reg, sources: ['datalink'] };
  for (const p of c.points ?? []) tracks.add('dl', trackKey, p.lon, p.lat, p.altFt, p.ts, c.flight ?? c.reg, dlInfo);
  if (!c.points && c.lat !== undefined && c.lon !== undefined && !c.coarse) tracks.add('dl', trackKey, c.lon, c.lat, c.altFt, c.ts, c.flight ?? c.reg, dlInfo);
  store.sight(localDay(c.ts), 'vdl2', key, c.ts);
  // At most one feed item per flight every 10 minutes, except controller datalink.
  const last = lastVdl2PerFlight.get(key) ?? 0;
  if (!c.title.includes('controller') && c.ts - last < 5 * 60_000) return;
  lastVdl2PerFlight.set(key, c.ts);
  publishFeed({ ts: c.ts, family: 'air', kind: 'Datalink', title: c.title, meta: `${c.freqMhz.toFixed(3)}`, body: c.body, raw: c.raw, lat: c.lat, lon: c.lon, ref: c.hex ? `air:${c.hex}` : undefined });
}

// ---- weather balloons (radiosonde_auto_rx payload summaries over UDP) -----------------------
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
function onSonde(raw: string) {
  const j = tryJson(raw);
  if (j) logRaw('sonde', String(j.callsign ?? j.type ?? '?'), raw);
  const e = sondes.push(raw);
  if (!e) return;
  heard('sonde');
  const b = e.balloon;
  const freq = b.freqMhz ? b.freqMhz.toFixed(3) : '400–406';
  if (e.kind === 'detected' || e.kind === 'burst' || e.kind === 'progress') {
    const d = describeBalloon(e.kind, b);
    publishFeed({ ts: Date.now(), family: 'wx', kind: 'Balloon', title: d.title, meta: freq, body: d.body, lat: b.lat, lon: b.lon, ref: `balloon:${b.id}` });
  }
}
// A flight that went quiet on the way down gets a closing card with where it was last heard.
setInterval(() => {
  for (const b of sondes.lastHeard()) {
    const d = describeBalloon('last', b);
    publishFeed({ ts: b.lastSeen, family: 'wx', kind: 'Balloon', title: d.title, meta: b.freqMhz ? b.freqMhz.toFixed(3) : '400–406', body: d.body, lat: b.lat, lon: b.lon, ref: `balloon:${b.id}` });
  }
}, 60_000).unref();

// ---- tire sensors: one feed card per passing car ------------------------------------------
const tires = new TireGrouper();
setInterval(() => {
  for (const car of tires.flush(Date.now())) {
    const days = store.daysSeen('tpms', car.tires.map((t) => `${t.model}:${t.id}`));
    const d = describeCar(car, days);
    publishFeed({ ts: car.first, family: 'home', kind: 'Street', title: d.title, meta: '315', body: d.body });
  }
  tpmsNewSinceSummary = 0;
}, 10_000).unref();

// ---- rtl_433 and NOAA alerts (MQTT) -------------------------------------------------------
function onRtl433(raw: string) {
  logRaw('rtl433', String(tryJson(raw)?.model ?? '?'), raw);
  const e = parseRtl433(raw);
  if (!e) return;
  heard('ism', e.ts);
  const day = localDay(e.ts);
  if (e.kind === 'tpms') {
    const { first } = store.sight(day, 'tpms', `${e.model}:${e.id}`, e.ts);
    if (first) tpmsNewSinceSummary++;
    tires.add(tireReading(e.model, e.id, e.fields, e.ts));
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
  // Other sensors: remember the latest reading (for pinning), post the first of the day, then at most hourly per device.
  const key = `${e.model}:${e.id}`;
  if (isSecurityDevice(e.model, e.fields)) {
    store.sight(day, 'sensor', key, e.ts); // counted, never shown (says when a neighbour's door opens)
    return;
  }
  const num = (k: string) => (typeof e.fields[k] === 'number' ? (e.fields[k] as number) : undefined);
  const tc = num('temperature_C');
  const prev = sensors.get(key);
  sensors.set(key, {
    key,
    model: e.model.replace(/-/g, ' '),
    lastSeen: e.ts,
    heardToday: prev && localDay(prev.lastSeen) === day ? prev.heardToday + 1 : 1,
    summary: describeSensor(e.fields),
    temperatureF: num('temperature_F') ?? (tc !== undefined ? Math.round((tc * 1.8 + 32) * 10) / 10 : prev?.temperatureF),
    humidity: num('humidity') ?? prev?.humidity,
  });
  store.sight(day, 'sensor', key, e.ts);
  if (e.ts - (lastSensorPost.get(key) ?? 0) < 3600_000) return;
  lastSensorPost.set(key, e.ts);
  publishFeed({ ts: e.ts, family: 'home', kind: 'Sensor', title: e.model.replace(/-/g, ' '), meta: `${e.freqMhz ? e.freqMhz.toFixed(2) : 'ISM'}`, body: describeSensor(e.fields) });
}

function onEas(line: string) {
  if (line.trim()) logRaw('eas', 'line', line);
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
// Plain VHF ACARS from acarsdec: same translation and handling as VDL2 messages.
udp(ACARS_UDP_PORT, (line) => {
  heard('acars');
  const j = tryJson(line);
  logRaw('acars', String(j?.label ?? '?'), line);
  const c = parseAcarsdec(line);
  if (c) {
    store.sight(localDay(c.ts), 'acars', `${c.flight ?? c.reg ?? c.title}`, c.ts);
    onDatalink(c);
  }
});
// UAT: dump978-fa serves JSON (aircraft) and raw frames (incl. FIS-B uplinks) over TCP while its slot runs.
tcpLines(UAT_JSON_PORT, (line) => {
  const now = Date.now();
  heard('uat', now);
  logRaw('uat', 'adsb', line, now);
  const a = uat.onJson(line, now);
  if (!a) return;
  store.sight(localDay(now), 'uat', a.hex, now);
  if (a.lat !== undefined && a.lon !== undefined) tracks.add('air', `air:${a.hex}`, a.lon, a.lat, typeof a.altBaro === 'number' ? a.altBaro : null, now, a.flight, { sources: ['UAT'] });
});
tcpLines(UAT_RAW_PORT, (line) => {
  if (!line.startsWith('+')) return; // downlinks arrive decoded on the JSON port
  logRaw('uat', 'uplink', line);
  uat.onRaw(line);
});
// VDL2 ground station names (downloaded and cached; re-checked daily, refreshed when a week old).
const loadGs = () => loadGroundStations(join(DATA_DIR, 'ground-stations.json')).then((n) => n && console.log(`ground stations: ${n} known`));
void loadGs();
setInterval(() => void loadGs(), 86_400_000).unref();

// ---- audio clips (ATC and weather radio) -----------------------------------------------------
/** Local path of a clip URL ("/api/clips/<dir>/<file>"), for reading its waveform. */
function clipPath(url: string): string | undefined {
  const m = /^\/api\/clips\/([a-z]+)\/([^/]+)$/.exec(url);
  return CLIPS_ROOT && m ? join(CLIPS_ROOT, m[1], decodeURIComponent(m[2])) : undefined;
}
const peaksOf = async (url: string | undefined) => {
  const p = url && clipPath(url);
  return p ? clipPeaks(p) : undefined;
};

async function onClip(c: Clip) {
  const url = `/api/clips/${c.dir}/${encodeURIComponent(c.file)}`;
  const peaks = await peaksOf(url);
  if (c.dir === 'atc') {
    heard('atc', c.ts);
    store.sight(localDay(c.ts), 'atc', c.file, c.ts);
    atcHeard.set(c.template, Math.max(atcHeard.get(c.template) ?? 0, c.ts));
    // AIR_<kHz>: channels from the survey without a confirmed name yet, labelled by frequency.
    const air = /^AIR_(\d{6})$/.exec(c.template);
    const ch = ATC_NAMES[c.template] ?? (air ? { name: `Airband ${(Number(air[1]) / 1000).toFixed(3)}`, freq: (Number(air[1]) / 1000).toFixed(3) } : { name: c.template.replace(/_/g, ' '), freq: '' });
    const site = SITES.find((st) => st.channels.some((x) => x.atc === c.template));
    publishFeed({ ts: c.ts, family: 'air', kind: 'ATC', title: ch.name, meta: `${ch.freq}`, body: '', clip: url, peaks, lat: site?.lat, lon: site?.lon, ref: site ? `site:${site.id}` : undefined });
  } else if (c.dir === 'noaa') {
    heard('noaa', c.ts);
    const noaaSite = SITES.find((st) => st.id === 'noaa-wx');
    publishFeed({ ts: c.ts, family: 'wx', kind: 'Weather', title: 'NOAA Weather Radio', meta: `162.450`, body: '', clip: url, peaks, lat: noaaSite?.lat, lon: noaaSite?.lon, ref: noaaSite ? 'site:noaa-wx' : undefined });
  } else if (c.dir === 'rail') {
    // rtl_airband names each channel RAIL_<kHz>; AAR channel numbers run 07 (159.810) upward in 15 kHz steps.
    const mhz = Number(c.template.replace(/^RAIL_/, '')) / 1000;
    if (!Number.isFinite(mhz)) return;
    heard('rail', c.ts);
    const aar = Math.round((mhz - 159.81) / 0.015) + 7;
    publishFeed({ ts: c.ts, family: 'rail', kind: 'Rail radio', title: `Railroad channel ${String(aar).padStart(2, '0')}`, meta: mhz.toFixed(3), body: '', clip: url, peaks });
  }
}
if (CLIPS_ROOT) new ClipWatcher({ atc: join(CLIPS_ROOT, 'atc'), noaa: join(CLIPS_ROOT, 'noaa'), rail: join(CLIPS_ROOT, 'rail') }, (c) => void onClip(c)).start();
// Rail radio recordings made while it was a beta slot (not posted then): post them once, in order.
if (CLIPS_ROOT && !store.getState('railBackfilled')) {
  store.setState('railBackfilled', true);
  void (async () => {
    const clips = await existingClips('rail', join(CLIPS_ROOT, 'rail'));
    for (const c of clips) await onClip(c);
    if (clips.length) console.log(`rail: backfilled ${clips.length} earlier recording(s) into the feed`);
  })();
}
// Clips filed before waveforms existed (or while ffmpeg was missing): fill them in once, in the background.
void (async () => {
  let n = 0;
  for (const r of store.clipsWithoutPeaks(Date.now() - 24 * 3600_000)) {
    const peaks = await peaksOf(r.clip);
    if (peaks) {
      store.setPeaks(r.id, peaks);
      n++;
    }
  }
  if (n) console.log(`peaks: backfilled ${n} clip waveform(s)`);
})();

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
    const feed = store.recentFeedPerKind();
    res.end(JSON.stringify(pub ? { snapshot: publicSnapshot(snap), feed: feed.map(publicItem) } : { snapshot: snap, feed }));
    return;
  }
  if (p === '/api/pins' && req.method === 'POST') {
    // Pin or unpin a sensor reading. Local network only: never from the public tunnel.
    if (isPublic(req)) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d).length > 4096 && req.destroy());
    req.on('end', () => {
      try {
        const b = JSON.parse(body) as { key?: string; metric?: string; label?: string; remove?: boolean };
        const metrics: PinMetric[] = ['temperatureF', 'humidity'];
        if (typeof b.key !== 'string' || !metrics.includes(b.metric as PinMetric)) throw new Error('bad pin');
        const metric = b.metric as PinMetric;
        pins = pins.filter((x) => !(x.key === b.key && x.metric === metric));
        if (!b.remove) pins.push({ key: b.key, metric, label: String(b.label ?? '').trim().slice(0, 40) || (metric === 'temperatureF' ? 'temperature' : 'humidity') });
        store.setState('pins', pins);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(pins));
      } catch {
        res.writeHead(400).end();
      }
    });
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
  if (p === '/api/tracks') {
    // The same data the public copy gets (no home location in it).
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(tracks.export()));
    return;
  }
  if (p === '/api/rawlog' || p.startsWith('/api/rawlog/')) {
    // Durable raw logs: a listing, or one hourly file. Local network only.
    if (isPublic(req)) {
      res.writeHead(403).end();
      return;
    }
    if (p === '/api/rawlog') {
      void rawLog.list().then((files) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(files, null, 1)));
      return;
    }
    if (serveFile(res, RAW_DIR, p.slice('/api/rawlog/'.length))) return;
    res.writeHead(404).end();
    return;
  }
  if (p === '/api/raw') {
    // Raw decoder samples for the parsing audit. Local network only: never from the public tunnel.
    if (isPublic(req)) {
      res.writeHead(403).end();
      return;
    }
    const source = url.searchParams.get('source');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(source ? rawTap.get(source) : rawTap.summary(), null, 1));
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
  if (p === '/api/slotlogs') {
    // LAN only: the last lines each decoder printed (decoder output can name hosts or devices).
    if (isPublic(req)) return void res.writeHead(403).end();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(scheduler?.slotLogs ?? {}));
    return;
  }
  if (p === '/api/survey') {
    // Beta: channels the fine sweeps keep finding (frequencies only, nothing decoded).
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ surveys: survey.surveys, channels: surveyReport(survey), probes: survey.probes ?? {} }));
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
  for (const [hex, n] of dlNames) if (now - n.ts > DL_NAME_MS) dlNames.delete(hex);
  const rl = await rawLog.rotate(now);
  if (rl.deleted) console.log(`rawlog: ${rl.zipped} hours gzipped, ${rl.deleted} old files deleted`);
  const files = CLIPS_ROOT
    ? (await purgeOldFiles(join(CLIPS_ROOT, 'atc'), CLIP_RETENTION_MS, ['.mp3', '.wav'])) + (await purgeOldFiles(join(CLIPS_ROOT, 'noaa'), CLIP_RETENTION_MS, ['.mp3', '.wav'])) + (await purgeOldFiles(join(CLIPS_ROOT, 'radio'), CLIP_RETENTION_MS, ['.mp3', '.wav'])) + (await purgeOldFiles(join(CLIPS_ROOT, 'trains'), CLIP_RETENTION_MS, ['.wav'])) + (await purgeOldFiles(join(CLIPS_ROOT, 'rail'), CLIP_RETENTION_MS, ['.mp3', '.wav'])) + (await purgeOldFiles(join(CLIPS_ROOT, 'probe'), CLIP_RETENTION_MS, ['.wav']))
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
  if (await ingestSpectrum(SPECTRUM_DIR, store, (f, text) => rawLog.write('spectrum', f, text, now))) heard('spectrum', now);
  if (await ingestSurvey(SPECTRUM_DIR, survey, (f, text) => rawLog.write('survey', f, text, now))) {
    heard('survey', now);
    store.setState('survey', survey);
  }
  if (await ingestAprsFiles(APRS_DIR, onAprs)) heard('aprs', now);
  // Beta identify probe: classify what the survey's unknown channels carry.
  const probes = await ingestProbes(PROBE_DIR, CLIPS_ROOT ? join(CLIPS_ROOT, 'probe') : undefined);
  for (const r of probes) {
    heard('probe', r.at);
    rawLog.write('probe', `${r.mhz.toFixed(3)} ${r.guess}`, JSON.stringify(r), r.at);
    addProbe(survey, r);
  }
  if (probes.length) store.setState('survey', survey);
  const bursts = await ingestTrains(TRAINS_DIR);
  if (bursts.length) heard('trains', now);
  if (bursts.length) {
    const d = localDay(now);
    if (trainsToday.day !== d) trainsToday = { day: d, bursts: 0, units: [] };
    trainsToday.bursts += bursts.length;
    for (const b of bursts) {
      const unit = await postTrain(b);
      if (unit !== undefined && !trainsToday.units?.includes(unit)) (trainsToday.units ??= []).push(unit);
    }
    store.setState('trainsToday', trainsToday);
  }
  mkdirSync(ART_DIR, { recursive: true });
  const radioClips = CLIPS_ROOT ? join(CLIPS_ROOT, 'radio') : undefined;
  for (const c of await ingestHdRadio(HD_DIR, ART_DIR, radioClips, undefined, (name, text) => logRaw('hdradio', name.replace(/_\d{8}.*$/, ''), `${name}\n${text}`))) {
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
      publishFeed({ ts: c.ts, family: 'bcast', kind: 'Radio', title: `${st.name ?? `${c.freq} FM`} HD${c.program + 1}`, meta: c.freq, body: playing, image: art ?? st.logo, clip, tag: radioTag(c), peaks: await peaksOf(clip) });
    }
  }
}
/** Caveat for a radio feed item: the text is an ad / promo, or changed while the clip was recorded. */
function radioTag(c: { title?: string; textKind?: string; textSynced?: boolean; clip?: string }): string | undefined {
  if (!c.title) return undefined;
  if (c.textKind === 'message') return 'Station message';
  if (c.clip && c.textSynced === false) return 'Text changed during the clip';
  return undefined;
}
setInterval(() => void ingestFiles(), 60_000);

// ---- railroad voice: transmission counts for the header tile (clips go to the feed via onClip) ----
let railCache: { at: number; stat: SlotStat } | undefined;
function railStat(): SlotStat {
  const now = Date.now();
  if (railCache && now - railCache.at < 60_000) return railCache.stat;
  const byFreq = new Map<string, number>();
  let n = 0;
  try {
    for (const f of CLIPS_ROOT ? readdirSync(join(CLIPS_ROOT, 'rail')) : []) {
      const m = f.match(/^RAIL_(\d+)/);
      if (!m) continue;
      n++;
      byFreq.set(m[1], (byFreq.get(m[1]) ?? 0) + 1);
    }
  } catch {
    /* no recordings yet */
  }
  const top = [...byFreq].sort((a, b) => b[1] - a[1])[0];
  const stat: SlotStat = { value: String(n), label: 'transmissions (24 h)', short: 'transmissions', brief: top ? `busiest ${(Number(top[0]) / 1000).toFixed(3)}` : 'listening', detail: top ? `busiest channel ${(Number(top[0]) / 1000).toFixed(3)} MHz` : 'listening to every railroad channel' };
  railCache = { at: now, stat };
  return stat;
}

// ---- APRS: amateur stations on 144.39 MHz ---------------------------------------------------
const aprsWeatherPosted = new Map<string, number>();
function onAprs(p: AprsPacket, ts: number, line: string) {
  logRaw('aprs', p.kind, line, ts);
  const r = aprs.add(p, ts);
  if (!r) return;
  const st = r.station;
  store.sight(localDay(ts), 'aprs', st.call, ts);
  if (st.lat !== undefined && st.lon !== undefined && (st.speedKt ?? 0) > 2) tracks.add('ham', `aprs:${st.call}`, st.lon, st.lat, st.altFt ?? null, ts, st.call, { type: st.symbol, sources: ['APRS'] });
  const wx = st.weather;
  if (r.isNew) {
    const d = describeAprs(st);
    publishFeed({ ts, family: 'ham', kind: 'APRS', title: d.title, meta: '144.390', body: d.body, lat: st.lat, lon: st.lon, ref: `aprs:${st.call}` });
    if (wx) aprsWeatherPosted.set(st.call, ts);
  } else if (wx && ts - (aprsWeatherPosted.get(st.call) ?? 0) > 3 * 3600_000) {
    aprsWeatherPosted.set(st.call, ts);
    publishFeed({ ts, family: 'ham', kind: 'APRS weather', title: `${st.call} weather`, meta: '144.390', body: `${weatherLine(wx)}.`, lat: st.lat, lon: st.lon, ref: `aprs:${st.call}` });
  }
}

// APRS cards posted before the plain-English wording: rewrite them once from the stations we know.
if (!store.getState('aprsTextV2')) {
  setTimeout(() => {
    let n = 0;
    for (const r of store.feedOfKind('APRS')) {
      const st = aprs.stations.get(r.title);
      if (!st) continue;
      const d = describeAprs(st);
      store.setTitleBody(r.id, d.title, d.body);
      n++;
    }
    store.setState('aprsTextV2', true);
    if (n) console.log(`aprs: reworded ${n} earlier card(s)`);
  }, 5000).unref();
}

// Security-sensor cards posted before they were hidden: remove them once.
if (!store.getState('securityCardsRemoved')) {
  let n = 0;
  for (const r of store.feedOfKind('Sensor')) if (isSecurityDevice(r.title.replace(/ /g, '-'), {})) (store.deleteFeedItem(r.id), n++);
  store.setState('securityCardsRemoved', true);
  if (n) console.log(`sensors: removed ${n} security-sensor card(s)`);
}

// ---- trains: end-of-train device bursts on 457.9375 MHz -------------------------------------
/** Decodes a burst clip: the card's title and text, and the device's unit number when the checksum passed. */
async function readTrain(file: string, ms?: number): Promise<{ title: string; body: string; unit?: number }> {
  let packets: ReturnType<typeof decodeEot> = [];
  try {
    const s = wavSamples(await readFile(join(TRAINS_DIR, 'review', file)));
    if (s) packets = decodeEot(s, TRAIN_RATE);
  } catch {
    /* clip gone: fall through */
  }
  const p = packets[0];
  if (p) return { title: `Train passing · EOT ${p.unit}`, body: describeEot(p), unit: p.unit };
  return { title: 'Train passing', body: `A ${ms ? `${ms} ms ` : ''}data burst from a train's end-of-train device (the box on the last car that reports brake pressure), too noisy to decode.` };
}

const lastTrainCard = new Map<number, number>(); // EOT unit → when its card was posted
/** Posts a burst to the feed (text only: decoded signals keep no audio); returns the end-of-train unit when it decoded. */
async function postTrain(b: TrainBurst): Promise<number | undefined> {
  logRaw('trains', 'burst', JSON.stringify(b), b.at);
  const h = b.hot?.[0];
  if (h) {
    publishFeed({ ts: b.at, family: 'rail', kind: 'Train', title: `Locomotive · ${h.command === 'emergency brake' ? 'EMERGENCY' : 'status request'} to EOT ${h.unit}`, meta: '452.938', body: describeHot(h) });
    return undefined;
  }
  if (b.dpu) {
    // Beta: distributed-power traffic is noted (raw log above, count on the trains tile), not posted.
    trainsToday.dpu = (trainsToday.dpu ?? 0) + 1;
    return undefined;
  }
  const p = b.packets?.[0];
  // A train's device repeats itself every minute or so: one card per train, not per burst.
  if (p && b.at - (lastTrainCard.get(p.unit) ?? 0) < 20 * 60_000) return p.unit;
  if (p) lastTrainCard.set(p.unit, b.at);
  const t = p
    ? { title: `Train passing · EOT ${p.unit}`, body: describeEot(p), unit: p.unit }
    : { title: 'Train passing', body: `A ${b.ms} ms data burst from a train's end-of-train device (the box on the last car that reports brake pressure), too noisy to decode.`, unit: undefined };
  publishFeed({ ts: b.at, family: 'rail', kind: 'Train', title: t.title, meta: '457.938', body: t.body });
  return t.unit;
}
// Cards posted before decoding existed: decode their clips once (the review folder keeps a week of them).
if (!store.getState('trainsDecoded')) {
  store.setState('trainsDecoded', true);
  void (async () => {
    let n = 0;
    for (const r of store.feedOfKind('Train')) {
      const file = r.clip ? decodeURIComponent(r.clip.split('/').pop() ?? '') : '';
      if (!file) continue;
      const t = await readTrain(file);
      if (!t.unit) continue;
      store.setTitleBody(r.id, t.title, t.body);
      n++;
      if (localDay(r.ts) === localDay(Date.now()) && trainsToday.day === localDay(r.ts) && !trainsToday.units?.includes(t.unit)) (trainsToday.units ??= []).push(t.unit);
    }
    if (n) console.log(`trains: decoded ${n} earlier burst(s)`);
  })();
}
// Decoded, so the recordings go: no audio on train cards, no WAVs kept (once, after the decode above has read them).
if (!store.getState('trainAudioDropped')) {
  void (async () => {
    while (!store.getState('trainsDecoded')) await new Promise((r) => setTimeout(r, 1000));
    await new Promise((r) => setTimeout(r, 30_000)); // let the one-off decode finish with the WAVs first
    const cleared = store.clearClips('Train');
    for (const f of await readdir(join(TRAINS_DIR, 'review')).catch(() => [] as string[])) if (f.endsWith('.wav')) await unlink(join(TRAINS_DIR, 'review', f)).catch(() => {});
    store.setState('trainAudioDropped', true);
    if (cleared) console.log(`trains: removed audio from ${cleared} train card(s)`);
  })();
}
// ---- state that survives restarts: ships, buoys, home location ------------------------------------
function saveState() {
  store.setState('lastHeard', Object.fromEntries(lastHeard));
  store.setState('vessels', [...vessels.values()]);
  store.setState('aisFixed', [...aisFixed.values()]);
  if (adsb.home) store.setState('home', adsb.home);
  store.setState('balloons', [...sondes.flights.values()]);
  store.setState('tracks', tracks.export());
  store.setState('radio', [...radio.values()]);
  store.setState('sensors', [...sensors.values()]);
  store.setState('aprs', aprs.recent(Date.now(), 3 * 86_400_000));
  store.setState('uatStations', [...uat.stations.values()]);
}
function loadState() {
  for (const [k, v] of Object.entries(store.getState<Record<string, number>>('lastHeard') ?? {})) if (typeof v === 'number') lastHeard.set(k, v);
  const day = Date.now() - 86_400_000;
  for (const v of store.getState<Vessel[]>('vessels') ?? []) if (v.lastSeen > day) vessels.set(v.mmsi, v);
  for (const f of store.getState<AisFixed[]>('aisFixed') ?? []) aisFixed.set(f.mmsi, f);
  adsb.home ??= store.getState('home');
  aprs.load(store.getState('aprs'), Date.now());
  for (const st of store.getState<{ lat: number; lon: number; frames: number; lastHeard: number }[]>('uatStations') ?? []) uat.stations.set(`${st.lat.toFixed(2)},${st.lon.toFixed(2)}`, st);
  // v2 drops TV spill and broadband signals: start over rather than keep what the first sweeps mislabelled.
  const savedSurvey = store.getState<SurveyState & { v?: number }>('survey');
  survey = savedSurvey?.v === 2 ? savedSurvey : { v: 2, surveys: {}, channels: {} };
  publicOffset = store.getState<Offset>('publicOffset');
  if (!publicOffset) {
    publicOffset = randomOffset();
    store.setState('publicOffset', publicOffset);
  }
  for (const r of store.getState<RadioStation[]>('radio') ?? []) if (r.updatedAt > day) radio.set(r.key, r);
  for (const x of store.getState<SensorInfo[]>('sensors') ?? []) if (x.lastSeen > day) sensors.set(x.key, x);
  pins = store.getState<Pin[]>('pins') ?? [];
  trainsToday = store.getState<typeof trainsToday>('trainsToday') ?? trainsToday;
  for (const b of store.getState<Balloon[]>('balloons') ?? []) if (b.lastSeen > Date.now() - 3 * 86_400_000) sondes.flights.set(b.id, b);
  tracks.load(store.getState<Tracks>('tracks'));
}
loadState();
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => {
    saveState();
    rawLog.flush();
    process.exit(0);
  });

void housekeeping();
setInterval(() => {
  saveState();
  void housekeeping();
}, 10 * 60_000);

// Public, read-only copy of the dashboard on a web host (always the public view).
// Values from Docker's --env-file arrive exactly as written: trim spaces and surrounding quotes.
const cleanEnv = (v?: string) => v?.trim().replace(/^(['"])(.*)\1$/, '$2') || undefined;
if (cleanEnv(env.PUBLISH_HOST)) {
  new Publisher({
    host: cleanEnv(env.PUBLISH_HOST)!,
    port: Number(cleanEnv(env.PUBLISH_PORT) ?? 22),
    user: cleanEnv(env.PUBLISH_USER),
    pass: cleanEnv(env.PUBLISH_PASS),
    dir: cleanEnv(env.PUBLISH_DIR) || '/',
    everySec: Number(env.PUBLISH_EVERY_SEC ?? 30) || 30,
    webDir: WEB_DIR,
    roots: { clips: CLIPS_ROOT, art: ART_DIR, maps: join(HD_DIR, 'maps') },
    snapshot: () => publicSnapshot(snapshot()),
    feed: () => store.recentFeedPerKind().map(publicItem),
    spectrum: currentSpectrum,
    overlays: currentOverlays,
    tracks: () => tracks.export(),
  }).start();
}

await adsb.loadReceiver().catch((e) => console.warn('receiver.json unavailable:', e.message));
await tick();
setInterval(tick, 2000);
server.listen(PORT, () => console.log(`collector on http://localhost:${PORT} · adsb ${ADSB_URL} · mqtt ${MQTT_URL ? 'on' : 'off'} · clips ${CLIPS_ROOT ?? 'off'}`));
