import { useEffect, useRef, useState } from 'react';
import { Map as MlMap, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
// MapLibre loads its worker relative to its own module, which breaks once bundled.
// Let Vite bundle the worker (with its shared chunk) and hand MapLibre the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Aircraft, AisFixed, Balloon, Home, Overlays, Snapshot, Vessel } from '../../../shared/types.ts';
import { apiUrl, isStatic } from '../api.ts';
import { ago } from '../live.ts';

const STYLE = 'https://tiles.openfreemap.org/styles/dark';
// Absolute, because the build uses a relative base and the worker must resolve against the page.
setWorkerUrl(new URL(workerUrl, document.baseURI).href);
const RINGS_NM = [10, 20, 30];
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
    properties: { kind: f.kind, label: fixedLabel(f) },
  }));
  return { type: 'FeatureCollection', features: [...ships, ...aids] };
}

function balloonsFC(list: Balloon[]): FC {
  const features: GeoJSON.Feature[] = [];
  for (const b of list) {
    if (b.track.length > 1) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: b.track }, properties: {} });
    const arrow = b.vertMps !== undefined && b.vertMps < 0 ? '↓' : '↑';
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
      properties: { label: `${b.id} · ${(b.altM / 1000).toFixed(1)} km ${arrow}${b.burst ? ' · burst' : ''}` },
    });
  }
  return { type: 'FeatureCollection', features };
}

const OVERLAY_REFRESH_MS = 5 * 60_000;
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
        properties: { label: a.flight ?? a.hex, alt: fmtAlt(a), track: a.track ?? 0, stale: a.seen > STALE_S },
      })),
  };
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

export function MapView({ snapshot }: { snapshot?: Snapshot }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap>(null);
  const [ready, setReady] = useState(false);
  const centered = useRef(false);
  const [overlays, setOverlays] = useState<Overlays>({});
  const [layer, setLayer] = useState<Layer>('live');

  useEffect(() => {
    const m = new MlMap({ container: el.current!, style: STYLE, center: [-77.03, 38.9], zoom: 8.6, attributionControl: { compact: true } });
    map.current = m;
    // MapLibre opens the compact attribution ("ⓘ") by default, covering the map's corner.
    // Start it collapsed; the button still opens it.
    const collapseAttribution = () => m.getContainer().querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');
    m.once('idle', collapseAttribution);
    m.on('resize', collapseAttribution);
    m.on('load', () => {
      m.addImage('plane', planeImage(), { sdf: true });
      m.addImage('ship', shipImage(), { sdf: true });
      m.addSource('sea', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('rings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('aircraft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('balloons', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'rings', type: 'line', source: 'rings', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#3a4659', 'line-width': 1, 'line-dasharray': [2, 3] } });
      m.addLayer({ id: 'ring-labels', type: 'symbol', source: 'rings', filter: ['has', 'label'], layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, -0.8] }, paint: { 'text-color': '#8b93a1' } });
      m.addLayer({ id: 'home-halo', type: 'circle', source: 'rings', filter: ['has', 'home'], paint: { 'circle-radius': 14, 'circle-color': '#4ade80', 'circle-opacity': 0.15 } });
      m.addLayer({ id: 'home', type: 'circle', source: 'rings', filter: ['has', 'home'], paint: { 'circle-radius': 5, 'circle-color': '#4ade80' } });
      m.addLayer({ id: 'aids', type: 'circle', source: 'sea', filter: ['!=', ['get', 'kind'], 'ship'], paint: { 'circle-radius': 4, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#3cc9b4', 'circle-stroke-width': 1.5 } });
      m.addLayer({ id: 'aid-labels', type: 'symbol', source: 'sea', filter: ['!=', ['get', 'kind'], 'ship'], layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 7, 9, 11, 11], 'text-offset': [0.8, 0], 'text-anchor': 'left', 'text-optional': true }, paint: { 'text-color': '#3cc9b4', 'text-halo-color': '#0b0e13', 'text-halo-width': 1.2 } });
      m.addLayer({
        id: 'ships',
        type: 'symbol',
        source: 'sea',
        filter: ['==', ['get', 'kind'], 'ship'],
        layout: { 'icon-image': 'ship', 'icon-size': 0.7, 'icon-rotate': ['get', 'cog'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [1.1, 0], 'text-anchor': 'left', 'text-optional': true },
        paint: { 'icon-color': '#3cc9b4', 'icon-opacity': ['case', ['get', 'stale'], 0.4, 1], 'text-color': '#3cc9b4', 'text-halo-color': '#0b0e13', 'text-halo-width': 1.2 },
      });
      m.addLayer({ id: 'balloon-tracks', type: 'line', source: 'balloons', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#f5b547', 'line-width': 2, 'line-dasharray': [2, 2] } });
      m.addLayer({ id: 'balloons', type: 'circle', source: 'balloons', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#f5b547', 'circle-stroke-color': '#0b0e13', 'circle-stroke-width': 1.5 } });
      m.addLayer({ id: 'balloon-labels', type: 'symbol', source: 'balloons', filter: ['==', ['geometry-type'], 'Point'], layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0.9, 0], 'text-anchor': 'left' }, paint: { 'text-color': '#f5b547', 'text-halo-color': '#0b0e13', 'text-halo-width': 1.2 } });
      m.addLayer({
        id: 'aircraft',
        type: 'symbol',
        source: 'aircraft',
        layout: {
          'icon-image': 'plane',
          'icon-size': 0.8,
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
          'icon-color': '#5ab0ff',
          'icon-opacity': ['case', ['get', 'stale'], 0.35, 1],
          'text-color': '#e6e9ee',
          'text-opacity': ['case', ['get', 'stale'], 0.45, 1],
          'text-halo-color': '#0b0e13',
          'text-halo-width': 1.2,
        },
      });
      setReady(true);
    });
    return () => m.remove();
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !snapshot) return;
    (m.getSource('aircraft') as GeoJSONSource).setData(aircraftFC(snapshot.aircraft));
    (m.getSource('balloons') as GeoJSONSource).setData(balloonsFC(snapshot.balloons ?? []));
    (m.getSource('sea') as GeoJSONSource).setData(vesselsFC(snapshot.vessels, snapshot.aisFixed, snapshot.now));
    if (snapshot.home) {
      (m.getSource('rings') as GeoJSONSource).setData(ringsFC(snapshot.home));
      if (!centered.current) {
        centered.current = true;
        m.jumpTo({ center: [snapshot.home.lon, snapshot.home.lat], zoom: 8.6 });
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
      {layer === 'live' && (
        <>
          {adsb?.error && (
            <div className="overlay-tr">
              <span className="tog" style={{ color: 'var(--wx)' }}>
                Receiver unreachable{adsb.lastHeard ? ` · last heard ${ago(adsb.lastHeard, now)}` : ''}
              </span>
            </div>
          )}
          <div className="overlay-b">
            <div className="tog" style={{ gap: 16 }}>
              <span><b className="mono">{snapshot ? snapshot.stats.maxRangeNm.toFixed(0) : '—'}</b> <span className="muted">nm range</span></span>
              <span><b className="mono">{snapshot?.stats.avgRssi?.toFixed(0) ?? '—'}</b> <span className="muted">dBFS</span></span>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>Faded = not heard in the last {STALE_S} s</span>
          </div>
        </>
      )}
      {layer === 'traffic' &&
        (overlays.traffic ? (
          <ImagePanel caption={`Traffic map from HD Radio · received ${ago(overlays.traffic.updatedAt, now)}${overlays.traffic.tiles.length < (overlays.traffic.rows ?? 3) * (overlays.traffic.cols ?? 3) ? ` · ${overlays.traffic.tiles.length} of ${(overlays.traffic.rows ?? 3) * (overlays.traffic.cols ?? 3)} tiles so far` : ''}`} render={(z) => <TrafficGrid t={overlays.traffic!} zoom={z} />} />
        ) : (
          <div className="layer-panel layer-empty"><b>No traffic map received yet</b><span className="muted">Traffic maps come in over HD Radio during the HD Radio slot and are kept for 90 minutes.</span></div>
        ))}
      {layer === 'weather' &&
        (overlays.radar ? (
          <ImagePanel
            caption={`Radar from HD Radio · received ${ago(overlays.radar.updatedAt, now)}`}
            render={(z) => (
              <div className="layer-img" style={{ width: `${z * 100}%` }}>
                <img src={overlays.radar!.url} alt="Weather radar image as broadcast" draggable={false} />
              </div>
            )}
          />
        ) : (
          <div className="layer-panel layer-empty"><b>No radar image received yet</b><span className="muted">Radar comes in over HD Radio with the traffic maps. It will show here as broadcast.</span></div>
        ))}
    </section>
  );
}
