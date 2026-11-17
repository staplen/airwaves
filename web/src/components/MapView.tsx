import { useEffect, useRef, useState } from 'react';
import { Map as MlMap, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
// MapLibre loads its worker relative to its own module, which breaks once bundled.
// Let Vite bundle the worker (with its shared chunk) and hand MapLibre the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Aircraft, AisFixed, Home, Snapshot, Vessel } from '../../../shared/types.ts';
import { ago } from '../live.ts';
import { FreshnessRing } from './FreshnessRing.tsx';

const STYLE = 'https://tiles.openfreemap.org/styles/dark';
setWorkerUrl(workerUrl);
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
  const [showPlanes, setShowPlanes] = useState(true);
  const [showRings, setShowRings] = useState(true);
  const [showShips, setShowShips] = useState(true);
  const centered = useRef(false);

  useEffect(() => {
    const m = new MlMap({ container: el.current!, style: STYLE, center: [-77.03, 38.9], zoom: 8.6, attributionControl: { compact: true } });
    map.current = m;
    m.on('load', () => {
      m.addImage('plane', planeImage(), { sdf: true });
      m.addImage('ship', shipImage(), { sdf: true });
      m.addSource('sea', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('rings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('aircraft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
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
    const m = map.current;
    if (!ready || !m) return;
    m.setLayoutProperty('aircraft', 'visibility', showPlanes ? 'visible' : 'none');
    for (const id of ['rings', 'ring-labels']) m.setLayoutProperty(id, 'visibility', showRings ? 'visible' : 'none');
    for (const id of ['ships', 'aids', 'aid-labels']) m.setLayoutProperty(id, 'visibility', showShips ? 'visible' : 'none');
  }, [ready, showPlanes, showRings, showShips]);

  const now = snapshot?.now ?? Date.now();
  const adsb = snapshot?.sources.find((s) => s.id === 'adsb');
  const heardAge = adsb?.lastHeard ? (now - adsb.lastHeard) / 1000 : Infinity;
  const placed = snapshot?.aircraft.filter((a) => a.lat !== undefined).length ?? 0;
  const ais = snapshot?.sources.find((s) => s.id === 'ais');

  return (
    <section className="card mapcard" aria-label="Map">
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      <div className="overlay-tl">
        <button type="button" className="tog" aria-pressed={showPlanes} onClick={() => setShowPlanes((v) => !v)}>
          <span className="dot" style={{ background: 'var(--air)' }} />Aircraft <span className="mono muted">{placed}</span>
        </button>
        <button type="button" className="tog" aria-pressed={showShips} onClick={() => setShowShips((v) => !v)}>
          <span className="dot" style={{ background: 'var(--sea)' }} />Ships <span className="mono muted">{snapshot?.vessels.length ?? 0}</span>
        </button>
        <button type="button" className="tog" aria-pressed={false} disabled title="Balloons appear once the radiosonde slot runs">
          <span className="dot" style={{ background: 'var(--wx)' }} />Balloon
        </button>
        <button type="button" className="tog" aria-pressed={showRings} onClick={() => setShowRings((v) => !v)}>Rings</button>
      </div>
      <div className="overlay-tr">
        <span className="tog">
          <FreshnessRing fraction={adsb?.error ? 0 : 1 - heardAge / 600} color="var(--air)" />
          {adsb?.error ? <span style={{ color: 'var(--wx)' }}>Receiver unreachable{adsb.lastHeard ? ` · last heard ${ago(adsb.lastHeard, now)}` : ''}</span> : <>Aircraft {ago(adsb?.lastHeard, now)}</>}
        </span>
        {ais?.running && (
          <span className="tog">
            <FreshnessRing fraction={ais.lastHeard ? 1 - (now - ais.lastHeard) / 1_200_000 : 0} color="var(--sea)" />
            Ships {ago(ais.lastHeard, now)}
          </span>
        )}
      </div>
      <div className="overlay-b">
        <div className="tog" style={{ gap: 16 }}>
          <span><b className="mono">{snapshot ? snapshot.stats.maxRangeNm.toFixed(0) : '—'}</b> <span className="muted">nm range</span></span>
          <span><b className="mono">{snapshot?.stats.avgRssi?.toFixed(0) ?? '—'}</b> <span className="muted">dBFS</span></span>
        </div>
        <span className="muted" style={{ fontSize: 11 }}>Faded = not heard in the last {STALE_S} s</span>
      </div>
    </section>
  );
}
