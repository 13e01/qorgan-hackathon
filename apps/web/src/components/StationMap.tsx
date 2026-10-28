// Интерактивная карта СКО на MapLibre GL.
//  • Подложка — стиль OpenFreeMap «dark» (без ключа; © OpenMapTiles, © OpenStreetMap). Без интернета — тёмный фон.
//  • Река Есиль — реальная геометрия OpenStreetMap (ODbL), упрощённая (src/map/esil-river.json).
//  • Пунктир между станциями — схема модели распространения волны, НЕ русло реки.
//  • Станции — HTML-маркеры-кнопки: доступны с клавиатуры, цвет и подпись риска.

import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, GeoJSONSourceSpecification, LngLatBoundsLike, StyleSpecification } from 'maplibre-gl';
// Фоновый поток MapLibre подключаем явно: Vite копирует файл в сборку и отдаёт его в режиме разработки.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef, useState } from 'react';
import type { SnapshotStation, StationMeta } from '../api/types';
import { useI18n } from '../i18n';
import { metersFromCm } from '../lib/format';
import { levelView } from '../lib/level';
import river from '../map/esil-river.json';
import { useStore } from '../state/store';

maplibregl.setWorkerUrl(workerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1220' } }],
};
const REGION: LngLatBoundsLike = [
  [66.6, 53.55],
  [70.2, 55.45],
];

function stationBounds(stations: StationMeta[]): LngLatBoundsLike {
  if (stations.length === 0) return REGION;
  const lons = stations.map((s) => s.lon);
  const lats = stations.map((s) => s.lat);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

function linksGeoJson(stations: StationMeta[]) {
  const byCode = new Map(stations.map((s) => [s.code, s]));
  return {
    type: 'FeatureCollection' as const,
    features: stations
      .filter((s) => s.upstreamCode && byCode.has(s.upstreamCode))
      .map((s) => {
        const up = byCode.get(s.upstreamCode!)!;
        return {
          type: 'Feature' as const,
          properties: { from: up.code, to: s.code },
          geometry: { type: 'LineString' as const, coordinates: [[up.lon, up.lat], [s.lon, s.lat]] },
        };
      }),
  };
}

export function StationMap() {
  const { t, lang } = useI18n();
  const { stations, live, selected, select } = useStore();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef(new Map<string, { marker: maplibregl.Marker; el: HTMLButtonElement }>());
  const popup = useRef<maplibregl.Popup | null>(null);
  const [baseUnavailable, setBaseUnavailable] = useState(false);
  const stationsRef = useRef(stations);
  stationsRef.current = stations;

  // Создание карты (один раз).
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE_URL,
      bounds: REGION,
      fitBoundsOptions: { padding: 30 },
      attributionControl: { compact: true, customAttribution: 'Esil river data © OpenStreetMap contributors (ODbL)' },
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __qorganMap?: maplibregl.Map }).__qorganMap = map; // только для отладки
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    map.touchZoomRotate.disableRotation();

    const addOverlays = () => {
      if (!map.getSource('esil')) {
        map.addSource('esil', { type: 'geojson', data: river as unknown as GeoJSONSourceSpecification['data'] });
        map.addLayer({ id: 'esil-line', type: 'line', source: 'esil', paint: { 'line-color': '#3d8fd1', 'line-width': 2.2, 'line-opacity': 0.95 } });
      }
      if (!map.getSource('links')) {
        map.addSource('links', { type: 'geojson', data: linksGeoJson(stationsRef.current) });
        map.addLayer({
          id: 'links-line',
          type: 'line',
          source: 'links',
          paint: { 'line-color': '#b9c4d2', 'line-width': 1.5, 'line-opacity': 0.75, 'line-dasharray': [3, 3] },
        });
      }
    };

    // Стиль подложки не загрузился (нет сети) — переходим на запасной стиль, река и станции остаются.
    // Успехом считаем загрузку стиля ('style.load'), а не первую отрисовку: отрисовка может ждать,
    // пока вкладка скрыта, и это не значит, что подложка недоступна.
    let decided = false;
    const fallback = () => {
      if (decided) return;
      decided = true;
      setBaseUnavailable(true);
      map.setStyle(FALLBACK_STYLE);
    };
    const timer = setTimeout(fallback, 15_000);
    map.on('style.load', () => {
      decided = true;
      clearTimeout(timer);
      addOverlays();
    });
    map.on('error', (e: { error?: { message?: string } }) => {
      if (!decided && /style|Failed to fetch|NetworkError/i.test(String(e.error?.message ?? ''))) fallback();
    });

    return () => {
      clearTimeout(timer);
      popup.current?.remove();
      for (const { marker } of markers.current.values()) marker.remove();
      markers.current.clear();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Связи между станциями и маркеры — по списку станций.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    (map.getSource('links') as GeoJSONSource | undefined)?.setData(linksGeoJson(stations));
    for (const st of stations) {
      if (markers.current.has(st.code)) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'marker r-NO_DATA';
      el.innerHTML = '<span class="mdot"></span><span class="mlabel"></span>';
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        select(st.code);
      });
      const marker = new maplibregl.Marker({ element: el, anchor: 'left', offset: [-9, 0] }).setLngLat([st.lon, st.lat]).addTo(map);
      markers.current.set(st.code, { marker, el });
    }
    if (stations.length > 0) map.fitBounds(stationBounds(stations), { padding: { top: 60, bottom: 90, left: 60, right: 160 }, duration: 0 });
  }, [stations, select]);

  // Обновление маркеров по снимку (риск, уровень, выбор) и подсказка.
  const snapStations = live.snapshot?.stations;
  useEffect(() => {
    const byCode = new Map((snapStations ?? []).map((s) => [s.code, s]));
    for (const st of stations) {
      const entry = markers.current.get(st.code);
      if (!entry) continue;
      const snap = byCode.get(st.code);
      const lv = levelView(snap);
      const risk = lv.measuredCm === null || !snap ? 'NO_DATA' : snap.risk.risk;
      const level = metersFromCm(lv.measuredCm, lang);
      entry.el.className = `marker r-${risk}${selected === st.code ? ' selected' : ''}`;
      entry.el.querySelector('.mlabel')!.textContent = `${st.code} · ${level ? `${level} ${t('unit.m')}` : t('common.noData')}`;
      entry.el.setAttribute('aria-label', t('map.markerLabel', { name: st.name, risk: t(`risk.${risk}`) }));
      entry.el.setAttribute('aria-pressed', String(selected === st.code));
      entry.el.onmouseenter = () => showPopup(st, snap);
      entry.el.onfocus = () => showPopup(st, snap);
      entry.el.onmouseleave = () => popup.current?.remove();
      entry.el.onblur = () => popup.current?.remove();
    }

    function showPopup(st: StationMeta, snap: SnapshotStation | undefined) {
      const map = mapRef.current;
      if (!map) return;
      popup.current?.remove();
      const lv = levelView(snap);
      const risk = snap && lv.measuredCm !== null ? snap.risk.risk : 'NO_DATA';
      const level = metersFromCm(lv.measuredCm, lang);
      const div = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${st.name} · ${st.code}`;
      const demo = document.createElement('div');
      demo.className = 'faint';
      demo.textContent = t('station.demo');
      const line = document.createElement('div');
      line.textContent = `${t('level.title')}: ${level ? `${level} ${t('unit.m')}` : t('common.noData')} · ${t('risk.final')}: ${t(`risk.${risk}`)}`;
      div.append(title, demo, line);
      popup.current = new maplibregl.Popup({ closeButton: false, offset: 16, anchor: 'bottom' }).setLngLat([st.lon, st.lat]).setDOMContent(div).addTo(map);
    }
  }, [snapStations, stations, selected, lang, t]);

  // Центрирование на выбранной станции — только когда выбор действительно изменился (не при первом показе).
  const shown = useRef(selected);
  useEffect(() => {
    if (shown.current === selected) return;
    shown.current = selected;
    const st = stations.find((s) => s.code === selected);
    const map = mapRef.current;
    if (st && map) map.easeTo({ center: [st.lon, st.lat], zoom: Math.max(map.getZoom(), 7.2), duration: 600 });
  }, [selected, stations]);

  return (
    <div className="map-wrap">
      <div ref={container} className="map" role="region" aria-label={t('map.label')} />
      <div className="map-tools">
        <button className="btn sm" onClick={() => mapRef.current?.fitBounds(stationBounds(stations), { padding: { top: 60, bottom: 90, left: 60, right: 160 } })}>
          {t('map.fit')}
        </button>
      </div>
      {baseUnavailable && <div className="map-notice callout warn">{t('map.baseUnavailable')}</div>}
      <div className="map-legend" aria-label={t('map.legend')}>
        <div className="row">
          <span className="legend-line" />
          {t('map.river')}
        </div>
        <div className="row">
          <span className="legend-line dashed" />
          {t('map.link')}
        </div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {(['LOW', 'MEDIUM', 'HIGH', 'NO_DATA'] as const).map((r) => (
            <span key={r} className="row" style={{ gap: 4 }}>
              <span className="legend-dot" style={{ background: `var(--risk-${r === 'NO_DATA' ? 'unknown' : r.toLowerCase()})` }} />
              {t(`risk.${r}`)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
