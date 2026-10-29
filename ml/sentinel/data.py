"""Загрузка набора данных и разбиение train / validation / test (docs/SENTINEL_ML.md §4).

Разбиение — по эпизодам и по порядку эпизодов («хронологически»): эпизод целиком попадает только в одну
выборку, поэтому почти одинаковые соседние часы одной симуляции не оказываются одновременно в обучении и в тесте.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

# Порядок признаков — контракт с packages/shared/src/ml/features.ts (FEATURE_NAMES).
FEATURE_NAMES = [
    "level_vs_danger_cm",
    "level_vs_warning_cm",
    "delta_1h_cm",
    "delta_3h_cm",
    "delta_6h_cm",
    "delta_12h_cm",
    "slope_6h_cm_h",
    "accel_3h_cm",
    "ma6_dev_cm",
    "data_age_h",
    "rain_6h_mm",
    "temp_mean_24h_c",
    "up_level_vs_danger_cm",
    "up_delta_3h_cm",
    "up_delta_6h_cm",
    "up_arriving_6h_cm",
    "up_travel_h",
]
FEATURE_SCHEMA_VERSION = 1
HORIZON_H = 6
UPSTREAM_FEATURES = [n for n in FEATURE_NAMES if n.startswith("up_")]
TARGETS = {"danger": "y_danger", "warning": "y_warning"}
MAX_AGE_H = 3.0

SPLIT_FRACTIONS = (0.70, 0.15, 0.15)


@dataclass
class Splits:
    train: pd.DataFrame
    val: pd.DataFrame
    test: pd.DataFrame


def load(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    missing = [c for c in FEATURE_NAMES + list(TARGETS.values()) if c not in df.columns]
    if missing:
        raise ValueError(f"в наборе данных нет столбцов: {missing}")
    return df


def usable(df: pd.DataFrame) -> pd.DataFrame:
    """Строки, на которых модель делает оценку (как на сервере: есть свежее измерение уровня)."""
    age = df["data_age_h"]
    return df[age.notna() & (age <= MAX_AGE_H) & df["level_vs_danger_cm"].notna()].copy()


def split_by_episode(df: pd.DataFrame, fractions=SPLIT_FRACTIONS) -> Splits:
    episodes = np.sort(df["episode"].unique())
    n = len(episodes)
    n_train = int(round(n * fractions[0]))
    n_val = int(round(n * fractions[1]))
    train_ep = set(episodes[:n_train])
    val_ep = set(episodes[n_train : n_train + n_val])
    test_ep = set(episodes[n_train + n_val :])
    return Splits(
        train=df[df["episode"].isin(train_ep)].copy(),
        val=df[df["episode"].isin(val_ep)].copy(),
        test=df[df["episode"].isin(test_ep)].copy(),
    )


def xy(df: pd.DataFrame, target: str, features=FEATURE_NAMES) -> tuple[np.ndarray, np.ndarray]:
    return df[features].to_numpy(dtype=np.float32), df[TARGETS[target]].to_numpy(dtype=np.int32)


def load_meta(path: str | Path) -> dict:
    p = Path(str(path).replace(".csv", ".meta.json"))
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
