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
    properties: { kind: f.kind, label: f.kind === 'aid' ? `${f.aidType ?? 'Aid'}${f.name ? ` ${f.name}` : ''}` : 'AIS base station' },
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
const BELOW = ['rings', 'ring-labels', 'home-halo', 'home', 'aids', 'aid-labels', 'ships', 'balloon-tracks', 'balloons', 'balloon-labels', 'aircraft'];

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(url));
    img.src = url;
  });
}

/** Traffic tiles are opaque: key out the olive background and the water blue so only roads and labels remain. */
async function keyedTile(url: string, bg: [number, number, number] | undefined): Promise<string> {
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], gr = px[i + 1], b = px[i + 2];
    const isBg = bg !== undefined && Math.abs(r - bg[0]) <= 18 && Math.abs(gr - bg[1]) <= 18 && Math.abs(b - bg[2]) <= 18;
    const isWater = b > r + 40 && b > gr + 10;
    if (isBg || isWater) px[i + 3] = 0;
  }
  g.putImageData(d, 0, 0);
  return c.toDataURL('image/png');
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
  const applied = useRef<{ traffic?: string; radar?: string; ids: { traffic: string[]; radar: string[] } }>({ ids: { traffic: [], radar: [] } });
  const gen = useRef({ traffic: 0, radar: 0 });

  useEffect(() => {
    const m = new MlMap({ container: el.current!, style: STYLE, center: [-77.03, 38.9], zoom: 8.6, attributionControl: { compact: true } });
    map.current = m;
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
      m.addLayer({ id: 'aid-labels', type: 'symbol', source: 'sea', filter: ['!=', ['get', 'kind'], 'ship'], minzoom: 10, layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0.8, 0], 'text-anchor': 'left' }, paint: { 'text-color': '#3cc9b4', 'text-halo-color': '#0b0e13', 'text-halo-width': 1 } });
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

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const clear = (kind: 'traffic' | 'radar') => {
      for (const id of applied.current.ids[kind]) {
        if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource(id)) m.removeSource(id);
      }
      applied.current.ids[kind] = [];
      applied.current[kind] = undefined;
    };
    const place = (kind: 'traffic' | 'radar', id: string, dataUrl: string, b: [number, number, number, number], opacity: number) => {
      const [w, so, e, n] = b;
      m.addSource(id, { type: 'image', url: dataUrl, coordinates: [[w, n], [e, n], [e, so], [w, so]] });
      m.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 } }, BELOW.find((l) => m.getLayer(l)));
      applied.current.ids[kind].push(id);
    };
    const sync = async (kind: 'traffic' | 'radar') => {
      const o = overlays[kind];
      const key = o ? (kind === 'traffic' ? overlays.traffic!.tiles.map((t) => t.url).join('|') : overlays.radar!.url) : undefined;
      if (key === applied.current[kind]) return;
      const my = ++gen.current[kind];
      if (!key) return clear(kind);
      try {
        if (kind === 'traffic') {
          const t = overlays.traffic!;
          const urls = await Promise.all(t.tiles.map((x) => keyedTile(x.url, t.background)));
          if (my !== gen.current.traffic || !map.current) return;
          clear('traffic');
          t.tiles.forEach((x, i) => place('traffic', `traffic-${i}`, urls[i], x.bounds, 0.9));
        } else {
          const r = overlays.radar!;
          await loadImage(r.url);
          if (my !== gen.current.radar || !map.current) return;
          clear('radar');
          place('radar', 'radar-0', r.url, r.bounds, 0.6);
        }
        applied.current[kind] = key;
      } catch {
        // leave the previous overlay in place; the next refresh retries
      }
    };
    void sync('traffic');
    void sync('radar');
  }, [ready, overlays]);

  const now = snapshot?.now ?? Date.now();
  const adsb = snapshot?.sources.find((s) => s.id === 'adsb');

  return (
    <section className="card mapcard" aria-label="Map">
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      {adsb?.error && (
        <div className="overlay-tr">
          <span className="tog" style={{ color: 'var(--wx)' }}>
            Receiver unreachable{adsb.lastHeard ? ` · last heard ${ago(adsb.lastHeard, now)}` : ''}
          </span>
        </div>
      )}
      <div className="overlay-b">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <div className="tog" style={{ gap: 16 }}>
          <span><b className="mono">{snapshot ? snapshot.stats.maxRangeNm.toFixed(0) : '—'}</b> <span className="muted">nm range</span></span>
          <span><b className="mono">{snapshot?.stats.avgRssi?.toFixed(0) ?? '—'}</b> <span className="muted">dBFS</span></span>
        </div>
        {(overlays.traffic || overlays.radar) && (
          <span className="tog muted" style={{ fontSize: 11 }}>
            {[overlays.traffic && 'Traffic', overlays.radar && 'radar'].filter(Boolean).join(' & ').replace(/^radar/, 'Radar')} from HD Radio · {ago(Math.max(overlays.traffic?.updatedAt ?? 0, overlays.radar?.updatedAt ?? 0), now)}
          </span>
        )}
        </div>
        <span className="muted" style={{ fontSize: 11 }}>Faded = not heard in the last {STALE_S} s</span>
      </div>
    </section>
  );
}
