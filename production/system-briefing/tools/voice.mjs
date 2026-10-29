// Озвучка: синтез реплик из edit/narration.json (tools/tts.py, Microsoft Neural через edge-tts, онлайн)
// и подготовка WAV для монтажа.
//   py -m pip install --user edge-tts   (один раз)
//   node production/system-briefing/tools/voice.mjs [L03 ...]   — без аргументов пересинтезирует все реплики
//   node production/system-briefing/tools/voice.mjs --no-synth   — только пересобрать WAV из готовых MP3
// Результат: audio/vo/Lxx.wav (48 кГц, моно, тишина по краям обрезана) и audio/vo/durations.json.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './stand.mjs';

const BASE = resolve(ROOT, 'production/system-briefing');
const OUT = join(BASE, 'audio/vo');
mkdirSync(OUT, { recursive: true });
const n = JSON.parse(readFileSync(join(BASE, 'edit/narration.json'), 'utf8'));
const args = process.argv.slice(2);
if (!args.includes('--no-synth')) execFileSync('py', [join(BASE, 'tools/tts.py'), ...args], { stdio: 'inherit' });

const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const durations = {};
for (const line of n.lines) {
  const mp3 = join(OUT, `${line.id}.mp3`);
  const wav = join(OUT, `${line.id}.wav`);
  // Обрезать тишину в начале и конце, чтобы время start совпадало с первым звуком.
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', mp3, '-af',
    'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,apad=pad_dur=0.05',
    '-ar', '48000', '-ac', '1', wav]);
  durations[line.id] = +probe(wav).toFixed(3);
  console.log(line.id, durations[line.id].toFixed(2), 's', `${line.start}→${(line.start + durations[line.id]).toFixed(2)}`);
}
writeFileSync(join(OUT, 'durations.json'), JSON.stringify(durations, null, 1));
