// Контактный лист для проверки: кадры из видео (по секундам) или готовые JPEG → одна картинка 4×N.
//   node production/system-briefing/tools/sheet.mjs <выход.jpg> <видео.mp4> 1,5,10,...
//   node production/system-briefing/tools/sheet.mjs <выход.jpg> --files a.jpg b.jpg ...
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [out, src, ...rest] = process.argv.slice(2);
const tmp = mkdtempSync(join(tmpdir(), 'qorgan-sheet-'));
let files;
if (src === '--files') files = rest;
else {
  files = rest[0].split(',').map(Number).map((t, i) => {
    const f = join(tmp, `${String(i).padStart(3, '0')}.jpg`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', src, '-frames:v', '1', '-vf', `drawtext=text='${t.toFixed(2)}s':x=20:y=20:fontsize=48:fontcolor=yellow:box=1:boxcolor=black@0.6`, f]);
    return f;
  });
}
const cols = 4;
const inputs = files.flatMap((f) => ['-i', f]);
const scaled = files.map((_, i) => `[${i}:v]scale=640:360[s${i}]`).join(';');
const layout = files.map((_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 360}`).join('|');
execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', `${scaled};${files.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=black`, '-frames:v', '1', '-q:v', '3', out]);
rmSync(tmp, { recursive: true, force: true });
console.log(out);
