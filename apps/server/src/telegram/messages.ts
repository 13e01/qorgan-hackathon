// Тексты Telegram-бота (ru / kk / en). Telegram — отдельный клиент без фронтенда, поэтому его строки живут на
// сервере (исключение из правила «сервер отдаёт коды», ADR-034). Сообщение о предупреждении собирается только из
// данных события QORGAN (payload в telegram_outbox): станция, уровень, пороги, время измерения, причина.

import type { Reason } from '@qorgan/shared';

export type BotLang = 'ru' | 'kk' | 'en';

export interface AlertPayload {
  kind: 'ALERT';
  event: 'OPENED' | 'ESCALATED';
  alertId: number;
  runId: number;
  tick: number;
  stationCode: string;
  stationName: string;
  severity: 'HIGH';
  levelCm: number | null;
  warningCm: number | null;
  dangerCm: number | null;
  /** Время измерения уровня (виртуальное, часы прогона). */
  measuredAt: string | null;
  trigger: 'DANGER_LEVEL' | 'FORECAST';
  reasons: Reason[];
  ml: { category: string | null; pDanger: number | null; modelVersion: string } | null;
  dataSource: string;
}

export interface TestPayload {
  kind: 'TEST';
  username: string;
}

export type OutboxPayload = AlertPayload | TestPayload;

const LOCALE: Record<BotLang, string> = { ru: 'ru-RU', kk: 'kk-KZ', en: 'en-GB' };

export function botLang(code: string | undefined | null): BotLang {
  const c = (code ?? '').slice(0, 2).toLowerCase();
  return c === 'kk' || c === 'en' ? c : 'ru';
}

const T = {
  ru: {
    alertTitle: 'QORGAN | Предупреждение',
    escalated: 'Риск повысился: средний → высокий',
    station: 'Станция',
    level: 'Уровень',
    thresholds: 'Пороги (учебные): внимание {w} м, опасный {d} м',
    risk: 'Риск',
    measured: 'Время измерения',
    reason: 'Причина',
    trigger_DANGER_LEVEL: 'превышен учебный опасный порог.',
    trigger_FORECAST: 'ухудшение прогноза (уровень пока ниже опасного порога).',
    ml: 'Оценка ML (учебная, {v}): {c}, вероятность опасного уровня за 6 ч — {p}',
    open: 'Открыть QORGAN',
    demo: 'Учебная демонстрация: данные симулятора/учебного датчика, не официальное оповещение.',
    sim: 'Источник: встроенная симуляция (ускоренное время)',
    ext: 'Источник: внешний учебный датчик (MQTT)',
    noData: 'нет данных',
    m: 'м',
    risk_LOW: 'низкий',
    risk_MEDIUM: 'средний',
    risk_HIGH: 'высокий',
    test: 'QORGAN | Проверка связи\nБот подключён к учётной записи «{user}». Вы будете получать сообщения о новом высоком риске.\nУчебная демонстрация.',
    help: 'QORGAN — учебная система раннего предупреждения паводков (р. Есиль).\n\nКоманды:\n/status — состояние системы\n/stations — станции, уровни и риск\n/alerts — активные предупреждения\n/subscribe — получать предупреждения\n/unsubscribe — не получать предупреждения\n/help — эта справка\n\nУчебная демонстрация, данные демонстрационные.',
    startNeedCode: 'Здравствуйте! Этот бот отправляет предупреждения QORGAN только привязанным операторам.\nЧтобы привязать чат: войдите в QORGAN → «Журнал предупреждений» → «Telegram» → «Получить код», затем отправьте сюда:\n/start КОД',
    linked: 'Чат привязан к учётной записи «{user}». Подписка на предупреждения о высоком риске включена. /help — команды.',
    alreadyLinked: 'Чат уже привязан к учётной записи «{user}». /help — команды.',
    badCode: 'Код не подошёл: неверный, уже использован или истёк (действует 10 минут). Получите новый код в QORGAN.',
    notAllowed: 'Этот чат не входит в список разрешённых для демонстрации (TELEGRAM_ALLOWED_CHAT_IDS).',
    notLinked: 'Чат не привязан к QORGAN. Отправьте /start, чтобы узнать, как это сделать.',
    subscribed: 'Подписка включена: вы будете получать предупреждения о высоком риске.',
    unsubscribed: 'Подписка выключена. Включить снова — /subscribe.',
    unknown: 'Неизвестная команда. /help — список команд.',
    statusTitle: 'QORGAN | Состояние',
    mode: 'Режим данных',
    mode_LIVE: 'симуляция идёт',
    mode_PAUSED: 'пауза',
    mode_HISTORICAL: 'исторические данные',
    mode_NO_DATA: 'нет данных',
    virtual: 'Модельное время',
    activeAlerts: 'Активных предупреждений: {n} (высокий риск: {h})',
    mlStatus: 'ML Sentinel: {s}',
    ml_READY: 'работает (учебная модель {v})',
    ml_DISABLED: 'выключена',
    ml_MISSING: 'недоступна (нет файла модели) — работает основная оценка',
    ml_INVALID: 'недоступна (несовместимый файл модели) — работает основная оценка',
    stationsTitle: 'QORGAN | Станции (вниз по течению)',
    alertsTitle: 'QORGAN | Активные предупреждения',
    noAlerts: 'Активных предупреждений нет.',
    alertLine: '{risk} · {station} · с {time}',
  },
  kk: {
    alertTitle: 'QORGAN | Ескерту',
    escalated: 'Қауіп артты: орташа → жоғары',
    station: 'Бекет',
    level: 'Деңгей',
    thresholds: 'Шектер (оқу): назар {w} м, қауіпті {d} м',
    risk: 'Қауіп',
    measured: 'Өлшеу уақыты',
    reason: 'Себебі',
    trigger_DANGER_LEVEL: 'оқу қауіпті шегінен асты.',
    trigger_FORECAST: 'болжам нашарлады (деңгей әзірге қауіпті шектен төмен).',
    ml: 'ML бағасы (оқу, {v}): {c}, 6 сағатта қауіпті деңгей ықтималдығы — {p}',
    open: 'QORGAN ашу',
    demo: 'Оқу демонстрациясы: симулятор/оқу датчигінің деректері, ресми хабарлама емес.',
    sim: 'Дереккөз: кірістірілген симуляция (жеделдетілген уақыт)',
    ext: 'Дереккөз: сыртқы оқу датчигі (MQTT)',
    noData: 'дерек жоқ',
    m: 'м',
    risk_LOW: 'төмен',
    risk_MEDIUM: 'орташа',
    risk_HIGH: 'жоғары',
    test: 'QORGAN | Байланысты тексеру\nБот «{user}» есептік жазбасына қосылды. Жаңа жоғары қауіп туралы хабарлар келеді.\nОқу демонстрациясы.',
    help: 'QORGAN — су тасқынынан ерте ескертудің оқу жүйесі (Есіл өзені).\n\nКомандалар:\n/status — жүйе күйі\n/stations — бекеттер, деңгейлер және қауіп\n/alerts — белсенді ескертулер\n/subscribe — ескертулерді алу\n/unsubscribe — ескертулерді алмау\n/help — анықтама\n\nОқу демонстрациясы, деректер демонстрациялық.',
    startNeedCode: 'Сәлеметсіз бе! Бұл бот QORGAN ескертулерін тек байланыстырылған операторларға жібереді.\nЧатты байланыстыру: QORGAN-ға кіріңіз → «Ескертулер журналы» → «Telegram» → «Код алу», содан кейін мұнда жіберіңіз:\n/start КОД',
    linked: 'Чат «{user}» есептік жазбасына байланыстырылды. Жоғары қауіп туралы ескертулерге жазылу қосылды. /help — командалар.',
    alreadyLinked: 'Чат «{user}» есептік жазбасына бұрыннан байланыстырылған. /help — командалар.',
    badCode: 'Код жарамсыз: қате, қолданылған немесе мерзімі өткен (10 минут). QORGAN-да жаңа код алыңыз.',
    notAllowed: 'Бұл чат демонстрацияға рұқсат етілгендер тізімінде жоқ (TELEGRAM_ALLOWED_CHAT_IDS).',
    notLinked: 'Чат QORGAN-ға байланыстырылмаған. Қалай байланыстыруды білу үшін /start жіберіңіз.',
    subscribed: 'Жазылу қосылды: жоғары қауіп туралы ескертулер келеді.',
    unsubscribed: 'Жазылу өшірілді. Қайта қосу — /subscribe.',
    unknown: 'Белгісіз команда. /help — командалар тізімі.',
    statusTitle: 'QORGAN | Күйі',
    mode: 'Деректер режимі',
    mode_LIVE: 'симуляция жүріп жатыр',
    mode_PAUSED: 'кідіріс',
    mode_HISTORICAL: 'тарихи деректер',
    mode_NO_DATA: 'дерек жоқ',
    virtual: 'Модельдік уақыт',
    activeAlerts: 'Белсенді ескертулер: {n} (жоғары қауіп: {h})',
    mlStatus: 'ML Sentinel: {s}',
    ml_READY: 'жұмыс істейді (оқу моделі {v})',
    ml_DISABLED: 'өшірілген',
    ml_MISSING: 'қолжетімсіз (модель файлы жоқ) — негізгі бағалау жұмыс істейді',
    ml_INVALID: 'қолжетімсіз (модель файлы сәйкес емес) — негізгі бағалау жұмыс істейді',
    stationsTitle: 'QORGAN | Бекеттер (ағыс бойымен)',
    alertsTitle: 'QORGAN | Белсенді ескертулер',
    noAlerts: 'Белсенді ескертулер жоқ.',
    alertLine: '{risk} · {station} · {time} бастап',
  },
  en: {
    alertTitle: 'QORGAN | Warning',
    escalated: 'Risk increased: medium → high',
    station: 'Station',
    level: 'Level',
    thresholds: 'Thresholds (training): warning {w} m, danger {d} m',
    risk: 'Risk',
    measured: 'Measured at',
    reason: 'Reason',
    trigger_DANGER_LEVEL: 'the training danger threshold is exceeded.',
    trigger_FORECAST: 'the outlook got worse (level is still below the danger threshold).',
    ml: 'ML estimate (training, {v}): {c}, probability of danger level within 6 h — {p}',
    open: 'Open QORGAN',
    demo: 'Training demo: simulator / training sensor data, not an official warning.',
    sim: 'Source: built-in simulation (accelerated time)',
    ext: 'Source: external training sensor (MQTT)',
    noData: 'no data',
    m: 'm',
    risk_LOW: 'low',
    risk_MEDIUM: 'medium',
    risk_HIGH: 'high',
    test: 'QORGAN | Connection test\nThe bot is linked to the account “{user}”. You will receive messages about new high risk.\nTraining demo.',
    help: 'QORGAN is a training flood early-warning system (Esil river).\n\nCommands:\n/status — system status\n/stations — stations, levels and risk\n/alerts — active warnings\n/subscribe — receive warnings\n/unsubscribe — stop warnings\n/help — this help\n\nTraining demo, demonstration data.',
    startNeedCode: 'Hello! This bot sends QORGAN warnings only to linked operators.\nTo link this chat: sign in to QORGAN → “Alerts” → “Telegram” → “Get code”, then send here:\n/start CODE',
    linked: 'Chat linked to the account “{user}”. High-risk warnings are on. /help — commands.',
    alreadyLinked: 'Chat is already linked to the account “{user}”. /help — commands.',
    badCode: 'The code did not work: wrong, already used or expired (valid for 10 minutes). Get a new code in QORGAN.',
    notAllowed: 'This chat is not on the demo allowlist (TELEGRAM_ALLOWED_CHAT_IDS).',
    notLinked: 'This chat is not linked to QORGAN. Send /start to see how to link it.',
    subscribed: 'Subscribed: you will receive high-risk warnings.',
    unsubscribed: 'Unsubscribed. Turn back on — /subscribe.',
    unknown: 'Unknown command. /help — list of commands.',
    statusTitle: 'QORGAN | Status',
    mode: 'Data mode',
    mode_LIVE: 'simulation running',
    mode_PAUSED: 'paused',
    mode_HISTORICAL: 'historical data',
    mode_NO_DATA: 'no data',
    virtual: 'Model time',
    activeAlerts: 'Active warnings: {n} (high risk: {h})',
    mlStatus: 'ML Sentinel: {s}',
    ml_READY: 'running (training model {v})',
    ml_DISABLED: 'off',
    ml_MISSING: 'unavailable (no model file) — main assessment keeps working',
    ml_INVALID: 'unavailable (incompatible model file) — main assessment keeps working',
    stationsTitle: 'QORGAN | Stations (downstream order)',
    alertsTitle: 'QORGAN | Active warnings',
    noAlerts: 'No active warnings.',
    alertLine: '{risk} · {station} · since {time}',
  },
} as const;

export type BotKey = keyof (typeof T)['ru'];

export function bt(lang: BotLang, key: BotKey, params: Record<string, string | number> = {}): string {
  const s: string = T[lang][key] ?? T.ru[key];
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));
}

export function fmtTime(iso: string | null, lang: BotLang): string {
  if (!iso) return bt(lang, 'noData');
  const d = new Date(iso);
  return `${new Intl.DateTimeFormat(LOCALE[lang], { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)} (UTC+5)`;
}

export function fmtMeters(cm: number | null, lang: BotLang): string {
  if (cm === null || !Number.isFinite(cm)) return bt(lang, 'noData');
  return new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cm / 100);
}

export const riskWord = (risk: string, lang: BotLang) => bt(lang, `risk_${risk}` as BotKey);

/** Текст сообщения о предупреждении — только из данных события. */
export function renderAlert(p: AlertPayload, lang: BotLang, publicUrl: string | null): string {
  const level = p.levelCm === null ? bt(lang, 'noData') : `${fmtMeters(p.levelCm, lang)} ${bt(lang, 'm')}`;
  const lines = [
    bt(lang, 'alertTitle'),
    ...(p.event === 'ESCALATED' ? [bt(lang, 'escalated')] : []),
    `${bt(lang, 'station')}: ${p.stationName} (${p.stationCode})`,
    `${bt(lang, 'level')}: ${level}`,
    bt(lang, 'thresholds', { w: fmtMeters(p.warningCm, lang), d: fmtMeters(p.dangerCm, lang) }),
    `${bt(lang, 'risk')}: ${riskWord(p.severity, lang)}`,
    `${bt(lang, 'measured')}: ${fmtTime(p.measuredAt, lang)}`,
    `${bt(lang, 'reason')}: ${bt(lang, `trigger_${p.trigger}`)}`,
  ];
  if (p.ml?.category && p.ml.pDanger !== null) {
    const pct = new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 0 }).format(p.ml.pDanger);
    lines.push(bt(lang, 'ml', { v: p.ml.modelVersion, c: riskWord(p.ml.category, lang), p: pct }));
  }
  lines.push(bt(lang, p.dataSource === 'EXTERNAL_SENSOR' ? 'ext' : 'sim'));
  if (publicUrl) lines.push(`${bt(lang, 'open')}: ${publicUrl}`);
  lines.push(bt(lang, 'demo'));
  return lines.join('\n');
}

export function renderPayload(p: OutboxPayload, lang: BotLang, publicUrl: string | null): string {
  return p.kind === 'ALERT' ? renderAlert(p, lang, publicUrl) : bt(lang, 'test', { user: p.username });
}
