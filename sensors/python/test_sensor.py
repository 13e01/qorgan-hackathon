"""Проверки генератора и формата сообщений Python-датчика (стандартный unittest, без зависимостей).

    py -m unittest discover -s sensors/python -v
"""

import json
import re
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from sensor import MODES, OutBuffer, acquire_single_instance, WaterLevelModel, build_message, can_send, parse_args, read_env, status_topic, telemetry_topic


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
        m = WaterLevelModel(level_cm=1400, seed=5, rising_peak_cm=1450, danger_peak_cm=1500)
        for _ in range(50):
            self.assertLessEqual(m.step("DANGER"), 1500)
        with self.assertRaises(ValueError):
            m.step("FLOOD")

    def test_danger_has_peak_no_endless_growth(self):
        # Ручная проверка 28.10: за ~10 минут DANGER уровень дошёл до 14,54 м. Теперь он держится у учебного пика.
        m = WaterLevelModel(level_cm=320, seed=6)
        values = [m.step("DANGER") for _ in range(300)]
        self.assertLessEqual(max(values), 650 + 0.6)
        self.assertAlmostEqual(values[-1], 650, delta=0.7)
        # Плавно: у пика шаг меньше, чем в начале подъёма.
        self.assertGreater(values[5] - values[4], 15)
        self.assertLess(values[25] - values[24], 5)

    def test_rising_stops_at_its_peak(self):
        m = WaterLevelModel(level_cm=320, seed=7)
        values = [m.step("RISING") for _ in range(300)]
        self.assertAlmostEqual(values[-1], 500, delta=0.7)
        self.assertLessEqual(max(values), 500 + 0.6)

    def test_normal_and_falling_return_to_initial_level(self):
        for mode, max_steps in (("FALLING", 60), ("NORMAL", 150)):
            m = WaterLevelModel(level_cm=320, seed=8)
            for _ in range(60):
                m.step("DANGER")
            self.assertGreater(m.level_cm, 600)
            for _ in range(max_steps):
                m.step(mode)
            self.assertAlmostEqual(m.level_cm, 320, delta=1.0, msg=mode)
        # Спад быстрее, чем возврат в режиме NORMAL.
        fall, norm = WaterLevelModel(level_cm=320, seed=9), WaterLevelModel(level_cm=320, seed=9)
        for model in (fall, norm):
            for _ in range(60):
                model.step("DANGER")
        for _ in range(10):
            fall.step("FALLING")
            norm.step("NORMAL")
        self.assertLess(fall.level_cm, norm.level_cm)

    def test_same_seed_and_modes_reproducible(self):
        plan = ["NORMAL"] * 5 + ["RISING"] * 10 + ["DANGER"] * 20 + ["FALLING"] * 20 + ["NORMAL"] * 10
        a, b = WaterLevelModel(seed=11), WaterLevelModel(seed=11)
        self.assertEqual([a.step(x) for x in plan], [b.step(x) for x in plan])

    def test_invalid_levels_rejected(self):
        with self.assertRaises(ValueError):
            WaterLevelModel(level_cm=600, danger_peak_cm=650)  # начальный выше пика RISING
        with self.assertRaises(ValueError):
            WaterLevelModel(level_cm=320, rising_peak_cm=700, danger_peak_cm=650)
        with self.assertRaises(ValueError):
            WaterLevelModel(level_cm=320, danger_peak_cm=2000)


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

    def test_single_instance_lock(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / ".sensor-X.lock"
            first = acquire_single_instance(path)
            self.assertIsNotNone(first)
            self.assertIsNone(acquire_single_instance(path))  # второй экземпляр не запускается
            first.close()  # процесс датчика завершился — блокировка снята
            again = acquire_single_instance(path)
            self.assertIsNotNone(again)
            again.close()

    def test_args(self):
        a = parse_args(["--mode", "danger", "--interval", "1"])
        self.assertEqual(a.mode, "DANGER")
        self.assertEqual(a.interval, 1.0)
        self.assertIn("NORMAL", MODES)
        self.assertTrue(re.match(r".*\.env$", str(a.env)))
        b = parse_args(["--rising-peak", "450", "--danger-peak", "600"])
        self.assertEqual((b.initial, b.rising_peak, b.danger_peak, b.seed), (320.0, 450.0, 600.0, 1))


if __name__ == "__main__":
    unittest.main()
