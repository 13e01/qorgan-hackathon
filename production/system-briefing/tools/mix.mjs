// Звук ролика: оригинальная музыка и SFX синтезируются здесь же (без чужих сэмплов), озвучка — audio/vo/*.wav.
//   node production/system-briefing/tools/mix.mjs
// Результат: audio/music.wav, audio/sfx.wav, audio/vo.wav (дорожки по отдельности) и audio/mix.wav (сведение,
// громкость приведена к −16 LUFS, пики не выше −1,5 dBTP — ffmpeg loudnorm в два прохода).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './stand.mjs';

const BASE = resolve(ROOT, 'production/system-briefing');
const SR = 48000;
const tl = JSON.parse(readFileSync(join(BASE, 'edit/timeline.json'), 'utf8'));
const narration = JSON.parse(readFileSync(join(BASE, 'edit/narration.json'), 'utf8'));
const { events, t0 } = JSON.parse(readFileSync(join(BASE, 'capture', tl.take, 'events.json'), 'utf8'));
const DUR = tl.duration + 0.6; // короткий хвост реверберации после последнего кадра обрезается при сборке
const N = Math.round(DUR * SR);

// ── детерминированный шум (как в симуляторе QORGAN: никакого Math.random) ───────────────────────────
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };

const stereo = () => [new Float32Array(N), new Float32Array(N)];
const TAU = Math.PI * 2;
const midi = (m) => 440 * 2 ** ((m - 69) / 12);
const dbToGain = (db) => 10 ** (db / 20);

// ── время записи → время ролика (обратная карта отрезков монтажа) ─────────────────────────────────────
function outTimes(srcT) {
  const res = [];
  for (const seg of tl.segments) {
    const m = seg.map;
    let o;
    if (srcT <= m[0][1]) o = m[0][0] - (m[0][1] - srcT);
    else if (srcT >= m.at(-1)[1]) o = m.at(-1)[0] + (srcT - m.at(-1)[1]);
    else for (let i = 1; i < m.length; i++) if (srcT <= m[i][1]) { o = m[i - 1][0] + ((srcT - m[i - 1][1]) / (m[i][1] - m[i - 1][1])) * (m[i][0] - m[i - 1][0]); break; }
    if (o >= seg.out[0] && o < seg.out[1]) res.push(o);
  }
  return res;
}
const rel = (t) => t - t0;

// ── простая реверберация (Шрёдер: 4 гребенчатых + 2 фазовых фильтра), отдельно для каналов ────────────
function reverb(buf, { mix = 0.3, room = 0.84, damp = 0.35 } = {}) {
  const out = new Float32Array(buf.length);
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ d, b: new Float32Array(d), i: 0, f: 0 }));
  const aps = [225, 556].map((d) => ({ d, b: new Float32Array(d), i: 0 }));
  for (let n = 0; n < buf.length; n++) {
    const x = buf[n];
    let y = 0;
    for (const c of combs) {
      const o = c.b[c.i];
      c.f = o * (1 - damp) + c.f * damp;
      c.b[c.i] = x + c.f * room;
      c.i = (c.i + 1) % c.d;
      y += o;
    }
    y *= 0.25;
    for (const a of aps) {
      const o = a.b[a.i];
      const v = y + o * 0.5;
      a.b[a.i] = v;
      a.i = (a.i + 1) % a.d;
      y = o - v * 0.5;
    }
    out[n] = x * (1 - mix) + y * mix;
  }
  return out;
}
const lowpass = (buf, hz) => { const a = Math.exp((-TAU * hz) / SR); let s = 0; for (let n = 0; n < buf.length; n++) { s = buf[n] * (1 - a) + s * a; buf[n] = s; } return buf; };

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// МУЗЫКА: атмосферная электроника, ре минор. Спокойно → напряжение во время подъёма воды → разрешение.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
const A = tl.anchors.O;
const music = stereo();
// Огибающая «напряжения» 0..1 по сюжету.
const tension = (t) => {
  if (t < A.danger - 1) return 0.15 * Math.min(1, t / 6);
  if (t < A.high) return 0.15 + 0.85 * ((t - (A.danger - 1)) / (A.high - A.danger + 1));
  if (t < A.navClick) return 1;
  if (t < A.finaleIn) return 1 - 0.75 * ((t - A.navClick) / (A.finaleIn - A.navClick));
  return Math.max(0, 0.25 - (t - A.finaleIn) * 0.1);
};
// Аккорды (MIDI) по отрезкам времени.
const chords = [
  [0, [50, 57, 60, 64, 69]],          // Dm(add9)
  [7.5, [46, 53, 57, 62, 65]],        // Bbmaj7
  [15, [41, 53, 57, 60, 64]],         // F/A-ish
  [A.danger - 1.0, [50, 57, 62, 65, 69]],   // Dm — подъём
  [A.medium, [46, 53, 58, 62, 65]],   // Bb
  [A.high - 0.5, [48, 55, 58, 63, 67]],      // Cm(add9) — пик напряжения
  [A.navClick + 0.5, [43, 55, 58, 62, 65]],  // Gm7 — работа оператора, спокойнее
  [A.finaleIn, [50, 57, 62, 64, 69]],        // Dsus2 — разрешение
];
const chordAt = (t) => { let c = chords[0][1]; for (const [s, ch] of chords) if (t >= s) c = ch; return c; };

// Пэд: по 2 слегка расстроенных треугольника на ноту, медленная смена аккордов (кроссфейд 1,8 с).
{
  const L = new Float32Array(N), R = new Float32Array(N);
  const phases = new Map();
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    let ci = 0;
    for (let i = 0; i < chords.length; i++) if (t >= chords[i][0]) ci = i;
    const xf = Math.min(1, (t - chords[ci][0]) / 1.8);
    const sets = [[chords[ci][1], xf]];
    if (ci > 0 && xf < 1) sets.push([chords[ci - 1][1], 1 - xf]);
    let l = 0, r = 0;
    for (const [notes, g] of sets) {
      for (const m of notes) {
        for (const [det, pan] of [[-0.07, 0.25], [0.07, 0.75]]) {
          const key = `${m}:${det}`;
          const ph = ((phases.get(key) ?? (m * 0.137) % 1) + midi(m + det) / SR) % 1;
          phases.set(key, ph);
          const tri = 1 - 4 * Math.abs(ph - 0.5);
          const v = tri * g * (m < 48 ? 0.9 : 0.5);
          l += v * (1 - pan); r += v * pan;
        }
      }
    }
    const env = Math.min(1, t / 3.5) * (t > DUR - 3 ? Math.max(0, (DUR - t) / 3) : 1);
    const breathe = 0.85 + 0.15 * Math.sin(TAU * t / 9);
    L[n] = l * 0.018 * env * breathe; R[n] = r * 0.018 * env * breathe;
  }
  lowpass(L, 1400); lowpass(R, 1400);
  const rl = reverb(L, { mix: 0.45 }), rr = reverb(R, { mix: 0.45 });
  for (let n = 0; n < N; n++) { music[0][n] += rl[n]; music[1][n] += rr[n]; }
}
// Суббас-пульс во время подъёма воды (восьмые, 96 BPM), нарастает с напряжением.
{
  const bpm = 96, step = 60 / bpm / 2;
  let ph = 0;
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    const k = tension(t);
    if (k < 0.2) continue;
    const root = chordAt(t)[0] - 12;
    ph = (ph + midi(root) / SR) % 1;
    const local = (t % step) / step;
    const env = Math.exp(-local * 5.5) * (1 - Math.exp(-local * 120));
    const v = Math.sin(TAU * ph) * env * 0.11 * (k - 0.2) / 0.8;
    music[0][n] += v; music[1][n] += v;
  }
}
// Редкое арпеджио (колокольчики) в спокойной части и в финале.
{
  const L = new Float32Array(N), R = new Float32Array(N);
  const notesAt = (t) => chordAt(t).slice(1).map((m) => m + 12);
  const hits = [];
  for (let t = 2.0; t < DUR - 1.5; t += 60 / 96) {
    const k = tension(t);
    if (k > 0.5) continue; // во время подъёма воды арпеджио молчит — пусть работает пульс
    const idx = Math.round((t * 96) / 60) % 4;
    hits.push([t, notesAt(t)[[0, 2, 1, 3][idx]], idx % 2 ? 0.3 : 0.7]);
  }
  for (const [t, m, pan] of hits) {
    const s = Math.round(t * SR), f = midi(m);
    for (let i = 0; i < SR * 1.6 && s + i < N; i++) {
      const tt = i / SR;
      const v = (Math.sin(TAU * f * tt) + 0.25 * Math.sin(TAU * f * 2.01 * tt)) * Math.exp(-tt * 3.2) * (1 - Math.exp(-tt * 300)) * 0.03;
      L[s + i] += v * (1 - pan); R[s + i] += v * pan;
    }
  }
  const rl = reverb(L, { mix: 0.5 }), rr = reverb(R, { mix: 0.5 });
  for (let n = 0; n < N; n++) { music[0][n] += rl[n]; music[1][n] += rr[n]; }
}
// Высокое мерцание (фильтрованный шум), растёт с напряжением.
{
  let s1 = 0, s2 = 0;
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    const k = tension(t);
    const x = rnd();
    s1 = s1 * 0.92 + x * 0.08; // мягкий ФНЧ
    s2 = x - s1;              // остаток — верхние частоты
    const v = s2 * 0.006 * k * (0.7 + 0.3 * Math.sin(TAU * t * 0.5));
    music[0][n] += v; music[1][n] -= v * 0.8;
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// SFX — по событиям монтажа
// ════════════════════════════════════════════════════════════════════════════════════════════════════
const sfx = stereo();
function add(buf, at, gainDb = 0, pan = 0.5) {
  const s = Math.round(at * SR), g = dbToGain(gainDb);
  for (let i = 0; i < buf.length && s + i < N; i++) if (s + i >= 0) { sfx[0][s + i] += buf[i] * g * (1 - pan) * 2 * 0.5; sfx[1][s + i] += buf[i] * g * pan * 2 * 0.5; }
}
const gen = (sec, fn) => { const b = new Float32Array(Math.round(sec * SR)); for (let i = 0; i < b.length; i++) b[i] = fn(i / SR, i); return b; };
const uiClick = () => { let lp = 0; return gen(0.08, (t) => { const n = rnd(); lp = lp * 0.6 + n * 0.4; return (Math.sin(TAU * 1850 * t) * 0.5 + lp * 0.6) * Math.exp(-t * 90) * 0.5; }); };
const keyTick = () => { let lp = 0; return gen(0.035, (t) => { lp = lp * 0.5 + rnd() * 0.5; return lp * Math.exp(-t * 160) * 0.35; }); };
const whoosh = (sec = 0.9, up = true) => { let lp = 0; return gen(sec, (t) => { const u = t / sec; const cut = up ? 0.02 + 0.25 * u : 0.27 - 0.25 * u; lp = lp * (1 - cut) + rnd() * cut; return lp * Math.sin(Math.PI * u) ** 2 * 0.9; }); };
const lowHit = () => gen(1.4, (t) => Math.sin(TAU * (34 + 30 * Math.exp(-t * 6)) * t) * Math.exp(-t * 2.4) * (1 - Math.exp(-t * 200)) * 0.55);
const chime = (f1, f2) => gen(1.6, (t) => (Math.sin(TAU * f1 * t) * Math.exp(-t * 3) + (t > 0.13 ? Math.sin(TAU * f2 * (t - 0.13)) * Math.exp(-(t - 0.13) * 2.6) : 0)) * (1 - Math.exp(-t * 400)) * 0.32);
const dataPing = () => gen(0.12, (t) => Math.sin(TAU * 2600 * t) * Math.exp(-t * 55) * 0.18);
const shimmer = () => gen(2.6, (t) => [1, 1.5, 2, 3].reduce((a, k, i) => a + Math.sin(TAU * 587.33 * k * t + i) * Math.exp(-t * (1.4 + i * 0.5)), 0) * (1 - Math.exp(-t * 30)) * 0.08);

const marks = [];
const log = (name, t, db) => marks.push({ name, t: +t.toFixed(2), db });
// Клики
for (const e of events.filter((x) => x.type === 'click')) for (const o of outTimes(rel(e.t))) { add(uiClick(), o, -12, 0.5); log(`клик ${e.label}`, o, -12); }
// Набор комментария
for (const e of events.filter((x) => x.type === 'key')) for (const o of outTimes(rel(e.t))) add(keyTick(), o, -22, 0.55);
// Показания датчика — едва слышный «пинг» данных, только в главе «Учебный паводок»
for (const e of events.filter((x) => x.type === 'sensor' && /#\d+ /.test(x.line))) for (const o of outTimes(rel(e.t))) if (o > A.danger - 2.5 && o < A.navClick) add(dataPing(), o, -26, 0.35);
// Переходы и акценты
add(whoosh(1.0, true), A.openClick - 0.35, -16); log('whoosh → система', A.openClick - 0.35, -16);
add(lowHit(), A.openClick + 0.25, -14); log('низкий переход', A.openClick + 0.25, -14);
add(whoosh(0.8, false), A.danger - 2.6, -20); log('окно датчика', A.danger - 2.6, -20);
add(chime(659.25, 880), A.medium + 0.1, -15, 0.6); log('сигнал: средний', A.medium + 0.1, -15);
add(chime(587.33, 932.33), A.high + 0.1, -13, 0.6); log('сигнал: высокий', A.high + 0.1, -13);
add(lowHit(), A.high + 0.05, -18); log('акцент: высокий', A.high + 0.05, -18);
add(whoosh(1.1, true), A.finaleIn - 0.6, -17); log('whoosh → главная', A.finaleIn - 0.6, -17);
add(shimmer(), tl.end[0] + 0.1, -10); log('логотип', tl.end[0] + 0.1, -10);
add(lowHit(), tl.end[0] + 0.05, -16);
{ const r0 = reverb(sfx[0], { mix: 0.22, room: 0.8 }), r1 = reverb(sfx[1], { mix: 0.22, room: 0.8 }); sfx[0].set(r0); sfx[1].set(r1); }

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// ОЗВУЧКА + приглушение музыки под голосом
// ════════════════════════════════════════════════════════════════════════════════════════════════════
function readWavMono(file) {
  const b = readFileSync(file);
  let p = 12, fmt, data;
  while (p < b.length) { const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4); if (id === 'fmt ') fmt = b.subarray(p + 8, p + 8 + sz); if (id === 'data') data = b.subarray(p + 8, p + 8 + sz); p += 8 + sz + (sz & 1); }
  if (fmt.readUInt16LE(2) !== 1 || fmt.readUInt32LE(4) !== SR || fmt.readUInt16LE(14) !== 16) throw new Error(`${file}: нужен WAV 48 кГц 16 бит моно`);
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}
const vo = new Float32Array(N);
const voLines = [];
for (const line of narration.lines) {
  const buf = readWavMono(join(BASE, 'audio/vo', `${line.id}.wav`));
  const s = Math.round(line.start * SR);
  for (let i = 0; i < buf.length && s + i < N; i++) vo[s + i] += buf[i];
  voLines.push({ id: line.id, start: line.start, end: +(line.start + buf.length / SR).toFixed(2) });
}
// Огибающая голоса (атака 60 мс, спад 450 мс) → музыка тише на 6 дБ, пока звучит диктор.
const duck = new Float32Array(N);
{
  let env = 0;
  const att = Math.exp(-1 / (0.06 * SR)), rel_ = Math.exp(-1 / (0.45 * SR));
  for (let n = 0; n < N; n++) { const x = Math.abs(vo[n]) > 0.02 ? 1 : 0; env = x > env ? x + (env - x) * att : x + (env - x) * rel_; duck[n] = dbToGain(-6 * env); }
}

// ── запись ─────────────────────────────────────────────────────────────────────────────────────────
function writeWav(file, chans) {
  const n = chans[0].length, c = chans.length;
  const b = Buffer.alloc(44 + n * c * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * c * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(c, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * c * 4, 28); b.writeUInt16LE(c * 4, 32); b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(n * c * 4, 40);
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) b.writeFloatLE(chans[k][i], 44 + (i * c + k) * 4);
  writeFileSync(file, b);
}
const MUSIC_DB = 8, SFX_DB = 5, VO_DB = 0;
const mix = stereo();
for (let n = 0; n < N; n++) {
  const m = dbToGain(MUSIC_DB) * duck[n];
  mix[0][n] = music[0][n] * m + sfx[0][n] * dbToGain(SFX_DB) + vo[n] * dbToGain(VO_DB);
  mix[1][n] = music[1][n] * m + sfx[1][n] * dbToGain(SFX_DB) + vo[n] * dbToGain(VO_DB);
}
const A_DIR = join(BASE, 'audio');
writeWav(join(A_DIR, 'music.wav'), music);
writeWav(join(A_DIR, 'sfx.wav'), sfx);
writeWav(join(A_DIR, 'vo.wav'), [vo, vo]);
writeWav(join(A_DIR, 'mix-raw.wav'), mix);

// Громкость: два прохода loudnorm (−16 LUFS, пики ≤ −1,5 dBTP).
const LN = 'loudnorm=I=-16:TP=-1.5:LRA=11';
const r1 = spawnSync('ffmpeg', ['-hide_banner', '-i', join(A_DIR, 'mix-raw.wav'), '-af', `${LN}:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' });
// ffmpeg пишет отчёт loudnorm в stderr.
const stats = JSON.parse(r1.stderr.slice(r1.stderr.lastIndexOf('{'), r1.stderr.lastIndexOf('}') + 1));
const second = `${LN}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true:print_format=json`;
const r2 = spawnSync('ffmpeg', ['-y', '-hide_banner', '-i', join(A_DIR, 'mix-raw.wav'), '-af', `${second},aresample=48000`, '-c:a', 'pcm_s24le', join(A_DIR, 'mix.wav')], { encoding: 'utf8' });
const after = JSON.parse(r2.stderr.slice(r2.stderr.lastIndexOf('{'), r2.stderr.lastIndexOf('}') + 1));
writeFileSync(join(A_DIR, 'mix-report.json'), JSON.stringify({ before: stats, after, voLines, sfx: marks }, null, 1));
console.log(`звук: вход ${stats.input_i} LUFS → выход ${after.output_i} LUFS, пик ${after.output_tp} dBTP`);
console.log('реплики:', voLines.map((l) => `${l.id} ${l.start}–${l.end}`).join(' | '));
