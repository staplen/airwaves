import type { Aircraft, Home, WwtCandidate } from '../../shared/types.ts';

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

/** A very rough range from signal strength (dBFS): about 0.5 nm at −3, 5 nm at −23. Only used without a position. */
export function rangeFromRssi(rssi: number): number {
  return Math.min(20, Math.max(0.3, 0.5 * 10 ** ((-3 - rssi) / 20)));
}

export function kindOf(a: Pick<Aircraft, 'category' | 'military'>): string {
  const k = (a.category && KINDS[a.category]) || 'aircraft';
  return a.military ? `military ${k}` : k;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Scores every aircraft for a tap at `tapAt`; best first. */
export function rankCandidates(aircraft: Aircraft[], home: Home, tapAt: number, now: number): WwtCandidate[] {
  const from = Math.min(tapAt - LOOKBACK_MS, now);
  const out: WwtCandidate[] = [];
  for (const a of aircraft) {
    if (a.altBaro === 'ground' || a.seen > MAX_FIX_AGE_S) continue;
    const alt0 = typeof a.altBaro === 'number' ? Math.max(0, a.altBaro) : undefined;
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
  const what = [c.typeDesc ?? (c.flight || c.reg ? undefined : `unknown ${c.kind}`), c.owner, c.flight && c.flight !== c.reg ? `flight ${c.flight}` : c.reg].filter(Boolean);
  const where = [
    c.altFt !== undefined ? `${c.altFt.toLocaleString('en-US')} feet` : undefined,
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
];

/** "United States Army" → "Army", "American Airlines Inc" → "American"; long private owners (trusts, banks, leasing) → nothing. */
export function shortOwner(owner: string | undefined): string | undefined {
  if (!owner) return undefined;
  if (/\b(united states|u\.?s\.?a?|us)\b/i.test(owner) || /\bguard\b/i.test(owner)) {
    for (const [re, name] of BRANCHES) if (re.test(owner)) return name;
  }
  if (/\b(trust|trustee|bank|leasing|holdings|capital|services)\b/i.test(owner)) return undefined;
  let o = owner.replace(/[.,]/g, '').trim();
  for (let k = 0; k < 3; k++) o = o.replace(/\s+(inc|llc|corp|corporation|co|ltd|lp|company|na)$/i, '');
  o = o.replace(/\s+(air ?lines|airways)$/i, '');
  return o && o.split(/\s+/).length <= 3 ? o : undefined;
}

/** "Sikorsky UH-60 Black Hawk" → "Black Hawk", "Airbus A-321" → "A321", "Boeing 737-800" → "Boeing 737". */
export function shortModel(typeDesc: string | undefined): string | undefined {
  if (!typeDesc) return undefined;
  const words = typeDesc.trim().split(/\s+/);
  const i = words.findIndex((w) => /\d/.test(w));
  if (i < 0) return words.length > 1 ? words.slice(1).join(' ') : words[0];
  const tail = words.slice(i + 1);
  if (tail.length && tail.every((w) => /^[A-Za-z]+$/.test(w)) && !/^(ER|LR|XWB|MAX|NEO|II|III|IV)$/i.test(tail[0])) return tail.join(' ');
  const model = words[i].replace(/^(\d+)-\d+.*$/, '$1').replace(/^([A-Z])-(\d)/, '$1$2');
  return /^\d/.test(model) && i > 0 ? `${words.slice(0, i).join(' ')} ${model}` : model;
}

const SAY_KIND = new Set(['helicopter', 'light plane', 'small plane', 'glider', 'balloon', 'ultralight', 'drone']);
const article = (s: string) => (/^[aeiou]/i.test(s) ? 'an' : 'a');

export function altWords(ft: number | undefined): string | undefined {
  if (ft === undefined) return undefined;
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

/** What it is, briefly: "Army Black Hawk helicopter", "American A321", "small plane". */
export function shortName(c: WwtCandidate): string {
  const owner = shortOwner(c.owner);
  const name = [owner, shortModel(c.typeDesc)].filter(Boolean).join(' ');
  // "military" is implied by a named service; airliner and jet go without saying once there's a model.
  const kind = BRANCHES.some(([, b]) => b === owner) ? c.kind.replace(/^military /, '') : c.kind;
  if (!name) return kind === 'aircraft' ? 'an aircraft' : `${article(kind)} ${kind}`;
  return SAY_KIND.has(kind.replace(/^military /, '')) ? `${name} ${kind}` : name;
}

/** The clauses of the short form, without a lead-in or full stop. */
export function speakBare(c: WwtCandidate): string {
  return [shortName(c), altWords(c.altFt), whereWords(c)].filter(Boolean).join(', ');
}

const cap = (s: string) => s.replace(/^./, (x) => x.toUpperCase());

/** The short spoken answer. `maybe` when another close aircraft scores nearly as well. */
export function speak(c: WwtCandidate, maybe = false): string {
  const bare = speakBare(c);
  if (!maybe) return `${cap(bare)}.`;
  return /^(a|an) /.test(bare) ? `Maybe ${bare}.` : `Maybe ${article(bare)} ${bare}.`;
}
