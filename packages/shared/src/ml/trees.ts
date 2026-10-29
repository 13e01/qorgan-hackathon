// Вычисление градиентного бустинга деревьев (XGBoost, binary:logistic) и точных SHAP-вкладов (TreeSHAP)
// без Python и без внешних библиотек. Модель обучается в ml/ (Python, XGBoost) и выгружается в JSON
// (ml/sentinel/export.py); здесь деревья только вычисляются.
//
// Правило ветвления как в XGBoost: признак переводится в float32; x < порог → влево, иначе вправо;
// пропуск (NaN) → направление default_left. SHAP — алгоритм Path-dependent TreeSHAP (Lundberg и др., 2018),
// тот же, что `Booster.predict(pred_contribs=True)` в XGBoost; совпадение проверяется тестом паритета на
// примерах, которые сохранил Python при выгрузке модели (packages/shared/test/ml.test.ts).

export interface Tree {
  /** Индекс левого потомка; −1 — лист. */
  left: number[];
  right: number[];
  /** Номер признака в узле (у листа не используется). */
  feature: number[];
  /** Порог ветвления (у листа — значение листа, как в XGBoost). */
  threshold: number[];
  /** 1 — пропуск идёт влево. */
  defaultLeft: number[];
  /** Покрытие узла (сумма гессиана) — нужно TreeSHAP. */
  cover: number[];
}

export interface Booster {
  /** Начальное значение в пространстве логитов (base_score). */
  baseMargin: number;
  trees: Tree[];
}

function nextNode(tree: Tree, node: number, x: readonly number[]): number {
  const v = x[tree.feature[node]!]!;
  if (Number.isNaN(v)) return tree.defaultLeft[node] ? tree.left[node]! : tree.right[node]!;
  return Math.fround(v) < tree.threshold[node]! ? tree.left[node]! : tree.right[node]!;
}

function leafValue(tree: Tree, x: readonly number[]): number {
  let node = 0;
  while (tree.left[node] !== -1) node = nextNode(tree, node, x);
  return tree.threshold[node]!;
}

/** Логит (margin) модели. */
export function predictMargin(booster: Booster, x: readonly number[]): number {
  let sum = booster.baseMargin;
  for (const tree of booster.trees) sum += leafValue(tree, x);
  return sum;
}

export const sigmoid = (m: number) => 1 / (1 + Math.exp(-m));

export function predictProba(booster: Booster, x: readonly number[]): number {
  return sigmoid(predictMargin(booster, x));
}

// Путь TreeSHAP хранится в общих массивах (как в эталонной реализации на C++): у узла на глубине d свой участок
// длиной d + 1, следующий участок начинается сразу за ним. Так на каждый узел не создаются новые объекты.
const PATH_SIZE = 4096;
const pFeature = new Int32Array(PATH_SIZE);
const pZero = new Float64Array(PATH_SIZE);
const pOne = new Float64Array(PATH_SIZE);
const pW = new Float64Array(PATH_SIZE);

function extendPath(o: number, depth: number, zero: number, one: number, feature: number): void {
  pFeature[o + depth] = feature;
  pZero[o + depth] = zero;
  pOne[o + depth] = one;
  pW[o + depth] = depth === 0 ? 1 : 0;
  for (let i = depth - 1; i >= 0; i -= 1) {
    pW[o + i + 1]! += (one * pW[o + i]! * (i + 1)) / (depth + 1);
    pW[o + i] = (zero * pW[o + i]! * (depth - i)) / (depth + 1);
  }
}

function unwindPath(o: number, depth: number, index: number): void {
  const one = pOne[o + index]!;
  const zero = pZero[o + index]!;
  let next = pW[o + depth]!;
  for (let i = depth - 1; i >= 0; i -= 1) {
    if (one !== 0) {
      const tmp = pW[o + i]!;
      pW[o + i] = (next * (depth + 1)) / ((i + 1) * one);
      next = tmp - (pW[o + i]! * zero * (depth - i)) / (depth + 1);
    } else {
      pW[o + i] = (pW[o + i]! * (depth + 1)) / (zero * (depth - i));
    }
  }
  for (let i = index; i < depth; i += 1) {
    pFeature[o + i] = pFeature[o + i + 1]!;
    pZero[o + i] = pZero[o + i + 1]!;
    pOne[o + i] = pOne[o + i + 1]!;
  }
}

function unwoundPathSum(o: number, depth: number, index: number): number {
  const one = pOne[o + index]!;
  const zero = pZero[o + index]!;
  let next = pW[o + depth]!;
  let total = 0;
  for (let i = depth - 1; i >= 0; i -= 1) {
    if (one !== 0) {
      const tmp = (next * (depth + 1)) / ((i + 1) * one);
      total += tmp;
      next = pW[o + i]! - (tmp * zero * (depth - i)) / (depth + 1);
    } else if (zero !== 0) {
      total += pW[o + i]! / zero / ((depth - i) / (depth + 1));
    }
  }
  return total;
}

function treeShap(tree: Tree, x: readonly number[], phi: number[], node: number, parent: number, depthIn: number, zero: number, one: number, feature: number): void {
  // Участок пути этого узла — сразу за участком родителя; копируются элементы родителя 0…depthIn.
  const o = parent + depthIn + 1;
  if (o + depthIn + 1 >= PATH_SIZE) throw new Error('tree too deep for TreeSHAP buffer');
  for (let i = 0; i <= depthIn; i += 1) {
    pFeature[o + i] = pFeature[parent + i]!;
    pZero[o + i] = pZero[parent + i]!;
    pOne[o + i] = pOne[parent + i]!;
    pW[o + i] = pW[parent + i]!;
  }
  let depth = depthIn;
  extendPath(o, depth, zero, one, feature);
  if (tree.left[node] === -1) {
    for (let i = 1; i <= depth; i += 1) {
      const w = unwoundPathSum(o, depth, i);
      phi[pFeature[o + i]!]! += w * (pOne[o + i]! - pZero[o + i]!) * tree.threshold[node]!;
    }
    return;
  }
  const split = tree.feature[node]!;
  const hot = nextNode(tree, node, x);
  const cold = hot === tree.left[node] ? tree.right[node]! : tree.left[node]!;
  const w = tree.cover[node]!;
  const hotZero = tree.cover[hot]! / w;
  const coldZero = tree.cover[cold]! / w;
  let inZero = 1;
  let inOne = 1;
  let index = 0;
  for (; index <= depth; index += 1) if (pFeature[o + index] === split) break;
  if (index !== depth + 1) {
    inZero = pZero[o + index]!;
    inOne = pOne[o + index]!;
    unwindPath(o, depth, index);
    depth -= 1;
  }
  treeShap(tree, x, phi, hot, o, depth + 1, hotZero * inZero, inOne, split);
  treeShap(tree, x, phi, cold, o, depth + 1, coldZero * inZero, 0, split);
}

/** Ожидаемое значение дерева (взвешенное по покрытию среднее листьев). */
function expectedValue(tree: Tree, node = 0): number {
  if (tree.left[node] === -1) return tree.threshold[node]!;
  const l = tree.left[node]!;
  const r = tree.right[node]!;
  return (tree.cover[l]! * expectedValue(tree, l) + tree.cover[r]! * expectedValue(tree, r)) / tree.cover[node]!;
}

/**
 * SHAP-вклады признаков в логит: `bias + Σ phi = predictMargin(x)`.
 * Возвращает массив длины nFeatures + 1, последний элемент — базовое значение (bias), как в XGBoost.
 */
export function shapValues(booster: Booster, x: readonly number[], nFeatures: number): number[] {
  const phi = new Array<number>(nFeatures + 1).fill(0);
  for (const tree of booster.trees) {
    // Корень: «родительский» участок — позиция 0, участок корня начинается с 1 (как в C++-реализации).
    treeShap(tree, x, phi, 0, 0, 0, 1, 1, -1);
    phi[nFeatures]! += expectedValue(tree);
  }
  phi[nFeatures]! += booster.baseMargin;
  return phi;
}
