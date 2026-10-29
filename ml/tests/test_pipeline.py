"""Тесты конвейера QORGAN Sentinel: разбиение, метрики, обучение, выгрузка и паритет (без большого набора данных).

    ml/.venv/Scripts/python -m unittest discover -s ml/tests -t ml
"""

from __future__ import annotations

import math
import unittest

import numpy as np
import pandas as pd
import xgboost as xgb

from sentinel import metrics as M
from sentinel.data import FEATURE_NAMES, split_by_episode, usable
from sentinel.export import _leaf_sum, build_artifact, export_booster
from sentinel.train import fit_xgb


def toy_frame(episodes: int = 20, ticks: int = 60, seed: int = 0) -> pd.DataFrame:
    """Игрушечные эпизоды: уровень растёт с разной скоростью; метка — достигнет ли порога через ≤ 6 ч."""
    rng = np.random.default_rng(seed)
    rows = []
    for e in range(episodes):
        rate = rng.uniform(-1, 6)
        for t in range(ticks):
            level = -150 + rate * t + rng.normal(0, 1)
            f = {n: np.nan for n in FEATURE_NAMES}
            f.update(level_vs_danger_cm=level, level_vs_warning_cm=level + 100, delta_3h_cm=3 * rate, delta_1h_cm=rate, data_age_h=0.0)
            if t % 7 == 0:
                f["delta_3h_cm"] = np.nan  # пропуски
            future = -150 + rate * (t + 6)
            rows.append({"episode": e, "kind": "toy", "station": "QRG-01", "tick": t, **f,
                         "y_danger": int(max(level, future) >= 0), "y_warning": int(max(level, future) >= -100),
                         "now_danger": int(level >= 0), "now_warning": int(level >= -100), "rules_risk": "LOW", "rules_score": 0})
    return pd.DataFrame(rows)


class SplitTests(unittest.TestCase):
    def test_split_by_episode_has_no_overlap_and_keeps_order(self):
        df = toy_frame()
        s = split_by_episode(df)
        tr, va, te = (set(x["episode"]) for x in (s.train, s.val, s.test))
        self.assertFalse(tr & va or tr & te or va & te)
        self.assertLess(max(tr), min(va))
        self.assertLess(max(va), min(te))
        self.assertEqual(len(s.train) + len(s.val) + len(s.test), len(df))

    def test_usable_drops_stale_and_missing_level(self):
        df = toy_frame(2, 5)
        df.loc[0, "data_age_h"] = 5.0
        df.loc[1, "level_vs_danger_cm"] = np.nan
        self.assertEqual(len(usable(df)), len(df) - 2)


class MetricTests(unittest.TestCase):
    def test_binary_report(self):
        y = np.array([1, 1, 0, 0, 0])
        r = M.binary_report(y, np.array([1, 0, 1, 0, 0]), np.array([0.9, 0.4, 0.6, 0.1, 0.2]))
        self.assertEqual(r["confusion"], {"tp": 1, "fp": 1, "fn": 1, "tn": 2})
        self.assertAlmostEqual(r["precision"], 0.5)
        self.assertAlmostEqual(r["recall"], 0.5)
        self.assertAlmostEqual(r["miss_rate"], 0.5)
        self.assertAlmostEqual(r["false_alarm_rate"], 1 / 3)
        self.assertIn("pr_auc", r)

    def test_threshold_prefers_recall(self):
        y = np.array([1] * 10 + [0] * 90)
        p = np.concatenate([np.linspace(0.3, 0.9, 10), np.linspace(0.0, 0.5, 90)])
        t2, _ = M.choose_threshold(y, p, beta=2.0)
        t1, _ = M.choose_threshold(y, p, beta=1.0)
        # F2 ценит полноту выше точности: порог не выше, полнота не ниже, чем у F1.
        self.assertLessEqual(t2, t1)
        self.assertGreaterEqual(M.binary_report(y, p >= t2)["recall"], M.binary_report(y, p >= t1)["recall"])

    def test_multiclass_and_lead_time(self):
        rep = M.multiclass_report(np.array(["LOW", "HIGH", "MEDIUM"]), np.array(["LOW", "HIGH", "HIGH"]))
        self.assertEqual(rep["confusion_matrix"]["MEDIUM"]["HIGH"], 1)
        df = pd.DataFrame({"episode": 0, "station": "A", "tick": range(10), "now_danger": [0] * 6 + [1] * 4, "flag": [0, 0, 0, 1, 1, 1, 1, 1, 1, 1]})
        lt = M.lead_times(df, "flag")
        self.assertEqual(lt["events"], 1)
        self.assertEqual(lt["mean_lead_h"], 3.0)

    def test_calibration_bins_cover_all_rows(self):
        p = np.linspace(0, 1, 101)
        rows = M.calibration_table((p > 0.5).astype(int), p)
        self.assertEqual(sum(r["n"] for r in rows), 101)


class TrainExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = split_by_episode(toy_frame())
        cls.splits = s
        cls.booster, cls.proba = fit_xgb(s.train, s.val, "danger", {"max_depth": 3, "learning_rate": 0.3, "min_child_weight": 1}, max_rounds=60)

    def test_model_learns_toy_target(self):
        y = self.splits.val["y_danger"].to_numpy()
        self.assertGreater(M.binary_report(y, self.proba >= 0.5, self.proba)["pr_auc"], 0.9)

    def test_export_reproduces_margin_including_missing_values(self):
        x = self.splits.test[FEATURE_NAMES].to_numpy(dtype=np.float32)
        exported = export_booster(self.booster, x)
        margins = self.booster.predict(xgb.DMatrix(x, missing=np.nan, feature_names=FEATURE_NAMES), output_margin=True)
        for row, m in zip(x[:100], margins[:100]):
            self.assertAlmostEqual(exported["baseMargin"] + _leaf_sum(exported["trees"], row), float(m), places=4)
        self.assertTrue(np.isnan(x).any())

    def test_artifact_has_contract_fields_and_parity(self):
        x = self.splits.test[FEATURE_NAMES].to_numpy(dtype=np.float32)
        art = build_artifact(model_version="test", boosters={"danger": self.booster, "warning": self.booster}, thresholds={"danger": 0.5, "warning": 0.4},
                             sample=x[:50], parity_rows=x[:5], dataset={}, metrics={}, trained_with={})
        self.assertEqual(art["featureNames"], FEATURE_NAMES)
        self.assertEqual(art["horizonH"], 6)
        self.assertTrue(art["demo"])
        case = art["parity"][0]
        self.assertEqual(len(case["contribs"]["danger"]), len(FEATURE_NAMES) + 1)
        self.assertAlmostEqual(sum(case["contribs"]["danger"]), case["margin"]["danger"], places=4)
        self.assertTrue(all(v is None or math.isfinite(v) for v in case["x"]))


if __name__ == "__main__":
    unittest.main()
