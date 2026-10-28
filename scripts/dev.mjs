// `npm run dev`: backend (http://localhost:3000) и интерфейс (http://localhost:5173) одной командой.
// Ctrl+C останавливает оба процесса (на Windows — вместе с дочерними процессами).

import { spawn, spawnSync } from 'node:child_process';

// Порт backend задаётся явно: интерфейс проксирует /api и /ws именно на 3000, и чужая переменная PORT
// в окружении (например, от другой программы) не должна его менять.
const procs = [
  { name: 'server', color: '\x1b[36m', args: ['run', 'dev', '-w', '@qorgan/server'], env: { PORT: '3000', HOST: '127.0.0.1' } },
  { name: 'web   ', color: '\x1b[35m', args: ['run', 'dev', '-w', '@qorgan/web'], env: {} },
];
const npm = 'npm';
const children = [];
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

for (const p of procs) {
  const child = spawn(`${npm} ${p.args.join(' ')}`, { shell: true, env: { ...process.env, FORCE_COLOR: '1', ...p.env } });
  children.push(child);
  const prefix = `${p.color}[${p.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${prefix}процесс завершился (код ${code}) — останавливаю остальные`);
      stopAll(code ?? 1);
    }
  });
}

console.log('\nQORGAN: откройте http://localhost:5173 (интерфейс). Остановить — Ctrl+C.\n');
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
