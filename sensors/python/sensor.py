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
# QORGAN не принимает показания старше 5 минут — дольше их хранить в буфере нет смысла.
BUFFER_MAX_AGE_S = 300
MIN_CM, MAX_CM = 0.0, 1500.0


# ── Модель уровня воды (только своя физика датчика) ─────────────────────────────────────────────────────────
@dataclass
class WaterLevelModel:
    """Уровень воды у датчика. Один шаг = одно показание (по умолчанию раз в 2 с)."""

    level_cm: float = 320.0
    seed: int | None = None
    # Скорость изменения за одно показание, см.
    rising_step: float = 6.0
    danger_step: float = 18.0
    falling_step: float = 10.0
    noise_cm: float = 0.6
    _rng: random.Random = field(init=False, repr=False)
    _base: float = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._rng = random.Random(self.seed)
        self._base = self.level_cm

    def step(self, mode: str) -> float:
        if mode not in MODES:
            raise ValueError(f"неизвестный режим: {mode}")
        noise = self._rng.uniform(-self.noise_cm, self.noise_cm)
        if mode == "NORMAL":
            # Стабильный уровень: небольшое колебание без накопления (держится у текущего уровня).
            value = self.level_cm + noise
        elif mode == "RISING":
            self.level_cm += self.rising_step
            value = self.level_cm + noise
        elif mode == "DANGER":
            self.level_cm += self.danger_step
            value = self.level_cm + noise
        else:  # FALLING
            self.level_cm = max(self._base - 40.0, self.level_cm - self.falling_step)
            value = self.level_cm + noise
        self.level_cm = min(MAX_CM, max(MIN_CM, self.level_cm))
        return round(min(MAX_CM, max(MIN_CM, value)), 1)


# ── Сообщение ───────────────────────────────────────────────────────────────────────────────────────────────
def telemetry_topic(device_id: str) -> str:
    return f"{TOPIC_PREFIX}/{device_id}/telemetry"


def status_topic(device_id: str) -> str:
    return f"{TOPIC_PREFIX}/{device_id}/status"


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


# ── Программа ───────────────────────────────────────────────────────────────────────────────────────────────
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description="QORGAN: программный датчик уровня воды (MQTT)")
    p.add_argument("--mode", choices=MODES, default="NORMAL", type=str.upper, help="начальный режим")
    p.add_argument("--interval", type=float, default=2.0, help="секунд между показаниями (в QORGAN 1 ч модели = 2 с)")
    p.add_argument("--initial", type=float, default=320.0, help="начальный уровень, см")
    p.add_argument("--env", type=Path, default=root / ".env", help="файл настроек QORGAN")
    p.add_argument("--device-id", help="идентификатор устройства (по умолчанию SENSOR_DEVICE_ID из .env)")
    p.add_argument("--station", help="код станции (по умолчанию SENSOR_STATION из .env)")
    p.add_argument("--token", help="пароль устройства (по умолчанию SENSOR_TOKEN из .env)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, help="порт брокера (по умолчанию MQTT_PORT из .env или 1883)")
    p.add_argument("--seed", type=int, help="для повторяемого шума")
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
    try:
        import paho.mqtt.client as mqtt  # type: ignore[import-not-found]
    except ImportError:
        print("Не установлена библиотека paho-mqtt. Запустите start-sensor.bat — он установит её сам,")
        print("или выполните: py -m pip install -r sensors/python/requirements.txt")
        return 2

    model = WaterLevelModel(level_cm=args.initial, seed=args.seed)
    boot_id = uuid.uuid4().hex[:12]
    state = {"mode": args.mode, "connected": False, "stop": False, "seq": 0}
    buffer = OutBuffer()
    pending: dict[int, dict] = {}
    pending_lock = threading.Lock()

    client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=f"{device_id}-{boot_id}", clean_session=True)
    client.username_pw_set(device_id, token)
    # «Завещание»: если связь оборвётся, брокер сам сообщит QORGAN, что датчик offline.
    client.will_set(status_topic(device_id), "offline", qos=1, retain=True)
    client.reconnect_delay_set(min_delay=1, max_delay=10)

    def log(text: str) -> None:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {text}", flush=True)

    def on_connect(_c, _u, _flags, reason_code, _props):  # noqa: ANN001
        if reason_code.is_failure:
            log(f"брокер отказал в подключении: {reason_code} — проверьте SENSOR_TOKEN (npm run setup) и что QORGAN хотя бы раз запускался")
            return
        state["connected"] = True
        log(f"подключено к mqtt://{args.host}:{port} как {device_id}")
        client.publish(status_topic(device_id), "online", qos=1, retain=True)
        # Показания, накопленные без связи, отправляются по порядку (сервер отбросит повторы по bootId + seq).
        for msg in buffer.take_fresh(time.monotonic()):
            send(msg)

    def on_disconnect(_c, _u, _flags, reason_code, _props):  # noqa: ANN001
        if state["connected"]:
            log(f"связь потеряна ({reason_code}) — показания копятся в буфере, переподключаюсь…")
        state["connected"] = False
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
                log(f"режим → {state['mode']}")

    print("=" * 72)
    print(f" QORGAN · программный датчик уровня воды · устройство {device_id} · станция {station}")
    print(f" Брокер mqtt://{args.host}:{port} · показание каждые {args.interval:g} с · начальный уровень {args.initial:g} см")
    print(" Команды: N — норма, R — подъём, D — опасный подъём, F — спад, Q — выход (буква + Enter)")
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
            if state["connected"]:
                send(msg)
                status = "отправлено"
            else:
                buffer.add(time.monotonic(), msg)
                status = f"нет связи, в буфере {len(buffer)}"
            log(f"#{state['seq']:<4} {mode:<8} {value:7.1f} см  {status}")
            if args.count and state["seq"] >= args.count:
                time.sleep(1.0)  # дать дойти подтверждению последнего сообщения
                break
            next_at += args.interval
            time.sleep(max(0.0, next_at - time.monotonic()))
    finally:
        log("остановка датчика…")
        if state["connected"]:
            client.publish(status_topic(device_id), "offline", qos=1, retain=True).wait_for_publish(timeout=2)
        client.disconnect()
        client.loop_stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
