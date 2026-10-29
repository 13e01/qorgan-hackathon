"""Отчёт об оценке в Markdown (ml/reports/evaluation.md) — генерируется из evaluation.json, числа не правятся руками."""

from __future__ import annotations

from pathlib import Path

NAMES = {
    "rules_t2": "Правила T2 (QORGAN-RULES-1)",
    "persistence": "«Уже выше порога» (без прогноза)",
    "logistic_regression": "Логистическая регрессия",
    "random_forest": "Случайный лес",
    "xgboost": "XGBoost (выбрана)",
    "xgboost_without_upstream": "XGBoost без станции выше по течению",
}
TARGET_NAMES = {"danger": "опасный порог D за 6 ч", "warning": "порог внимания W за 6 ч"}


def pct(x) -> str:
    return "—" if x is None else f"{100 * x:.1f} %"


def num(x, d=3) -> str:
    return "—" if x is None else f"{x:.{d}f}"


def write_markdown(report: dict, path: Path) -> None:
    lines = [
        "# QORGAN Sentinel — результаты оценки (сгенерировано)",
        "",
        f"Файл создан `ml/sentinel/train.py` из `evaluation.json`. Модель `{report['modelVersion']}`.",
        "",
        "> **Данные синтетические** (генератор волны симулятора QORGAN со случайными параметрами эпизодов).",
        "> Числа ниже — качество на синтетике, а не доказательство точности на реальной реке.",
        "",
        "## Данные",
        "",
        f"- Эпизодов: {report['dataset']['episodes']}, строк: {report['dataset']['rows']}, с оценкой модели: {report['dataset']['rowsUsable']}",
        f"- Разбиение: {report['dataset']['split']}",
    ]
    for k, v in report["dataset"]["sizes"].items():
        lines.append(f"  - {k}: {v['rows']} строк, {v['episodes']} эпизодов, положительных D: {v['positives_danger']}, W: {v['positives_warning']}")
    lines += ["", f"- Версии: {', '.join(f'{k} {v}' for k, v in report['trainedWith'].items())}", ""]

    for target in ("danger", "warning"):
        for subset, title in ((target, "все строки теста"), (f"{target}_onset", "только «начало подъёма» (сейчас ниже порога)")):
            lines += [f"## Цель: {TARGET_NAMES[target]} — {title}", "", "| Модель | Precision | Recall | F1 | PR-AUC | Пропущено | Ложные тревоги (доля / число) |", "|---|---|---|---|---|---|---|"]
            for e in report["experiments"]:
                r = e["test"][subset]
                lines.append(f"| {NAMES.get(e['name'], e['name'])} | {pct(r['precision'])} | {pct(r['recall'])} | {num(r['f1'])} | {num(r.get('pr_auc'))} | {pct(r['miss_rate'])} | {pct(r['false_alarm_rate'])} / {r['false_alarms']} |")
            lines.append("")

    lines += ["## Категории LOW / MEDIUM / HIGH на тесте", ""]
    for name, rep in report["categories"].items():
        lines += [f"**{NAMES.get(name, name)}** — macro-F1 {num(rep['macro_f1'])}", "", "| Класс | Precision | Recall | F1 | Строк |", "|---|---|---|---|---|"]
        for c, r in rep["per_class"].items():
            lines.append(f"| {c} | {pct(r['precision'])} | {pct(r['recall'])} | {num(r['f1'])} | {r['positives']} |")
        lines += ["", "Матрица ошибок (строка — истина, столбец — оценка):", "", "| | LOW | MEDIUM | HIGH |", "|---|---|---|---|"]
        for t, row in rep["confusion_matrix"].items():
            lines.append(f"| {t} | {row['LOW']} | {row['MEDIUM']} | {row['HIGH']} |")
        lines.append("")

    lines += ["## Время упреждения (тест): за сколько часов до достижения опасного порога появился сигнал HIGH", "", "| Модель | Событий | Обнаружено | Пропущено | Среднее упреждение, ч | Медиана, ч |", "|---|---|---|---|---|---|"]
    for name, r in report["leadTime"].items():
        lines.append(f"| {NAMES.get(name, name)} | {r['events']} | {r['detected']} | {r['missed']} | {num(r['mean_lead_h'], 2)} | {num(r['median_lead_h'], 1)} |")
    lines.append("")

    lines += ["## Калибровка вероятностей XGBoost (тест)", ""]
    for target, rows in report["calibration"].items():
        lines += [f"**{TARGET_NAMES[target]}**", "", "| Интервал | Строк | Средняя вероятность | Доля событий |", "|---|---|---|---|"]
        for r in rows:
            lines.append(f"| {r['bin']} | {r['n']} | {num(r['mean_pred'])} | {num(r['observed'])} |")
        lines.append("")

    if report.get("official"):
        off = report["official"]
        lines += [f"## Официальные сценарии демо (NORMAL / GRADUAL_FLOOD / RAPID_FLOOD × 3 seed, {off['rows']} строк, не участвовали в обучении)", "", "| Модель | Цель | Precision | Recall | F1 | Ложные тревоги |", "|---|---|---|---|---|---|"]
        for name in ("xgboost", "rules_t2"):
            for target in ("danger", "warning"):
                r = off[name][target]
                lines.append(f"| {NAMES[name]} | {TARGET_NAMES[target]} | {pct(r['precision'])} | {pct(r['recall'])} | {num(r['f1'])} | {r['false_alarms']} |")
        lines.append("")

    lines += ["## Средний |SHAP| признаков (тест, логит)", ""]
    for target, imp in report["importance"].items():
        lines += [f"**{TARGET_NAMES[target]}**: " + ", ".join(f"`{k}` {v:.3f}" for k, v in list(imp.items())[:8]), ""]

    lines += ["## Подбор гиперпараметров XGBoost (валидация)", "", "| Цель | max_depth | learning_rate | min_child_weight | Деревьев | PR-AUC |", "|---|---|---|---|---|---|"]
    for t in report["tuning"]:
        lines.append(f"| {t['target']} | {t['max_depth']} | {t['learning_rate']} | {t['min_child_weight']} | {t['rounds']} | {num(t['val_pr_auc'], 4)} |")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
