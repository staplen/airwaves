import { readFileSync } from 'node:fs';
// Turns common ACARS / VDL2 message formats into plain English.
// Anything we don't recognise and that looks like machine telemetry is dropped;
// recognisable free text is passed through as-is.

const AIRLINES: Record<string, string> = {
  AA: 'American', AC: 'Air Canada', AS: 'Alaska', B6: 'JetBlue', DL: 'Delta', F9: 'Frontier', G4: 'Allegiant',
  G7: 'GoJet (United Express)', HA: 'Hawaiian', MQ: 'Envoy (American Eagle)', NK: 'Spirit', OH: 'PSA (American Eagle)',
  OO: 'SkyWest', QX: 'Horizon', RV: 'Air Canada Rouge', SY: 'Sun Country', UA: 'United', WN: 'Southwest',
  YV: 'Mesa', YX: 'Republic', '9E': 'Endeavor (Delta Connection)', ZW: 'Air Wisconsin', C5: 'CommuteAir',
  BA: 'British Airways', LH: 'Lufthansa', AF: 'Air France', KL: 'KLM', VS: 'Virgin Atlantic', EI: 'Aer Lingus',
  QR: 'Qatar Airways', EK: 'Emirates', TK: 'Turkish Airlines', ET: 'Ethiopian', FX: 'FedEx', '5X': 'UPS',
};

const AIRPORTS: Record<string, string> = {
  KDCA: 'Reagan National', KIAD: 'Dulles', KBWI: 'Baltimore', KJFK: 'New York JFK', KLGA: 'LaGuardia', KEWR: 'Newark',
  KBOS: 'Boston', KPHL: 'Philadelphia', KPIT: 'Pittsburgh', KCLT: 'Charlotte', KATL: 'Atlanta', KMIA: 'Miami',
  KFLL: 'Fort Lauderdale', KMCO: 'Orlando', KTPA: 'Tampa', KRDU: 'Raleigh-Durham', KORD: "Chicago O'Hare",
  KMDW: 'Chicago Midway', KDTW: 'Detroit', KCLE: 'Cleveland', KCMH: 'Columbus', KBNA: 'Nashville', KDFW: 'Dallas/Fort Worth',
  KDAL: 'Dallas Love', KIAH: 'Houston', KHOU: 'Houston Hobby', KDEN: 'Denver', KMSP: 'Minneapolis', KSTL: 'St. Louis',
  KLAX: 'Los Angeles', KSFO: 'San Francisco', KSEA: 'Seattle', KLAS: 'Las Vegas', KPHX: 'Phoenix', KSAN: 'San Diego',
  KRIC: 'Richmond', KORF: 'Norfolk', KBDL: 'Hartford', KPVD: 'Providence', KBUF: 'Buffalo', KSYR: 'Syracuse',
  KALB: 'Albany', KMSY: 'New Orleans', KAUS: 'Austin', KSAT: 'San Antonio', KSLC: 'Salt Lake City', KSJU: 'San Juan',
  KSDF: 'Louisville', KCVG: 'Cincinnati', KIND: 'Indianapolis', KMCI: 'Kansas City', KMEM: 'Memphis', KJAX: 'Jacksonville',
  KRSW: 'Fort Myers', KPBI: 'West Palm Beach', KSAV: 'Savannah', KCHS: 'Charleston', KGSO: 'Greensboro',
  KPWM: 'Portland, ME', KBTV: 'Burlington', KMHT: 'Manchester', KISP: 'Islip', KHPN: 'White Plains', KSWF: 'Newburgh',
  KABE: 'Allentown', KMDT: 'Harrisburg', KAVP: 'Scranton', KROA: 'Roanoke', KCHO: 'Charlottesville', KLYH: 'Lynchburg',
  KHGR: 'Hagerstown', KSBY: 'Salisbury', KPHF: 'Newport News', KILM: 'Wilmington', KMYR: 'Myrtle Beach', KOMA: 'Omaha',
  KMKE: 'Milwaukee', KOKC: 'Oklahoma City', KTUL: 'Tulsa', KABQ: 'Albuquerque', KBOI: 'Boise', KPDX: 'Portland',
  KSMF: 'Sacramento', KSJC: 'San Jose', KOAK: 'Oakland', KSNA: 'Santa Ana', KONT: 'Ontario', KBUR: 'Burbank',
  KELP: 'El Paso', KMSN: 'Madison', KDSM: 'Des Moines', KGRR: 'Grand Rapids', KBHM: 'Birmingham', KLIT: 'Little Rock',
  TJSJ: 'San Juan', CYUL: 'Montreal', CYYZ: 'Toronto', CYOW: 'Ottawa', EGLL: 'London Heathrow', LFPG: 'Paris CDG',
  EDDF: 'Frankfurt', EHAM: 'Amsterdam', EIDW: 'Dublin', LTFM: 'Istanbul', OTHH: 'Doha', OMDB: 'Dubai',
};
// IATA codes that show up in free text.
const IATA: Record<string, string> = Object.fromEntries(
  Object.entries(AIRPORTS).filter(([k]) => k.startsWith('K')).map(([k, v]) => [k.slice(1), v]),
);
Object.assign(IATA, { YUL: 'Montreal', YYZ: 'Toronto', YOW: 'Ottawa', LHR: 'London Heathrow', CDG: 'Paris CDG', SJU: 'San Juan' });

const AIRCRAFT: Record<string, string> = {
  B7378MAX: 'Boeing 737 MAX 8', B737: 'Boeing 737', B738: 'Boeing 737-800', B739: 'Boeing 737-900', B38M: 'Boeing 737 MAX 8',
  B39M: 'Boeing 737 MAX 9', A320: 'Airbus A320', A321: 'Airbus A321', A21N: 'Airbus A321neo', A20N: 'Airbus A320neo',
  A319: 'Airbus A319', E75L: 'Embraer 175', E170: 'Embraer 170', CRJ9: 'CRJ-900', CRJ7: 'CRJ-700', B752: 'Boeing 757',
  B763: 'Boeing 767', 'B737-700': 'Boeing 737-700', 'B737-800': 'Boeing 737-800', 'B737-900': 'Boeing 737-900', B77W: 'Boeing 777', B789: 'Boeing 787-9', B788: 'Boeing 787-8', BCS3: 'Airbus A220-300',
};

// City names for ICAO codes (US airports with K codes, plus larger airports worldwide), from the
// public-domain OurAirports data, bundled so nothing is looked up online.
const CITY: Record<string, string> = JSON.parse(readFileSync(new URL('./airports.json', import.meta.url), 'utf8'));

/** "KJNX" → "Smithfield, NC (KJNX)"; well-known airports use their short name ("Boston (KBOS)"). */
export function airport(code?: string): string | undefined {
  if (!code) return undefined;
  const c = code.trim().toUpperCase();
  const name = AIRPORTS[c] ?? IATA[c] ?? CITY[c] ?? (c.length === 3 ? CITY[`K${c}`] : undefined);
  return name ? `${name} (${c})` : c;
}

/** "WN2543" → "Southwest 2543"; leaves unknown callsigns alone. */
export function flightName(flight?: string): string | undefined {
  if (!flight) return undefined;
  const m = flight.match(/^([A-Z0-9]{2})0*(\d{1,4}[A-Z]?)$/);
  if (!m || !AIRLINES[m[1]]) return flight;
  return `${AIRLINES[m[1]]} ${m[2]}`;
}

// 38175 → 38.29 (ddmm.m packed without the decimal point)
function ddmm(s: string, degDigits: number): number {
  const deg = Number(s.slice(0, degDigits));
  const min = Number(s.slice(degDigits)) / 10;
  return deg + min / 60;
}

function utcHhmmToLocal(hhmm: string): string | undefined {
  const m = hhmm.match(/^(\d{2})(\d{2})/);
  if (!m) return undefined;
  const d = new Date();
  d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: process.env.TIMEZONE ?? 'America/New_York' });
}

const fl = (v: string) => (Number(v) ? `${(Number(v) * 100).toLocaleString('en-US')} ft` : undefined);

/** Validates a position; rejects anything outside North America (the only region we expect to hear). */
function pos(lat: number, lon: number): { lat: number; lon: number } | undefined {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
  if (lat < 15 || lat > 72 || lon < -170 || lon > -50) return undefined;
  return { lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000 };
}

/** Altitude field: 3 digits = flight level (350 → FL350), 4–5 digits = feet. */
function altText(v: string): string | undefined {
  const n = Number(v);
  if (!n) return undefined;
  if (v.length <= 3) return `FL${String(n).padStart(3, '0')}`;
  return `${n.toLocaleString('en-US')} ft`;
}

export interface Translation {
  headline: string; // short, plain English
  lat?: number;
  lon?: number;
  /** A run of timed fixes (flight summaries log one a minute): drawn as the plane's trail. utc = "HHMMSS". */
  points?: { lat: number; lon: number; altFt?: number; utc: string }[];
}

/** Returns a plain-English reading, or undefined to drop the message. */
export function translateAcars(label: string | undefined, text: string): Translation | undefined {
  const t = text.trim();

  // Position report: POSN38175W077049,HVNNN,201614,370,BAILZ,202033,PALEO,M55,298029,…
  let m = t.match(/^POSN([NS])?(\d{5})([EW])(\d{6}),([A-Z0-9]{2,5}),(\d{6}),(\d{3}),([A-Z0-9]{2,5}),(\d{6}),([A-Z0-9]{2,5}),([MP])(\d{2}),(\d{3})(\d{2,3})/);
  if (m) {
    const lat = ddmm(m[2], 2);
    const lon = -ddmm(m[4], 3);
    const temp = (m[11] === 'M' ? -1 : 1) * Number(m[12]);
    return {
      headline: `Position report at ${fl(m[7])}: over ${m[5]}, next ${m[8]} then ${m[10]}. Outside air ${temp}°C, wind from ${Number(m[13])}° at ${Number(m[14])} kt.`,
      lat,
      lon,
    };
  }

  // Estimated arrival: ETA RV1637/17/17 YUL 2131Z
  m = t.match(/^ETA\s+\S+\/\d+\/\d+\s+([A-Z]{3,4})\s+(\d{4})Z/);
  if (m) return { headline: `Expects to land at ${airport(m[1])} around ${utcHhmmToLocal(m[2])}.` };

  // Flight summary: ++86501,N8748Q,B7378MAX,261117,WN2543,KFLL,KBWI,…  (also "74302,7878,B737-700,261120,WN4075,KDCA,KPVD,…",
  // sometimes followed by a fix like "N3840.0,W07725.7,201756,…" in degrees + decimal minutes)
  m = t.match(/^(?:\+\+)?\d{4,6},([A-Z0-9]+),([A-Z0-9-]+),\d{6},[A-Z0-9]+,([A-Z]{4}),([A-Z]{4})/);
  if (m && (t.startsWith('++') || label === 'H1')) {
    const reg = /^N\d[0-9A-Z]{1,4}$/.test(m[1]) ? ` ${m[1]}` : '';
    const out: Translation = { headline: `${AIRCRAFT[m[2]] ?? m[2]}${reg}, flying ${airport(m[3])} → ${airport(m[4])}.` };
    // Every timed fix: "N3840.0,W07725.7,201756,17754,…" = position, HHMMSS (UTC), altitude ft.
    const points: NonNullable<Translation['points']> = [];
    for (const f of t.matchAll(/\bN(\d{2})(\d{2}\.\d),W(\d{3})(\d{2}\.\d),(\d{6}),\s*(\d{3,5})?/g)) {
      const p = pos(Number(f[1]) + Number(f[2]) / 60, -(Number(f[3]) + Number(f[4]) / 60));
      const alt = f[6] ? Number(f[6]) : undefined;
      if (p) points.push({ ...p, altFt: alt !== undefined && alt > 0 && alt <= 60_000 ? alt : undefined, utc: f[5] });
    }
    if (points.length) return { ...out, lat: points[points.length - 1].lat, lon: points[points.length - 1].lon, points };
    const f = t.match(/\bN(\d{2})(\d{2}\.\d),W(\d{3})(\d{2}\.\d),/);
    const p = f && pos(Number(f[1]) + Number(f[2]) / 60, -(Number(f[3]) + Number(f[4]) / 60));
    return p ? { ...out, ...p } : out;
  }

  // Flight plan: FPN/RP:DA:KCLT:AA:KPVD:CR:KCLTKPVD(23O)..DANGR.…  (DA = departure, AA = arrival)
  m = t.match(/^FPN\/.*?\bDA:([A-Z]{4}):AA:([A-Z]{4})\b/);
  if (m) return { headline: `Flight plan ${airport(m[1])} → ${airport(m[2])}.` };

  // Progress report: PRG/FNUAL511/DTKORD,28C,92,193819  (DT = destination and landing runway; "O" = no L/R/C suffix)
  m = t.match(/^PRG\/.*?\/DT([A-Z]{4}),(\d{2})([LRCO]?)\b/);
  if (m) return { headline: `Planning to land at ${airport(m[1])}, runway ${m[2]}${m[3] === 'O' ? '' : m[3]}.` };

  if (label === '36') {
    // "400,A,20,201126,163410,N3841.7,W07519.1,350,0118,KMYR,KBDL,KBDL,…" (altitude: 3 digits = flight level, 5 = feet)
    m = t.match(/,N(\d{2})(\d{2}\.\d),W(\d{3})(\d{2}\.\d),(\d{3,5}),[^,]*,([A-Z]{4}),([A-Z]{4}),/);
    const p = m && pos(Number(m[1]) + Number(m[2]) / 60, -(Number(m[3]) + Number(m[4]) / 60));
    if (m && p) return { headline: `Position report at ${altText(m[5])}, flying ${airport(m[6])} → ${airport(m[7])}.`, ...p };
  }

  if (label === '30' || label === '21' || label === '22' || label === '10' || label === '83' || label === '4N') {
    // "182,HG,1815,3,KEWR,N 39.068,W 76.927,,,200" (decimal degrees)
    m = label === '30' ? t.match(/\bN\s(\d{2}\.\d+),W\s(\d{2,3}\.\d+),/) : null;
    if (m) {
      const p = pos(Number(m[1]), -Number(m[2]));
      if (p) return { headline: 'Position report.', ...p };
    }
    // "POSN 39.067W 76.913, 217,171736,32004,26314,  67,-45,191512,KMCO" (decimal degrees, last field is the destination)
    m = label === '21' ? t.match(/^POSN\s(\d{2}\.\d+)W\s(\d{2,3}\.\d+),.*,([A-Z]{4})\s*$/) : null;
    if (m) {
      const p = pos(Number(m[1]), -Number(m[2]));
      if (p) return { headline: `Position report, heading for ${airport(m[3])}.`, ...p };
    }
    // "N 390401W 765446,-------,171736,…" (ddmmss)
    m = label === '22' ? t.match(/^N\s(\d{2})(\d{2})(\d{2})W\s(\d{2,3})(\d{2})(\d{2}),/) : null;
    if (m) {
      const p = pos(Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600, -(Number(m[4]) + Number(m[5]) / 60 + Number(m[6]) / 3600));
      if (p) return { headline: 'Position report.', ...p };
    }
    // "/N39.282/W077.200/10/0.43/204/075/KHEF/1806/…" (decimal degrees, then the destination)
    m = label === '10' ? t.match(/^\/N(\d{2}\.\d+)\/W(\d{3}\.\d+)\/(?:[^/]*\/){4}([A-Z]{4})\//) : null;
    if (m) {
      const p = pos(Number(m[1]), -Number(m[2]));
      if (p) return { headline: `Position report, bound for ${airport(m[3])}.`, ...p };
    }
    // "001PR20171806N3857.2W07527.1400399" (ddmm.m)
    m = label === '83' ? t.match(/^\d{3}PR\d{8}N(\d{2})(\d{2}\.\d)W(\d{3})(\d{2}\.\d)/) : null;
    if (m) {
      const p = pos(Number(m[1]) + Number(m[2]) / 60, -(Number(m[3]) + Number(m[4]) / 60));
      if (p) return { headline: 'Position report.', ...p };
    }
    // "20184N  ABE  ATL1\r\n0091  0088 N039375 W076528   249" (origin, destination, then ddd mm.m)
    // The coordinate encoding here (ddd mm.m or decimal?) isn't certain, so only the route is used, not a map position.
    m = label === '4N' ? t.match(/^\d{4}4N\s+([A-Z]{3})\s+([A-Z]{3})\d?\s/) : null;
    if (m) return { headline: `Route ${airport(m[1])} → ${airport(m[2])}.` };
  }

  // Takeoff report: "OFF02\r\nKDCA,KMCO,1742,21.6" (label 22)
  m = label === '22' ? t.match(/^OFF\d*\s+([A-Z]{4}),([A-Z]{4}),(\d{4}),/) : null;
  if (m) return { headline: `Took off from ${airport(m[1])} for ${airport(m[2])} at ${utcHhmmToLocal(m[3])}.` };

  // Route header: "201724 KBWI KATL6" (24), "20174L KDCA KPIT7" (4L)
  m = label === '24' || label === '4L' ? t.match(/^\d{4}(?:\d{2}|4L)\s+([A-Z]{4})\s+([A-Z]{4})\d?\b/) : null;
  if (m) return { headline: `Route ${airport(m[1])} → ${airport(m[2])}.` };

  // Requests to the airline: "/R3 HOWGOZIT REQ   / KIAD KTPA 20 182552 …", "/B6 LDG DATA REQ   / KRDU KEWR 20 …"
  m = t.match(/^\/\w+\s+HOWGOZIT REQ\s+\/\s+([A-Z]{4})\s+([A-Z]{4})\b/);
  if (m) return { headline: `Asked the airline for a progress update (HOWGOZIT) on the flight ${airport(m[1])} → ${airport(m[2])}.` };
  m = t.match(/^\/\w+\s+LDG DATA REQ\s+\/\s+([A-Z]{4})\s+([A-Z]{4})\b/);
  if (m) return { headline: `Requested landing data for ${airport(m[2])}.` };

  // Weather / ATIS requests: "WX REQ KATL", "/KEWR.TI2/024KEWRA7CDE"
  m = t.match(/^WX\s*REQ\s+([A-Z]{3,4})/);
  if (m) return { headline: `Asked the airline for the weather at ${airport(m[1])}.` };
  m = t.match(/^\/([A-Z]{4})\.TI2\//);
  if (m) return { headline: `Requested the current airport information (ATIS) for ${airport(m[1])}.` };

  // Out/Off/On/In times: "OUT 0902 OFF 0914 …"
  m = t.match(/\bOFF\s*(\d{4})/);
  if (m && /\bOUT\b/.test(t)) return { headline: `Reported takeoff at ${utcHhmmToLocal(m[1])}.` };
  m = t.match(/\bON\s*(\d{4})/);
  if (m && /\bIN\b/.test(t)) return { headline: `Reported landing at ${utcHhmmToLocal(m[1])}.` };

  // SkyWest-style fix: "P,E,2026-11-17 15:34:10,5860,66176,N 38.886 W 077.391,7199,…"
  m = t.match(/N\s?(\d{2}\.\d+)\s+W\s?(\d{3}\.\d+),(\d{3,5})/);
  if (m) return { headline: `Position fix at ${Number(m[3]).toLocaleString('en-US')} ft.`, lat: Number(m[1]), lon: -Number(m[2]) };

  // City pair route: "171539  JFK  PIT3"
  m = t.match(/^\d{6}\s+([A-Z]{3})\s+([A-Z]{3})\d?\b/);
  if (m && IATA[m[1]] && IATA[m[2]]) return { headline: `Route ${airport(m[1])} → ${airport(m[2])}.` };

  // Weather reports and forecasts relayed to the cockpit.
  m = t.match(/\b(METAR|SPECI)\s+([A-Z]{4})\b/);
  if (m) return { headline: `Received the latest weather report for ${airport(m[2])}.` };
  m = t.match(/\bTAF\s+(?:AMD\s+)?([A-Z]{4})\b/);
  if (m) return { headline: `Received the weather forecast for ${airport(m[1])}.` };

  // Departure clearance, load sheet, gate assignment.
  m = t.match(/\b(?:CLRD|CLEARED)\s+TO\s+([A-Z]{3,4})\b/);
  if (m || /\bPDC\b/.test(t)) return { headline: m ? `Received its departure clearance to ${airport(m[1])}.` : 'Received its pre-departure clearance.' };
  if (/LOAD\s?SHEET|\bZFW\b|\bTOW\b.*\bLAW\b/.test(t)) return { headline: 'Received its load sheet (passenger, cargo and fuel weights for takeoff).' };
  m = t.match(/\bGATE\s*:?\s*([A-Z]?\d{1,3}[A-Z]?)\b/);
  if (m) return { headline: `Gate information: gate ${m[1]}.` };

  // Automated maintenance and engine-health reports (MDC, ACMF, CMC, APM…): say what they are, not their contents.
  if (/\b(MDC|ACMF|CMC|APM_REPORT|AHM|FDAMS|FAULT|SNAPSHOT|PN:|FILENAME|ENG(?:INE)?\s+(?:TREND|REPORT)|SWVER)\b/.test(t)) {
    const what = t.match(/REPORT:\s*([A-Z][A-Z ]{3,40})/)?.[1]?.trim().toLowerCase();
    return { headline: `Sent an automated maintenance report to the airline${what ? ` (${what})` : ''}.` };
  }

  // Skip routine acknowledgements and performance telemetry we can't read.
  if (/^(RESREQ|PER\/|REJ|ACK)/.test(t)) return undefined;
  if (label && ['32', '36', '37', '4N', 'H2', 'SA', '_d', 'Q0'].includes(label)) return undefined;
  // Anything else: keep it only if it reads like a sentence (crew/dispatch free text), as a quote.
  const firstLine = t.split('\n').map((l) => l.trim()).find((l) => l && !/^PAGE\s+\d+/i.test(l)) ?? '';
  const words = firstLine.split(/\s+/).filter((w) => /^[A-Za-z']{2,}[.,!?]?$/.test(w));
  const symbols = (firstLine.match(/[^A-Za-z0-9\s.,'!?-]/g) ?? []).length;
  if (words.length < 4 || words.length / firstLine.split(/\s+/).length < 0.6 || symbols > 3) return undefined;
  const quote = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  return { headline: `Text message: "${quote.charAt(0) + quote.slice(1).toLowerCase()}"` };
}

/** Plain-English CPDLC replies and common instructions. */
export function translateCpdlc(words: string[]): string {
  const w = words.join(' ');
  if (/WILCO/.test(w)) return 'Pilot accepted a controller instruction by text ("will comply").';
  if (/UNABLE/.test(w)) return 'Pilot told the controller they can\'t comply.';
  if (/ROGER/.test(w)) return 'Pilot acknowledged a controller message by text.';
  if (/STANDBY/.test(w)) return 'Pilot asked the controller to stand by.';
  if (/CLIMB/.test(w)) return 'Controller sent a climb instruction by text.';
  if (/DESCEND/.test(w)) return 'Controller sent a descent instruction by text.';
  if (/DIRECT|PROCEED/.test(w)) return 'Controller cleared the flight direct to a waypoint.';
  if (/CONTACT|MONITOR/.test(w)) return 'Controller handed the flight to the next frequency.';
  return w ? `Controller–pilot text message: ${w.toLowerCase()}.` : 'Controller–pilot text message.';
}
