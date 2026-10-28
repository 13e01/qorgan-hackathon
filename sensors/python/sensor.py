"""
QORGAN — программный датчик уровня воды (Python).

Отдельная программа, которая работает как физический датчик: сама генерирует показания уровня воды
и передаёт их по MQTT. С сайтом и встроенным симулятором QORGAN она не связана и данных у них не берёт.

    python sensor.py --mode NORMAL            # запуск (настройки подключения берутся из ../../.env)
    во время работы: N — норма, R — подъём, D — опасный подъём, F — спад, Q — выход (буква + Enter)

Протокол — docs/PYTHON_SENSOR.md.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import random
import signal
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

MODES = ("NORMAL", "RISING", "DANGER", "FALLING")
MODE_KEYS = {"N": "NORMAL", "R": "RISING", "D": "DANGER", "F": "FALLING"}
TOPIC_PREFIX = "qorgan/v1/sensors"
# QORGAN сообщает здесь, принимает ли он данные: online — подписка подтверждена, offline — сервер недоступен.
SERVER_STATUS_TOPIC = "qorgan/v1/server/status"
# QORGAN не принимает показания старше 5 минут — дольше их хранить в буфере нет смысла.
BUFFER_MAX_AGE_S = 300
MIN_CM, MAX_CM = 0.0, 1500.0


# ── Модель уровня воды (только своя физика датчика) ─────────────────────────────────────────────────────────
# Уровни ниже — учебные значения для демонстрации (подобраны под учебные пороги станции Петропавловск в QORGAN:
# предупредительный 480 см, опасный 580 см). Это НЕ официальные гидрологические нормы.
DEFAULT_BASE_CM = 320.0      # начальный (нормальный) уровень
DEFAULT_RISING_PEAK_CM = 500.0  # куда уровень поднимается в режиме RISING
DEFAULT_DANGER_PEAK_CM = 650.0  # пик опасного подъёма в режиме DANGER
DEFAULT_SEED = 1


@dataclass
class WaterLevelModel:
    """Уровень воды у датчика. Один шаг = одно показание (по умолчанию раз в 2 с).

    Каждый режим ведёт уровень к своей цели и не дальше — бесконечного роста нет:
      NORMAL  → к начальному уровню (медленно, если вода была выше);
      RISING  → к умеренному пику rising_peak_cm;
      DANGER  → к опасному пику danger_peak_cm (быстро, у пика плавно замедляется и держится);
      FALLING → к начальному уровню (спад быстрее, чем в NORMAL).
    Шаг = доля оставшегося расстояния (gain), но не больше скорости режима — подъём ровный, у цели плавный.
    Шум детерминирован: одинаковые seed и последовательность режимов дают одинаковый ряд.
    """

    level_cm: float = DEFAULT_BASE_CM
    seed: int | None = DEFAULT_SEED
    rising_peak_cm: float = DEFAULT_RISING_PEAK_CM
    danger_peak_cm: float = DEFAULT_DANGER_PEAK_CM
    # Наибольшая скорость изменения за одно показание, см.
    normal_step: float = 4.0
    rising_step: float = 6.0
    danger_step: float = 18.0
    falling_step: float = 12.0
    gain: float = 0.25
    noise_cm: float = 0.6
    _rng: random.Random = field(init=False, repr=False)
    _base: float = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if not (MIN_CM <= self.level_cm <= MAX_CM):
            raise ValueError(f"начальный уровень вне диапазона {MIN_CM:g}–{MAX_CM:g} см")
        if not (self.level_cm < self.rising_peak_cm <= self.danger_peak_cm <= MAX_CM):
            raise ValueError("нужно: начальный уровень < пик RISING <= пик DANGER <= 1500 см")
        self._rng = random.Random(self.seed)
        self._base = self.level_cm

    @property
    def base_cm(self) -> float:
        return self._base

    def target(self, mode: str) -> tuple[float, float]:
        """Цель и наибольший шаг режима."""
        if mode == "NORMAL":
            return self._base, self.normal_step
        if mode == "RISING":
            return self.rising_peak_cm, self.rising_step
        if mode == "DANGER":
            return self.danger_peak_cm, self.danger_step
        if mode == "FALLING":
            return self._base, self.falling_step
        raise ValueError(f"неизвестный режим: {mode}")

    def step(self, mode: str) -> float:
        goal, max_step = self.target(mode)
        delta = goal - self.level_cm
        move = min(max_step, abs(delta) * self.gain)
        if abs(delta) < 0.05:
            self.level_cm = goal
        else:
            self.level_cm += move if delta > 0 else -move
        self.level_cm = min(MAX_CM, max(MIN_CM, self.level_cm))
        noise = self._rng.uniform(-self.noise_cm, self.noise_cm)
        return round(min(MAX_CM, max(MIN_CM, self.level_cm + noise)), 1)


# ── Сообщение ───────────────────────────────────────────────────────────────────────────────────────────────
def telemetry_topic(device_id: str) -> str:
    return f"{TOPIC_PREFIX}/{device_id}/telemetry"


def status_topic(device_id: str) -> str:
    return f"{TOPIC_PREFIX}/{device_id}/status"


def can_send(broker_connected: bool, server_online: bool) -> bool:
    """Показание отправляется, только если есть связь с брокером И QORGAN подписан (иначе брокер его просто отбросит)."""
    return broker_connected and server_online


def iso_now(now: datetime | None = None) -> str:
    """Время измерения: UTC, ISO 8601 с миллисекундами и смещением."""
    moment = now or datetime.now(timezone.utc)
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_message(device_id: str, station_id: str, value: float, seq: int, boot_id: str, mode: str, now: datetime | None = None) -> dict:
    return {
        "v": 1,
        "deviceId": device_id,
        "stationId": station_id,
        "type": "water_level",
        "value": value,
        "unit": "cm",
        "timestamp": iso_now(now),
        "seq": seq,
        "bootId": boot_id,
        "source": "PYTHON_SENSOR",
        "mode": mode,
    }


# ── Настройки из .env QORGAN (чтобы ничего не редактировать руками) ─────────────────────────────────────────
def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


# ── Буфер на время потери связи ─────────────────────────────────────────────────────────────────────────────
class OutBuffer:
    """Показания, ещё не подтверждённые брокером. Старше 5 минут — отбрасываются (сервер их всё равно не примет)."""

    def __init__(self, max_items: int = 1000) -> None:
        self._items: collections.deque[tuple[float, dict]] = collections.deque(maxlen=max_items)
        self._lock = threading.Lock()

    def add(self, created: float, message: dict) -> None:
        with self._lock:
            self._items.append((created, message))

    def take_fresh(self, now: float) -> list[dict]:
        with self._lock:
            fresh = [m for (t, m) in self._items if now - t <= BUFFER_MAX_AGE_S]
            self._items.clear()
            return fresh

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)


# ── Один экземпляр датчика на устройство ────────────────────────────────────────────────────────────────────
def acquire_single_instance(path: Path):
    """Блокировка файла: второй датчик с тем же устройством не запустится (иначе два потока показаний смешались бы).
    Блокировку снимает операционная система, когда процесс завершается, даже аварийно. None — уже запущен."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+")
    try:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


# ── Программа ───────────────────────────────────────────────────────────────────────────────────────────────
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description="QORGAN: программный датчик уровня воды (MQTT)")
    p.add_argument("--mode", choices=MODES, default="NORMAL", type=str.upper, help="начальный режим")
    p.add_argument("--interval", type=float, default=2.0, help="секунд между показаниями (в QORGAN 1 ч модели = 2 с)")
    p.add_argument("--initial", type=float, default=DEFAULT_BASE_CM, help="начальный (нормальный) уровень, см; к нему возвращают N и F")
    p.add_argument("--rising-peak", type=float, default=DEFAULT_RISING_PEAK_CM, help="учебный пик режима RISING, см")
    p.add_argument("--danger-peak", type=float, default=DEFAULT_DANGER_PEAK_CM, help="учебный пик режима DANGER, см")
    p.add_argument("--env", type=Path, default=root / ".env", help="файл настроек QORGAN")
    p.add_argument("--device-id", help="идентификатор устройства (по умолчанию SENSOR_DEVICE_ID из .env)")
    p.add_argument("--station", help="код станции (по умолчанию SENSOR_STATION из .env)")
    p.add_argument("--token", help="пароль устройства (по умолчанию SENSOR_TOKEN из .env)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, help="порт брокера (по умолчанию MQTT_PORT из .env или 1883)")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED, help="зерно шума: одинаковое зерно и режимы — одинаковый ряд")
    p.add_argument("--count", type=int, help="остановиться после N показаний (для проверок)")
    p.add_argument("--no-keyboard", action="store_true", help="не читать команды с клавиатуры")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    env = read_env(args.env)
    device_id = args.device_id or env.get("SENSOR_DEVICE_ID", "PY-SENSOR-01")
    station = args.station or env.get("SENSOR_STATION", "QRG-03")
    token = args.token or env.get("SENSOR_TOKEN", "")
    port = args.port or int(env.get("MQTT_PORT", "1883"))
    if not token or token == "replace-me":
        print("Нет пароля датчика (SENSOR_TOKEN в .env). Выполните в папке проекта: npm run setup")
        return 2
    lock = acquire_single_instance(Path(__file__).resolve().parent / f".sensor-{device_id}.lock")
    if lock is None:
        print(f"Датчик {device_id} уже запущен в другом окне. Второй экземпляр не нужен — пользуйтесь открытым окном")
        print("(или закройте его: Q + Enter) и запустите снова.")
        return 3
    try:
        import paho.mqtt.client as mqtt  # type: ignore[import-not-found]
    except ImportError:
        print("Не установлена библиотека paho-mqtt. Запустите start-sensor.bat — он установит её сам,")
        print("или выполните: py -m pip install -r sensors/python/requirements.txt")
        return 2

    try:
        model = WaterLevelModel(level_cm=args.initial, seed=args.seed, rising_peak_cm=args.rising_peak, danger_peak_cm=args.danger_peak)
    except ValueError as error:
        print(f"Неверные настройки уровней: {error}")
        return 2
    boot_id = uuid.uuid4().hex[:12]
    state = {"mode": args.mode, "connected": False, "server": False, "stop": False, "seq": 0}
    buffer = OutBuffer()
    pending: dict[int, dict] = {}
    pending_lock = threading.Lock()

    client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=f"{device_id}-{boot_id}", clean_session=True)
    client.username_pw_set(device_id, token)
    # «Завещание»: если связь оборвётся, брокер сам сообщит QORGAN, что датчик offline.
    client.will_set(status_topic(device_id), "offline", qos=1, retain=True)
    client.reconnect_delay_set(min_delay=1, max_delay=5)

    def log(text: str) -> None:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {text}", flush=True)

    def on_connect(_c, _u, _flags, reason_code, _props):  # noqa: ANN001
        if reason_code.is_failure:
            log(f"брокер отказал в подключении: {reason_code} — проверьте SENSOR_TOKEN (npm run setup) и что QORGAN хотя бы раз запускался")
            return
        state["connected"] = True
        log(f"подключено к mqtt://{args.host}:{port} как {device_id}")
        client.publish(status_topic(device_id), "online", qos=1, retain=True)
        client.subscribe(SERVER_STATUS_TOPIC, qos=1)

    def flush() -> None:
        # Показания, накопленные без связи, отправляются по порядку (сервер отбросит повторы по bootId + seq).
        fresh = buffer.take_fresh(time.monotonic())
        if fresh:
            log(f"QORGAN на связи — отправляю накопленные показания: {len(fresh)}")
        for msg in fresh:
            send(msg)

    def on_message(_c, _u, message):  # noqa: ANN001
        if message.topic != SERVER_STATUS_TOPIC:
            return
        online = message.payload.decode("utf-8", "replace").strip().lower() == "online"
        if online and not state["server"]:
            state["server"] = True
            log("QORGAN принимает данные (server online)")
            flush()
        elif not online and state["server"]:
            state["server"] = False
            log("QORGAN недоступен (server offline) — показания копятся в буфере")

    def on_disconnect(_c, _u, _flags, reason_code, _props):  # noqa: ANN001
        if state["connected"] and not state["stop"]:
            log(f"связь потеряна ({reason_code}) — показания копятся в буфере, переподключаюсь…")
        state["connected"] = False
        state["server"] = False
        # Неподтверждённые сообщения возвращаются в буфер — после переподключения уйдут снова.
        with pending_lock:
            for msg in pending.values():
                buffer.add(time.monotonic(), msg)
            pending.clear()

    def on_publish(_c, _u, mid, _reason, _props):  # noqa: ANN001
        with pending_lock:
            pending.pop(mid, None)

    def send(msg: dict) -> None:
        info = client.publish(telemetry_topic(device_id), json.dumps(msg, ensure_ascii=False), qos=1, retain=False)
        if info.rc == mqtt.MQTT_ERR_SUCCESS:
            with pending_lock:
                pending[info.mid] = msg
        else:
            buffer.add(time.monotonic(), msg)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_publish = on_publish
    client.on_message = on_message

    def stop(*_args) -> None:  # noqa: ANN002
        state["stop"] = True

    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop)

    def keyboard() -> None:
        for line in sys.stdin:
            key = line.strip().upper()[:1]
            if key == "Q":
                stop()
                return
            if key in MODE_KEYS:
                state["mode"] = MODE_KEYS[key]
                goal, _ = model.target(state["mode"])
                log(f"режим → {state['mode']} (цель {goal:g} см)")

    print("=" * 72)
    print(f" QORGAN · программный датчик уровня воды · устройство {device_id} · станция {station}")
    print(f" Брокер mqtt://{args.host}:{port} · показание каждые {args.interval:g} с")
    print(f" Учебные уровни: норма {args.initial:g} см · подъём до {args.rising_peak:g} см · опасный пик {args.danger_peak:g} см")
    print(" Команды: N — норма (возврат к начальному), R — подъём, D — опасный подъём, F — спад, Q — выход (буква + Enter)")
    print("=" * 72)
    if not args.no_keyboard:
        threading.Thread(target=keyboard, daemon=True).start()

    client.connect_async(args.host, port, keepalive=15)
    client.loop_start()
    next_at = time.monotonic()
    try:
        while not state["stop"]:
            state["seq"] += 1
            mode = state["mode"]
            value = model.step(mode)
            msg = build_message(device_id, station, value, state["seq"], boot_id, mode)
            if can_send(state["connected"], state["server"]):
                send(msg)
                status = "отправлено"
            else:
                buffer.add(time.monotonic(), msg)
                reason = "нет связи" if not state["connected"] else "ждём QORGAN"
                status = f"{reason}, в буфере {len(buffer)}"
            log(f"#{state['seq']:<4} {mode:<8} {value:7.1f} см  {status}")
            if args.count and state["seq"] >= args.count:
                time.sleep(1.0)  # дать дойти подтверждению последнего сообщения
                break
            next_at += args.interval
            time.sleep(max(0.0, next_at - time.monotonic()))
    finally:
        state["stop"] = True
        log("остановка датчика…")
        if len(buffer):
            log(f"не отправлено (не было связи): {len(buffer)} показ.")
        if state["connected"]:
            client.publish(status_topic(device_id), "offline", qos=1, retain=True).wait_for_publish(timeout=2)
        client.disconnect()
        client.loop_stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
