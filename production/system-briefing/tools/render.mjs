// Покадровый рендер видео: Edge без окна открывает edit/compositor.html, для каждого кадра вызывает renderFrame(k),
// снимок уходит в ffmpeg (H.264, 60 кадров/с). Звук добавляет tools/mix.mjs, финальная сборка — tools/build.mjs.
//   node production/system-briefing/tools/render.mjs [выход.mp4] [--from=сек --to=сек] [--still=сек,сек,...]
//   --still — вместо видео сохранить отдельные кадры PNG (для проверки раскадровки).

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchEdge, waitFor } from './cdp.mjs';
import { ROOT } from './stand.mjs';

const BASE = resolve(ROOT, 'production/system-briefing');
const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const out = resolve(args.find((a) => !a.startsWith('--')) ?? join(BASE, 'renders/work/video.mp4'));
const tl = JSON.parse(readFileSync(join(BASE, 'edit/timeline.json'), 'utf8'));
const FPS = tl.fps;
const from = Math.round(Number(opt('from') ?? 0) * FPS);
const to = Math.round(Number(opt('to') ?? tl.duration) * FPS);
const stills = opt('still')?.split(',').map(Number);

const { page, close } = await launchEdge({ width: 1920, height: 1080, port: 9340 });
try {
  await page.navigate(pathToFileURL(join(BASE, 'edit/compositor.html')).href);
  await waitFor(page, 'window.compositorReady === true');
  await page.eval('document.fonts.ready.then(() => true)');

  const shot = async (k) => {
    await page.eval(`renderFrame(${k})`);
    const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 96, optimizeForSpeed: false });
    return Buffer.from(data, 'base64');
  };

  if (stills) {
    mkdirSync(dirname(out), { recursive: true });
    for (const s of stills) {
      const file = out.replace(/\.(mp4|png)$/i, '') + `-${s.toFixed(2)}s.jpg`;
      writeFileSync(file, await shot(Math.round(s * FPS)));
      console.log(file);
    }
  } else {
    mkdirSync(dirname(out), { recursive: true });
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      // JPEG-кадры — полный диапазон яркости; переводим в стандартный ТВ-диапазон BT.709, иначе часть плееров покажет блёклую картинку.
      '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'film', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((res, rej) => ff.on('exit', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`)))));
    const t0 = Date.now();
    for (let k = from; k < to; k++) {
      const buf = await shot(k);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if ((k - from) % 300 === 0) console.log(`кадр ${k}/${to} (${((Date.now() - t0) / 1000).toFixed(0)} с)`);
    }
    ff.stdin.end();
    await done;
    console.log(`готово: ${out} за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  }
} finally {
  await close();
}
