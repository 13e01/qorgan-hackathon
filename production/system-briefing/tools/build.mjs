// Финальная сборка: рендер видео (render.mjs) + звук (audio/mix.wav) → renders/QORGAN_SYSTEM_BRIEFING_FINAL.mp4,
// затем автоматические проверки → renders/qa-auto.json.
//   node production/system-briefing/tools/build.mjs [--skip-render]

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './stand.mjs';

const BASE = resolve(ROOT, 'production/system-briefing');
const R = join(BASE, 'renders');
const video = join(R, 'work/video.mp4');
const final = join(R, 'QORGAN_SYSTEM_BRIEFING_FINAL.mp4');
mkdirSync(join(R, 'work'), { recursive: true });

if (!process.argv.includes('--skip-render') || !existsSync(video)) {
  execFileSync(process.execPath, [join(BASE, 'tools/render.mjs'), video], { stdio: 'inherit' });
}
// Звук обрезается ровно по видео (60,000 с); AAC 256 кбит/с.
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', video, '-i', join(BASE, 'audio/mix.wav'),
  '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-shortest',
  '-metadata', 'title=QORGAN System Briefing', '-metadata', 'comment=Учебная демонстрация, демо-данные. Голос: Microsoft Neural TTS (ru-RU-DmitryNeural).',
  '-movflags', '+faststart', final], { stdio: 'inherit' });

// ── автоматические проверки ────────────────────────────────────────────────────────────────────────
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', final]).toString());
const v = probe.streams.find((s) => s.codec_type === 'video');
const a = probe.streams.find((s) => s.codec_type === 'audio');
const run = (args) => spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...args], { encoding: 'utf8' }).stderr;
const black = [...run(['-i', final, '-vf', 'blackdetect=d=0.25:pix_th=0.06', '-an', '-f', 'null', '-']).matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
const freeze = [...run(['-i', final, '-vf', 'freezedetect=n=0.002:d=2.5', '-an', '-f', 'null', '-']).matchAll(/freeze_start: ([\d.]+)[\s\S]*?freeze_end: ([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
const ebur = run(['-i', final, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
const lufs = +(/I:\s+(-?[\d.]+) LUFS/.exec(ebur.slice(ebur.lastIndexOf('Summary')))?.[1]);
const tp = +(/Peak:\s+(-?[\d.]+) dBFS/.exec(ebur.slice(ebur.lastIndexOf('Summary')))?.[1]);
const report = {
  file: final,
  sizeMB: +(statSync(final).size / 1e6).toFixed(1),
  duration: +(+probe.format.duration).toFixed(3),
  video: { codec: v.codec_name, profile: v.profile, width: v.width, height: v.height, fps: v.r_frame_rate, pix_fmt: v.pix_fmt, frames: +v.nb_frames, bitrateMbps: +(v.bit_rate / 1e6).toFixed(1) },
  audio: { codec: a.codec_name, sampleRate: +a.sample_rate, channels: a.channels, bitrateKbps: Math.round(a.bit_rate / 1000) },
  loudness: { integratedLUFS: lufs, truePeakDBTP: tp },
  blackSegments: black,
  freezeSegments: freeze,
  checks: {},
};
const c = report.checks;
c.duration = Math.abs(report.duration - 60) <= 2;
c.resolution = v.width === 1920 && v.height === 1080;
c.fps60 = v.r_frame_rate === '60/1';
c.h264 = v.codec_name === 'h264';
c.aac = a.codec_name === 'aac';
c.loudness = lufs > -17.5 && lufs < -14.5 && tp <= -1.0;
// Допустимо: затемнение в самом начале (≤ 0,7 с) и в самом конце (финальная карточка уходит в чёрное).
c.noUnexpectedBlack = black.every(([s, e]) => s < 0.05 || e > report.duration - 1.2);
writeFileSync(join(R, 'qa-auto.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
