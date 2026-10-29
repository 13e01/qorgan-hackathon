// Монтажный план ролика: какие отрезки записи, с какой скоростью, куда смотрит камера, где титры и окно датчика.
// Все моменты привязаны к меткам из журнала съёмки (events.json), поэтому после пересъёмки план не надо править руками.
//   node production/system-briefing/tools/timeline.mjs [имя-дубля]
// Результат: edit/timeline.js (для compositor.html) и edit/timeline.json (для звука и проверки).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './stand.mjs';

const BASE = resolve(ROOT, 'production/system-briefing');
const TAKE = process.argv[2] ?? 'take5';
const FPS = 60;
const DURATION = 60;

const frames = JSON.parse(readFileSync(join(BASE, 'capture', TAKE, 'frames.json'), 'utf8'));
const { t0, events } = JSON.parse(readFileSync(join(BASE, 'capture', TAKE, 'events.json'), 'utf8'));
const rel = (t) => +(t - t0).toFixed(3);
const mark = (name) => {
  const e = events.find((x) => x.type === 'mark' && x.name === name);
  if (!e) throw new Error(`нет метки ${name}`);
  return rel(e.t);
};
const click = (label) => events.find((x) => x.type === 'click' && x.label === label);
const stationChange = (pred) => rel(events.find((x) => x.type === 'station' && pred(x.value)).t);

// ── ключевые моменты записи (секунды от начала записи) ──
const S = {
  openClick: rel(click('open-system').t),
  dashboard: mark('dashboard'),
  stationClick: rel(click('station-petropavlovsk').t),
  panel: mark('sensor-panel'),
  danger: mark('danger-command'),
  medium: stationChange((v) => v.includes('Средний')),
  high: stationChange((v) => v.includes('Высокий')),
  navClick: rel(click('nav-alerts').t),
  viewClick: rel(click('alert-view').t),
  resolveClick: rel(click('alert-resolve').t),
  confirmClick: rel(click('alert-confirm').t),
  homeClick: rel(click('brand-home').t),
  finale: mark('finale'),
};

// ── время ролика (секунды) для тех же событий — под реплики диктора ──
const O = {
  openClick: 10.0,
  stationClick: 15.0,
  danger: 28.6,
  medium: 33.0,
  high: 37.5,
  navClick: 44.2,
  viewClick: 48.3,
  confirmClick: 52.5,
  finaleIn: 54.0,
  end: 56.9,
};

// Главный отрезок: от главной панели до журнала. Карта времени — пары [время ролика, время записи].
// Между метками скорость 1, кроме двух мест, где это нужно для минуты и подписано «ускорено»:
// подъём воды (между «Средний» и «Высокий») и набор комментария.
const mainMap = [
  // Интерфейс сам растворяет главную в панель ≈ 0,6 с; отрезок начинается, когда панель уже загружена.
  [O.openClick + 0.6, S.openClick + 0.75],
  [O.stationClick, S.stationClick],
  // Пока диктор говорит о датчике, экран почти неподвижен (обновляется раз в 2 с) — время записи идёт медленнее.
  [O.stationClick + 5.0, S.stationClick + 5.0],
  [O.danger, S.danger],
  [O.medium, S.medium],
  [O.high, S.high],
  [O.navClick, S.navClick],
  [O.viewClick, S.viewClick],
  [O.viewClick + 1.6, S.viewClick + 1.6],
  [O.confirmClick, S.confirmClick],
  [O.finaleIn, S.confirmClick + (O.finaleIn - O.confirmClick)],
];
for (let i = 1; i < mainMap.length; i++) {
  const sp = (mainMap[i][1] - mainMap[i - 1][1]) / (mainMap[i][0] - mainMap[i - 1][0]);
  if (sp <= 0) throw new Error(`карта времени: отрезок ${i} идёт назад`);
}

// Камера главного отрезка (координаты страницы 1920×1080).
const pin = { x: 876, y: 776 }; // метка Петропавловска после перелёта карты (видно на кадрах дубля)
const cam = [
  { t: O.openClick + 0.6, x: 960, y: 540, z: 1.0 },
  { t: O.openClick + 1.6, x: 960, y: 540, z: 1.0 },
  { t: O.stationClick - 0.9, x: 900, y: 690, z: 1.35 },              // наезд на карту к станции
  { t: O.stationClick + 3.6, x: 900, y: 720, z: 1.5 },
  { t: O.stationClick + 6.0, x: 1330, y: 660, z: 1.32 },             // панорама к «Внешние датчики»: метка + карточка
  { t: O.danger - 0.2, x: 1330, y: 640, z: 1.32 },
  { t: O.high - 0.3, x: 1300, y: 650, z: 1.36, ease: 'linear' },     // медленный наезд во время подъёма
  { t: O.high + 1.4, x: 1420, y: 760, z: 1.25 },                     // всплывающие предупреждения справа внизу
  { t: O.navClick - 1.5, x: 1440, y: 770, z: 1.3, ease: 'linear' },  // медленный дрейф, чтобы план не застывал
  { t: O.navClick - 0.2, x: 960, y: 540, z: 1.0 },                   // общий план: курсор идёт к меню
  { t: O.navClick + 1.4, x: 960, y: 540, z: 1.0 },
  { t: O.viewClick - 0.8, x: 860, y: 650, z: 1.42 },                 // карточка Петропавловска
  { t: O.confirmClick - 2.0, x: 1000, y: 690, z: 1.32 },
  { t: O.confirmClick + 0.2, x: 1240, y: 720, z: 1.28 },
  { t: O.finaleIn, x: 1320, y: 780, z: 1.2 },                        // подтверждение «Отмечено как обработанное»
];

const welcomeCam = [
  { t: 0, x: 1330, y: 560, z: 1.64 },                // только река, без заголовка
  { t: 2.4, x: 1320, y: 560, z: 1.6, ease: 'linear' }, // едва заметный дрейф
  { t: 6.4, x: 1060, y: 560, z: 1.06 },                // отъезд: открывается заголовок главной
  { t: 7.6, x: 960, y: 540, z: 1.0 },
  { t: O.openClick - 0.6, x: 700, y: 610, z: 1.12 },
  { t: O.openClick + 0.8, x: 700, y: 610, z: 1.14 },
];
const finaleCam = [
  { t: O.finaleIn - 0.6, x: 1180, y: 640, z: 1.12 },
  { t: O.end + 0.5, x: 1120, y: 620, z: 1.2, ease: 'linear' },
];

const segments = [
  // 1. Hydro Future: запись с самого начала, клик «Открыть систему» точно в O.openClick.
  { take: TAKE, out: [0, O.openClick + 0.6], map: [[0, 0], [O.openClick, S.openClick]], cam: welcomeCam, cursor: true, cursorFade: [O.openClick - 2.2, O.openClick + 0.9] },
  // 2. Рабочая система: панель → датчик → подъём → журнал.
  { take: TAKE, out: [O.openClick + 0.6, O.finaleIn], xin: 0.35, map: mainMap, cam, cursor: true, cursorFade: [O.stationClick - 1.6, O.finaleIn + 1] },
  // 3. Возврат на главную по щелчку логотипа: живая полоса станций внизу, Петропавловск — «Высокий».
  { take: TAKE, out: [O.finaleIn, DURATION], xin: 0.6, map: [[O.finaleIn, S.finale - 0.2]], cam: finaleCam, cursor: false },
];

const chapters = [
  { n: '01', label: 'QORGAN · обзор', t: [0.8, O.openClick - 0.2] },
  { n: '02', label: 'Рабочая панель', t: [O.openClick + 0.8, O.danger - 2.0] },
  { n: '03', label: 'Учебный паводок · Python-датчик', t: [O.danger - 1.6, O.navClick - 0.4] },
  { n: '04', label: 'Действия оператора', t: [O.navClick + 0.6, O.finaleIn - 0.3] },
];

// Сгущение кадров записи для компоновщика: [время от начала записи, файл].
const takeData = {
  dsf: frames.dsf,
  frames: frames.frames.map((f) => [+(f.ts - t0).toFixed(4), f.file]),
  cursor: events.filter((e) => e.type === 'cursor').map((e) => [rel(e.t), +e.x.toFixed(1), +e.y.toFixed(1)]),
  clicks: events.filter((e) => e.type === 'click').map((e) => [rel(e.t), +e.x.toFixed(1), +e.y.toFixed(1), e.label]),
  // Окно датчика показывает его настоящий вывод; ввод «D» — момент, когда сценарий съёмки отправил команду в датчик.
  sensor: [
    ...events.filter((e) => e.type === 'sensor' && /^\[\d\d:\d\d:\d\d\] (#|режим)/.test(e.line)).map((e) => [rel(e.t), e.line.replace(/\s+отправлено$/, '  ✓ отправлено')]),
    [S.danger - 0.15, '> D'],
  ].sort((a, b) => a[0] - b[0]),
};

const timeline = {
  fps: FPS,
  duration: DURATION,
  fadeIn: 0.7,
  fadeOut: 0.8,
  takes: { [TAKE]: takeData },
  segments,
  chapters,
  lowers: [],
  terminal: { take: TAKE, t: [O.danger - 2.4, O.high + 1.2] },
  edu: [1.0, O.end - 0.3],
  end: [O.end, DURATION],
  anchors: { S, O },
};

writeFileSync(join(BASE, 'edit/timeline.js'), `// Сгенерировано tools/timeline.mjs из capture/${TAKE}. Не править руками.\nwindow.TIMELINE = ${JSON.stringify(timeline)};\n`);
const { takes, ...summary } = timeline;
writeFileSync(join(BASE, 'edit/timeline.json'), JSON.stringify({ take: TAKE, ...summary }, null, 1));
const speeds = mainMap.slice(1).map((m, i) => `${mainMap[i][0]}→${m[0]}: ×${((m[1] - mainMap[i][1]) / (m[0] - mainMap[i][0])).toFixed(2)}`);
console.log('Метки записи:', S);
console.log('Скорости главного отрезка:', speeds.join(' | '));
