// Types shared by the collector API, the scheduler and the web dashboard.

export type Family = 'air' | 'sea' | 'wx' | 'home' | 'bcast' | 'rail' | 'ham';

export interface Home {
  lat: number;
  lon: number;
  approx?: boolean; // public site: a stand-in a few km off (chosen landmark, or snapped and shifted); not the exact spot
}

export interface Aircraft {
  hex: string;
  flight?: string;
  type?: string;
  altBaro?: number | 'ground';
  altGeom?: number; // GPS altitude (ft above the WGS84 ellipsoid, not sea level)
  qnh?: number; // the altimeter setting the crew has set (hPa): local sea-level pressure
  baroRate?: number;
  gs?: number;
  track?: number;
  lat?: number;
  lon?: number;
  rssi?: number;
  seen: number; // seconds since last message
  // From readsb's aircraft database (tar1090-db), when the airframe is in it:
  reg?: string; // registration, e.g. N876DN
  typeDesc?: string; // long type name, e.g. "BOEING 737-800"
  owner?: string; // registered owner / operator
  military?: boolean;
  // From the aircraft itself:
  category?: string; // emitter category: A1 light … A5 heavy, A7 rotorcraft, …
  squawk?: string;
  emergency?: string; // readsb's emergency state when not "none" (general, lifeguard, minfuel, nordo, unlawful, downed)
  selAltFt?: number; // altitude the crew has selected on the autopilot
  via?: 'uat'; // heard on 978 MHz UAT instead of 1090 ADS-B
}

/** An APRS station (or object) heard on 144.39 MHz, with its latest report. */
export interface AprsStation {
  call: string;
  lat?: number;
  lon?: number;
  symbol?: string; // e.g. "car", "weather station"
  symbolCode?: string; // table + code, e.g. "/>"
  comment?: string;
  via?: string; // digipeater it came through
  speedKt?: number;
  course?: number;
  altFt?: number;
  weather?: { windDir?: number; windMph?: number; gustMph?: number; tempF?: number; humidity?: number; pressureMb?: number; rainLastHourIn?: number; rain24hIn?: number; rainSinceMidnightIn?: number; luminosity?: number };
  object?: string; // for objects/items: the station that placed it
  packets: number;
  firstHeard: number;
  lastHeard: number;
}

/** A UAT ground station (FIS-B), from the position in its uplink header. */
export interface UatStation {
  lat: number;
  lon: number;
  frames: number;
  lastHeard: number;
}

export interface Vessel {
  mmsi: number;
  name?: string;
  shipType?: string;
  lat?: number;
  lon?: number;
  sog?: number; // knots
  cog?: number; // degrees
  lastSeen: number; // epoch ms
}

/** Fixed AIS transmitters: aids to navigation (buoys, lights) and base stations. */
export interface AisFixed {
  mmsi: number;
  kind: 'aid' | 'base';
  name?: string;
  aidType?: string;
  lat: number;
  lon: number;
  lastSeen: number;
}

/** A weather balloon (radiosonde) flight. */
/** Recent positions for the map's fading contrails. */
export type TrackKind = 'air' | 'dl' | 'sea' | 'ham';
export interface Tracks {
  now: number;
  tracks: { id: string; kind: TrackKind; label?: string; info?: TrackInfo; pts: [number, number, number | null, number][] }[]; // lon, lat, alt ft | null, unix s
}

/** What a trail came from, for its hover card. */
export interface TrackInfo {
  reg?: string;
  type?: string; // long type name, e.g. "Boeing 737-800"
  owner?: string;
  sources?: string[]; // 'ADS-B', 'UAT', 'datalink', 'APRS', 'AIS'
}

export interface Balloon {
  id: string; // serial number, e.g. S3420157
  model?: string;
  freqMhz?: number;
  lat: number;
  lon: number;
  altM: number;
  maxAltM: number;
  vertMps?: number;
  burst: boolean;
  firstSeen: number;
  lastSeen: number;
  track: [number, number][]; // [lon, lat], oldest first
  // Readings from the sonde itself (radiosonde_auto_rx payload summary):
  tempC?: number; // air temperature
  minTempC?: number; // coldest so far
  humidity?: number; // relative humidity %, when the sensor reports it
  speedKmh?: number; // horizontal (wind-driven) speed
  heading?: number; // direction it's drifting toward, degrees
  sats?: number; // GPS satellites in use
  battV?: number;
  snrDb?: number;
  frames?: number; // packets heard
  poweredOnAt?: number; // estimated from the frame counter (one frame per second since power-on)
  maxAltAt?: number; // when the peak was reached
  lastHeardPosted?: boolean;
}

/** A signal source (decoder slot) and how fresh its data is. */
export interface SourceStatus {
  id: string;
  name: string;
  family: Family;
  freqMhz: number;
  running: boolean; // false = not built / not scheduled yet
  lastHeard?: number; // epoch ms
  error?: string; // set when the decoder or receiver can't be reached
  note?: string; // e.g. "needs the attic antenna"
}

/** What the scheduler publishes to MQTT (airwaves/scheduler/state). */
export interface SchedulerState {
  current?: { slotId: string; freqMhz: number; since: number; endsAt: number };
  upNext: { slotId: string; minutes: number }[];
  slots?: string[]; // every slot id in the loop
  beta?: string[]; // slot ids that are exploratory: scanning, not (yet) decoded into the feed or map
  names?: Record<string, string>; // display name per slot id
  failures?: Record<string, { at: number; reason: string }>; // last failure per slot
  slotLogs?: Record<string, { at: number; lines: string[] }>; // last lines each slot's decoder printed
  loop?: { slotId: string; minutes: number; freqMhz?: number }[]; // this pass's slots in order (ids can repeat)
  index?: number; // position of the running slot in `loop`
  loopMinutes: number;
  updatedAt: number;
}

export interface Rotation {
  /** 'continuous' while only ADS-B runs; 'rotating' once the scheduler reports in. */
  mode: 'continuous' | 'rotating';
  current?: { sourceId: string; freqMhz: number; since: number; endsAt?: number };
  upNext: { sourceId: string; minutes: number }[];
  /** The whole current pass in order; `index` is the running entry. */
  loop?: { sourceId: string; minutes: number; freqMhz?: number }[];
  index?: number;
  /** Every slot id the scheduler knows, in loop order (windowed and hourly ones included). */
  slots?: string[];
  /** Exploratory slots: shown in the loop, knowingly disconnected from the feed and map. */
  beta?: string[];
  names?: Record<string, string>;
}

/** The header tile for one slot: today's headline number and a one-line detail worth reading. */
export interface SlotStat {
  value?: string; // "387", "54°F"; absent when there's nothing to count
  label: string; // "aircraft today"
  short?: string; // label for an inactive tile: "aircraft"
  detail?: string; // "14 overhead · highest FL410"
  brief?: string; // detail for an inactive tile: "14 up now"
}

export interface FeedItem {
  id: number;
  ts: number; // epoch ms
  family: Family;
  kind: string;
  title: string;
  meta: string;
  body: string;
  mono?: boolean;
  clip?: string; // audio URL for ATC / weather radio clips
  raw?: string; // original decoded text, when the body is a translation
  image?: string; // e.g. HD Radio album art URL
  tag?: string; // short caveat shown before the body, e.g. "Station message"
  peaks?: string; // clip waveform: one character per bar, 0–63 (see collector/src/peaks.ts)
  lat?: number; // where it happened, when known (shown on the map when the card is clicked)
  lon?: number;
  approxKm?: number; // lat/lon is only rough: the true spot is within about this many km (drawn as an area, not a dot)
  altFt?: number; // altitude reported with that position, when there was one
  ref?: string; // the map object it's about: "air:<hex>", "sea:<mmsi>", "aprs:<call>", "balloon:<id>", "site:<id>"
}

/** An HD Radio station seen by the sweep, with what it was last playing. */
export interface RadioStation {
  key: string; // "<freq>_<program>"
  freq: string;
  program: number; // 0 = HD1
  name?: string;
  slogan?: string;
  title?: string;
  artist?: string;
  album?: string;
  art?: string; // album art URL
  logo?: string; // station logo URL
  clip?: string; // audio snippet URL
  updatedAt: number;
  songAt?: number; // when the current title was first seen
}

export interface Totals {
  aircraftToday: number;
  atcClipsToday: number;
  shipsToday: number;
  tpmsPassersToday: number; // tire sensors heard on only one pass today
  tpmsRegularsToday: number; // heard on several passes (parked / neighbours)
  metersToday: number;
  datalinkToday: number;
}

/** One possible answer to "what was that?" (see collector/src/wwt.ts). */
export interface WwtCandidate {
  hex: string;
  typeCode?: string; // ICAO type designator, e.g. B738
  flight?: string;
  reg?: string;
  typeDesc?: string;
  owner?: string;
  kind: string; // "helicopter", "small plane", "military airliner"…
  military?: boolean;
  emergency?: string;
  positioned: boolean; // false: altitude/identity only, placed by signal strength
  altFt?: number; // height above the house when HOME_ELEV_FT is set (altRef 'home'), else above sea level
  altRef?: 'home' | 'msl';
  groundMi?: number; // at its closest to the house (positioned only)
  slantMi: number; // straight-line distance at its closest (or the signal-strength guess)
  bearing?: string; // where it was from the house at its closest: "NE"
  heading?: string; // which way it's going: "SE"
  closestAt?: number; // ms; when it was (or will be) closest
  rssi?: number;
  close: boolean; // near enough to be what you saw or heard
  score: number; // lower is a better match
}

/** The state of one "what was that?" request. */
export interface WwtAnswer {
  at: number; // when you tapped
  now: number;
  // tuning: radio not on aircraft yet · early: something close heard, still pinning it down · listening: on, nothing close yet.
  // answer, nothing and no-radio are final.
  status: 'tuning' | 'early' | 'listening' | 'answer' | 'nothing' | 'no-radio';
  say: string; // short, for a voice assistant (about three seconds); progress lines while not final
  sayLong: string; // the full sentence, for the card
  next: 'stop' | 'wait'; // stop: final (answer, nothing, no-radio); wait: ask again (GET ?at=…&wait=N)
  timing?: { radioS?: number; answerS?: number }; // seconds after the tap: radio on aircraft, final answer
  candidates: WwtCandidate[]; // best first, at most 4
  heard: number; // aircraft on the air when answered
}

export interface Snapshot {
  now: number;
  home?: Home;
  rotation: Rotation;
  sources: SourceStatus[];
  aircraft: Aircraft[];
  vessels: Vessel[];
  aisFixed: AisFixed[];
  balloons: Balloon[];
  /** Newest ATC clip per rtl_airband channel template (e.g. DCA_TWR), for map site activity. */
  atcHeard?: Record<string, number>;
  /** APRS stations heard in the last 24 h. */
  aprs?: AprsStation[];
  /** UAT (978 MHz) FIS-B ground stations heard. */
  uatStations?: UatStation[];
  radio: RadioStation[];
  totals: Totals;
  stats: { avgRssi?: number };
  publishedAt?: number; // epoch ms the public copy was uploaded (static site only)
  sensors?: SensorInfo[]; // recent 315/433 MHz sensors, most-heard first (local view only)
  pinned?: PinnedStat[]; // sensor readings pinned to the top stats
  slotStats?: Record<string, SlotStat>; // header tile per slot id
}

export type PinMetric = 'temperatureF' | 'humidity';

/** A recurring sensor heard by rtl_433 (weather stations, thermometers, …). */
export interface SensorInfo {
  key: string; // "<model>:<id>"
  model: string;
  lastSeen: number;
  heardToday: number;
  summary: string; // e.g. "54°F · 61%"
  temperatureF?: number;
  humidity?: number;
}

export interface Pin {
  key: string;
  metric: PinMetric;
  label: string;
}

export interface PinnedStat extends Pin {
  value?: number;
  unit: string;
  lastSeen?: number;
}

/** Spectrum heatmap rows: strongest level per log-spaced bin (80–1150 MHz) per hour. */
export interface SpectrumHeat {
  bins: number;
  rows: { hour: number; db: (number | null)[] }[]; // hour = epoch hours, oldest first
}

/** Traffic tiles and weather radar decoded off HD Radio data services. bounds = [west, south, east, north]. */
export interface Overlays {
  traffic?: { mapId: string; updatedAt: number; rows?: number; cols?: number; tiles: { url: string; bounds: [number, number, number, number]; row?: number; col?: number }[]; background?: [number, number, number] };
  radar?: { url: string; updatedAt: number; bounds: [number, number, number, number]; empty?: boolean }; // empty: no rain or snow in the image
}
