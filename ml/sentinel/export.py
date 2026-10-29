"""Выгрузка обученных XGBoost-моделей в JSON для сервера QORGAN (packages/shared/src/ml/trees.ts).

Формат компактный: для каждого дерева — массивы потомков, признаков, порогов (float32), направления пропуска и
покрытия (sum_hessian, нужно TreeSHAP). base_margin вычисляется по самой модели (predict output_margin минус
сумма листьев), а не берётся из текстового base_score, — так выгрузка не зависит от его формата в версии XGBoost.
В файл добавляются примеры паритета: признаки, логит и SHAP-вклады от XGBoost (pred_contribs=True) — тест на
TypeScript проверяет, что сервер считает то же самое.
"""

from __future__ import annotations

import json
import math

import numpy as np
import xgboost as xgb

from .data import FEATURE_NAMES, FEATURE_SCHEMA_VERSION, HORIZON_H

MODEL_FORMAT = "qorgan-sentinel-model"
MODEL_FORMAT_VERSION = 1


def _f32(x: float) -> float:
    return float(np.float32(x))


def booster_trees(booster: xgb.Booster) -> list[dict]:
    raw = json.loads(booster.save_raw("json").decode("utf-8"))
    trees = raw["learner"]["gradient_booster"]["model"]["trees"]
    out = []
    for t in trees:
        left = [int(v) for v in t["left_children"]]
        out.append(
            {
                "left": left,
                "right": [int(v) for v in t["right_children"]],
                "feature": [int(v) for v in t["split_indices"]],
                "threshold": [_f32(v) for v in t["split_conditions"]],
                "defaultLeft": [int(v) for v in t["default_left"]],
                "cover": [float(v) for v in t["sum_hessian"]],
            }
        )
    return out


def _leaf_sum(trees: list[dict], x: np.ndarray) -> float:
    total = 0.0
    for t in trees:
        node = 0
        while t["left"][node] != -1:
            v = x[t["feature"][node]]
            if math.isnan(v):
                node = t["left"][node] if t["defaultLeft"][node] else t["right"][node]
            else:
                node = t["left"][node] if np.float32(v) < t["threshold"][node] else t["right"][node]
        total += t["threshold"][node]
    return total


def export_booster(booster: xgb.Booster, sample: np.ndarray) -> dict:
    trees = booster_trees(booster)
    margins = booster.predict(xgb.DMatrix(sample[:50], missing=np.nan, feature_names=FEATURE_NAMES), output_margin=True)
    base = [float(m) - _leaf_sum(trees, row) for m, row in zip(margins, sample[:50])]
    if max(base) - min(base) > 1e-4:
        raise RuntimeError(f"не удалось восстановить base_margin: разброс {max(base) - min(base)}")
    return {"baseMargin": float(np.mean(base)), "trees": trees}


def parity_cases(boosters: dict[str, xgb.Booster], rows: np.ndarray) -> list[dict]:
    cases = []
    dm = xgb.DMatrix(rows, missing=np.nan, feature_names=FEATURE_NAMES)
    margins = {k: b.predict(dm, output_margin=True) for k, b in boosters.items()}
    contribs = {k: b.predict(dm, pred_contribs=True) for k, b in boosters.items()}
    for i, row in enumerate(rows):
        cases.append(
            {
                "x": [None if math.isnan(float(v)) else float(v) for v in row],
                "margin": {k: float(margins[k][i]) for k in boosters},
                "contribs": {k: [float(c) for c in contribs[k][i]] for k in boosters},
            }
        )
    return cases


def build_artifact(
    *,
    model_version: str,
    boosters: dict[str, xgb.Booster],
    thresholds: dict[str, float],
    sample: np.ndarray,
    parity_rows: np.ndarray,
    dataset: dict,
    metrics: dict,
    trained_with: dict,
) -> dict:
    return {
        "format": MODEL_FORMAT,
        "formatVersion": MODEL_FORMAT_VERSION,
        "modelVersion": model_version,
        "algorithm": "xgboost-binary-logistic",
        "trainedWith": trained_with,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureNames": FEATURE_NAMES,
        "horizonH": HORIZON_H,
        "demo": True,
        "dataset": dataset,
        "metrics": metrics,
        "targets": {k: {"booster": export_booster(b, sample), "threshold": thresholds[k]} for k, b in boosters.items()},
        "parity": parity_cases(boosters, parity_rows),
    }
