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
