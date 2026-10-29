"""Обучение и оценка QORGAN Sentinel (docs/SENTINEL_ML.md, docs/SENTINEL_EVALUATION.md).

    ml/.venv/Scripts/python -m sentinel.train            (из папки ml; или npm run ml:train из корня)

Шаги: загрузка → строки, где модель вообще оценивает (свежий уровень) → разбиение по эпизодам 70/15/15 →
базовые модели (правила T2, «уровень уже выше порога», логистическая регрессия, случайный лес) →
XGBoost с подбором гиперпараметров по валидации (ранняя остановка) → порог вероятности по валидации (F2) →
оценка на тесте (по классам, на «начале подъёма», время упреждения, калибровка) и на официальных сценариях демо →
сохранение модели в JSON и отчёта. Тестовая выборка не используется ни для подбора, ни для порогов.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import sklearn
import xgboost as xgb
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from . import metrics as M
from .data import FEATURE_NAMES, TARGETS, UPSTREAM_FEATURES, load, load_meta, split_by_episode, usable, xy
from .export import build_artifact

ROOT = Path(__file__).resolve().parents[2]
MODEL_VERSION = "sentinel-1.0.0"
SEED = 0

GRID = [
    {"max_depth": d, "learning_rate": lr, "min_child_weight": mcw}
    for d in (3, 4, 5)
    for lr in (0.05, 0.1)
    for mcw in (1, 10)
]
QUICK_GRID = [{"max_depth": 3, "learning_rate": 0.1, "min_child_weight": 1}]


def log(msg: str) -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(f"[train] {msg}", flush=True)


def fit_xgb(train: pd.DataFrame, val: pd.DataFrame, target: str, params: dict, features=FEATURE_NAMES, max_rounds=800):
    xt, yt = xy(train, target, features)
    xv, yv = xy(val, target, features)
    dtrain = xgb.DMatrix(xt, label=yt, missing=np.nan, feature_names=list(features))
    dval = xgb.DMatrix(xv, label=yv, missing=np.nan, feature_names=list(features))
    full = {
        "objective": "binary:logistic",
        "eval_metric": "aucpr",
        "tree_method": "hist",
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "seed": SEED,
        "nthread": 4,
        **params,
    }
    booster = xgb.train(full, dtrain, num_boost_round=max_rounds, evals=[(dval, "val")], early_stopping_rounds=40, verbose_eval=False)
    # Оставляем только деревья до лучшей итерации: выгружаемая модель = та, что оценена.
    booster = booster[: booster.best_iteration + 1]
    proba = booster.predict(dval)
    return booster, proba


def predict_xgb(booster: xgb.Booster, df: pd.DataFrame, features=FEATURE_NAMES) -> np.ndarray:
    return booster.predict(xgb.DMatrix(df[list(features)].to_numpy(dtype=np.float32), missing=np.nan, feature_names=list(features)))


def baseline_rules(df: pd.DataFrame) -> dict[str, np.ndarray]:
    return {"danger": (df["rules_risk"] == "HIGH").to_numpy(), "warning": df["rules_risk"].isin(["MEDIUM", "HIGH"]).to_numpy()}


def baseline_persistence(df: pd.DataFrame) -> dict[str, np.ndarray]:
    return {"danger": (df["level_vs_danger_cm"] >= 0).to_numpy(), "warning": (df["level_vs_warning_cm"] >= 0).to_numpy()}


def category_from(p_danger: np.ndarray, p_warning: np.ndarray, thr: dict) -> np.ndarray:
    return np.where(p_danger >= thr["danger"], "HIGH", np.where(p_warning >= thr["warning"], "MEDIUM", "LOW"))


def evaluate_split(df: pd.DataFrame, preds: dict[str, np.ndarray], probas: dict[str, np.ndarray] | None) -> dict:
    out = {}
    for target, col in TARGETS.items():
        y = df[col].to_numpy()
        pr = None if probas is None else probas[target]
        out[target] = M.binary_report(y, preds[target], pr)
        # «Начало подъёма»: сейчас уровень ниже порога — проверяем именно раннее предупреждение,
        # а не то, что уже видно по текущему уровню.
        onset = (df[f"now_{target}"] == 0).to_numpy()
        out[f"{target}_onset"] = M.binary_report(y[onset], preds[target][onset], None if pr is None else pr[onset])
    return out


def mean_abs_shap(booster: xgb.Booster, df: pd.DataFrame, n: int = 20_000) -> dict[str, float]:
    sample = df.sample(min(n, len(df)), random_state=SEED)
    contribs = booster.predict(xgb.DMatrix(sample[FEATURE_NAMES].to_numpy(dtype=np.float32), missing=np.nan, feature_names=FEATURE_NAMES), pred_contribs=True)
    vals = np.abs(contribs[:, :-1]).mean(axis=0)
    return dict(sorted(((f, float(v)) for f, v in zip(FEATURE_NAMES, vals)), key=lambda kv: -kv[1]))


def run(args) -> dict:
    started = time.time()
    data_path = (ROOT / args.data).resolve()
    raw = load(data_path)
    meta = load_meta(data_path)
    df = usable(raw)
    log(f"данные: {len(raw)} строк, из них с оценкой модели: {len(df)} ({data_path.name})")
    splits = split_by_episode(df)
    full_test = split_by_episode(raw).test  # для времени упреждения нужны все часы, в том числе без оценки
    sizes = {k: {"rows": len(getattr(splits, k)), "episodes": int(getattr(splits, k)["episode"].nunique()), "positives_danger": int(getattr(splits, k)["y_danger"].sum()), "positives_warning": int(getattr(splits, k)["y_warning"].sum())} for k in ("train", "val", "test")}
    log(f"разбиение: {sizes}")

    experiments: list[dict] = []
    val, test, train = splits.val, splits.test, splits.train

    # 1. Базовые модели без обучения.
    for name, fn in (("rules_t2", baseline_rules), ("persistence", baseline_persistence)):
        experiments.append({"name": name, "val": evaluate_split(val, fn(val), None), "test": evaluate_split(test, fn(test), None)})

    # 2. Логистическая регрессия и случайный лес (порог тоже по валидации).
    lin = {}
    for name, factory in (
        ("logistic_regression", lambda: make_pipeline(SimpleImputer(strategy="median", add_indicator=True), StandardScaler(), LogisticRegression(max_iter=2000))),
        ("random_forest", lambda: RandomForestClassifier(n_estimators=150 if not args.quick else 20, max_depth=14, min_samples_leaf=20, n_jobs=-1, random_state=SEED)),
    ):
        t0 = time.time()
        preds_val, preds_test, prob_val, prob_test, thr = {}, {}, {}, {}, {}
        for target in TARGETS:
            xt, yt = xy(train, target)
            model = factory().fit(xt, yt)
            prob_val[target] = model.predict_proba(xy(val, target)[0])[:, 1]
            prob_test[target] = model.predict_proba(xy(test, target)[0])[:, 1]
            thr[target], _ = M.choose_threshold(val[TARGETS[target]].to_numpy(), prob_val[target])
            preds_val[target] = prob_val[target] >= thr[target]
            preds_test[target] = prob_test[target] >= thr[target]
        experiments.append({"name": name, "thresholds": thr, "seconds": round(time.time() - t0, 1), "val": evaluate_split(val, preds_val, prob_val), "test": evaluate_split(test, preds_test, prob_test)})
        lin[name] = (prob_test, thr)
        log(f"{name}: PR-AUC опасный (вал.) = {experiments[-1]['val']['danger']['pr_auc']:.4f}")

    # 3. XGBoost: подбор гиперпараметров по PR-AUC на валидации для каждой цели.
    grid = QUICK_GRID if args.quick else GRID
    best: dict[str, dict] = {}
    tuning: list[dict] = []
    for target in TARGETS:
        for params in grid:
            booster, proba = fit_xgb(train, val, target, params)
            ap = M.binary_report(val[TARGETS[target]].to_numpy(), proba >= 0.5, proba)["pr_auc"]
            tuning.append({"target": target, **params, "rounds": booster.num_boosted_rounds(), "val_pr_auc": ap})
            if target not in best or ap > best[target]["val_pr_auc"]:
                best[target] = {"params": params, "booster": booster, "val_proba": proba, "val_pr_auc": ap}
        log(f"xgboost {target}: лучшие {best[target]['params']} (деревьев {best[target]['booster'].num_boosted_rounds()}), PR-AUC вал. = {best[target]['val_pr_auc']:.4f}")

    thresholds = {t: M.choose_threshold(val[TARGETS[t]].to_numpy(), best[t]["val_proba"])[0] for t in TARGETS}
    boosters = {t: best[t]["booster"] for t in TARGETS}
    prob_test = {t: predict_xgb(boosters[t], test) for t in TARGETS}
    prob_val = {t: best[t]["val_proba"] for t in TARGETS}
    xgb_exp = {
        "name": "xgboost",
        "thresholds": thresholds,
        "params": {t: best[t]["params"] for t in TARGETS},
        "trees": {t: boosters[t].num_boosted_rounds() for t in TARGETS},
        "val": evaluate_split(val, {t: prob_val[t] >= thresholds[t] for t in TARGETS}, prob_val),
        "test": evaluate_split(test, {t: prob_test[t] >= thresholds[t] for t in TARGETS}, prob_test),
    }
    experiments.append(xgb_exp)

    # 4. Абляция: XGBoost без признаков станции выше по течению (насколько они нужны).
    no_up = [f for f in FEATURE_NAMES if f not in UPSTREAM_FEATURES]
    abl_probs, abl_thr = {}, {}
    for target in TARGETS:
        booster, proba = fit_xgb(train, val, target, best[target]["params"], features=no_up)
        abl_thr[target], _ = M.choose_threshold(val[TARGETS[target]].to_numpy(), proba)
        abl_probs[target] = predict_xgb(booster, test, features=no_up)
    experiments.append({"name": "xgboost_without_upstream", "thresholds": abl_thr, "test": evaluate_split(test, {t: abl_probs[t] >= abl_thr[t] for t in TARGETS}, abl_probs)})

    # 5. Категории LOW/MEDIUM/HIGH: XGBoost и правила T2 на одной и той же цели.
    y_cat = M.category_true(test)
    cat_ml = category_from(prob_test["danger"], prob_test["warning"], thresholds)
    categories = {"xgboost": M.multiclass_report(y_cat, cat_ml), "rules_t2": M.multiclass_report(y_cat, test["rules_risk"].to_numpy())}

    # 6. Время упреждения на тесте (все часы; где модель не оценивала — сигнала нет).
    ft = full_test.copy()
    ok = ft.index.isin(test.index)
    ft["ml_high"] = False
    ft.loc[ok, "ml_high"] = prob_test["danger"] >= thresholds["danger"]
    ft["rules_high"] = ft["rules_risk"] == "HIGH"
    lead = {"xgboost": M.lead_times(ft, "ml_high"), "rules_t2": M.lead_times(ft, "rules_high")}

    # 7. Калибровка вероятностей.
    calibration = {t: M.calibration_table(test[TARGETS[t]].to_numpy(), prob_test[t]) for t in TARGETS}

    # 8. Официальные сценарии демо (не участвовали в обучении).
    official = None
    if args.official and (ROOT / args.official).exists():
        off = usable(load(ROOT / args.official))
        op = {t: predict_xgb(boosters[t], off) for t in TARGETS}
        official = {
            "rows": len(off),
            "xgboost": evaluate_split(off, {t: op[t] >= thresholds[t] for t in TARGETS}, op),
            "rules_t2": evaluate_split(off, baseline_rules(off), None),
            "categories": {"xgboost": M.multiclass_report(M.category_true(off), category_from(op["danger"], op["warning"], thresholds)), "rules_t2": M.multiclass_report(M.category_true(off), off["rules_risk"].to_numpy())},
        }

    importance = {t: mean_abs_shap(boosters[t], test) for t in TARGETS}
    dataset_info = {
        "source": "synthetic: QORGAN simulator wave generator with randomized episodes (ml/dataset/export.ts)",
        "synthetic": True,
        "file": data_path.name,
        "generatorSeed": meta.get("seed"),
        "episodes": int(raw["episode"].nunique()),
        "rows": int(len(raw)),
        "rowsUsable": int(len(df)),
        "split": "by episode, in episode order 70/15/15",
        "sizes": sizes,
        "label": "measured level reaches threshold within next 6 h (ticks t+1..t+6), from uncorrupted readings",
    }
    summary = {
        "test": {t: {k: xgb_exp["test"][t][k] for k in ("precision", "recall", "f1", "pr_auc", "miss_rate", "false_alarm_rate")} for t in TARGETS},
        "testRulesT2": {t: {k: experiments[0]["test"][t][k] for k in ("precision", "recall", "f1", "miss_rate", "false_alarm_rate")} for t in TARGETS},
        "leadTime": lead,
    }
    trained_with = {"python": platform.python_version(), "xgboost": xgb.__version__, "scikit-learn": sklearn.__version__, "numpy": np.__version__, "pandas": pd.__version__}

    # Примеры паритета: обычные строки теста и строки с пропусками.
    rng = np.random.default_rng(SEED)
    rows = test[FEATURE_NAMES].to_numpy(dtype=np.float32)
    pick = list(rng.choice(len(rows), size=min(24, len(rows)), replace=False))
    pick += list(np.where(np.isnan(rows).any(axis=1))[0][:8])
    pick += list(np.where(test["y_danger"].to_numpy() == 1)[0][:8])
    artifact = build_artifact(
        model_version=MODEL_VERSION,
        boosters=boosters,
        thresholds=thresholds,
        sample=rows[:200],
        parity_rows=rows[pick],
        dataset=dataset_info,
        metrics=summary,
        trained_with=trained_with,
    )
    report = {
        "modelVersion": MODEL_VERSION,
        "dataset": dataset_info,
        "trainedWith": trained_with,
        "seconds": round(time.time() - started, 1),
        "experiments": experiments,
        "tuning": tuning,
        "categories": categories,
        "leadTime": lead,
        "calibration": calibration,
        "official": official,
        "importance": importance,
    }
    return {"artifact": artifact, "report": report}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="QORGAN Sentinel: обучение и оценка")
    p.add_argument("--data", default="data/ml/dataset.csv")
    p.add_argument("--official", default="data/ml/official.csv")
    p.add_argument("--model-out", default="ml/models/sentinel-model.json")
    p.add_argument("--report-out", default="ml/reports/evaluation.json")
    p.add_argument("--quick", action="store_true", help="маленькая сетка — для проверки конвейера")
    args = p.parse_args(argv)
    result = run(args)
    model_out = ROOT / args.model_out
    report_out = ROOT / args.report_out
    model_out.parent.mkdir(parents=True, exist_ok=True)
    report_out.parent.mkdir(parents=True, exist_ok=True)
    model_out.write_text(json.dumps(result["artifact"], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report_out.write_text(json.dumps(result["report"], ensure_ascii=False, indent=2), encoding="utf-8")
    from .report import write_markdown

    write_markdown(result["report"], report_out.with_suffix(".md"))
    log(f"модель → {model_out.relative_to(ROOT)}, отчёт → {report_out.relative_to(ROOT)} ({result['report']['seconds']} с)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
