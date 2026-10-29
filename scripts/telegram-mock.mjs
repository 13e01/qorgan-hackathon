// Локальная заглушка Telegram Bot API для показа и проверки без интернета и без настоящего бота
// (docs/SENTINEL_TELEGRAM.md §7). Только 127.0.0.1. Реализует getMe, getUpdates (long polling), sendMessage.
// Страница http://127.0.0.1:8081/ — «чат» учебного пользователя: видно сообщения бота, можно отправить команду.
//
//   npm run telegram:mock
//   в .env (или переменных окружения сервера): TELEGRAM_BOT_TOKEN=mock-token  TELEGRAM_API_BASE=http://127.0.0.1:8081
//
// Это НЕ Telegram: сообщения никуда не уходят. Для настоящего бота уберите TELEGRAM_API_BASE.

import { createServer } from 'node:http';

const PORT = Number(process.env.TELEGRAM_MOCK_PORT ?? 8081);
const CHAT_ID = 1001;
const messages = []; // { from: 'bot' | 'user', text, at }
const updates = [];
let updateId = 1;
let waiting = [];

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });

function flush() {
  if (updates.length === 0) return;
  for (const w of waiting) {
    clearTimeout(w.timer);
    json(w.res, 200, { ok: true, result: updates.filter((u) => u.update_id >= w.offset) });
  }
  waiting = [];
}

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Заглушка Telegram · QORGAN</title><style>
body{font-family:system-ui,Segoe UI,sans-serif;margin:0;background:#e9eef3;color:#0b1117}
header{background:#24323f;color:#fff;padding:12px 16px}header b{display:block}header span{font-size:12px;opacity:.8}
#log{padding:16px;display:flex;flex-direction:column;gap:8px;max-width:720px;margin:0 auto 90px}
.m{white-space:pre-wrap;padding:10px 12px;border-radius:12px;max-width:85%;font-size:14px;line-height:1.4;box-shadow:0 1px 1px #0001}
.bot{background:#fff;align-self:flex-start}.user{background:#d7f0c6;align-self:flex-end}.t{display:block;font-size:11px;opacity:.55;margin-top:4px}
form{position:fixed;bottom:0;left:0;right:0;display:flex;gap:8px;padding:12px;background:#fff;border-top:1px solid #ccd}
input{flex:1;font-size:15px;padding:10px;border:1px solid #bbc;border-radius:8px}button{font-size:15px;padding:10px 16px;border-radius:8px;border:0;background:#2481cc;color:#fff}
</style></head><body><header><b>QORGAN Bot — локальная заглушка Telegram</b><span>Учебная демонстрация: сообщения не уходят в настоящий Telegram. Чат ${CHAT_ID}.</span></header>
<div id="log" aria-live="polite"></div><form id="f"><input id="i" placeholder="/start КОД, /status, /stations, /alerts, /help" autocomplete="off" aria-label="Сообщение боту"><button>Отправить</button></form>
<script>
const log=document.getElementById('log');let n=0;
async function load(){const r=await fetch('/mock/messages');const list=await r.json();if(list.length===n)return;n=list.length;log.innerHTML='';
for(const m of list){const d=document.createElement('div');d.className='m '+m.from;d.textContent=m.text;const t=document.createElement('span');t.className='t';t.textContent=new Date(m.at).toLocaleTimeString();d.appendChild(t);log.appendChild(d);}
window.scrollTo(0,document.body.scrollHeight);}
document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const i=document.getElementById('i');if(!i.value.trim())return;
await fetch('/mock/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:i.value})});i.value='';load();};
setInterval(load,1000);load();
</script></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (url.pathname === '/mock/messages') return json(res, 200, messages);
  if (url.pathname === '/mock/send' && req.method === 'POST') {
    const { text } = await readBody(req);
    const msg = { message_id: updateId, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID, username: 'demo_operator', language_code: 'ru' }, text: String(text ?? '') };
    updates.push({ update_id: updateId++, message: msg });
    messages.push({ from: 'user', text: msg.text, at: Date.now() });
    flush();
    return json(res, 200, { ok: true });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname);
  if (!m) return json(res, 404, { ok: false, description: 'Not Found' });
  const body = await readBody(req);
  if (m[1] === 'getMe') return json(res, 200, { ok: true, result: { id: 1, is_bot: true, username: 'qorgan_mock_bot' } });
  if (m[1] === 'sendMessage') {
    messages.push({ from: 'bot', text: String(body.text ?? ''), at: Date.now() });
    console.log(`[mock-telegram] → чат ${body.chat_id}: ${String(body.text ?? '').split('\n')[0]}`);
    return json(res, 200, { ok: true, result: { message_id: messages.length } });
  }
  if (m[1] === 'getUpdates') {
    const offset = Number(body.offset ?? 0);
    // Подтверждённые сервером обновления больше не нужны.
    while (updates.length && updates[0].update_id < offset) updates.shift();
    const ready = updates.filter((u) => u.update_id >= offset);
    if (ready.length) return json(res, 200, { ok: true, result: ready });
    const timeout = Math.min(Number(body.timeout ?? 0), 25) * 1000;
    const w = { res, offset, timer: setTimeout(() => {
      waiting = waiting.filter((x) => x !== w);
      json(res, 200, { ok: true, result: [] });
    }, timeout) };
    waiting.push(w);
    return;
  }
  return json(res, 400, { ok: false, description: 'method not supported by mock' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-telegram] заглушка Bot API: http://127.0.0.1:${PORT}/ (только этот компьютер)`));
