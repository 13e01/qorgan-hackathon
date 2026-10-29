"""Метрики качества (docs/SENTINEL_EVALUATION.md). Только numpy/scikit-learn, без «общей accuracy» как главной метрики."""

from __future__ import annotations

import numpy as np
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

LEVELS = ["LOW", "MEDIUM", "HIGH"]


def binary_report(y: np.ndarray, pred: np.ndarray, proba: np.ndarray | None = None) -> dict:
    y = np.asarray(y).astype(int)
    pred = np.asarray(pred).astype(int)
    tp = int(((pred == 1) & (y == 1)).sum())
    fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum())
    tn = int(((pred == 0) & (y == 0)).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    out = {
        "n": int(len(y)),
        "positives": int(y.sum()),
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
        "precision": precision,
        "recall": recall,
        "f1": f1,
        # Доля пропущенных опасных событий и ложных тревог (среди всех отрицательных строк).
        "miss_rate": fn / (tp + fn) if tp + fn else 0.0,
        "false_alarm_rate": fp / (fp + tn) if fp + tn else 0.0,
        "false_alarms": fp,
    }
    if proba is not None and 0 < y.sum() < len(y):
        out["pr_auc"] = float(average_precision_score(y, proba))
        out["roc_auc"] = float(roc_auc_score(y, proba))
        out["brier"] = float(brier_score_loss(y, proba))
        out["ece"] = expected_calibration_error(y, proba)
    return out


def f_beta(precision: float, recall: float, beta: float) -> float:
    b2 = beta * beta
    return (1 + b2) * precision * recall / (b2 * precision + recall) if precision + recall else 0.0


def choose_threshold(y: np.ndarray, proba: np.ndarray, beta: float = 2.0) -> tuple[float, float]:
    """Порог вероятности, максимизирующий F-beta на валидации (beta = 2: пропуск опасного события дороже ложной тревоги)."""
    best_t, best = 0.5, -1.0
    for t in np.round(np.arange(0.05, 0.96, 0.01), 2):
        r = binary_report(y, proba >= t)
        score = f_beta(r["precision"], r["recall"], beta)
        if score > best + 1e-12:
            best_t, best = float(t), score
    return best_t, best


def calibration_table(y: np.ndarray, proba: np.ndarray, bins: int = 10) -> list[dict]:
    edges = np.linspace(0, 1, bins + 1)
    rows = []
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (proba >= lo) & (proba < hi if i < bins - 1 else proba <= hi)
        if mask.sum() == 0:
            continue
        rows.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": int(mask.sum()), "mean_pred": float(proba[mask].mean()), "observed": float(y[mask].mean())})
    return rows


def expected_calibration_error(y: np.ndarray, proba: np.ndarray, bins: int = 10) -> float:
    n = len(y)
    return float(sum(r["n"] / n * abs(r["mean_pred"] - r["observed"]) for r in calibration_table(y, proba, bins)))


def category_true(df) -> np.ndarray:
    """Истинный класс: HIGH — опасный порог в ближайшие 6 ч, MEDIUM — порог внимания, иначе LOW."""
    return np.where(df["y_danger"] == 1, "HIGH", np.where(df["y_warning"] == 1, "MEDIUM", "LOW"))


def multiclass_report(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    per_class = {}
    for c in LEVELS:
        per_class[c] = binary_report(y_true == c, y_pred == c)
        per_class[c] = {k: per_class[c][k] for k in ("n", "positives", "precision", "recall", "f1", "confusion")}
    matrix = {t: {p: int(((y_true == t) & (y_pred == p)).sum()) for p in LEVELS} for t in LEVELS}
    macro_f1 = float(np.mean([per_class[c]["f1"] for c in LEVELS]))
    return {"per_class": per_class, "confusion_matrix": matrix, "macro_f1": macro_f1, "accuracy": float((y_true == y_pred).mean())}


def lead_times(df, flag_col: str, threshold_col: str = "now_danger", horizon: int = 6) -> dict:
    """Время упреждения: за сколько часов до первого фактического достижения порога в эпизоде на станции
    модель непрерывно (до момента пересечения) сигналила. 0 — сигнал появился только в момент пересечения;
    пропуск — сигнала не было ни за `horizon` ч до пересечения, ни в момент пересечения."""
    leads = []
    missed = 0
    for (_, _), g in df.sort_values("tick").groupby(["episode", "station"]):
        crossing = g[g[threshold_col] == 1]
        if crossing.empty:
            continue
        t_cross = int(crossing["tick"].iloc[0])
        before = g[(g["tick"] <= t_cross) & (g["tick"] >= t_cross - horizon)].sort_values("tick", ascending=False)
        lead = None
        for _, row in before.iterrows():
            if row[flag_col]:
                lead = t_cross - int(row["tick"])
            else:
                break
        if lead is None:
            missed += 1
        else:
            leads.append(lead)
    events = len(leads) + missed
    return {
        "events": events,
        "detected": len(leads),
        "missed": missed,
        "mean_lead_h": float(np.mean(leads)) if leads else None,
        "median_lead_h": float(np.median(leads)) if leads else None,
    }
