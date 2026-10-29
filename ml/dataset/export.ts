// Подготовка обучающих данных QORGAN Sentinel (docs/SENTINEL_ML.md §2).
//
//   npx tsx ml/dataset/export.ts [--episodes 400] [--seed 2026] [--out data/ml/dataset.csv]
//   npx tsx ml/dataset/export.ts --official --out data/ml/official.csv   — сценарии демо (NORMAL/GRADUAL/RAPID)
//
// ДАННЫЕ СИНТЕТИЧЕСКИЕ. Ряды строит тот же генератор волны, что и встроенный симулятор QORGAN
// (packages/shared/src/simulation), с случайными, но воспроизводимыми параметрами эпизода (seed → тот же файл).
// Реальных исторических измерений р. Есиль в открытом машиночитаемом виде мы не нашли (docs/SENTINEL_ML.md §1).
//
// Метка НЕ копирует правила T2: это будущее событие — «измеренный уровень достигнет порога в следующие 6 ч»
// (тики t+1…t+6). Признаки — только по измерениям до t включительно, причём из «испорченных» рядов (пропуски,
// разрывы связи, выбросы), как их видел бы сервер. Метка — по неиспорченным показаниям.
// В каждую строку записывается и оценка правил T2 на те же данные — для честного сравнения на той же цели.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  assessRisk,
  computeFeatures,
  createGenerator,
  DEFAULT_RISK_CONFIG,
  FEATURE_NAMES,
  hashUnit,
  LEVEL_HISTORY_H,
  ML_HORIZON_H,
  resolveScenario,
  UPSTREAM_HISTORY_EXTRA_H,
  type Intervention,
  type MeasurementPoint,
  type ParameterCode,
  type RiskLevel,
  type ScenarioDefinition,
  type ScenarioId,
  type StationModel,
} from '@qorgan/shared';
import { SEED_STATIONS } from '../../apps/server/src/db/seed';

const MS_PER_HOUR = 3_600_000;
const START_MS = Date.parse('2026-03-01T00:00:00.000Z');

interface Args {
  episodes: number;
  seed: number;
  out: string;
  official: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const official = argv.includes('--official');
  return {
    episodes: Number(get('episodes') ?? 400),
    seed: Number(get('seed') ?? 2026),
    out: resolve(get('out') ?? (official ? 'data/ml/official.csv' : 'data/ml/dataset.csv')),
    official,
  };
}

/** Детерминированный генератор случайных чисел эпизода (без Math.random — как во всём QORGAN). */
function rng(seed: number, episode: number) {
  let n = 0;
  const u = () => hashUnit(`ml|${seed}|${episode}|${(n += 1)}`);
  return {
    u,
    range: (a: number, b: number) => a + (b - a) * u(),
    int: (a: number, b: number) => Math.floor(a + (b - a + 1) * u()),
    chance: (p: number) => u() < p,
  };
}

interface StationSetup {
  model: StationModel;
  warning: number;
  danger: number;
}

interface Episode {
  index: number;
  kind: string;
  scenario: ScenarioDefinition;
  seed: number;
  stations: StationSetup[];
  interventions: Intervention[];
  dropout: number;
  outage: { station: string; from: number; to: number } | null;
  spikeRate: number;
}

function seedStations(): StationSetup[] {
  return SEED_STATIONS.map((s) => ({
    model: {
      code: s.code,
      baseLevelCm: s.baseLevelCm,
      upstreamCode: s.upstream,
      travelHours: s.travelHours,
      attenuation: s.attenuation,
      responseHours: s.responseHours,
      sensors: Object.keys(s.parameters) as ParameterCode[],
    },
    warning: s.parameters.water_level!.warning!,
    danger: s.parameters.water_level!.danger!,
  }));
}

/** Случайный эпизод: форма волны, станции (база, задержка, ослабление, пороги), дожди, местные подъёмы, сбои данных. */
function randomEpisode(seed: number, index: number): Episode {
  const r = rng(seed, index);
  const roll = r.u();
  const kind = roll < 0.15 ? 'calm' : roll < 0.8 ? 'flood' : 'local';
  const stations = seedStations().map((s) => {
    const base = s.model.baseLevelCm + r.range(-25, 25);
    const warning = Math.round(s.warning + r.range(-30, 30));
    const danger = Math.round(warning + (s.danger - s.warning) + r.range(-20, 40));
    return {
      model: {
        ...s.model,
        baseLevelCm: Math.round(base),
        travelHours: s.model.travelHours === null ? null : Math.max(6, Math.round(s.model.travelHours * r.range(0.75, 1.25))),
        attenuation: s.model.upstreamCode ? Math.round(r.range(0.8, 1.15) * 100) / 100 : 1,
        responseHours: s.model.upstreamCode ? r.int(1, 8) : 1,
      },
      warning,
      danger,
    };
  });
  const startTick = r.int(5, 60);
  const riseH = r.int(6, 48);
  const peakH = r.int(0, 36);
  const fallH = r.int(18, 96);
  const amplitudeCm = kind === 'flood' ? r.range(60, 380) : r.range(0, 40);
  const cascade = stations.reduce((a, s) => a + (s.model.travelHours ?? 0), 0);
  const totalTicks = Math.min(420, Math.max(140, startTick + riseH + peakH + fallH + cascade + r.int(0, 30)));

  const localInflowCm: Record<string, number> = {};
  for (const s of stations.slice(1)) if (r.chance(0.3)) localInflowCm[s.model.code] = Math.round(r.range(-20, 60));

  const rain: ScenarioDefinition['rain'] = [];
  if (kind === 'flood' && r.chance(0.6)) {
    const from = Math.max(0, startTick - r.int(1, 8));
    rain.push({ stationCode: 'QRG-01', fromTick: from, toTick: from + r.int(2, 8), mmH: Math.round(r.range(1, 6) * 10) / 10 });
  }
  // Дожди, не связанные с волной (ложные предвестники).
  const extraRain = r.int(0, 2);
  for (let i = 0; i < extraRain; i += 1) {
    const from = r.int(0, totalTicks - 10);
    rain.push({ stationCode: stations[r.int(0, 2)]!.model.code, fromTick: from, toTick: from + r.int(1, 8), mmH: Math.round(r.range(0.5, 6) * 10) / 10 });
  }
  const tStart = r.range(-8, 2);
  const scenario: ScenarioDefinition = {
    ...resolveScenario('RAPID_FLOOD'),
    totalTicks,
    sourceStation: 'QRG-01',
    wave: { amplitudeCm, startTick, riseH, peakH, fallH },
    localInflowCm,
    rain,
    drizzle: { probability: r.range(0, 0.06), mmH: 0.5 },
    temperature: { startC: tStart, endC: tStart + r.range(-2, 12), rampH: r.int(12, 48), dailyAmplitudeC: r.range(1, 3), noiseC: 0.3 },
    level: { dailyAmplitudeCm: r.range(0, 3), noiseCm: r.range(0.5, 3) },
  };

  const interventions: Intervention[] = [];
  const surges = kind === 'local' ? r.int(1, 3) : r.chance(0.3) ? 1 : 0;
  for (let i = 0; i < surges; i += 1) {
    interventions.push({
      type: 'RISE_RATE',
      stationCode: stations[r.int(0, 3)]!.model.code,
      effectiveTick: r.int(10, Math.max(11, totalTicks - 40)),
      value: Math.round(r.range(-4, 16) * 10) / 10,
      durationH: r.int(3, 24),
    });
  }
  if (r.chance(0.1)) {
    interventions.push({ type: 'LEVEL_SHIFT', stationCode: stations[r.int(0, 3)]!.model.code, effectiveTick: r.int(10, totalTicks - 20), value: Math.round(r.range(-60, 90)) });
  }

  const outage = r.chance(0.3) ? (() => {
    const from = r.int(5, totalTicks - 15);
    return { station: stations[r.int(0, 3)]!.model.code, from, to: from + r.int(2, 10) };
  })() : null;

  return {
    index,
    kind,
    scenario,
    seed: r.int(1, 1_000_000),
    stations,
    interventions,
    dropout: r.chance(0.5) ? 0 : r.range(0.01, 0.08),
    outage,
    spikeRate: r.chance(0.5) ? 0 : 0.004,
  };
}

/** Эпизоды официальных сценариев демо — с теми же станциями и порогами, что в seed, без сбоев данных. */
function officialEpisodes(): Episode[] {
  const list: Episode[] = [];
  const ids: ScenarioId[] = ['NORMAL', 'GRADUAL_FLOOD', 'RAPID_FLOOD'];
  let index = 0;
  for (const id of ids) {
    for (const seed of [1, 7, 42]) {
      list.push({ index: index++, kind: id, scenario: resolveScenario(id), seed, stations: seedStations(), interventions: [], dropout: 0, outage: null, spikeRate: 0 });
    }
  }
  return list;
}

type Series = Record<string, Partial<Record<ParameterCode, Array<number | null>>>>;

/** Ряды эпизода: «истинные» показания (для метки) и то, что увидел бы сервер (пропуски, разрыв связи, выбросы). */
function simulate(ep: Episode): { truth: Series; observed: Series } {
  const gen = createGenerator({ scenario: ep.scenario, seed: ep.seed, stations: ep.stations.map((s) => s.model), interventions: ep.interventions });
  const truth: Series = {};
  const observed: Series = {};
  for (const s of ep.stations) {
    truth[s.model.code] = {};
    observed[s.model.code] = {};
    for (const p of s.model.sensors) {
      truth[s.model.code]![p] = [];
      observed[s.model.code]![p] = [];
    }
  }
  for (let t = 0; t < ep.scenario.totalTicks; t += 1) {
    for (const reading of gen.readingsAt(t)) {
      const code = reading.stationCode;
      truth[code]![reading.parameter]!.push(reading.value);
      const key = `${ep.seed}|${ep.index}|${code}|${reading.parameter}|${t}`;
      let value: number | null = reading.value;
      if (ep.outage && ep.outage.station === code && t >= ep.outage.from && t <= ep.outage.to) value = null;
      else if (hashUnit(`drop|${key}`) < ep.dropout) value = null;
      else if (reading.parameter === 'water_level' && hashUnit(`spike|${key}`) < ep.spikeRate) {
        const size = 55 + 95 * hashUnit(`spikesize|${key}`);
        value = Math.max(0, Math.round((reading.value + (hashUnit(`spikesign|${key}`) < 0.5 ? -size : size)) * 10) / 10);
      }
      observed[code]![reading.parameter]!.push(value);
    }
  }
  return { truth, observed };
}

const iso = (t: number) => new Date(START_MS + t * MS_PER_HOUR).toISOString();

function points(values: Array<number | null> | undefined, from: number, to: number): MeasurementPoint[] {
  if (!values) return [];
  const out: MeasurementPoint[] = [];
  for (let t = Math.max(0, from); t <= to; t += 1) {
    const v = values[t];
    if (v !== null && v !== undefined) out.push({ measuredAt: iso(t), value: v });
  }
  return out;
}

const fmt = (x: number) => (Number.isFinite(x) ? String(Math.round(x * 10_000) / 10_000) : '');

function exportEpisode(ep: Episode, lines: string[]): number {
  const { truth, observed } = simulate(ep);
  const cfg = DEFAULT_RISK_CONFIG;
  const byCode = new Map(ep.stations.map((s) => [s.model.code, s]));
  let rows = 0;
  for (let t = 0; t + ML_HORIZON_H < ep.scenario.totalTicks; t += 1) {
    const asOf = iso(t);
    const rules = new Map<string, RiskLevel>();
    // Порядок seed — по течению (верхняя раньше нижней), как в createEvaluator.
    for (const s of ep.stations) {
      const code = s.model.code;
      const obs = observed[code]!;
      const has = (p: ParameterCode) => s.model.sensors.includes(p);
      const up = s.model.upstreamCode ? byCode.get(s.model.upstreamCode)! : null;
      const assessment = assessRisk({
        asOf,
        thresholds: { warning: s.warning, danger: s.danger },
        sensors: s.model.sensors,
        series: {
          water_level: points(obs.water_level, t - cfg.windowSize * 3, t).slice(-cfg.windowSize * 3),
          precipitation: has('precipitation') ? points(obs.precipitation, t - cfg.rainWindowH - cfg.maxGapH + 1, t) : undefined,
          air_temp: has('air_temp') ? points(obs.air_temp, t - cfg.meltWindowH + 1, t) : undefined,
        },
        upstream: up ? { stationCode: up.model.code, risk: rules.get(up.model.code)!, travelHours: s.model.travelHours } : null,
        config: cfg,
      });
      rules.set(code, assessment.risk);

      const upHistory = (s.model.travelHours ?? 0) + UPSTREAM_HISTORY_EXTRA_H;
      const f = computeFeatures({
        asOf,
        thresholds: { warning: s.warning, danger: s.danger },
        level: points(obs.water_level, t - LEVEL_HISTORY_H, t),
        precipitation: has('precipitation') ? points(obs.precipitation, t - 7, t) : null,
        airTemp: has('air_temp') ? points(obs.air_temp, t - 24, t) : null,
        upstream: up
          ? { level: points(observed[up.model.code]!.water_level, t - upHistory, t), dangerCm: up.danger, travelHours: s.model.travelHours }
          : null,
      });
      const truthLevel = truth[code]!.water_level!;
      let futureMax = -Infinity;
      for (let k = 1; k <= ML_HORIZON_H; k += 1) futureMax = Math.max(futureMax, truthLevel[t + k]!);
      const now = truthLevel[t]!;
      lines.push(
        [
          ep.index, ep.kind, code, t,
          ...FEATURE_NAMES.map((n) => fmt(f[n])),
          futureMax >= s.warning ? 1 : 0, futureMax >= s.danger ? 1 : 0,
          now >= s.warning ? 1 : 0, now >= s.danger ? 1 : 0,
          assessment.risk, assessment.score,
        ].join(','),
      );
      rows += 1;
    }
  }
  return rows;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const episodes = args.official ? officialEpisodes() : Array.from({ length: args.episodes }, (_, i) => randomEpisode(args.seed, i));
  const header = ['episode', 'kind', 'station', 'tick', ...FEATURE_NAMES, 'y_warning', 'y_danger', 'now_warning', 'now_danger', 'rules_risk', 'rules_score'];
  const lines = [header.join(',')];
  let rows = 0;
  const started = Date.now();
  for (const ep of episodes) rows += exportEpisode(ep, lines);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${lines.join('\n')}\n`);
  const meta = {
    generator: 'ml/dataset/export.ts',
    synthetic: true,
    official: args.official,
    seed: args.official ? null : args.seed,
    episodes: episodes.length,
    rows,
    horizonH: ML_HORIZON_H,
    kinds: episodes.reduce<Record<string, number>>((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {}),
  };
  writeFileSync(args.out.replace(/\.csv$/, '.meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`[dataset] ${episodes.length} эпизодов, ${rows} строк → ${args.out} (${((Date.now() - started) / 1000).toFixed(1)} с)`);
}

main();
