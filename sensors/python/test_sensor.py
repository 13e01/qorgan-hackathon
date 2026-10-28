"""Проверки генератора и формата сообщений Python-датчика (стандартный unittest, без зависимостей).

    py -m unittest discover -s sensors/python -v
"""

import json
import re
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from sensor import MODES, OutBuffer, WaterLevelModel, build_message, can_send, parse_args, read_env, status_topic, telemetry_topic


class ModelTest(unittest.TestCase):
    def test_same_seed_same_series(self):
        a = WaterLevelModel(seed=7)
        b = WaterLevelModel(seed=7)
        self.assertEqual([a.step("NORMAL") for _ in range(20)], [b.step("NORMAL") for _ in range(20)])

    def test_normal_is_stable(self):
        m = WaterLevelModel(level_cm=320, seed=1)
        values = [m.step("NORMAL") for _ in range(200)]
        self.assertLess(max(values) - min(values), 1.5)
        self.assertAlmostEqual(sum(values) / len(values), 320, delta=0.3)

    def test_rising_grows_steadily(self):
        m = WaterLevelModel(level_cm=320, seed=2)
        values = [m.step("RISING") for _ in range(10)]
        self.assertTrue(all(b > a for a, b in zip(values, values[1:])))
        self.assertAlmostEqual(values[-1] - 320, 60, delta=1)

    def test_danger_reaches_danger_level_fast(self):
        m = WaterLevelModel(level_cm=320, seed=3)
        values = [m.step("DANGER") for _ in range(15)]
        self.assertGreater(values[-1], 580)  # учебный опасный порог Петропавловска в QORGAN — 580 см

    def test_falling_has_floor(self):
        m = WaterLevelModel(level_cm=320, seed=4)
        for _ in range(100):
            m.step("FALLING")
        self.assertGreaterEqual(m.step("FALLING"), 280 - 1)

    def test_bounds_and_unknown_mode(self):
        m = WaterLevelModel(level_cm=1490, seed=5)
        for _ in range(10):
            self.assertLessEqual(m.step("DANGER"), 1500)
        with self.assertRaises(ValueError):
            m.step("FLOOD")


class MessageTest(unittest.TestCase):
    def test_fields_and_types(self):
        now = datetime(2026, 10, 28, 12, 0, 0, 123000, tzinfo=timezone.utc)
        msg = build_message("PY-SENSOR-01", "QRG-03", 321.4, 5, "abcd1234", "RISING", now)
        self.assertEqual(
            msg,
            {
                "v": 1,
                "deviceId": "PY-SENSOR-01",
                "stationId": "QRG-03",
                "type": "water_level",
                "value": 321.4,
                "unit": "cm",
                "timestamp": "2026-10-28T12:00:00.123Z",
                "seq": 5,
                "bootId": "abcd1234",
                "source": "PYTHON_SENSOR",
                "mode": "RISING",
            },
        )
        json.dumps(msg)  # сериализуется

    def test_timestamp_is_iso_utc(self):
        msg = build_message("D-1", "QRG-03", 1.0, 1, "boot", "NORMAL")
        self.assertRegex(msg["timestamp"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

    def test_topics(self):
        self.assertEqual(telemetry_topic("PY-SENSOR-01"), "qorgan/v1/sensors/PY-SENSOR-01/telemetry")
        self.assertEqual(status_topic("PY-SENSOR-01"), "qorgan/v1/sensors/PY-SENSOR-01/status")


class SupportTest(unittest.TestCase):
    def test_read_env(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".env"
            p.write_text("# comment\nSENSOR_TOKEN=abc123\nMQTT_PORT=1884\nEMPTY=\nQUOTED='x y'\n", encoding="utf-8")
            env = read_env(p)
        self.assertEqual(env["SENSOR_TOKEN"], "abc123")
        self.assertEqual(env["MQTT_PORT"], "1884")
        self.assertEqual(env["QUOTED"], "x y")
        self.assertEqual(read_env(Path("no-such-file.env")), {})

    def test_buffer_drops_stale(self):
        b = OutBuffer()
        b.add(0, {"seq": 1})
        b.add(290, {"seq": 2})
        b.add(299, {"seq": 3})
        self.assertEqual([m["seq"] for m in b.take_fresh(now=300)], [1, 2, 3])
        b.add(0, {"seq": 4})
        b.add(200, {"seq": 5})
        self.assertEqual([m["seq"] for m in b.take_fresh(now=301)], [5])
        self.assertEqual(len(b), 0)

    def test_sends_only_when_broker_and_qorgan_online(self):
        self.assertTrue(can_send(True, True))
        self.assertFalse(can_send(True, False))  # брокер есть, QORGAN не подписан — сообщение потерялось бы
        self.assertFalse(can_send(False, True))
        self.assertFalse(can_send(False, False))

    def test_args(self):
        a = parse_args(["--mode", "danger", "--interval", "1"])
        self.assertEqual(a.mode, "DANGER")
        self.assertEqual(a.interval, 1.0)
        self.assertIn("NORMAL", MODES)
        self.assertTrue(re.match(r".*\.env$", str(a.env)))


if __name__ == "__main__":
    unittest.main()
