// Types shared by the collector API, the scheduler and the web dashboard.

export type Family = 'air' | 'sea' | 'wx' | 'home' | 'bcast' | 'rail';

export interface Home {
  lat: number;
  lon: number;
  approx?: boolean; // public site: snapped and shifted a few km; draw as a soft area, not a pin
}

export interface Aircraft {
  hex: string;
  flight?: string;
  type?: string;
  altBaro?: number | 'ground';
  baroRate?: number;
  gs?: number;
  track?: number;
  lat?: number;
  lon?: number;
  distNm?: number;
  rssi?: number;
  seen: number; // seconds since last message
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
export type TrackKind = 'air' | 'dl' | 'sea';
export interface Tracks {
  now: number;
  tracks: { id: string; kind: TrackKind; label?: string; pts: [number, number, number | null, number][] }[]; // lon, lat, alt ft | null, unix s
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
  failures?: Record<string, { at: number; reason: string }>; // last failure per slot
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
  radio: RadioStation[];
  totals: Totals;
  stats: { maxRangeNm: number; avgRssi?: number };
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
  radar?: { url: string; updatedAt: number; bounds: [number, number, number, number] };
}
