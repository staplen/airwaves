// Types shared by the collector API, the scheduler and the web dashboard.

export type Family = 'air' | 'sea' | 'wx' | 'home' | 'bcast';

export interface Home {
  lat: number;
  lon: number;
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
  loopMinutes: number;
  updatedAt: number;
}

export interface Rotation {
  /** 'continuous' while only ADS-B runs; 'rotating' once the scheduler reports in. */
  mode: 'continuous' | 'rotating';
  current?: { sourceId: string; freqMhz: number; since: number; endsAt?: number };
  upNext: { sourceId: string; minutes: number }[];
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
  totals: Totals;
  stats: { maxRangeNm: number; avgRssi?: number };
}
