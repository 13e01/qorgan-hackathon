# QORGAN Sentinel — архитектура (ML, Telegram, звук)

> Ветка `revolution/qorgan-sentinel`. Дополняет [ARCHITECTURE.md](ARCHITECTURE.md), ничего в существующей цепочке не заменяет.

## 1. Цепочка

```
Python-датчик / симулятор ─► POST /api/telemetry ─► ingest (одна транзакция):
                                                      измерения → часы прогона → риск T2 (risk_assessments)
                                                      → ML Sentinel (ml_assessments)            ← новое, параллельно
                                                      → предупреждения T2 (alerts, alert_events)
                                                      → очередь Telegram (telegram_outbox)      ← новое
                               после фиксации ─► WebSocket-снимок (+ ml по станциям, mlModel) ─► интерфейс
                                              ─► TelegramService.kick() ─► sendMessage (повторы, лимиты)
интерфейс: снимок → новые/обострившиеся предупреждения → звук (Web Audio), если пользователь включил
```

Отдельных процессов не добавлено: ML вычисляется в процессе сервера (TypeScript, без Python), бот — цикл внутри сервера. `start-demo.bat` и `stop-demo.bat` не менялись.

## 2. Решения
- **Официальное состояние — правила T2.** ML не пишет в `risk_assessments` и `alerts`; тест `sentinel-ml.test.ts` сравнивает журнал предупреждений одного прогона с ML и без ML — он совпадает полностью.
- **ML без Python на сервере** (ADR-038): обучение — Python/XGBoost (`ml/`), инференс и TreeSHAP — TypeScript (`packages/shared/src/ml`), паритет с XGBoost проверяется тестом. Обучения на сервере нет — только чтение JSON при старте.
- **Отказоустойчивость:** нет файла → `MISSING`; несовместим → `INVALID`; `ML_ENABLED=false` → `DISABLED`; ошибка расчёта станции → строка `ERROR`; исключение в ML или очереди Telegram ловится, пакет телеметрии всё равно фиксируется (тест с «ломающейся» моделью).
- **Один снимок:** оценка ML читается по тому же `runId` и `asOf`, что и оценка T2 (`latestMl(run, station, asOf)`).
- **Время:** оценки ML и сообщения Telegram используют модельное время измерения; журнал отправок — реальное время (подписано «реальное»).

## 3. Данные (миграция v5 `sentinel`, только новые таблицы)

| Таблица | Назначение |
|---|---|
| `ml_assessments(run_id, station_id, tick, as_of, model_version, status, category, p_danger, p_warning, rules_risk, agreement, result_json, computed_at)` | оценка ML на каждый тик и станцию; `rules_risk` — категория T2 того же тика, `agreement` — AGREE / ML_HIGHER / ML_LOWER |
| `telegram_links(chat_id UNIQUE, user_id, tg_username, lang, subscribed, …)` | привязка чата к пользователю QORGAN |
| `telegram_link_codes(code_hash PK, user_id, expires_at, used_at)` | одноразовые коды привязки (только SHA-256, 10 мин) |
| `telegram_outbox(chat_id, alert_id, run_id, station_id, tick, dedup_key UNIQUE, payload_json, status, attempts, next_attempt_at, last_error, …)` | очередь с защитой от повторов и состоянием отправки |
| `telegram_state(update_offset)` | смещение `getUpdates` (команды не обрабатываются дважды после перезапуска) |

Удаление прогона администратором удаляет и его `ml_assessments`.

## 4. API (роли — по ARCHITECTURE §10, вход — zod)

| Метод и путь | Роль | Назначение |
|---|---|---|
| `GET /api/ml/model` | гость | статус модели, версия, признаки, пороги, краткие метрики, сведения о данных (без деревьев) |
| `GET /api/stations/:id/ml[?runId]` | гость (runId — оператор) | `{ model: {status, version}, rules: {risk, score}, assessment: {category, pDanger, pWarning, agreement, result: {contributions, features, baseValue, …}} , context }` |
| `GET /api/stations/:id/ml/history?runId&limit` | оператор | оценки ML по тикам |
| `GET /api/telegram/status` | оператор | состояние бота, свои привязки (админ — все), журнал отправок |
| `POST /api/telegram/link-code` | оператор | одноразовый код и ссылка `t.me/<бот>?start=<код>` |
| `PATCH /api/telegram/links/:id {subscribed}` · `DELETE /api/telegram/links/:id` | владелец / админ | подписка, отвязка (в `audit_log`) |
| `POST /api/telegram/test` | оператор | проверочное сообщение в свои чаты (не чаще раза в минуту) |

Снимок WebSocket: у каждой станции `ml` (без вкладов SHAP), на верхнем уровне `mlModel: {status, version}`.

## 5. Интерфейс
- Карточка станции: блок **«Почему такой риск?»** (`components/MlExplain.tsx`) — категория ML, вероятность на 6 ч, совпадение/расхождение с основной оценкой, краткое объяснение, 3–5 факторов, источник, версия модели, модельное время анализа, учебный статус. Запрос — при новой оценке ML в снимке, не чаще раза в 800 мс. Расчётов в браузере нет.
- Верхняя строка: **кнопка звука** (`components/SoundControl.tsx`, `state/sound.tsx`, `lib/sound.ts`).
- Журнал предупреждений (оператору): раздел **«Telegram-уведомления»** (`components/TelegramPanel.tsx`).
- Hydro Future (главная) не менялась. Стили — в `eclipse.css`, только токены `styles.css`, обе темы; все строки — через `t()` (ru/kk/en).

## 6. Звук
- Звуки оригинальные, синтезируются Web Audio: средний — два мягких синусоидальных тона вверх (E5 → A5, ≈ 0,5 с); высокий — четыре коротких импульса треугольной волны (G5/B5, ≈ 0,8 с). Без сирен; пик громкости ≤ 0,3 × выбранная громкость.
- Когда звучит: только новое предупреждение или повышение MEDIUM → HIGH по снимку сервера; не при первом снимке после загрузки и не при смене прогона; не чаще раза в 4 с (HIGH сразу после MEDIUM разрешён); понижение риска не звучит.
- По умолчанию выключено. Включение — переключатель (это и есть разрешение браузера на звук: AudioContext создаётся в обработчике нажатия). Если звук был включён раньше, браузер разрешит его после первого нажатия на странице — об этом подсказка. Громкость 0–100 %, настройка в `localStorage` (`qorgan.sound`), кнопки «Проверить: средний / высокий».
- Доступность: кнопка с подписью и `aria-expanded`, переключатель `role="switch"`, ползунок с `aria-valuetext`, факт воспроизведения дублируется в `aria-live`; звук всегда дополняет текстовое уведомление.

## 7. Telegram
Подробно — [SENTINEL_TELEGRAM.md](SENTINEL_TELEGRAM.md).
