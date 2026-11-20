import type { AprsStation } from '../../shared/types.ts';

// Plain-English feed text for APRS (ham radio position reporting on 144.39 MHz). Each packet says who sent it,
// what kind of station it is (a map symbol), maybe a position, readings and a free-text comment full of codes.
// This turns that into one readable line, keeps the codes out, and explains what the station is for.

const MOVING = new Set(['car', 'jeep', 'truck', 'van', 'motorcycle', 'bike', 'person', 'RV', 'bus', 'semi truck', 'rover', 'snowmobile', 'tractor', 'horse', 'boat', 'yacht', 'canoe']);

/** What kind of station this is, in words. */
function role(st: AprsStation): string {
  const s = st.symbol ?? '';
  if (s === 'digipeater') return 'A relay station that re-broadcasts ham radio reports so they travel farther';
  if (s === 'iGate') return 'A ham radio station that passes reports heard over the air on to the internet';
  if (s === 'weather station') return 'A home weather station reporting over ham radio';
  if (s === 'house') return "A ham radio operator's home station";
  if (s === 'balloon') return 'A high-altitude balloon carrying a ham radio tracker';
  if (s === 'aircraft' || s === 'large aircraft' || s === 'helicopter' || s === 'glider') return `A ${s} with a ham radio tracker`;
  if (MOVING.has(s)) return `A ham radio operator on the move (${s})`;
  if (s === 'EOC' || s === 'incident command' || s === 'shelter' || s === 'aid station') return `An emergency-communications post (${s})`;
  if (s) return `A ham radio station (${s})`;
  return 'A ham radio station';
}

/** Repeater "objects" are named after their frequency: "146.955-" = listen on 146.955 MHz, transmit 600 kHz lower. */
function repeater(st: AprsStation): string | undefined {
  const m = /^(\d{3}\.\d{2,3})([+-])?$/.exec(st.call);
  if (!m) return undefined;
  const c = st.comment ?? '';
  const parts = [`Voice repeater on ${m[1]} MHz${m[2] ? ` (radios transmit ${m[2] === '-' ? 'lower' : 'higher'}, listen here)` : ''}`];
  const tone = /\b[TC](\d{3})\b/.exec(c);
  if (tone && tone[1] !== '000') parts.push(`needs a ${Number(tone[1]) / (tone[1].length === 3 && Number(tone[1]) > 300 ? 10 : 1)} Hz access tone`);
  const range = /\bR(\d{1,3})([mk])\b/.exec(c);
  if (range) parts.push(`reaches about ${range[1]} ${range[2] === 'k' ? 'km' : 'miles'}`);
  const net = /\bNET\s?(\d{1,2})(\d{2})\s?(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.exec(c);
  if (net) parts.push(`weekly on-air meeting ${net[3]} ${net[1]}:${net[2]} PM`);
  if (st.object) parts.push(`announced by ${st.object}`);
  return `${parts.join(' · ')}.`;
}

/** The comment, minus machine codes (PHG power/antenna codes, tones, battery noise); undefined if nothing readable is left. */
export function readableComment(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const t = c
    .replace(/\bPHG\d{4,5}\/?/g, '')
    .replace(/\b(RNG|DFS)\d{4}\b/g, '')
    .replace(/\b[TC]\d{3}\b|\bR\d{1,3}[mk]\b/g, '')
    .replace(/![wW][^!]{2}!/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const words = t.match(/[A-Za-z]{3,}/g) ?? [];
  return words.length >= 2 ? t : undefined;
}

export function weatherLine(wx: NonNullable<AprsStation['weather']>): string {
  return [
    wx.tempF !== undefined ? `${Math.round(wx.tempF)}°F` : '',
    wx.windMph !== undefined ? (wx.windMph === 0 ? 'calm' : `wind ${wx.windMph} mph${wx.gustMph ? `, gusting ${wx.gustMph}` : ''}`) : '',
    wx.humidity !== undefined ? `${wx.humidity}% humidity` : '',
    wx.pressureMb !== undefined ? `pressure ${wx.pressureMb.toFixed(0)} mb` : '',
    wx.rainLastHourIn ? `${wx.rainLastHourIn} in of rain in the last hour` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Feed title and body for a station heard for the first time today. */
export function describeAprs(st: AprsStation): { title: string; body: string } {
  const rep = repeater(st);
  if (rep) return { title: `Repeater ${st.call.replace(/[+-]$/, '')} MHz`, body: rep };
  const parts = [role(st)];
  if (st.weather) parts.push(weatherLine(st.weather));
  if (st.speedKt) parts.push(`${Math.round(st.speedKt * 1.15)} mph${st.course !== undefined ? ` heading ${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(st.course / 45) % 8]}` : ''}`);
  if (st.altFt && st.altFt > 1000) parts.push(`at ${Math.round(st.altFt).toLocaleString('en-US')} ft`);
  if (st.object) parts.push(`map marker placed by ${st.object}`);
  const note = readableComment(st.comment);
  if (note) parts.push(`says “${note}”`);
  if (st.via) parts.push(`heard through relay ${st.via}`);
  return { title: st.call, body: `${parts.join(' · ')}.` };
}
