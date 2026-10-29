# QORGAN System Briefing — 60-секундный ролик

Короткий инструктаж о QORGAN для жюри перед живым выступлением: главная Hydro Future → рабочая панель →
учебный паводок от Python-датчика → действия оператора → логотип. Всё, что видно на экране, — запись настоящего
QORGAN на изолированном стенде; значения считает сервер.

**Готовый файл:** `renders/QORGAN_SYSTEM_BRIEFING_FINAL.mp4` (в git не хранится — см. «Где лежит»).
1920×1080, 60 к/с, H.264 + AAC 48 кГц, 60,0 с.

| Файл | Что это |
|---|---|
| [script.md](script.md) | дикторский текст с таймкодами и редакторский аудит |
| [storyboard.md](storyboard.md) | покадровый план: экран, курсор, камера, реплика, звук, переход |
| [sources.md](sources.md) | источники, инструменты, лицензии |
| [QA.md](QA.md) | отчёт о проверке готового ролика |
| `edit/narration.json` | реплики (текст + время начала) — единственный источник текста диктора |
| `edit/compositor.html` | покадровый компоновщик: камера, курсор, титры, окно датчика, финальная карточка |
| `edit/timeline.json` | монтажный план, собранный из журнала съёмки (`edit/timeline.js` — то же для компоновщика) |
| `capture/<дубль>/events.json`, `frames.json` | журнал съёмки: курсор, клики, метки сцен, вывод датчика, показания на экране; время кадров |
| `audio/vo/*.mp3` | синтезированные реплики |
| `tools/` | скрипты (ниже) |

## Как пересобрать ролик (Windows, Git Bash, из корня репозитория)

Нужно: Node 24, Python 3 (`py`), FFmpeg в PATH, Microsoft Edge, `npm install` выполнен, интерфейс собран.

```bash
npm run build
```
```bash
node production/system-briefing/tools/capture.mjs take4
```
Поднимает стенд (сервер :3210, брокер :1994, база `data/briefing-capture.db` — рабочую базу и порты 3000/1883
не трогает, пароли случайные и живут только в памяти), включает приём датчиков, снимает Edge без окна ≈ 70 с.
Порты 3210/1994 должны быть свободны. Кадры — `capture/take4/frames/` (~1–2 ГБ).

```bash
node production/system-briefing/tools/timeline.mjs take4
```
Строит монтажный план по меткам съёмки (время в ролике — объект `O` в `tools/timeline.mjs`).

```bash
py -m pip install --user edge-tts
```
```bash
node production/system-briefing/tools/voice.mjs
```
Синтез реплик (онлайн, Microsoft Neural, голос ru-RU-DmitryNeural). Сервис иногда отвечает пустым потоком —
скрипт повторяет запрос; полный синтез занимает 5–15 минут. `--no-synth` — только пересобрать WAV из готовых MP3.

```bash
node production/system-briefing/tools/mix.mjs
```
Музыка и SFX (синтез), сведение с голосом, громкость −16 LUFS.

```bash
node production/system-briefing/tools/build.mjs
```
Рендер 3600 кадров (≈ 5–8 мин) и сборка `renders/QORGAN_SYSTEM_BRIEFING_FINAL.mp4`, затем автоматические проверки
(длительность, разрешение, FPS, кодеки, громкость, чёрные и застывшие кадры) → `renders/qa-auto.json`.

Проверка отдельных кадров без рендера всего ролика:
```bash
node production/system-briefing/tools/render.mjs production/system-briefing/renders/work/still.png --still=5,20,35,50
```

## Честность
- Плашка «Учебная демонстрация · демо-данные» видна весь ролик; бейдж «Демо-данные · учебная модель» есть в самом интерфейсе.
- Ускоренные места подписаны «ускорено ×N» прямо в кадре (подъём воды, набор комментария).
- Окно датчика показывает его настоящий вывод; уровни учебные (норма 3,20 м, учебный пик 6,5 м).
- Голос синтезирован (Microsoft Neural TTS), это сказано в `sources.md`.
