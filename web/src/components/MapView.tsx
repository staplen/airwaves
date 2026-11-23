import { memo, useEffect, useRef, useState } from 'react';
import { Map as MlMap, Popup, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent } from 'maplibre-gl';
// MapLibre loads its worker relative to its own module, which breaks once bundled.
// Let Vite bundle the worker (with its shared chunk) and hand MapLibre the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Aircraft, AisFixed, AprsStation, Balloon, FeedItem, Home, Overlays, Snapshot, Tracks, UatStation, Vessel } from '../../../shared/types.ts';
import { apiUrl, isStatic } from '../api.ts';
import { ago } from '../live.ts';
import { sitesFC } from '../sites.ts';
import { timeRange } from './When.tsx';
import { onMapFilter, onMapFocus, positionsChanged, setLocator, type Focus } from '../mapEvents.ts';
import { SITES } from '../../../shared/sites.ts';
import { AGE_OPACITY, TRAIL_COLOR, tracksFC } from '../trails.ts';

const STYLE = 'https://tiles.openfreemap.org/styles/dark';
// Absolute, because the build uses a relative base and the worker must resolve against the page.
setWorkerUrl(new URL(workerUrl, document.baseURI).href);
const RINGS_NM = [10, 20, 30];
const PUBLIC_MAX_ZOOM = 10;
const STALE_S = 30;

type FC = GeoJSON.FeatureCollection;

function planeImage(): ImageData {
  const s = 32;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.translate(s / 2, s / 2);
  g.scale(1.6, 1.6);
  g.fillStyle = '#fff';
  g.beginPath();
  const p = [[0, -8], [2, -2], [9, 1], [9, 3], [2, 1.5], [1.5, 6], [4, 8], [4, 9], [0, 8], [-4, 9], [-4, 8], [-1.5, 6], [-2, 1.5], [-9, 3], [-9, 1], [-2, -2]];
  p.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, s, s);
}

/** Helicopter (emitter category A7): a small body under a two-blade rotor, drawn top-down. */
function heliImage(): ImageData {
  const s = 32;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.translate(s / 2, s / 2);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.beginPath();
  g.ellipse(0, -1, 4, 6, 0, 0, Math.PI * 2);
  g.fill();
  g.fillRect(-1, 4, 2, 10); // tail boom
  g.fillRect(-4, 12, 8, 2); // tail rotor
  g.lineWidth = 2;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(-13, -10);
  g.lineTo(13, 8);
  g.moveTo(13, -10);
  g.lineTo(-13, 8);
  g.stroke();
  return g.getImageData(0, 0, s, s);
}

function shipImage(): ImageData {
  const s = 24;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(12, 2);
  g.lineTo(19, 21);
  g.lineTo(12, 17);
  g.lineTo(5, 21);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, s, s);
}

type NavIcon = 'nav-port' | 'nav-stbd' | 'nav-light' | 'nav-other' | 'nav-station';

/** Chart-style symbols: green can (port hand), red nun (starboard hand), magenta light flare, yellow diamond, shore station mast. */
/** Whether to draw the receiver's antenna icon on the map (off until there's a better icon). */
const SHOW_RECEIVER = false;

/** The receiver: a yagi on a mast with a foot, green over a dark outline, drawn at 2x for a crisp 18 px icon. */
function receiverImage(): ImageData {
  const k = 2;
  const c = document.createElement('canvas');
  c.width = c.height = 24 * k;
  const g = c.getContext('2d')!;
  g.scale(k, k);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const path = () => {
    g.beginPath();
    for (const [x1, y1, x2, y2] of [[8, 9, 8, 21], [4, 9, 20, 9], [11.5, 5, 11.5, 13], [15.5, 6, 15.5, 12], [19.5, 7, 19.5, 11], [5, 21, 11, 21]]) {
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
    }
  };
  path();
  g.strokeStyle = '#0b0e13';
  g.lineWidth = 4.5;
  g.stroke();
  path();
  g.strokeStyle = '#4ade80';
  g.lineWidth = 2;
  g.stroke();
  return g.getImageData(0, 0, c.width, c.height);
}

function navImage(kind: NavIcon): ImageData {
  const s = 24;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.lineJoin = 'round';
  g.strokeStyle = '#0b0e13';
  g.lineWidth = 2;
  g.beginPath();
  if (kind === 'nav-port') {
    g.rect(6, 6, 12, 12);
    g.fillStyle = '#2fbf5b';
  } else if (kind === 'nav-stbd') {
    g.moveTo(12, 4); g.lineTo(20, 19); g.lineTo(4, 19); g.closePath();
    g.fillStyle = '#e5484d';
  } else if (kind === 'nav-light') {
    const pts = [[12, 2], [14, 10], [22, 12], [14, 14], [12, 22], [10, 14], [2, 12], [10, 10]];
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fillStyle = '#d96bd9';
  } else if (kind === 'nav-other') {
    g.moveTo(12, 4); g.lineTo(20, 12); g.lineTo(12, 20); g.lineTo(4, 12); g.closePath();
    g.fillStyle = '#f5b547';
  } else {
    g.fillStyle = 'rgba(0,0,0,0)';
    g.strokeStyle = '#3cc9b4';
    g.lineWidth = 1.8;
    g.moveTo(7, 21); g.lineTo(12, 7); g.lineTo(17, 21); g.moveTo(9, 15); g.lineTo(15, 15);
    g.moveTo(6, 7); g.arc(12, 9, 6, Math.PI * 1.15, Math.PI * 1.85);
  }
  g.fill();
  g.stroke();
  return g.getImageData(0, 0, s, s);
}

function navIcon(f: AisFixed): NavIcon {
  if (f.kind === 'base') return 'nav-station';
  const t = f.aidType ?? '';
  if (/starboard/i.test(t)) return 'nav-stbd';
  if (/port/i.test(t)) return 'nav-port';
  if (/light/i.test(t)) return 'nav-light';
  return 'nav-other';
}

/** Title and plain-English explanation for the details card. */
function navInfo(f: AisFixed): { title: string; what: string } {
  if (f.kind === 'base') return { title: 'AIS shore station', what: 'A fixed AIS transmitter on land that relays ship positions and broadcasts the time.' };
  const icon = navIcon(f);
  const title = f.name ? `Channel marker ${f.name}` : 'Channel marker';
  if (icon === 'nav-stbd') return { title, what: 'Red nun, starboard-hand mark: keep it on your right heading upriver ("red right returning").' };
  if (icon === 'nav-port') return { title, what: 'Green can, port-hand mark: keep it on your left heading upriver.' };
  if (icon === 'nav-light') return { title: f.name ? `Light ${f.name}` : 'Navigation light', what: f.aidType ? `${f.aidType}.` : 'A lit navigation aid.' };
  return { title, what: f.aidType ? `${f.aidType}.` : 'A navigation aid.' };
}

/** Short map label for fixed AIS transmitters: "Marker 5", "Light 3", "AIS station". */
function fixedLabel(f: AisFixed): string {
  if (f.kind === 'base') return 'AIS station';
  const t = f.aidType ?? '';
  const kind = /light/i.test(t) ? 'Light' : /beacon/i.test(t) ? 'Beacon' : /mark|buoy/i.test(t) || !t ? 'Marker' : t;
  return f.name ? `${kind} ${f.name}` : kind;
}

function vesselsFC(list: Vessel[], fixed: AisFixed[], now: number): FC {
  const ships: GeoJSON.Feature[] = list
    .filter((v) => v.lat !== undefined && v.lon !== undefined)
    .map((v) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [v.lon!, v.lat!] },
      properties: { kind: 'ship', label: v.name ?? String(v.mmsi), cog: v.cog ?? 0, stale: now - v.lastSeen > 20 * 60_000 },
    }));
  const aids: GeoJSON.Feature[] = fixed.map((f) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
    properties: { kind: f.kind, label: fixedLabel(f), icon: navIcon(f), title: navInfo(f).title, what: navInfo(f).what, lastSeen: f.lastSeen },
  }));
  return { type: 'FeatureCollection', features: [...ships, ...aids] };
}

function balloonsFC(list: Balloon[]): FC {
  const features: GeoJSON.Feature[] = [];
  const now = Date.now();
  for (const b of list) {
    // Flights stay on the map for two days, fading once they're no longer heard.
    const ageH = (now - b.lastSeen) / 3600_000;
    const op = ageH < 1 ? 1 : ageH < 6 ? 0.55 : ageH < 24 ? 0.3 : 0.15;
    if (b.track.length > 1) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: b.track }, properties: { op } });
    if (ageH >= 6) continue; // old flights: just the track
    const arrow = b.vertMps !== undefined && b.vertMps < 0 ? '↓' : '↑';
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
      properties: { id: `balloon:${b.id}`, op, label: `${b.id} · ${(b.altM / 1000).toFixed(1)} km ${arrow}${b.burst ? ' · burst' : ''}${ageH >= 1 ? ` · ${Math.round(ageH)} h ago` : ''}`, info: JSON.stringify({ ...b, track: undefined }) },
    });
  }
  return { type: 'FeatureCollection', features };
}

const OVERLAY_REFRESH_MS = 5 * 60_000;
const TRACKS_REFRESH_MS = 60_000;
type Layer = 'live' | 'traffic' | 'weather';

const TILE_PX = 200; // broadcast traffic tiles are 200 px squares

/** Traffic tiles laid out in their broadcast grid (row 1 = north) at no more than their own size; missing tiles leave gaps. */
function TrafficGrid({ t, zoom }: { t: NonNullable<Overlays['traffic']>; zoom: number }) {
  // Row/col come from the overlay index, or from the tile name (TMT_<map>_<row>_<col>_...).
  const placed = t.tiles.flatMap((x) => {
    const m = x.url.match(/TMT_[^_]+_(\d+)_(\d+)_/);
    const row = x.row ?? (m ? Number(m[1]) : undefined);
    const col = x.col ?? (m ? Number(m[2]) : undefined);
    return row && col ? [{ url: x.url, row, col }] : [];
  });
  const rows = Math.max(t.rows ?? 3, ...placed.map((x) => x.row));
  const cols = Math.max(t.cols ?? 3, ...placed.map((x) => x.col));
  const bg = t.background ? `rgba(${t.background.join(',')}, 0.12)` : undefined;
  const tile = `calc(min(${TILE_PX}px, (100cqw - 32px) / ${cols}, (100cqh - 64px) / ${rows}) * ${zoom})`;
  return (
    <div className="traffic-grid" style={{ gridTemplateColumns: `repeat(${cols}, ${tile})`, gridTemplateRows: `repeat(${rows}, ${tile})` }}>
      {Array.from({ length: rows * cols }, (_, i) => {
        const row = Math.floor(i / cols) + 1;
        const col = (i % cols) + 1;
        const got = placed.find((x) => x.row === row && x.col === col);
        return got ? (
          <img key={got.url} src={got.url} alt="" draggable={false} style={{ gridRow: row, gridColumn: col }} />
        ) : (
          <div key={`ph-${row}-${col}`} className="traffic-ph" style={{ gridRow: row, gridColumn: col, ...(bg ? { background: bg } : {}) }}>
            <span>not received yet</span>
          </div>
        );
      })}
    </div>
  );
}

/** Received images shown untouched, filling the card; zoom with the buttons, pan by scrolling or dragging. */
function ImagePanel({ render, caption }: { render: (zoom: number) => React.ReactNode; caption: string }) {
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; l: number; t: number }>(null);
  return (
    <div className="layer-panel">
      <div
        ref={box}
        className="layer-scroll"
        onPointerDown={(e) => { const b = box.current!; drag.current = { x: e.clientX, y: e.clientY, l: b.scrollLeft, t: b.scrollTop }; b.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (!d) return; box.current!.scrollLeft = d.l - (e.clientX - d.x); box.current!.scrollTop = d.t - (e.clientY - d.y); }}
        onPointerUp={() => (drag.current = null)}
      >
        {render(zoom)}
      </div>
      <div className="overlay-b">
        <span className="tog muted" style={{ fontSize: 11 }}>{caption}</span>
        <span className="tog" style={{ padding: 0, gap: 0 }}>
          <button type="button" className="zoom-btn" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>−</button>
          <button type="button" className="zoom-btn" aria-label="Zoom in" disabled={zoom >= 5} onClick={() => setZoom((z) => Math.min(5, z * 1.5))}>+</button>
        </span>
      </div>
    </div>
  );
}

function fmtAlt(a: Aircraft): string {
  if (a.altBaro === 'ground') return 'GND';
  if (a.altBaro === undefined) return '';
  const arrow = a.baroRate && a.baroRate < -300 ? ' ▼' : a.baroRate && a.baroRate > 300 ? ' ▲' : '';
  return (a.altBaro >= 18000 ? `FL${Math.round(a.altBaro / 100)}` : a.altBaro.toLocaleString('en-US')) + arrow;
}

function aircraftFC(list: Aircraft[]): FC {
  return {
    type: 'FeatureCollection',
    features: list
      .filter((a) => a.lat !== undefined && a.lon !== undefined)
      .map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lon!, a.lat!] },
        properties: {
          id: a.hex,
          label: a.flight ?? a.reg ?? a.hex,
          alt: fmtAlt(a),
          track: a.track ?? 0,
          stale: a.seen > STALE_S,
          category: a.category ?? '',
          heli: a.category === 'A7',
          state: a.emergency || (a.squawk && EMERGENCY_SQUAWKS.has(a.squawk)) ? 'emergency' : a.military ? 'military' : 'normal',
          info: JSON.stringify(a),
        },
      })),
  };
}

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);
const SQUAWK_MEANING: Record<string, string> = { '7500': 'hijack code', '7600': 'radio failure', '7700': 'emergency' };
const CATEGORY: Record<string, string> = { A1: 'Light aircraft', A2: 'Small aircraft', A3: 'Large aircraft', A4: 'Large, high wake (757)', A5: 'Heavy aircraft', A6: 'High performance', A7: 'Helicopter', B1: 'Glider', B2: 'Balloon', B4: 'Ultralight', B6: 'Drone', C1: 'Airport emergency vehicle', C2: 'Airport service vehicle' };

/** The aircraft's hover card: who and what it is, what it's doing, and how well we hear it. */
function aircraftCard(a: Aircraft): HTMLElement {
  const card = document.createElement('div');
  card.className = 'nav-card';
  const line = (text: string, cls?: string) => {
    const d = document.createElement(cls === 'b' ? 'b' : 'div');
    if (cls && cls !== 'b') d.className = cls;
    d.textContent = text;
    card.append(d);
  };
  line(a.flight ?? a.reg ?? a.hex.toUpperCase(), 'b');
  const what = [a.typeDesc ?? (a.category ? CATEGORY[a.category] : undefined), a.military ? 'military' : undefined].filter(Boolean).join(' · ');
  if (what) line(what);
  const who = [a.reg && a.reg !== a.flight ? a.reg : undefined, a.owner].filter(Boolean).join(' · ');
  if (who) line(who, 'muted');
  if (a.altBaro !== undefined) {
    const alt = a.altBaro === 'ground' ? 'On the ground' : a.altBaro >= 18000 ? `FL${Math.round(a.altBaro / 100)}` : `${a.altBaro.toLocaleString('en-US')} ft`;
    const rate = a.baroRate && Math.abs(a.baroRate) >= 300 ? `, ${a.baroRate > 0 ? 'climbing' : 'descending'} ${Math.abs(Math.round(a.baroRate / 100) * 100).toLocaleString('en-US')} ft/min` : '';
    const sel = a.selAltFt && typeof a.altBaro === 'number' && Math.abs(a.selAltFt - a.altBaro) > 250 ? ` → ${a.selAltFt >= 18000 ? `FL${Math.round(a.selAltFt / 100)}` : `${Math.round(a.selAltFt / 100) * 100} ft`}` : '';
    line(`${alt}${rate}${sel}`);
  }
  const motion = [a.gs !== undefined ? `${Math.round(a.gs)} kt` : undefined, a.track !== undefined ? `heading ${Math.round(a.track)}°` : undefined].filter(Boolean).join(' · ');
  if (motion) line(motion);
  if (a.emergency || (a.squawk && EMERGENCY_SQUAWKS.has(a.squawk))) line(`Squawk ${a.squawk ?? '—'}: ${a.squawk && SQUAWK_MEANING[a.squawk] ? SQUAWK_MEANING[a.squawk] : a.emergency}`, 'alert');
  else if (a.squawk) line(`Squawk ${a.squawk}`, 'muted');
  line([a.via === 'uat' ? 'UAT 978 MHz' : 'ADS-B 1090 MHz', a.rssi !== undefined ? `signal ${Math.round(a.rssi)} dB` : undefined, `heard ${Math.round(a.seen)} s ago`].filter(Boolean).join(' · '), 'muted');
  return card;
}

function aprsFC(list: AprsStation[], nowMs: number): FC {
  return {
    type: 'FeatureCollection',
    features: list
      .filter((st) => st.lat !== undefined && st.lon !== undefined)
      .map((st) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [st.lon!, st.lat!] }, properties: { id: `aprs:${st.call}`, call: st.call, wx: Boolean(st.weather), age: (nowMs - st.lastHeard) / 60_000, info: JSON.stringify(st) } })),
  };
}

function uatStationsFC(list: UatStation[]): FC {
  return { type: 'FeatureCollection', features: list.map((st) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [st.lon, st.lat] }, properties: { id: `uatgs:${st.lat},${st.lon}`, info: JSON.stringify(st) } })) };
}

// Datalink handoffs give only a rough position: drawn as a shaded "somewhere in here" area with a hollow, dashed plane
// in the middle. It fades over APPROX_MAX_MS and is dropped as soon as ADS-B has a live position for the same airframe.
const APPROX_MAX_MS = 20 * 60_000;
const APPROX_COLOR = '#5ab0ff';

/** A ring of `km` around a point, as a closed polygon ring. */
function circleRing(lon: number, lat: number, km: number): [number, number][] {
  const dLat = km / 111.32;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const out: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    out.push([lon + dLon * Math.sin(t), lat + dLat * Math.cos(t)]);
  }
  return out;
}

function approxFC(feed: FeedItem[], aircraft: Aircraft[], nowMs: number): FC {
  const live = new Set(aircraft.filter((a) => a.lat !== undefined && a.lon !== undefined && a.seen <= STALE_S).map((a) => `air:${a.hex}`));
  const done = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const i of [...feed].sort((a, b) => b.ts - a.ts)) {
    if (!i.approxKm || i.lat === undefined || i.lon === undefined) continue;
    const age = Math.max(0, nowMs - i.ts);
    if (age > APPROX_MAX_MS) continue;
    const name = i.title.split(' · ')[0];
    const key = i.ref ?? name;
    if (done.has(key)) continue; // newest report per airframe only
    done.add(key);
    if (i.ref && live.has(i.ref)) continue;
    const op = 1 - 0.7 * (age / APPROX_MAX_MS);
    features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circleRing(i.lon, i.lat, i.approxKm)] }, properties: { op } });
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [i.lon, i.lat] },
      properties: { id: key, op, label: name, sub: [i.altFt ? `~${fmtFt(i.altFt)}` : undefined, ago(i.ts, nowMs)].filter(Boolean).join(' · '), info: JSON.stringify(i) },
    });
  }
  return { type: 'FeatureCollection', features };
}

function approxCard(i: FeedItem): HTMLElement {
  return card([
    [i.title.split(' · ')[0]],
    [`Rough position from a datalink handoff: somewhere within about ${i.approxKm} km of here. Not on ADS-B right now.`],
    [[i.altFt ? `~${fmtFt(i.altFt)}` : undefined, `heard ${fmtTime(i.ts)}`, `${i.meta} MHz`].filter(Boolean).join(' · '), 'muted'],
  ]);
}

/** The plane outline, hollow and dashed, for an aircraft we only roughly know the position of (no heading: points north). */
function ghostPlaneImage(): ImageData {
  const s = 32;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.translate(s / 2, s / 2);
  g.scale(1.6, 1.6);
  g.strokeStyle = APPROX_COLOR;
  g.lineWidth = 1;
  g.lineJoin = 'round';
  g.setLineDash([1.6, 1.2]);
  g.beginPath();
  const p = [[0, -8], [2, -2], [9, 1], [9, 3], [2, 1.5], [1.5, 6], [4, 8], [4, 9], [0, 8], [-4, 9], [-4, 8], [-1.5, 6], [-2, 1.5], [-9, 3], [-9, 1], [-2, -2]];
  p.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.stroke();
  return g.getImageData(0, 0, s, s);
}

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtFt = (ft: number) => (ft >= 18000 ? `FL${Math.round(ft / 100)}` : `${Math.round(ft / 100) * 100} ft`);

function card(lines: [string, string?][]): HTMLElement {
  const c = document.createElement('div');
  c.className = 'nav-card';
  lines.forEach(([text, cls], i) => {
    const d = document.createElement(i === 0 ? 'b' : 'div');
    if (cls) d.className = cls;
    d.textContent = text;
    c.append(d);
  });
  return c;
}

function aprsCard(st: AprsStation): HTMLElement {
  const wx = st.weather;
  const lines: [string, string?][] = [[st.call], [[st.symbol ? st.symbol.charAt(0).toUpperCase() + st.symbol.slice(1) : 'APRS station', st.object ? `placed by ${st.object}` : ''].filter(Boolean).join(' · ')]];
  if (wx) lines.push([[wx.tempF !== undefined ? `${Math.round(wx.tempF)}°F` : '', wx.windMph !== undefined ? `wind ${wx.windMph} mph${wx.gustMph ? ` (gust ${wx.gustMph})` : ''}` : '', wx.humidity !== undefined ? `${wx.humidity}%` : '', wx.pressureMb !== undefined ? `${wx.pressureMb.toFixed(1)} mb` : ''].filter(Boolean).join(' · ')]);
  if (st.speedKt) lines.push([`${Math.round(st.speedKt)} kt${st.course !== undefined ? ` · heading ${st.course}°` : ''}${st.altFt ? ` · ${Math.round(st.altFt).toLocaleString('en-US')} ft` : ''}`]);
  if (st.comment) lines.push([`“${st.comment}”`, 'muted']);
  lines.push([`${st.packets} packet${st.packets === 1 ? '' : 's'}${st.via ? ` · via ${st.via}` : ''} · last heard ${fmtTime(st.lastHeard)} · 144.390 MHz`, 'muted']);
  return card(lines);
}

function ringsFC(home: Home): FC {
  const features: GeoJSON.Feature[] = [];
  for (const nm of RINGS_NM) {
    const dLat = nm / 60;
    const dLon = dLat / Math.cos((home.lat * Math.PI) / 180);
    const coords: [number, number][] = [];
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * 2 * Math.PI;
      coords.push([home.lon + dLon * Math.sin(t), home.lat + dLat * Math.cos(t)]);
    }
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [home.lon, home.lat + dLat] }, properties: { label: `${nm} nm` } });
  }
  features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [home.lon, home.lat] }, properties: { home: true } });
  return { type: 'FeatureCollection', features };
}

// Pulses redraw the whole map, so they run at most this often, and only while the map is on screen and the tab visible.
const PULSE_FRAME_MS = 1000 / 30;

/** Memoised: re-renders when the snapshot changes, not on the app's once-a-second clock. */
/** Event data on our own moves back to the starting view, so they clear the re-center button. */
const HOME_MOVE = { home: true };

export const MapView = memo(function MapView({ snapshot, feed }: { snapshot?: Snapshot; feed: FeedItem[] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap>(null);
  const [ready, setReady] = useState(false);
  const centered = useRef(false);
  // Moved off the starting view (a pan, a zoom, or flying to a feed card's location): offer a way back.
  const [offHome, setOffHome] = useState(false);
  const [overlays, setOverlays] = useState<Overlays>({});
  const [layer, setLayer] = useState<Layer>('live');
  const [tracks, setTracks] = useState<Tracks>();
  const tracksRef = useRef<Tracks>(undefined);
  tracksRef.current = tracks;
  // Trails are always on now (the toggle was cut with the redesign); kept as state so it's easy to bring back.
  const [trails] = useState(true);
  const approx = useRef(false);
  const onScreen = useRef(true);
  const snapRef = useRef<Snapshot | undefined>(snapshot);
  snapRef.current = snapshot;
  const focusUntil = useRef(0); // the highlight ring around a catch shown from the feed

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const io = new IntersectionObserver((es) => (onScreen.current = es[es.length - 1].isIntersecting));
    io.observe(node);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const m = new MlMap({ container: el.current!, style: STYLE, center: [-77.03, 38.9], zoom: 8.6, attributionControl: false });
    map.current = m;
    let pulse = 0;
    // Hover a marker for its card (tap on touch screens): one shared popup, replaced as the pointer moves.
    const hover = new Popup({ closeButton: false, closeOnClick: false, className: 'nav-popup', offset: 10 });
    let shown: unknown;
    const hoverCard = (layer: string, maxWidth: string, build: (e: MapLayerMouseEvent) => { at: [number, number]; card: HTMLElement } | undefined) => {
      const show = (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        const key = f ? `${f.properties?.id ?? f.properties?.title ?? ''}:${JSON.stringify(f.geometry.type === 'Point' ? f.geometry.coordinates : '')}` : undefined;
        if (key === shown) return;
        const r = build(e);
        if (!r) return;
        shown = key;
        hover.setMaxWidth(maxWidth).setLngLat(r.at).setDOMContent(r.card).addTo(m);
      };
      m.on('mousemove', layer, (e) => {
        m.getCanvas().style.cursor = 'pointer';
        show(e);
      });
      m.on('click', layer, show);
      m.on('mouseleave', layer, () => {
        m.getCanvas().style.cursor = '';
        hover.remove();
        shown = undefined;
      });
    };
    // Touch screens never send mouseleave: a tap on empty map closes the card.
    m.on('click', (e) => {
      const layers = ['home', 'aids', 'sites', 'aircraft', 'approx-plane', 'aprs', 'uat-gs', 'balloons', 'trails-hit'].filter((l) => m.getLayer(l));
      if (!m.queryRenderedFeatures(e.point, { layers }).length) {
        hover.remove();
        shown = undefined;
      }
    });
    m.on('load', () => {
      m.addImage('plane', planeImage(), { sdf: true });
      m.addImage('heli', heliImage(), { sdf: true });
      m.addImage('ship', shipImage(), { sdf: true });
      m.addImage('plane-ghost', ghostPlaneImage());
      m.addSource('sea', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('rings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('aircraft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('balloons', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('sites', { type: 'geojson', data: sitesFC(undefined) });
      m.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'trails-line', type: 'line', source: 'trails', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round' }, paint: { 'line-color': TRAIL_COLOR as never, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.2, 11, 2.2], 'line-opacity': AGE_OPACITY as never } });
      m.addLayer({ id: 'trails-dot', type: 'circle', source: 'trails', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 1.8, 'circle-color': TRAIL_COLOR as never, 'circle-opacity': AGE_OPACITY as never } });
      // Invisible, wider copy of the trails so they're easy to hover.
      m.addLayer({ id: 'trails-hit', type: 'line', source: 'trails', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 10 } });
      hoverCard('trails-hit', '280px', (e) => {
        const f = e.features?.[0];
        const tr = f && tracksRef.current?.tracks.find((t) => t.id === f.properties?.id);
        if (!tr || !tr.pts.length) return undefined;
        const alts = tr.pts.map((p) => p[2]).filter((v): v is number => v !== null);
        const first = tr.pts[0][3] * 1000;
        const last = tr.pts[tr.pts.length - 1][3] * 1000;
        const here = Number(f.properties?.alt);
        const lines: [string, string?][] = [[tr.label ?? tr.id.replace(/^\w+:/, '').toUpperCase()]];
        const what = [tr.info?.type, tr.info?.reg && tr.info.reg !== tr.label ? tr.info.reg : undefined].filter(Boolean).join(' · ');
        if (what) lines.push([what]);
        if (tr.info?.owner) lines.push([tr.info.owner, 'muted']);
        lines.push([`Seen ${timeRange(first, last)}${alts.length ? ` · ${fmtFt(Math.min(...alts))}–${fmtFt(Math.max(...alts))}` : ''}`]);
        lines.push([`Here at ${fmtTime(Number(f.properties?.t) * 1000)}${here >= 0 ? `, ${fmtFt(here)}` : ''}`, 'muted']);
        lines.push([`${tr.pts.length} ${tr.pts.length === 1 ? 'point' : 'points'} · from ${(tr.info?.sources ?? [tr.kind === 'dl' ? 'datalink' : tr.kind === 'sea' ? 'AIS' : 'ADS-B']).join(' + ')}`, 'muted']);
        return { at: [e.lngLat.lng, e.lngLat.lat], card: card(lines) };
      });
      // APRS stations (amateur radio): green dots, weather stations amber; UAT ground stations: hollow squares.
      m.addSource('aprs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'aprs', type: 'circle', source: 'aprs', paint: { 'circle-radius': 4, 'circle-color': ['case', ['get', 'wx'], '#f5b547', '#9be35a'], 'circle-stroke-color': '#0b0e13', 'circle-stroke-width': 1, 'circle-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 1, 360, 0.6, 1440, 0.3] } });
      m.addLayer({ id: 'aprs-labels', type: 'symbol', source: 'aprs', minzoom: 10, layout: { 'text-field': ['get', 'call'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#9be35a', 'text-halo-color': '#0b0e13', 'text-halo-width': 1.2 } });
      hoverCard('aprs', '260px', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return undefined;
        return { at: f.geometry.coordinates as [number, number], card: aprsCard(JSON.parse(String(f.properties?.info)) as AprsStation) };
      });
      hoverCard('balloons', '270px', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return undefined;
        const b = JSON.parse(String(f.properties?.info)) as Balloon;
        const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const lines: [string, string?][] = [[`Weather balloon ${b.id}`], [`${b.model ?? 'Radiosonde'} · ${(b.altM / 1000).toFixed(1)} km${b.vertMps !== undefined ? `, ${b.vertMps > 0 ? 'climbing' : 'falling'} ${Math.abs(b.vertMps).toFixed(1)} m/s` : ''}${b.burst ? ' · burst' : ''}`]];
        const r = [b.tempC !== undefined ? `${Math.round(b.tempC)}°C` : '', b.humidity !== undefined ? `${Math.round(b.humidity)}% RH` : '', b.speedKmh !== undefined && b.heading !== undefined ? `drifting ${COMPASS[Math.round(b.heading / 45) % 8]} ${Math.round(b.speedKmh)} km/h` : ''].filter(Boolean).join(' · ');
        if (r) lines.push([r]);
        lines.push([`Peak ${(b.maxAltM / 1000).toFixed(1)} km${b.minTempC !== undefined ? ` · coldest ${Math.round(b.minTempC)}°C` : ''}`, 'muted']);
        lines.push([[b.freqMhz ? `${b.freqMhz.toFixed(3)} MHz` : '', b.sats !== undefined ? `${b.sats} GPS sats` : '', b.battV !== undefined ? `battery ${b.battV.toFixed(1)} V` : '', `last heard ${fmtTime(b.lastSeen)}`].filter(Boolean).join(' · '), 'muted']);
        return { at: f.geometry.coordinates as [number, number], card: card(lines) };
      });
      m.addSource('uat-gs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'uat-gs', type: 'circle', source: 'uat-gs', paint: { 'circle-radius': 5, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#5ab0ff', 'circle-stroke-width': 1.5 } });
      hoverCard('uat-gs', '240px', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return undefined;
        const st = JSON.parse(String(f.properties?.info)) as UatStation;
        return { at: f.geometry.coordinates as [number, number], card: card([['UAT ground station'], ['FIS-B weather and flight information broadcasts on 978 MHz'], [`${st.frames.toLocaleString('en-US')} ${st.frames === 1 ? 'frame' : 'frames'} heard · last ${fmtTime(st.lastHeard)}`, 'muted']]) };
      });
      m.addLayer({ id: 'rings', type: 'line', source: 'rings', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#3a4659', 'line-width': 1, 'line-dasharray': [2, 3] } });
      m.addLayer({ id: 'ring-labels', type: 'symbol', source: 'rings', filter: ['has', 'label'], layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, -0.8] }, paint: { 'text-color': '#8b93a1' } });
      // The receiver: a static antenna icon (its foot on the point), labelled once zoomed in like the transmitter sites.
      m.addImage('receiver', receiverImage(), { pixelRatio: 2 });
      m.addLayer({
        id: 'home',
        type: 'symbol',
        source: 'rings',
        filter: ['has', 'home'],
        // Hidden for now: the antenna icon doesn't read well and there's no replacement yet. Flip SHOW_RECEIVER to bring it back.
        layout: { visibility: SHOW_RECEIVER ? 'visible' : 'none', 'icon-image': 'receiver', 'icon-size': 0.75, 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'text-field': ['step', ['zoom'], '', 9, 'Receiver'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, 0.3], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#4ade80', 'text-halo-color': '#0b0e13', 'text-halo-width': 1.2 },
      });
      (['nav-port', 'nav-stbd', 'nav-light', 'nav-other', 'nav-station'] as const).forEach((k) => m.addImage(k, navImage(k), { pixelRatio: 1.5 }));
      m.addLayer({ id: 'aids', type: 'symbol', source: 'sea', filter: ['!=', ['get', 'kind'], 'ship'], layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true } });
      // Click a marker for a small card: what it is, which side of the channel, and where the data came from.
      hoverCard('aids', '240px', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return undefined;
        const p = f.properties as { title: string; what: string; lastSeen: number; kind: string };
        const card = document.createElement('div');
        card.className = 'nav-card';
        const h = document.createElement('b');
        h.textContent = p.title;
        const what = document.createElement('div');
        what.textContent = p.what;
        const src = document.createElement('div');
        src.className = 'muted';
        src.textContent = `Source: ${p.kind === 'base' ? 'its own AIS broadcast' : 'AIS aid-to-navigation broadcast'} · last heard ${ago(Number(p.lastSeen), Date.now())}`;
        card.append(h, what, src);
        return { at: f.geometry.coordinates as [number, number], card };
      });
      m.addLayer({ id: 'aid-labels', type: 'symbol', source: 'sea', filter: ['!=', ['get', 'kind'], 'ship'], layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 7, 9, 11, 11], 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-optional': true }, paint: { 'text-color': '#c9cfd8', 'text-halo-color': '#0b0e13', 'text-halo-width': 1.2 } });
      m.addLayer({
        id: 'ships',
        type: 'symbol',
        source: 'sea',
        filter: ['==', ['get', 'kind'], 'ship'],
        layout: { 'icon-image': 'ship', 'icon-size': 0.7, 'icon-rotate': ['get', 'cog'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [1.1, 0], 'text-anchor': 'left', 'text-optional': true },
        paint: { 'icon-color': '#3cc9b4', 'icon-opacity': ['case', ['get', 'stale'], 0.4, 1], 'text-color': '#3cc9b4', 'text-halo-color': '#0b0e13', 'text-halo-width': 1.2 },
      });
      m.addLayer({ id: 'balloon-tracks', type: 'line', source: 'balloons', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#f5b547', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': ['get', 'op'] } });
      m.addLayer({ id: 'balloons', type: 'circle', source: 'balloons', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-opacity': ['get', 'op'], 'circle-radius': 6, 'circle-color': '#f5b547', 'circle-stroke-color': '#0b0e13', 'circle-stroke-width': 1.5 } });
      m.addLayer({ id: 'balloon-labels', type: 'symbol', source: 'balloons', filter: ['==', ['geometry-type'], 'Point'], layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0.9, 0], 'text-anchor': 'left' }, paint: { 'text-color': '#f5b547', 'text-halo-color': '#0b0e13', 'text-halo-width': 1.2 } });
      // Transmitter sites: muted dots, pulsing while their frequency is on air.
      m.addLayer({ id: 'site-pulse', type: 'circle', source: 'sites', filter: ['==', ['get', 'on'], true], paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-opacity': 0.3, 'circle-radius-transition': { duration: 0 }, 'circle-opacity-transition': { duration: 0 } } });
      m.addLayer({
        id: 'sites',
        type: 'circle',
        source: 'sites',
        filter: ['!', ['has', 'pulseOnly']],
        paint: {
          'circle-radius': ['case', ['get', 'on'], 5.5, 4],
          'circle-color': ['get', 'color'],
          'circle-opacity': ['case', ['get', 'on'], 1, 0.6],
          'circle-stroke-color': '#0b0e13',
          'circle-stroke-width': 1.2,
        },
      });
      m.addLayer({
        id: 'site-labels',
        type: 'symbol',
        source: 'sites',
        filter: ['!', ['has', 'pulseOnly']],
        layout: { 'text-field': ['step', ['zoom'], ['get', 'label'], 9, ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': ['get', 'color'], 'text-opacity': ['case', ['get', 'on'], 1, 0.6], 'text-halo-color': '#0b0e13', 'text-halo-width': 1.2 },
      });
      hoverCard('aircraft', '260px', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return undefined;
        return { at: f.geometry.coordinates as [number, number], card: aircraftCard(JSON.parse(String(f.properties?.info)) as Aircraft) };
      });
      hoverCard('home', '240px', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return undefined;
        const near = approx.current;
        return { at: f.geometry.coordinates as [number, number], card: card([['Receiver'], [near ? 'The antenna is near here, not at this exact spot.' : 'Where the antenna is.', 'muted']]) };
      });
      hoverCard('sites', '260px', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return undefined;
        const p = f.properties as { name: string; note: string; channels: string };
        const card = document.createElement('div');
        card.className = 'nav-card';
        const h = document.createElement('b');
        h.textContent = p.name;
        card.append(h);
        for (const c of JSON.parse(p.channels) as { label: string; freq?: number; on: boolean }[]) {
          const row = document.createElement('div');
          row.textContent = `${c.label}${c.freq ? ` · ${c.freq.toFixed(c.freq < 140 && c.freq > 108 ? 3 : 1)} MHz` : ''}${c.on ? ' · on air' : ''}`;
          card.append(row);
        }
        if (p.note) {
          const n = document.createElement('div');
          n.className = 'muted';
          n.textContent = p.note;
          card.append(n);
        }
        return { at: f.geometry.coordinates as [number, number], card };
      });
      m.addLayer({
        id: 'aircraft',
        type: 'symbol',
        source: 'aircraft',
        layout: {
          'icon-image': ['case', ['get', 'heli'], 'heli', 'plane'],
          // Size by emitter category: light aircraft small, heavies big.
          'icon-size': ['match', ['get', 'category'], 'A1', 0.6, 'A2', 0.7, 'A3', 0.8, 'A4', 0.9, 'A5', 1.0, 'A6', 0.75, 'A7', 0.75, 0.75],
          'icon-rotate': ['get', 'track'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'text-field': ['format', ['get', 'label'], {}, '\n', {}, ['get', 'alt'], { 'font-scale': 0.85 }],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-anchor': 'left',
          'text-offset': [1.3, 0],
          'text-justify': 'left',
          'text-optional': true,
        },
        paint: {
          'icon-color': ['match', ['get', 'state'], 'emergency', '#ff5a5a', 'military', '#d8c66a', '#5ab0ff'],
          'icon-opacity': ['case', ['get', 'stale'], 0.35, 1],
          'text-color': '#e6e9ee',
          'text-opacity': ['case', ['get', 'stale'], 0.45, 1],
          'text-halo-color': '#0b0e13',
          'text-halo-width': 1.2,
        },
      });
      // Aircraft we only roughly know the position of (datalink handoffs), under the live ones.
      m.addSource('approx', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'approx-area', type: 'fill', source: 'approx', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': APPROX_COLOR, 'fill-opacity': ['*', 0.09, ['get', 'op']] } }, 'aircraft');
      m.addLayer({ id: 'approx-edge', type: 'line', source: 'approx', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': APPROX_COLOR, 'line-width': 1, 'line-dasharray': [2, 3], 'line-opacity': ['*', 0.45, ['get', 'op']] } }, 'aircraft');
      m.addLayer(
        {
          id: 'approx-plane',
          type: 'symbol',
          source: 'approx',
          filter: ['==', ['geometry-type'], 'Point'],
          layout: { 'icon-image': 'plane-ghost', 'icon-size': 0.8, 'icon-allow-overlap': true, 'text-field': ['format', ['get', 'label'], {}, '\n', {}, ['get', 'sub'], { 'font-scale': 0.85 }], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-anchor': 'left', 'text-offset': [1.3, 0], 'text-justify': 'left', 'text-optional': true },
          paint: { 'icon-opacity': ['get', 'op'], 'text-color': APPROX_COLOR, 'text-opacity': ['get', 'op'], 'text-halo-color': '#0b0e13', 'text-halo-width': 1.2 },
        },
        'aircraft',
      );
      hoverCard('approx-plane', '260px', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return undefined;
        return { at: f.geometry.coordinates as [number, number], card: approxCard(JSON.parse(String(f.properties?.info)) as FeedItem) };
      });
      // Highlight ring for "show on the map" from a feed card (animated in the pulse loop below).
      m.addSource('focus', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'focus-ring', type: 'circle', source: 'focus', paint: { 'circle-radius': 14, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#e6e9ee', 'circle-stroke-width': 2, 'circle-stroke-opacity': 0.9 } });
      setReady(true);
      // Subtle pulse on the listening dot: the halo grows and fades every 2.4 s.
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        let lastFrame = 0;
        const tick = (t: number) => {
          pulse = requestAnimationFrame(tick);
          if (!onScreen.current || document.hidden || t - lastFrame < PULSE_FRAME_MS) return;
          lastFrame = t;
          if (focusUntil.current) {
            const left = focusUntil.current - Date.now();
            if (left <= 0) {
              focusUntil.current = 0;
              (m.getSource('focus') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
            } else if (m.getLayer('focus-ring')) {
              const k = (t % 1200) / 1200;
              m.setPaintProperty('focus-ring', 'circle-radius', 10 + 14 * k);
              m.setPaintProperty('focus-ring', 'circle-stroke-opacity', Math.min(1, left / 1500) * (1 - k * 0.6));
            }
          }
          if (m.getLayer('site-pulse')) {
            const q = (t % 1800) / 1800;
            m.setPaintProperty('site-pulse', 'circle-radius', 5 + 13 * q);
            m.setPaintProperty('site-pulse', 'circle-opacity', 0.45 * (1 - q));
          }
        };
        pulse = requestAnimationFrame(tick);
      }
    });
    return () => {
      cancelAnimationFrame(pulse);
      m.remove();
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !snapshot) return;
    (m.getSource('aircraft') as GeoJSONSource).setData(aircraftFC(snapshot.aircraft));
    (m.getSource('balloons') as GeoJSONSource).setData(balloonsFC(snapshot.balloons ?? []));
    (m.getSource('sea') as GeoJSONSource).setData(vesselsFC(snapshot.vessels, snapshot.aisFixed, snapshot.now));
    (m.getSource('sites') as GeoJSONSource).setData(sitesFC(snapshot));
    (m.getSource('aprs') as GeoJSONSource | undefined)?.setData(aprsFC(snapshot.aprs ?? [], snapshot.now));
    (m.getSource('uat-gs') as GeoJSONSource | undefined)?.setData(uatStationsFC(snapshot.uatStations ?? []));
    if (snapshot.home) {
      (m.getSource('rings') as GeoJSONSource).setData(ringsFC(snapshot.home));
      if (snapshot.home.approx && !approx.current) {
        // Public site: the point is a stand-in a few km off (a chosen landmark, or snapped and shifted), so say so
        // and stop zooming in before streets would make it look exact.
        approx.current = true;
        m.setMaxZoom(PUBLIC_MAX_ZOOM);
      }
      if (!centered.current) {
        centered.current = true;
        m.jumpTo({ center: [snapshot.home.lon, snapshot.home.lat], zoom: 8.6 }, HOME_MOVE);
      }
    }
  }, [ready, snapshot]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(apiUrl('overlays') + (isStatic ? `?t=${Date.now()}` : ''))
        .then((r) => (r.ok ? (r.json() as Promise<Overlays>) : {}))
        .catch(() => ({}) as Overlays)
        .then((o) => alive && setOverlays(o));
    load();
    const t = setInterval(load, OVERLAY_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(apiUrl('tracks') + (isStatic ? `?t=${Date.now()}` : ''))
        .then((r) => (r.ok ? (r.json() as Promise<Tracks>) : undefined))
        .catch(() => undefined)
        .then((t) => alive && t && setTracks(t));
    load();
    const t = setInterval(load, TRACKS_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Rough datalink positions: redrawn as the feed and live aircraft change, and every 30 s so they keep fading.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const draw = () => (m.getSource('approx') as GeoJSONSource | undefined)?.setData(approxFC(feed, snapRef.current?.aircraft ?? [], Date.now()));
    draw();
    const t = setInterval(draw, 30_000);
    return () => clearInterval(t);
  }, [ready, snapshot, feed]);

  // Redraw contrails when new tracks arrive, and every minute so they keep fading.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const draw = () => (m.getSource('trails') as GeoJSONSource | undefined)?.setData(tracksFC(trails ? tracks : undefined));
    draw();
    const t = setInterval(draw, 60_000);
    return () => clearInterval(t);
  }, [ready, tracks, trails]);

  // "Show on the map" from a feed card: fly to the object (its live position if it's still on the map) and ring it;
  // from a bundle, fit the map around every place in it and ring each one.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    // Where a card's target is: the live object, else where the card says it happened, else the end of its trail.
    const where = (f: Focus): { at: [number, number]; roughKm?: number } | undefined => {
      const snap = snapRef.current;
      const [kind, key] = (f.ref ?? '').split(/:(.*)/s);
      let at: [number, number] | undefined;
      if (kind === 'air') {
        const a = snap?.aircraft.find((x) => x.hex === key);
        if (a?.lat !== undefined && a.lon !== undefined) at = [a.lon, a.lat];
      } else if (kind === 'sea') {
        const v = snap?.vessels.find((x) => String(x.mmsi) === key);
        if (v?.lat !== undefined && v.lon !== undefined) at = [v.lon, v.lat];
      } else if (kind === 'aprs') {
        const st = snap?.aprs?.find((x) => x.call === key);
        if (st?.lat !== undefined && st.lon !== undefined) at = [st.lon, st.lat];
      } else if (kind === 'balloon') {
        const b = snap?.balloons?.find((x) => x.id === key);
        if (b) at = [b.lon, b.lat];
      } else if (kind === 'site') {
        const st = SITES.find((x) => x.id === key);
        if (st) at = [st.lon, st.lat];
      }
      if (at) return { at };
      // Where the card says: for a rough position (datalink handoff), the area it could be in.
      if (f.lat !== undefined && f.lon !== undefined) return { at: [f.lon, f.lat], roughKm: f.approxKm };
      if (f.ref) {
        const last = tracksRef.current?.tracks.find((t) => t.id === f.ref)?.pts.at(-1);
        if (last) return { at: [last[0], last[1]] };
      }
      return undefined;
    };
    const find = (f: Focus) => where(f)?.at;
    setLocator(find);
    const off = onMapFocus((fs) => {
      const seen = new Set<string>();
      const hits = fs.map(where).filter((h): h is NonNullable<typeof h> => {
        const k = h && `${h.at[0].toFixed(4)},${h.at[1].toFixed(4)}`;
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const pts = hits.map((h) => h.at);
      if (pts.length === 0) return;
      setLayer('live');
      el.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (pts.length === 1 && !hits[0].roughKm) {
        m.flyTo({ center: pts[0], zoom: Math.min(m.getMaxZoom(), Math.max(m.getZoom(), 10)), duration: 900 }, { focus: true });
      } else {
        // Fit every place, and the whole of any rough area (not zoomed in on a centre that's only a guess).
        const corners = hits.flatMap((h) => (h.roughKm ? circleRing(h.at[0], h.at[1], h.roughKm) : [h.at]));
        const lons = corners.map((p) => p[0]);
        const lats = corners.map((p) => p[1]);
        m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 56, maxZoom: Math.min(m.getMaxZoom(), 12), duration: 900 }, { focus: true });
      }
      (m.getSource('focus') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pts.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } })) });
      focusUntil.current = Date.now() + 8000;
    });
    return () => {
      off();
      setLocator(null);
    };
  }, [ready]);

  // New positions or trails: cards re-check whether their pin has anywhere to go.
  useEffect(() => {
    if (ready) positionsChanged();
  }, [ready, snapshot, tracks]);

  // Feed filtered to some types: dim the map layers of the other families (the trails and sites per feature).
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const LAYER_FAMILY: Record<string, string> = { aircraft: 'air', 'approx-area': 'air', 'approx-edge': 'air', 'approx-plane': 'air', 'uat-gs': 'air', ships: 'sea', aids: 'sea', 'aid-labels': 'sea', balloons: 'wx', 'balloon-tracks': 'wx', 'balloon-labels': 'wx', aprs: 'ham', 'aprs-labels': 'ham' };
    const PER_FEATURE: Record<string, unknown> = {
      'trails-line': ['match', ['get', 'kind'], 'sea', 'sea', 'ham', 'ham', 'air'],
      'trails-dot': ['match', ['get', 'kind'], 'sea', 'sea', 'ham', 'ham', 'air'],
      sites: ['match', ['get', 'kind'], 'atc', 'air', 'fm', 'bcast', 'nws', 'wx', 'ais', 'sea', 'bcast'],
      'site-labels': ['match', ['get', 'kind'], 'atc', 'air', 'fm', 'bcast', 'nws', 'wx', 'ais', 'sea', 'bcast'],
    };
    const PROPS: Record<string, string[]> = { fill: ['fill-opacity'], circle: ['circle-opacity', 'circle-stroke-opacity'], symbol: ['icon-opacity', 'text-opacity'], line: ['line-opacity'] };
    const DIM = 0.12;
    const original = new Map<string, unknown>();
    return onMapFilter((fams) => {
      for (const id of [...Object.keys(LAYER_FAMILY), ...Object.keys(PER_FEATURE)]) {
        const type = m.getLayer(id)?.type;
        if (!type) continue;
        for (const prop of PROPS[type] ?? []) {
          const key = `${id}|${prop}`;
          if (!original.has(key)) original.set(key, m.getPaintProperty(id, prop as never) ?? 1);
          const orig = original.get(key);
          let value: unknown = orig;
          if (fams) {
            if (LAYER_FAMILY[id]) value = fams.includes(LAYER_FAMILY[id] as never) ? orig : ['*', orig, DIM];
            else value = ['*', orig, ['case', ['in', PER_FEATURE[id], ['literal', fams]], 1, DIM]];
          }
          m.setPaintProperty(id, prop as never, value as never);
        }
      }
    });
  }, [ready]);

  // Weather tab: the broadcast radar drawn on the live map at its own coverage box, with the box outlined.
  const radar = overlays.radar;
  const radarKey = radar ? `${radar.url}|${radar.bounds.join(',')}` : '';
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const show = layer === 'weather' && radar !== undefined;
    const drop = () => {
      for (const id of ['radar-img', 'radar-box']) if (m.getLayer(id)) m.removeLayer(id);
      for (const id of ['radar-img', 'radar-box']) if (m.getSource(id)) m.removeSource(id);
    };
    drop();
    if (!show || !radar) return;
    const [w, s, e, n] = radar.bounds;
    const before = m.getLayer('trails-line') ? 'trails-line' : undefined;
    m.addSource('radar-box', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[w, n], [e, n], [e, s], [w, s], [w, n]] } } });
    m.addLayer({ id: 'radar-box', type: 'line', source: 'radar-box', paint: { 'line-color': '#f5b547', 'line-opacity': 0.5, 'line-width': 1, 'line-dasharray': [3, 3] } }, before);
    if (!radar.empty) {
      m.addSource('radar-img', { type: 'image', url: new URL(radar.url, document.baseURI).href, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
      m.addLayer({ id: 'radar-img', type: 'raster', source: 'radar-img', paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 } }, 'radar-box');
    }
    return drop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, layer, radarKey, radar?.empty]);
  // Opening the Weather tab zooms out to the radar's coverage; leaving it goes back to the local view.
  const prevLayer = useRef<Layer>('live');
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    if (layer === 'weather' && prevLayer.current !== 'weather' && radar) {
      const [w, s, e, n] = radar.bounds;
      m.fitBounds([[w, s], [e, n]], { padding: 24, duration: 600 }, HOME_MOVE);
    } else if (layer !== 'weather' && prevLayer.current === 'weather') {
      m.easeTo({ ...homeView(), duration: 600 }, HOME_MOVE);
    }
    prevLayer.current = layer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, layer]);

  // Starting view: the receiver's area, or on the Weather tab the radar's coverage.
  const homeView = () => ({ center: (snapRef.current?.home ? [snapRef.current.home.lon, snapRef.current.home.lat] : [-77.03, 38.9]) as [number, number], zoom: 8.6 });
  const recenter = () => {
    const m = map.current;
    if (!m) return;
    if (layer === 'weather' && radar) {
      const [w, s, e, n] = radar.bounds;
      m.fitBounds([[w, s], [e, n]], { padding: 24, duration: 600 }, HOME_MOVE);
    } else m.easeTo({ ...homeView(), duration: 600 }, HOME_MOVE);
  };
  // Button zooms count as moving off the starting view, like a scroll or pinch does.
  const zoomBy = (dir: 1 | -1) => {
    const m = map.current;
    if (!m) return;
    if (dir > 0) m.zoomIn({ duration: 300 }, { focus: true });
    else m.zoomOut({ duration: 300 }, { focus: true });
  };
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    // Off the starting view: the viewer dragging, pinching or scrolling (an originalEvent), or a feed card's flyTo.
    // Resizes and our own returns home (HOME_MOVE) move the camera too, but don't count.
    const isHome = (e: object) => (e as { home?: boolean }).home === true;
    const start = (e: object) => {
      const ev = e as { originalEvent?: unknown; focus?: boolean };
      if (ev.originalEvent || ev.focus) setOffHome(true);
    };
    const end = (e: object) => {
      if (isHome(e)) setOffHome(false);
    };
    m.on('movestart', start);
    m.on('moveend', end);
    return () => {
      m.off('movestart', start);
      m.off('moveend', end);
    };
  }, [ready]);

  const now = snapshot?.now ?? Date.now();
  const adsb = snapshot?.sources.find((s) => s.id === 'adsb');

  const tabs: { id: Layer; label: string; at?: number }[] = [
    { id: 'live', label: 'Live' },
    { id: 'traffic', label: 'Traffic', at: overlays.traffic?.updatedAt },
    { id: 'weather', label: 'Weather', at: overlays.radar?.updatedAt },
  ];
  const short = (ts: number) => ago(ts, now).replace(/ ago$/, '').replace(' min', 'm').replace(' h', 'h').replace(' s', 's');

  return (
    <section className="card mapcard" aria-label="Map">
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      <div className="layer-tabs" role="tablist" aria-label="Map layers">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={layer === t.id} className={`layer-tab${layer === t.id ? ' on' : ''}${t.id !== 'live' && !t.at ? ' none' : ''}`} onClick={() => setLayer(t.id)}>
            {t.label}
            {t.id !== 'live' && <span className="layer-age">{t.at ? short(t.at) : '—'}</span>}
          </button>
        ))}
      </div>
      {layer === 'live' && adsb?.error && (
        <div className="overlay-warn">
          <span className="tog" style={{ color: 'var(--wx)' }}>
            Receiver unreachable{adsb.lastHeard ? ` · last heard ${ago(adsb.lastHeard, now)}` : ''}
          </span>
        </div>
      )}
      {layer !== 'traffic' && (
        <div className="overlay-b">
          {/* Zoom always; Re-center joins the group once the view has moved off the starting view. */}
          <span className="tog map-view" role="group" aria-label="Map view">
            <button type="button" className="zoom-btn" aria-label="Zoom out" onClick={() => zoomBy(-1)}>−</button>
            <button type="button" className="zoom-btn" aria-label="Zoom in" onClick={() => zoomBy(1)}>+</button>
            {offHome && (
              <button type="button" className="zoom-btn recenter" onClick={recenter} title={layer === 'weather' ? 'Back to the radar area' : 'Back to the starting view'}>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="7" cy="7" r="1.4" fill="currentColor" /><path d="M7 .8v2.2M7 11v2.2M.8 7h2.2M11 7h2.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                Re-center
              </button>
            )}
          </span>
        </div>
      )}
      {layer !== 'traffic' && (
        // Map credits (required by OpenStreetMap's licence): faint, always there, in the map's bottom-right corner.
        <span className="map-credits">
          <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>
          <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a>
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>
        </span>
      )}
      {layer === 'traffic' &&
        (overlays.traffic ? (
          <ImagePanel caption={`Traffic map from HD Radio · received ${ago(overlays.traffic.updatedAt, now)}${overlays.traffic.tiles.length < (overlays.traffic.rows ?? 3) * (overlays.traffic.cols ?? 3) ? ` · ${overlays.traffic.tiles.length} of ${(overlays.traffic.rows ?? 3) * (overlays.traffic.cols ?? 3)} tiles so far` : ''}`} render={(z) => <TrafficGrid t={overlays.traffic!} zoom={z} />} />
        ) : (
          <div className="layer-panel layer-empty"><b>No traffic map received yet</b><span className="muted">Traffic maps come in over HD Radio during the HD Radio slot and are kept for 90 minutes.</span></div>
        ))}
      {layer === 'weather' && (
        <div className="overlay-b">
          <div className="tog" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2, maxWidth: 420 }}>
            {radar ? (
              <>
                <b style={{ fontSize: 12 }}>{radar.empty ? 'No rain or snow on the latest radar' : 'Weather radar'}</b>
                <span className="muted" style={{ fontSize: 11 }}>
                  From HD Radio · received {ago(radar.updatedAt, now)}
                  {radar.empty ? ' · the dashed box is the area it covers' : ''}
                </span>
              </>
            ) : (
              <>
                <b style={{ fontSize: 12 }}>No radar image in the last 45 minutes</b>
                <span className="muted" style={{ fontSize: 11 }}>Radar comes in over HD Radio during the deep HD Radio pass, about every half hour.</span>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
});
