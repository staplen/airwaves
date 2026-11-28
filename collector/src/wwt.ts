import type { Aircraft, Home, WwtCandidate } from '../../shared/types.ts';
import { isSdrDown } from '../../shared/sdr.ts';
import { aircraftName, modelNumberWords } from './aircraftNames.ts';

// "What was that?": given the aircraft on the air and the moment you looked up, rank what's most
// likely to be the thing you saw or heard. Low and close beats everything else.
//
// Each aircraft's last fix is projected along its track (ground speed, heading, climb rate) over the
// window from a little before the tap until now, and scored at its closest point to the house. That
// covers both the plane that already went by (the tap comes late) and one heard while still coming.
// Aircraft that send altitude but no position (common for military and police helicopters) are
// placed by signal strength alone: rough, but a very strong signal means close.

const LOOKBACK_MS = 30_000; // you notice, then reach for the phone
const STEP_MS = 2000;
const MAX_FIX_AGE_S = 60; // older fixes are too stale to project
const FT_PER_NM = 6076;
const MI_PER_NM = 1.15078;
const ALT_PENALTY_FT_PER_NM = 5000; // every 5,000 ft of height counts like another nautical mile away
export const CLOSE_NM = 6; // beyond this (slant) it's unlikely to be what you saw or heard
export const FIRM_MI = 2.3; // (2 nm) this close with a position: answer straight away, without waiting for the rest to decode

const KINDS: Record<string, string> = {
  A1: 'light plane',
  A2: 'small plane',
  A3: 'airliner',
  A4: 'large jet',
  A5: 'heavy jet',
  A6: 'fast jet',
  A7: 'helicopter',
  B1: 'glider',
  B2: 'balloon',
  B4: 'ultralight',
  B6: 'drone',
};

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const SHORT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compassIndex = (deg: number) => Math.round((((deg % 360) + 360) % 360) / 45) % 8;

const rad = (d: number) => (d * Math.PI) / 180;

/** Moves a point `nm` nautical miles along `trackDeg` (flat-earth: fine over a few miles). */
function move(lat: number, lon: number, trackDeg: number, nm: number): [number, number] {
  const dLat = (nm * Math.cos(rad(trackDeg))) / 60;
  const dLon = (nm * Math.sin(rad(trackDeg))) / (60 * Math.cos(rad(lat)));
  return [lat + dLat, lon + dLon];
}

/** Ground distance (nm) and bearing (degrees from the house) of a point. */
function fromHome(home: Home, lat: number, lon: number): { nm: number; bearing: number } {
  const dy = (lat - home.lat) * 60;
  const dx = (lon - home.lon) * 60 * Math.cos(rad(home.lat));
  return { nm: Math.hypot(dx, dy), bearing: (Math.atan2(dx, dy) * 180) / Math.PI };
}

// Signal strength (dBFS) against straight-line distance (nm), from three days of this receiver's own
// positioned aircraft (Nov 2026, attic TV antenna): about −18 within a mile, −27 at 2–5 nm, −33 past 5 nm.
// Thin data close in (a handful of samples) and a wide spread, so it's only a rough guide.
const RSSI_CURVE: [number, number][] = [
  [-15, 0.3],
  [-18, 0.6],
  [-21, 1.2],
  [-27, 3],
  [-33, 8],
  [-36, 20],
];

/** A very rough range (nm) from signal strength, only used for aircraft that send no position. */
export function rangeFromRssi(rssi: number): number {
  if (rssi >= RSSI_CURVE[0][0]) return RSSI_CURVE[0][1];
  for (let k = 1; k < RSSI_CURVE.length; k++) {
    const [r1, d1] = RSSI_CURVE[k - 1];
    const [r2, d2] = RSSI_CURVE[k];
    if (rssi >= r2) return Math.exp(Math.log(d1) + ((rssi - r1) / (r2 - r1)) * (Math.log(d2) - Math.log(d1)));
  }
  return RSSI_CURVE[RSSI_CURVE.length - 1][1];
}

// Helicopter type codes, for helicopters that don't send an emitter category.
const HELICOPTER_TYPES = /^(H60|H64|H47|H46|H53S?|H500|H269|EC\d\d|AS(32|50|55|65)|A1[0-3]9|A169|B06|B2[0-3]\d|B4[0-2]\d|B505|S76|S92|R22|R44|R66|MD[56]\d|UH1|EN[24]8)$/;

export function kindOf(a: Pick<Aircraft, 'category' | 'military' | 'type'>): string {
  const k = (a.category && KINDS[a.category]) || (a.type && HELICOPTER_TYPES.test(a.type) ? 'helicopter' : 'aircraft');
  return a.military ? `military ${k}` : k;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

// ---- true height ----------------------------------------------------------------------------------
// readsb's alt_baro is pressure altitude (standard pressure assumed): on a high-pressure day it reads
// hundreds of feet low. GPS altitude is above the WGS84 ellipsoid, which around DC sits about 33 m
// (108 ft) below sea level. So: sea-level altitude = GPS + geoid offset, or failing that, pressure
// altitude corrected with the local altimeter setting (any nearby aircraft's will do).

export interface HeightOptions {
  elevFt?: number; // ground elevation at the house (HOME_ELEV_FT): heights become "above you"
  geoidFt?: number; // sea level above the ellipsoid here (GEOID_FT); about 108 ft around DC
}
export const DEFAULT_GEOID_FT = 108;
const FT_PER_HPA = 27.3; // near sea level

/** The local altimeter setting (hPa): the middle value of what nearby crews have set, if any. */
export function localQnh(aircraft: Aircraft[]): number | undefined {
  const q = aircraft.map((a) => a.qnh).filter((v): v is number => v !== undefined && v > 940 && v < 1060).sort((x, y) => x - y);
  return q.length ? q[Math.floor(q.length / 2)] : undefined;
}

/** Best estimate of an aircraft's altitude above sea level (ft). */
export function seaLevelAltFt(a: Aircraft, geoidFt = DEFAULT_GEOID_FT, qnh?: number): number | undefined {
  if (a.altGeom !== undefined) return a.altGeom + geoidFt;
  if (typeof a.altBaro !== 'number') return undefined;
  const setting = a.qnh ?? qnh;
  return setting ? a.altBaro + (setting - 1013.25) * FT_PER_HPA : a.altBaro;
}

/** Scores every aircraft for a tap at `tapAt`; best first. */
export function rankCandidates(aircraft: Aircraft[], home: Home, tapAt: number, now: number, opts: HeightOptions = {}): WwtCandidate[] {
  const from = Math.min(tapAt - LOOKBACK_MS, now);
  const qnh = localQnh(aircraft);
  const altRef = opts.elevFt !== undefined ? 'home' : 'msl';
  const out: WwtCandidate[] = [];
  for (const a of aircraft) {
    if (a.altBaro === 'ground' || a.seen > MAX_FIX_AGE_S) continue;
    // Height above the house (or sea level, without HOME_ELEV_FT); this is what scores and what's said.
    const msl = seaLevelAltFt(a, opts.geoidFt, qnh);
    const alt0 = msl === undefined ? undefined : Math.max(0, msl - (opts.elevFt ?? 0));
    const fixAt = now - a.seen * 1000;
    if (a.lat !== undefined && a.lon !== undefined) {
      // Walk the window and keep the closest point (by score) to the house.
      let best: { score: number; slant: number; ground: number; bearing: number; alt?: number; t: number } | undefined;
      for (let t = from; t <= now; t += STEP_MS) {
        const dtS = (t - fixAt) / 1000;
        const [lat, lon] = a.gs && a.track !== undefined ? move(a.lat, a.lon, a.track, (a.gs * dtS) / 3600) : [a.lat, a.lon];
        const alt = alt0 === undefined ? undefined : Math.max(0, alt0 + ((a.baroRate ?? 0) * dtS) / 60);
        const g = fromHome(home, lat, lon);
        const slant = Math.hypot(g.nm, (alt ?? 0) / FT_PER_NM);
        const score = slant + (alt ?? 3000) / ALT_PENALTY_FT_PER_NM; // unknown height: assume middling
        if (!best || score < best.score) best = { score, slant, ground: g.nm, bearing: g.bearing, alt, t };
      }
      if (!best) continue;
      out.push({
        ...ident(a),
        positioned: true,
        altFt: best.alt === undefined ? undefined : Math.round(best.alt / 50) * 50,
        altRef,
        groundMi: round1(best.ground * MI_PER_NM),
        slantMi: round1(best.slant * MI_PER_NM),
        bearing: best.ground < 0.15 ? undefined : SHORT[compassIndex(best.bearing)],
        heading: a.track === undefined ? undefined : SHORT[compassIndex(a.track)],
        closestAt: best.t,
        close: best.slant <= CLOSE_NM,
        score: Math.round(best.score * 100) / 100,
      });
    } else if (a.rssi !== undefined && a.seen < 30) {
      const slant = rangeFromRssi(a.rssi);
      out.push({
        ...ident(a),
        positioned: false,
        altFt: alt0 === undefined ? undefined : Math.round(alt0 / 50) * 50,
        altRef,
        slantMi: round1(slant * MI_PER_NM),
        rssi: a.rssi,
        heading: a.track === undefined ? undefined : SHORT[compassIndex(a.track)],
        close: slant <= CLOSE_NM && (alt0 === undefined || alt0 < 10_000),
        score: Math.round((slant + (alt0 ?? 3000) / ALT_PENALTY_FT_PER_NM) * 100) / 100,
      });
    }
  }
  return out.sort((x, y) => x.score - y.score);
}

function ident(a: Aircraft) {
  return {
    hex: a.hex,
    typeCode: a.type,
    flight: a.flight,
    reg: a.reg,
    typeDesc: a.typeDesc,
    owner: a.owner,
    kind: kindOf(a),
    military: a.military,
    emergency: a.emergency,
  };
}

const dirWord = (s: string | undefined) => (s ? COMPASS[SHORT.indexOf(s)] : undefined);
const miles = (x: number) => `${x < 1 ? x.toFixed(1) : Math.round(x * 10) / 10} ${x === 1 ? 'mile' : 'miles'}`;

/** One sentence to show or speak, e.g. "Probably a helicopter: Sikorsky UH-60 Black Hawk, US Army, 900 feet, 0.6 miles northeast, heading southeast." */
export function describe(c: WwtCandidate, lead = true): string {
  const nick = aircraftName(c.typeCode, c.typeDesc, c.military)?.nick;
  const type = c.typeDesc && nick && !c.typeDesc.toLowerCase().includes(nick.toLowerCase()) ? `${c.typeDesc} ("${nick}")` : c.typeDesc;
  const what = [type ?? (c.flight || c.reg ? undefined : `unknown ${c.kind}`), c.owner, c.flight && c.flight !== c.reg ? `flight ${c.flight}` : c.reg].filter(Boolean);
  const where = [
    c.altFt !== undefined ? `${c.altFt.toLocaleString('en-US')} feet${c.altRef === 'home' ? ' above you' : ''}` : undefined,
    c.positioned
      ? c.groundMi !== undefined && c.groundMi >= 0.2
        ? `${miles(c.groundMi)} ${dirWord(c.bearing) ?? 'away'}`
        : 'right overhead'
      : `no position sent, signal says about ${miles(c.slantMi)} away`,
    c.heading ? `heading ${dirWord(c.heading)}` : undefined,
  ].filter(Boolean);
  const head = lead ? `${c.close ? 'Probably' : 'Nothing close. Nearest is'} ${/^[aeiou]/.test(c.kind) ? 'an' : 'a'} ${c.kind}` : c.kind;
  return `${head}${what.length ? `: ${what.join(', ')}` : ''}. ${where.join(', ')}.`.replace(/^./, (x) => x.toUpperCase());
}

// ---- short spoken form ------------------------------------------------------------------------------
// For a voice assistant: about three seconds, e.g. "Army Black Hawk helicopter, under 1,000 feet, just north."

const BRANCHES: [RegExp, string][] = [
  [/\barmy\b/i, 'Army'],
  [/\bnavy\b/i, 'Navy'],
  [/\bair force\b/i, 'Air Force'],
  [/\bmarine/i, 'Marines'],
  [/\bcoast guard\b/i, 'Coast Guard'],
  [/\bnational guard\b/i, 'National Guard'],
  [/\bpark police\b/i, 'Park Police'],
  [/\bcustoms\b/i, 'Customs and Border Protection'],
];
const KNOWN_OPERATORS: [RegExp, string][] = [
  [/^united parcel service/i, 'UPS'],
  [/^federal express/i, 'FedEx'],
  [/^net ?jets?\b/i, 'NetJets'],
  [/^jet ?blue/i, 'JetBlue'],
  [/^amazon/i, 'Amazon Air'],
];
// Public operators worth naming even off an airline callsign (police, medevac, county, state).
const PUBLIC_OPERATOR = /\b(police|sheriff|county|state of|commonwealth|fire|rescue|medical|medevac|health|hospital|civil air patrol)\b/i;

/**
 * The owner as said aloud: "United States Army" → "Army", "American Airlines Inc" → "American". Only for
 * military and public operators, or when the plane is flying an airline callsign (`flight` like "AAL1234").
 * Private owners (often a shell company, sometimes a person's name) are left out.
 */
export function shortOwner(owner: string | undefined, flight?: string): string | undefined {
  if (!owner) return undefined;
  if (/\b(united states|u\.?s\.?a?|us)\b/i.test(owner) || /\bguard\b/i.test(owner)) {
    for (const [re, name] of BRANCHES) if (re.test(owner)) return name;
  }
  const airline = flight !== undefined && /^[A-Z]{3}\d/.test(flight.trim());
  if (!airline && !PUBLIC_OPERATOR.test(owner)) return undefined;
  for (const [re, name] of KNOWN_OPERATORS) if (re.test(owner)) return name;
  // Shell and leasing names ("Cu III", "Aircol 12", "Sunrise Asset Management") aren't worth saying.
  if (/\d|\b(I{2,3}|IV|VI{0,3})\b/.test(owner) || /\b(trust|trustee|bank|leasing|holdings|capital|asset|management|enterprises|properties|investments)\b/i.test(owner)) return undefined;
  let o = owner.replace(/[.,]/g, '').trim();
  for (let k = 0; k < 3; k++) o = o.replace(/\s+(inc|llc|corp|corporation|co|ltd|lp|company|na|sales|group|partners)$/i, '');
  o = o.replace(/\s+(air ?lines|airways|aviation)$/i, '');
  return o && o.split(/\s+/).length <= 3 ? o : undefined;
}

/** "Sikorsky UH-60 Black Hawk" → "Black Hawk", "Airbus A-321" → "A321", "Boeing 737-800" → "Boeing 737". */
export function shortModel(typeDesc: string | undefined): string | undefined {
  if (!typeDesc) return undefined;
  const words = typeDesc.trim().split(/\s+/);
  const i = words.findIndex((w) => /\d/.test(w));
  if (i < 0) return words.length > 1 ? words.slice(1).join(' ') : words[0];
  const tail = words.slice(i + 1);
  // A name after the model ("UH-60 Black Hawk", "BD-100 Challenger 350") is what people say.
  if (tail.length && /^[A-Za-z]{3,}$/.test(tail[0]) && !/^(MAX|NEO|XWB)$/i.test(tail[0])) return tail.join(' ').replace(/(^|\s)(\d{3})(?=$|\s)/g, (_, sp: string, n: string) => `${sp}${modelNumberWords(Number(n))}`);
  const maker = words.slice(0, i).join(' ');
  // "Airbus A-319" → "Airbus 319": spoken the way people say it (Siri reads "A319" as "a 319"). Same for Embraer E-175.
  const lettered = words[i].match(/^([A-Z])-?(\d{3})/);
  if (lettered && maker && maker[0].toUpperCase() === lettered[1]) return `${maker} ${modelNumberWords(Number(lettered[2]))}`;
  const model = words[i].replace(/^(\d+)-\d+.*$/, '$1').replace(/^([A-Z])-(\d)/, '$1$2');
  const out = /^\d/.test(model) && i > 0 ? `${maker} ${model}` : model;
  return out.replace(/(^|\s)(\d{3})(?=$|\s)/g, (_, sp: string, n: string) => `${sp}${modelNumberWords(Number(n))}`); // "Bell 429" → "Bell four-twenty-nine"
}

const SAY_KIND = new Set(['helicopter', 'glider', 'balloon', 'ultralight', 'drone']); // worth saying next to a model name (plane size isn't)
const article = (s: string) => (/^[aeiou]/i.test(s) ? 'an' : 'a');

export function altWords(ft: number | undefined, ref: WwtCandidate['altRef'] = 'msl'): string | undefined {
  if (ft === undefined) return undefined;
  if (ref === 'home') {
    // Height above you: precise enough to matter down low ("about 650 feet above you").
    if (ft < 100) return 'under 100 feet above you';
    const step = ft < 2000 ? 50 : ft < 18_000 ? 500 : 1000;
    return `about ${(Math.round(ft / step) * step).toLocaleString('en-US')} feet above you`;
  }
  if (ft < 1000) return 'under 1,000 feet';
  if (ft < 18_000) return `about ${(Math.round(ft / 500) * 500).toLocaleString('en-US')} feet`;
  return `${(Math.round(ft / 1000) * 1000).toLocaleString('en-US')} feet`;
}

function whereWords(c: WwtCandidate): string {
  if (!c.positioned) return c.close ? 'no position, but close' : 'no position';
  const d = c.groundMi ?? 0;
  const dir = dirWord(c.bearing) ?? '';
  if (d < 0.3 || !dir) return 'overhead';
  if (d < 0.7) return `just ${dir}`;
  if (d < 1.5) return `a mile ${dir}`;
  return `${Math.round(d)} miles ${dir}`;
}

// Civil helicopters are named by who flies them, not who built them: "Airbus H135" means little out loud, while
// "medevac helicopter" says what it is. (The written card still has the model.) Military ones keep their names.
const MEDEVAC_OWNER = /\b(emerg(ency)?\.? med|medevac|med ?flight|life ?(line|flight|net|star|guard)|metro aviation|phi\b|air methods|medstar|care ?flight|air evac|hospital|health|medical)/i;
const NEWS_OWNER = /\b(television|broadcast(ing)?|tv|news)\b/i;
const SMALL_HELICOPTERS = new Set(['R22', 'R44', 'R66', 'B06', 'B505', 'MD52', 'MD60', 'H269', 'H500', 'EN28', 'EN48']);
const PLACE_FIXES: [RegExp, string][] = [[/\bGeorges\b/, "George's"], [/\bAnne Arundel\b/i, 'Anne Arundel']];

/** "a medevac helicopter", "a Prince George's police helicopter", "a small helicopter" (owner as in the database). */
export function helicopterRole(owner: string | undefined, typeCode: string | undefined): string {
  if (owner) {
    if (MEDEVAC_OWNER.test(owner)) return 'a medevac helicopter';
    if (/\bpark police\b/i.test(owner)) return 'a Park Police helicopter';
    if (/\bstate police\b|^state of maryland\b|^maryland state\b/i.test(owner)) return 'a State Police helicopter';
    const county = owner.match(/^(.+?)\s+county\b/i); // around here, county helicopters are police aviation units
    if (county) {
      let place = county[1].toLowerCase().replace(/\b[a-z]/g, (x) => x.toUpperCase());
      for (const [re, fix] of PLACE_FIXES) place = place.replace(re, fix);
      return `a ${place} police helicopter`;
    }
    if (/\b(police|sheriff)\b/i.test(owner)) return 'a police helicopter';
    if (NEWS_OWNER.test(owner)) return 'a news helicopter';
  }
  return SMALL_HELICOPTERS.has(typeCode ?? '') ? 'a small helicopter' : 'a helicopter';
}

/** What it is, briefly: "Army Black Hawk helicopter", "a medevac helicopter", "American A321", "small plane". */
export function shortName(c: WwtCandidate): string {
  if (c.kind === 'helicopter') return helicopterRole(c.owner, c.typeCode); // civil ("military helicopter" otherwise)
  const owner = shortOwner(c.owner, c.flight);
  const model = aircraftName(c.typeCode, c.typeDesc, c.military)?.say ?? shortModel(c.typeDesc);
  const name = [owner, model].filter(Boolean).join(' ');
  if (!model) {
    // Nothing better than the kind: "a military helicopter", "Prince Georges County helicopter".
    if (owner) return `${owner} ${c.kind.replace(/^military /, '')}`;
    return c.kind === 'aircraft' ? 'an aircraft' : `${article(c.kind)} ${c.kind}`;
  }
  const kind = c.kind.replace(/^military /, ''); // a named model or service already says enough
  return SAY_KIND.has(kind) ? `${name} ${kind}` : name;
}

/** The clauses of the short form, without a lead-in or full stop. */
export function speakBare(c: WwtCandidate): string {
  return [shortName(c), altWords(c.altFt, c.altRef), whereWords(c)].filter(Boolean).join(', ');
}

const cap = (s: string) => s.replace(/^./, (x) => x.toUpperCase());

/** The short spoken answer. `maybe` when another close aircraft scores nearly as well. */
export function speak(c: WwtCandidate, maybe = false): string {
  const bare = speakBare(c);
  if (!maybe) return `${cap(bare)}.`;
  return /^(a|an) /.test(bare) ? `Maybe ${bare}.` : `Maybe ${article(bare)} ${bare}.`;
}

// ---- receiver health ----------------------------------------------------------------------------
export interface ReceiverHealth {
  rotating: boolean; // the scheduler is sharing the dongle between slots
  sdrHung?: boolean; // the scheduler has concluded the dongle is hung (and paused the loop)
  failures?: Record<string, { at: number; reason: string }>; // scheduler's last failure per slot
  adsbLastHeard?: number; // last new ADS-B message
  adsbLastOk: number; // last successful read of readsb's output
  adsbLastError?: string;
}

/**
 * Why the receiver looks offline right now, or undefined if it looks fine. `since`: last heard; `at`: when it
 * failed; `certain`: no need to wait for this tap's own attempt (the scheduler says so, or Ultrafeeder is down).
 */
export function receiverDown(h: ReceiverHealth, now: number): { since?: number; at: number; reason: string; certain: boolean } | undefined {
  if (!h.rotating) {
    // Ultrafeeder runs all the time: it's down if it hasn't answered for a while.
    return h.adsbLastError && now - h.adsbLastOk > 30_000 ? { since: h.adsbLastHeard, at: h.adsbLastOk, reason: h.adsbLastError, certain: true } : undefined;
  }
  if (h.sdrHung) return { since: h.adsbLastHeard, at: now, reason: 'the dongle stopped sending data', certain: true };
  // Rotating: the newest dongle failure from any slot, if nothing has come in on ADS-B since.
  const hung = Object.values(h.failures ?? {})
    .filter((f) => isSdrDown(f.reason))
    .sort((a, b) => b.at - a.at)[0];
  return hung && hung.at > (h.adsbLastHeard ?? 0) ? { since: h.adsbLastHeard, at: hung.at, reason: hung.reason, certain: false } : undefined;
}

export type RadioGate =
  | { kind: 'offline'; since?: number; recheck: boolean } // say it's offline (recheck: the scheduler is checking again)
  | { kind: 'failed'; reason: string } // the slot this tap asked for failed for some other reason
  | { kind: 'tuning'; say: string }
  | { kind: 'gave-up' } // the radio never came on and nothing explains why
  | { kind: 'on' }; // aircraft data is coming in: go on to rank what's overhead

/**
 * Can "what was that?" answer from the aircraft data yet? Health comes before the data: readsb on a hung dongle
 * keeps writing fresh files (with no aircraft) until it gives up, so fresh files alone aren't proof the radio works.
 * Only messages decoded since the tap (`streaming`) are.
 */
export function radioGate(i: { at: number; now: number; fresh: boolean; streaming: boolean; health: ReceiverHealth; giveUpMs: number }): RadioGate {
  const { at, now, health } = i;
  const down = i.streaming ? undefined : receiverDown(health, now);
  if (down) {
    // The scheduler says it's hung (the tap still makes it check again), or it failed after the tap, or time's up.
    if (down.certain || down.at >= at || now - at > i.giveUpMs) return { kind: 'offline', since: down.since, recheck: down.certain && health.rotating };
    return { kind: 'tuning', say: 'The receiver looked offline earlier. Trying anyway.' }; // a replug since would bring it back
  }
  if (i.fresh) return { kind: 'on' };
  const ownTry = health.failures?.adsb; // the aircraft slot this tap asked for, if it has already failed
  if (ownTry && ownTry.at >= at) return { kind: 'failed', reason: ownTry.reason };
  if (now - at > i.giveUpMs) return { kind: 'gave-up' };
  return { kind: 'tuning', say: 'Tuning in.' };
}

/** "The receiver is offline. Nothing heard since 12:37 PM." (short, for a voice assistant) */
export function offlineWords(since: number | undefined, now: number, timeZone = 'America/New_York'): string {
  if (!since) return 'The receiver is offline.';
  const t = new Date(since).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone });
  return `The receiver is offline. Nothing heard since ${day(since) === day(now) ? t : `${t} ${new Date(since).toLocaleDateString('en-US', { weekday: 'long', timeZone })}`}.`;
}
