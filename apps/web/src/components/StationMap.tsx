// Интерактивная карта СКО на MapLibre GL — главный объект главной панели (Eclipse).
//  • Подложка — стиль OpenFreeMap «positron» (светлая тема) или «dark» (тёмная), без ключа; © OpenMapTiles, © OpenStreetMap.
//    Без интернета — однотонный фон в цвет темы. Смена темы меняет только стиль подложки — маркеры и выбор сохраняются.
//  • Река Есиль — реальная геометрия OpenStreetMap (ODbL), упрощённая (src/map/esil-river.json), с мягким свечением.
//  • Линии между станциями — СХЕМА распространения угрозы (не русло). Состояние линии берётся из данных сервера
//    (lib/flow.ts): «угроза идёт» — бегущий пунктир вниз по течению, «дошла» — сплошная линия. Зон затопления нет:
//    для них нужны геоданные рельефа, которых в системе нет.
//  • Станции — HTML-маркеры-кнопки: доступны с клавиатуры, цвет риска всегда дублируется текстом.

import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, GeoJSONSourceSpecification, LngLatBoundsLike, StyleSpecification } from 'maplibre-gl';
// Фоновый поток MapLibre подключаем явно: Vite копирует файл в сборку и отдаёт его в режиме разработки.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef, useState } from 'react';
import type { SnapshotStation, StationMeta } from '../api/types';
import { useI18n } from '../i18n';
import { metersFromCm } from '../lib/format';
import { levelView } from '../lib/level';
import { labelOnLeft, markerClassName, riverFlow, type FlowLink } from '../lib/flow';
import river from '../map/esil-river.json';
import { useStore } from '../state/store';
import { usePalette, useTheme, type Palette } from '../state/theme';
import type { Theme } from '../lib/prefs';
import { prefersReducedMotion, useReducedMotion } from './motion';
import { Icon } from './ui';

maplibregl.setWorkerUrl(workerUrl);

const STYLE_URL: Record<Theme, string> = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const fallbackStyle = (bg: string): StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': bg || '#0b1220' } }],
});
const REGION: LngLatBoundsLike = [
  [66.6, 53.55],
  [70.2, 55.45],
];
const FIT_PADDING = { top: 70, bottom: 70, left: 60, right: 190 };

/** Кадры бегущего пунктира (как в примере MapLibre «animate a line»): смещение штриха вдоль линии вниз по течению. */
const DASH_FRAMES: number[][] = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
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

function linksGeoJson(stations: StationMeta[], links: FlowLink[]) {
  const byCode = new Map(stations.map((s) => [s.code, s]));
  return {
    type: 'FeatureCollection' as const,
    features: links
      .filter((l) => byCode.has(l.from) && byCode.has(l.to))
      .map((l) => {
        const up = byCode.get(l.from)!;
        const down = byCode.get(l.to)!;
        return {
          type: 'Feature' as const,
          properties: { from: l.from, to: l.to, state: l.state, risk: l.risk ?? 'NONE' },
          geometry: { type: 'LineString' as const, coordinates: [[up.lon, up.lat], [down.lon, down.lat]] },
        };
      }),
  };
}

const riskColor = (c: Palette) => ['match', ['get', 'risk'], 'HIGH', c.riskHigh, 'MEDIUM', c.riskMedium, 'LOW', c.riskLow, c.link] as unknown as string;

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
  const flow = riverFlow(stations, live.snapshot);
  const linksRef = useRef(flow.links);
  linksRef.current = flow.links;
  const { theme } = useTheme();
  const palette = usePalette();
  const paletteRef = useRef<Palette>(palette);
  paletteRef.current = palette;
  const themeRef = useRef(theme);
  const baseRef = useRef(false);
  const reduced = useReducedMotion();
  const [legendOpen] = useState(() => typeof matchMedia === 'function' && matchMedia('(min-width: 1600px)').matches);

  // Создание карты (один раз).
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE_URL[themeRef.current],
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
      const c = paletteRef.current;
      if (!map.getSource('esil')) {
        map.addSource('esil', { type: 'geojson', data: river as unknown as GeoJSONSourceSpecification['data'] });
        // Свечение — тот же контур реки, шире и размыто: река читается как главный объект и на тёмной, и на светлой подложке.
        map.addLayer({ id: 'esil-glow', type: 'line', source: 'esil', paint: { 'line-color': c.riverGlow, 'line-width': 10, 'line-blur': 7, 'line-opacity': 0.9 } });
        map.addLayer({ id: 'esil-line', type: 'line', source: 'esil', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.river, 'line-width': 2.8, 'line-opacity': 0.95 } });
      }
      if (!map.getSource('links')) {
        map.addSource('links', { type: 'geojson', data: linksGeoJson(stationsRef.current, linksRef.current) });
        map.addLayer({
          id: 'links-line',
          type: 'line',
          source: 'links',
          filter: ['==', ['get', 'state'], 'calm'],
          paint: { 'line-color': c.link, 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [2, 3] },
        });
        map.addLayer({
          id: 'links-halo',
          type: 'line',
          source: 'links',
          filter: ['!=', ['get', 'state'], 'calm'],
          layout: { 'line-cap': 'round' },
          paint: { 'line-color': riskColor(c), 'line-width': 12, 'line-blur': 8, 'line-opacity': 0.35 },
        });
        map.addLayer({
          id: 'links-arrived',
          type: 'line',
          source: 'links',
          filter: ['==', ['get', 'state'], 'arrived'],
          layout: { 'line-cap': 'round' },
          paint: { 'line-color': riskColor(c), 'line-width': 3.5, 'line-opacity': 0.95 },
        });
        map.addLayer({
          id: 'links-threat',
          type: 'line',
          source: 'links',
          filter: ['==', ['get', 'state'], 'threat'],
          paint: { 'line-color': riskColor(c), 'line-width': 3.5, 'line-opacity': 0.95, 'line-dasharray': DASH_FRAMES[0]! },
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
      baseRef.current = true;
      setBaseUnavailable(true);
      map.setStyle(fallbackStyle(paletteRef.current.mapBg));
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

  // Смена темы — другой стиль подложки; реку и связи заново добавит обработчик 'style.load'.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || themeRef.current === theme) return;
    themeRef.current = theme;
    map.setStyle(baseRef.current ? fallbackStyle(palette.mapBg) : STYLE_URL[theme], { diff: false });
  }, [theme, palette]);

  // Маркеры — по списку станций.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const st of stations) {
      if (markers.current.has(st.code)) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'marker r-NO_DATA';
      el.innerHTML =
        '<span class="m-pin" aria-hidden="true"><span class="m-halo"></span><span class="m-core"></span></span>' +
        '<span class="m-card"><span class="m-name"></span><span class="m-meta"><span class="m-level num"></span><span class="m-risk"></span></span><span class="m-next"></span></span>';
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        select(st.code);
      });
      const left = labelOnLeft(st, stations);
      if (left) el.classList.add('label-left');
      el.dataset.side = left ? 'left' : 'right';
      const marker = new maplibregl.Marker({ element: el, anchor: left ? 'right' : 'left', offset: [left ? 12 : -12, 0] }).setLngLat([st.lon, st.lat]).addTo(map);
      markers.current.set(st.code, { marker, el });
    }
    if (stations.length > 0) map.fitBounds(stationBounds(stations), { padding: FIT_PADDING, duration: 0 });
  }, [stations, select]);

  // Связи по снимку: состояние «спокойно / угроза идёт / дошла».
  const linkKey = flow.links.map((l) => `${l.from}>${l.to}:${l.state}:${l.risk}`).join('|');
  useEffect(() => {
    (mapRef.current?.getSource('links') as GeoJSONSource | undefined)?.setData(linksGeoJson(stations, linksRef.current));
  }, [linkKey, stations]);

  // Бегущий пунктир — только пока есть связь «угроза идёт» и пользователь не просил меньше движения (~12 кадров/с).
  const threatActive = flow.links.some((l) => l.state === 'threat');
  useEffect(() => {
    if (!threatActive || reduced) return;
    let frame = 0;
    const id = setInterval(() => {
      const map = mapRef.current;
      if (!map?.getLayer('links-threat')) return;
      frame = (frame + 1) % DASH_FRAMES.length;
      map.setPaintProperty('links-threat', 'line-dasharray', DASH_FRAMES[frame]);
    }, 80);
    return () => clearInterval(id);
  }, [threatActive, reduced]);

  // Обновление маркеров по снимку (риск, уровень, выбор, «угроза приближается») и подсказка.
  const snapStations = live.snapshot?.stations;
  const nextCode = flow.nodes.find((n) => n.next)?.code ?? null;
  useEffect(() => {
    const byCode = new Map((snapStations ?? []).map((s) => [s.code, s]));
    for (const st of stations) {
      const entry = markers.current.get(st.code);
      if (!entry) continue;
      const snap = byCode.get(st.code);
      const lv = levelView(snap);
      const risk = lv.measuredCm === null || !snap ? 'NO_DATA' : snap.risk.risk;
      const level = metersFromCm(lv.measuredCm, lang);
      const isNext = nextCode === st.code;
      entry.el.className = markerClassName(entry.el.className, { risk, selected: selected === st.code, next: isNext, left: entry.el.dataset.side === 'left' });
      entry.el.querySelector('.m-name')!.textContent = st.name;
      entry.el.querySelector('.m-level')!.textContent = level ? `${level} ${t('unit.m')}` : t('common.noData');
      // Без измерений «Нет данных» пишется один раз (в уровне), риск не повторяет его.
      entry.el.querySelector('.m-risk')!.textContent = risk === 'NO_DATA' ? '' : t(`risk.${risk}`);
      entry.el.querySelector('.m-next')!.textContent = isNext ? t('flow.next') : '';
      entry.el.setAttribute('aria-label', t('map.markerLabel', { name: st.name, risk: t(`risk.${risk}`) }) + (isNext ? ` · ${t('flow.next')}` : ''));
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
      popup.current = new maplibregl.Popup({ closeButton: false, offset: 18, anchor: 'bottom', className: 'q-popup' }).setLngLat([st.lon, st.lat]).setDOMContent(div).addTo(map);
    }
  }, [snapStations, stations, selected, nextCode, lang, t]);

  // Камера: плавный перелёт к выбранной станции — только когда выбор действительно изменился (не при первом показе).
  const shown = useRef(selected);
  useEffect(() => {
    if (shown.current === selected) return;
    shown.current = selected;
    const st = stations.find((s) => s.code === selected);
    const map = mapRef.current;
    if (!st || !map) return;
    const zoom = Math.max(map.getZoom(), 7.4);
    if (prefersReducedMotion()) map.jumpTo({ center: [st.lon, st.lat], zoom });
    else map.flyTo({ center: [st.lon, st.lat], zoom, duration: 1100, curve: 1.3, essential: false });
  }, [selected, stations]);

  const fit = () => mapRef.current?.fitBounds(stationBounds(stations), { padding: FIT_PADDING, duration: prefersReducedMotion() ? 0 : 900 });

  return (
    <div className={`map-wrap${flow.hasThreat ? ' has-threat' : ''}`}>
      <div ref={container} className="map" role="region" aria-label={t('map.label')} />
      <div className="map-tools">
        <button className="btn sm map-btn" onClick={fit}>
          <Icon name="expand" />
          {t('map.fit')}
        </button>
      </div>
      {baseUnavailable && <div className="map-notice callout warn">{t('map.baseUnavailable')}</div>}
      {/* Легенда сворачивается: на ноутбуке она не должна закрывать станции. Открыта по умолчанию только на широком экране. */}
      <details className="map-legend" open={legendOpen || undefined}>
        <summary>{t('map.legend')}</summary>
        <div className="row">
          <span className="legend-line" />
          {t('map.river')}
        </div>
        <div className="row">
          <span className="legend-line dashed" />
          {t('map.link')}
        </div>
        <div className="row">
          <span className="legend-line threat" />
          {t('map.threat')}
        </div>
        <div className="row legend-risks">
          {(['LOW', 'MEDIUM', 'HIGH', 'NO_DATA'] as const).map((r) => (
            <span key={r} className="row">
              <span className={`legend-dot r-${r}`} />
              {t(`risk.${r}`)}
            </span>
          ))}
        </div>
      </details>
    </div>
  );
}
