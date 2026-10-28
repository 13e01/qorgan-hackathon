# QORGAN — Архитектура

> Статус: **черновик Phase 0, ожидает сверки с официальным ТЗ** (фотографии ТЗ пока не получены — см. [REQUIREMENTS.md](REQUIREMENTS.md)).
> Все пороги, задержки и уровни воды в этом документе — **учебные значения**, не официальные данные.

## 1. Общая структура

Одна программа-сервер и одна веб-страница, которые общаются по HTTP и WebSocket. База — один файл SQLite.

```
┌───────────────────────── Браузер (ноутбук на защите) ─────────────────────────┐
│  React-приложение (apps/web)                                                  │
│  Dashboard · Stations · Simulation · Analytics · Alerts · Admin · Login       │
│  live-store (Zustand) ◄── WebSocket /ws (снимки по тикам)                     │
│  REST-запросы (история, команды) ──► /api/*                                   │
└───────────────────────────────▲───────────────────────────────────────────────┘
                                │ HTTP + WS, порт 3000
┌───────────────────────────────┴───────────────────────────────────────────────┐
│  Сервер Fastify (apps/server)                                                 │
│   ├─ routes/        REST API, проверка ролей, валидация (zod)                 │
│   ├─ simulator/     часы симуляции, сценарии, модель волны, seeded-PRNG       │
│   ├─ pipeline/      ТИК: измерения → риск → предупреждения → снимок (1 транзакция)│
│   ├─ alerts/        жизненный цикл предупреждений, дедупликация               │
│   ├─ realtime/      рассылка снимков по WebSocket                             │
│   └─ db/            node:sqlite, миграции, seed, backup                       │
│  packages/shared    типы, расчёт риска (чистые функции), коды причин          │
└───────────────────────────────▲───────────────────────────────────────────────┘
                                │
                     data/qorgan.db (SQLite)  +  data/backups/*.db
```

Каталоги (создаются в Phase 1):

```
apps/server/   — backend (Fastify, TypeScript)
apps/web/      — frontend (React, Vite, TypeScript)
packages/shared/ — общие типы + risk engine + scenario definitions (без зависимостей от БД/DOM)
data/          — файл БД и резервные копии (в .gitignore)
docs/          — документация
```

## 2. Ответственность компонентов

| Компонент | Отвечает за | НЕ отвечает за |
|---|---|---|
| `packages/shared/risk` | Расчёт скорости, тренда, ETA, уровня риска, причин. Чистые функции, 100% покрытие тестами | Чтение БД, время, сеть |
| `packages/shared/scenarios` | Описание сценариев (параметры волны) | Запуск |
| `server/simulator` | Часы симуляции (тики), генерация уровней по модели волны, состояние IDLE/RUNNING/PAUSED/FINISHED | Расчёт риска |
| `server/pipeline` | Один тик = одна транзакция: записать измерения → посчитать риск → обновить предупреждения → сформировать снимок | UI |
| `server/alerts` | Создание/эскалация/автозакрытие, подтверждение оператором, история статусов | Отправку SMS/почты (не делаем) |
| `server/realtime` | Рассылка снимка всем клиентам, снимок при подключении | Хранение |
| `server/routes` | REST API, авторизация, валидация, аудит админ-действий | Бизнес-расчёты |
| `web` | Отображение, ввод команд, переключение языка | Расчёт риска (только показывает серверный результат) |

**Главное правило согласованности:** риск и прогноз считаются **только на сервере** один раз за тик и сохраняются в БД. Карта, графики, прогноз и предупреждения показывают одни и те же данные одного и того же тика (`runId + tick`).

## 3. Виртуальные станции (учебные позиции на реальной реке)

География проверена 2026-10-28 по данным OpenStreetMap (© участники OSM, ODbL): линия реки Есіл/Ишим (`waterway=river`, `name:ru=Ишим`) и населённые пункты рядом с руслом. Порядок с юга (выше по течению) на север (ниже по течению). Расстояния — кратчайший путь по линиям реки OSM, округлены.

| Код | Название (учебное) | Ближайший н. п. | Координаты точки на русле (lat, lon) | Расстояние до следующей | База, см | Порог «внимание» W, см | Порог «опасно» D, см |
|---|---|---|---|---|---|---|---|
| QRG-01 | Виртуальная станция «Сергеевка» | г. Сергеевка (ниже Сергеевского вдхр.) | 53.8809, 67.4335 | ≈153 км | 300 | 450 | 550 |
| QRG-02 | Виртуальная станция «Явленка» | с. Явленка | 54.3484, 68.4465 | ≈154 км | 280 | 420 | 520 |
| QRG-03 | Виртуальная станция «Петропавловск» | г. Петропавловск | 54.8825, 69.1172 | ≈52 км | 320 | 480 | 580 |
| QRG-04 | Виртуальная станция «Соколовка» | с. Соколовка | 55.1165, 69.2103 | — (конец цепочки) | 260 | 400 | 500 |

Ограничения (обязательно показывать в UI и на защите):
- Это **не реальные гидропосты Казгидромета**; координаты — точки на русле рядом с населённым пунктом.
- Уровни в «см над учебным нулём», пороги W/D — **учебные**, не официальные.
- Задержка волны рассчитана из учебной скорости добегания 3 км/ч (см. §7) — не измеренная величина.

## 4. Модель данных (SQLite)

Время: `sim_tick` (номер тика) + `sim_time` (ISO-время симуляции) + `created_at` (реальное время записи).

```sql
users(id PK, username UNIQUE, password_hash, role CHECK(role IN ('operator','admin')), created_at)

stations(id PK, code UNIQUE, name_key, lat, lon, order_index UNIQUE,  -- порядок вдоль реки
         base_level_cm, warning_cm, danger_cm, travel_hours_to_next, attenuation,
         is_active, updated_at)
         CHECK(warning_cm < danger_cm)

sim_runs(id PK, scenario_id, seed, params_json, tick_ms, status, started_at, finished_at)

sim_state(id=1 PK, run_id, status CHECK(status IN ('IDLE','RUNNING','PAUSED','FINISHED')),
          current_tick, tick_ms, updated_at)               -- одна строка, переживает перезапуск

measurements(id PK, run_id FK, station_id FK, tick, sim_time, level_cm,
             source CHECK(source IN ('simulated','manual')), created_at,
             UNIQUE(run_id, station_id, tick))             -- защита от дублей

risk_assessments(id PK, run_id, station_id, tick, level_cm, rate_cm_h, trend, risk,
                 eta_danger_h, eta_low_h, eta_high_h, confidence,
                 warning_cm, danger_cm,                    -- пороги, действовавшие в момент расчёта
                 reasons_json, UNIQUE(run_id, station_id, tick))

alerts(id PK, run_id, station_id, severity CHECK(severity IN ('MEDIUM','HIGH')),
       status CHECK(status IN ('ACTIVE','ACKNOWLEDGED','RESOLVED')),
       opened_tick, last_tick, resolved_tick, reasons_json, created_at, updated_at)
CREATE UNIQUE INDEX one_open_alert ON alerts(run_id, station_id) WHERE status <> 'RESOLVED';

alert_events(id PK, alert_id FK, tick, type CHECK(type IN ('OPENED','ESCALATED','DEESCALATED',
             'ACKNOWLEDGED','RESOLVED_AUTO','RESOLVED_MANUAL')), user_id NULL, comment, created_at)

audit_log(id PK, user_id, action, entity, entity_id, before_json, after_json, created_at)
```

## 5. Модели (TypeScript, packages/shared)

```ts
type Risk = 'LOW' | 'MEDIUM' | 'HIGH';
type Trend = 'RISING' | 'STABLE' | 'FALLING' | 'UNKNOWN';
type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

interface Measurement { runId: number; stationId: number; tick: number; simTime: string;
  levelCm: number; source: 'simulated' | 'manual' }

interface RiskResult { risk: Risk; levelCm: number; rateCmH: number | null; trend: Trend;
  etaDangerH: number | null;           // 0 = порог уже превышен; null = не ожидается/нет данных
  etaRangeH: [number, number | null] | null;  // неопределённость (null справа = «не ограничено»)
  confidence: Confidence; reasons: Reason[] }

interface Reason { code: ReasonCode; params?: Record<string, number | string> }
// коды переводятся на фронтенде: LEVEL_ABOVE_DANGER, LEVEL_ABOVE_WARNING, ETA_DANGER_WITHIN,
// RISING, FALLING, STABLE, INSUFFICIENT_DATA, SPIKE_IGNORED, SPIKE_UNCONFIRMED, SUDDEN_JUMP, UPSTREAM_WAVE

interface Alert { id; stationId; severity: 'MEDIUM' | 'HIGH';
  status: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED'; openedTick; lastTick; reasons: Reason[] }

interface Snapshot { runId: number; tick: number; simTime: string; simStatus: SimStatus;
  stations: Array<{ stationId: number; levelCm: number; risk: RiskResult }>;
  openAlerts: Alert[] }
```

## 6. Симулятор: состояния

```
           start(scenario, seed)            pause
  IDLE ─────────────────────────► RUNNING ◄────────► PAUSED
   ▲                                 │      resume      │
   │            reset (новый run)    │ последний тик    │
   └─────────────────────────────────┴──► FINISHED ◄───┘ (reset из любого состояния → IDLE)
```

- `step` — один тик вручную, доступен в состоянии PAUSED — удобно на защите.
- Недопустимые переходы → HTTP 409 (например, start при RUNNING).
- После перезапуска сервера: если в БД было RUNNING → становится **PAUSED** на последнем сохранённом тике. Оператор нажимает «Продолжить».
- Таймер тиков — один `setTimeout`-цикл на сервере; следующий тик планируется только после завершения транзакции предыдущего (тики не накладываются).

## 7. Модель паводковой волны (учебная, упрощённая)

Не физическая гидродинамика. Цель — наглядно и воспроизводимо показать добегание волны.

**Время:** 1 тик = 1 час симуляции. Реальная длительность тика `tick_ms` по умолчанию 1000 мс (настраивается 250–3000 мс).

**Станция-источник (QRG-01):** гидрограф сценария
```
h1(t) = base1 + A · pulse(t) + daily(t) + noise(t)
pulse(t) — трапеция: 0 до t0; линейный рост за T_rise ч до 1; плато T_peak ч; линейный спад за T_fall ч до 0
daily(t) = a_d · sin(2π t / 24)          (суточное колебание, a_d ≈ 3 см)
noise(t) — равномерный шум ±σ, PRNG mulberry32(seed)  (σ ≈ 2 см)
```

**Нижние станции (k = 2..4):**
```
h_k(t) = base_k + α_k · (h_{k-1}(t − τ_k) − base_{k-1}) + L_k(t) + noise_k(t)
τ_k = round(distance_{k-1→k} / c),  c = 3 км/ч (учебная скорость добегания)
     → τ2 = 51 ч, τ3 = 51 ч, τ4 = 17 ч
α_k — коэффициент ослабления/усиления (учебно: α2 = 0.95, α3 = 1.05, α4 = 0.9)
L_k(t) — локальный приток из сценария (по умолчанию 0)
при t − τ_k < 0 используется базовый уровень
```
Шум в формуле нижней станции берётся от **чистого** (без шума) уровня верхней станции, чтобы шум не накапливался по цепочке.

**Сценарии (packages/shared/scenarios):**

| ID | Название | A, см | t0 / T_rise / T_peak / T_fall, ч | Особенности | Ожидаемый результат |
|---|---|---|---|---|---|
| SC-NORMAL | Обычный режим | 0 | — | только суточные колебания | все станции LOW |
| SC-MODERATE | Умеренный паводок | 180 | 5 / 24 / 12 / 48 | — | пики ≈480 / 451 / 500 / 422 см: каждая станция по очереди выше W, ниже D → MEDIUM |
| SC-SEVERE | Сильный весенний паводок | 300 | 5 / 18 / 24 / 60 | L3 = +40 см во время пика (приток) | пики ≈600 / 565 / 659 / 565 см: все 4 станции по очереди выше D → HIGH, предупреждения идут по цепочке |
| SC-SENSOR | Сбой датчика | 120 | 5 / 24 / 12 / 48 | одиночные выбросы +150 см у QRG-02 на тиках 30 и 60 | выбросы не создают ложных предупреждений: сначала SPIKE_UNCONFIRMED, на следующем тике SPIKE_IGNORED |

**Ручной режим** (роль operator):
- изменить параметры сценария (A, T_*, seed) перед стартом;
- «ручное измерение» — записать значение уровня на станции в текущем тике (`source='manual'`, заменяет симулированное значение этой станции на этом тике, если тик ещё не записан; иначе — на следующий тик);
- управление: старт / пауза / продолжить / шаг / сброс / скорость.

**Воспроизводимость:** одинаковые `scenario + params + seed` ⇒ побитово одинаковые ряды (кроме ручных измерений). Проверяется тестом TC-S01.

## 8. Математическая модель риска

Для каждой станции на каждом тике. Параметры (учебные, в конфиге):
`N = 6` (окно, точек), `N_min = 3`, `ε = 0.5 см/ч`, `J_max = 50 см/тик`, `H_high = 6 ч`, `H_med = 24 ч`, `H_up = 72 ч` (горизонт учёта волны с верхней станции).

1. **Окно:** последние N измерений станции в текущем прогоне.
2. **Выбросы:** точка j (не последняя) — *одиночный выброс*, если `|h_j − h_{j−1}| > J_max` и `|h_{j+1} − h_{j−1}| ≤ J_max/2`. Исключается из расчёта → причина `SPIKE_IGNORED`.
   Последняя точка со скачком `|h_n − h_{n−1}| > J_max` — *неподтверждённый скачок*: в этом тике расчёт ведётся по предыдущей точке, причина `SPIKE_UNCONFIRMED`, доверие LOW. Если следующий тик не вернулся (скачок устойчив) — точка принимается, причина `SUDDEN_JUMP`.
3. **Скорость** `v` — наклон линейной регрессии МНК по (t, h) оставшихся точек, см/ч:
   `v = Σ(t−t̄)(h−h̄) / Σ(t−t̄)²`. Если точек < N_min → `v = null`, тренд `UNKNOWN`, причина `INSUFFICIENT_DATA`.
4. **Тренд:** `RISING` если v > ε; `FALLING` если v < −ε; иначе `STABLE`.
5. **ETA до опасного порога D:**
   - `h ≥ D` → ETA = 0 («порог уже превышен»);
   - `RISING` → ETA = (D − h) / v;
   - иначе → null («превышение не ожидается при текущей тенденции»).
6. **Неопределённость:** стандартная ошибка наклона `SE = sqrt( Σres² / (n−2) / Σ(t−t̄)² )` (n ≥ 3).
   Диапазон ETA: `[(D−h)/(v+SE), (D−h)/(v−SE)]`; если `v − SE ≤ ε`, правая граница = null («не ограничено»).
   Доверие: HIGH — n = N и SE ≤ 0.25·|v|; MEDIUM — n ≥ N_min; LOW — n < N_min или был `SPIKE_UNCONFIRMED`.
7. **Уровень риска (первое сработавшее правило):**
   - HIGH: `h ≥ D` **или** (RISING и ETA ≤ H_high);
   - MEDIUM: `h ≥ W` **или** (RISING и ETA ≤ H_med) **или** (станция выше по течению в HIGH и τ ≤ H_up → `UPSTREAM_WAVE{station, hours:τ}` — «волна ожидается примерно через τ ч»);
   - LOW: иначе.
8. **Причины** — список кодов с параметрами (`{code:'ETA_DANGER_WITHIN', params:{hours:10}}`), язык подставляет фронтенд.

Это **прозрачный детерминированный алгоритм** (линейная регрессия + правила). Не машинное обучение и не нейросеть — так и говорим на защите.

## 9. Предупреждения

- Риск станции LOW → MEDIUM/HIGH: если открытого предупреждения нет — создаётся (`OPENED`).
- Риск растёт MEDIUM → HIGH: то же предупреждение повышается (`ESCALATED`); снижение HIGH → MEDIUM — `DEESCALATED`. Новое не создаётся.
- Риск LOW **3 тика подряд** → автоматическое закрытие (`RESOLVED_AUTO`) — гистерезис против «мигания».
- Оператор: «Подтвердить» (ACTIVE → ACKNOWLEDGED, с комментарием), «Закрыть» вручную (`RESOLVED_MANUAL`).
- Дубли исключены уникальным индексом «одно открытое предупреждение на станцию в прогоне» + обработка в той же транзакции, что и тик.
- Новое повышение после закрытия → новое предупреждение.

## 10. API

Все ответы — JSON. Ошибки: `{ error: { code, message } }`. Коды: 400 валидация, 401 не вошёл, 403 нет роли, 404, 409 недопустимое состояние.

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| GET | `/api/health` | — | проверка работы, версия БД |
| POST | `/api/auth/login` · `/api/auth/logout` · GET `/api/auth/me` | — | сессия (httpOnly cookie) |
| GET | `/api/state` | — | текущий Snapshot (то же, что по WS) |
| GET | `/api/stations` · `/api/stations/:id` | — | станции и текущие показатели |
| GET | `/api/stations/:id/measurements?runId&fromTick&toTick` | — | история измерений |
| GET | `/api/stations/:id/risk?runId&fromTick&toTick` | — | история оценок риска |
| GET | `/api/scenarios` | — | список сценариев и параметры по умолчанию |
| GET | `/api/runs` | — | прошлые прогоны |
| POST | `/api/simulation/start` `{scenarioId, seed?, params?, tickMs?}` | operator | старт |
| POST | `/api/simulation/pause` · `/resume` · `/step` · `/reset` | operator | управление |
| PATCH | `/api/simulation/settings` `{tickMs}` | operator | скорость |
| POST | `/api/simulation/manual-measurement` `{stationId, levelCm}` | operator | ручной ввод |
| GET | `/api/alerts?status&runId` · `/api/alerts/:id/events` | — | журнал |
| POST | `/api/alerts/:id/ack` · `/api/alerts/:id/resolve` `{comment?}` | operator | действия оператора |
| PATCH | `/api/admin/stations/:id` `{warningCm, dangerCm, ...}` | admin | пороги/параметры (+audit) |
| GET/POST/PATCH | `/api/admin/users` | admin | пользователи (если требует ТЗ) |
| GET | `/api/admin/audit` | admin | журнал действий |
| POST | `/api/admin/backup` | admin | резервная копия БД |

Чтение (GET) открыто без входа — режим наблюдателя; это решение подлежит сверке с ТЗ.

## 11. Обновление в реальном времени

- `GET /ws` (WebSocket, `@fastify/websocket`). Только сервер → клиент; команды идут через REST.
- Сообщения: `{type:'snapshot', data: Snapshot}` при подключении и после каждого тика/команды; `{type:'alert_event', data}`; `{type:'station_updated', data}`.
- Каждый снимок несёт `runId + tick`; клиент игнорирует снимки старше текущего.
- Обрыв связи: клиент переподключается (1 с → 2 с → 5 с), получает свежий снимок; в UI индикатор «Связь потеряна».
- История для графиков — через REST, затем дополняется точками из снимков.

## 12. Локализация

- `i18next` + `react-i18next`, файлы `apps/web/src/i18n/{kk,ru,en}.json`, язык по умолчанию — ru, выбор сохраняется в localStorage.
- Сервер не отдаёт готовых фраз: только коды (`ReasonCode`, статусы, названия станций по ключу). Фронтенд переводит.
- Числа/даты — `Intl.NumberFormat` / `Intl.DateTimeFormat` с локалью `kk-KZ`, `ru-RU`, `en-GB`.
- Тест: во всех трёх файлах одинаковый набор ключей (TC-I01). Казахский перевод проверяет носитель языка из команды.

## 13. Авторизация (минимальная)

- Роли: `operator` (симуляция, предупреждения), `admin` (всё + станции, пороги, пользователи, аудит). Без входа — только просмотр.
- Пароли — `scrypt` из `node:crypto`, сессия — подписанный httpOnly cookie (`@fastify/cookie`), срок 12 ч.
- Демо-пользователи создаются seed-скриптом; пароли задаются в `.env` (в git только `.env.example` без реальных секретов).
- Не делаем: регистрацию, OAuth, восстановление пароля.

## 14. Резервное копирование и восстановление

- БД: `data/qorgan.db`; резервная копия — `VACUUM INTO 'data/backups/qorgan-YYYYMMDD-HHMM.db'` (команда `npm run db:backup` и кнопка в Admin).
- Полный сброс к демо-состоянию: `npm run db:reset` (удаляет БД, миграции, seed).
- Код: коммит после каждого этапа + локальные теги `checkpoint-*` перед рискованными изменениями; откат через GitHub Desktop.
- `git push` — только с разрешения пользователя.

## 15. Запуск

- Разработка: `npm install` → `npm run dev` (сервер :3000 + Vite :5173 с прокси `/api` и `/ws`).
- Демо (надёжнее): `npm run build` → `npm start` — один процесс Fastify на :3000 отдаёт и API, и собранный фронтенд. `start-demo.bat` для запуска двойным кликом.
- Карта: стиль OpenFreeMap `dark` (проверен, ключ не нужен). **Офлайн-запас:** линия реки и точки станций вшиты в проект как GeoJSON (из OSM) — без интернета карта показывает реку и станции на тёмном фоне без подложки.
