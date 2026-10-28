import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { saveSession } from './session-store.js';

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TMS CLI 로그인</title></head><body data-api-key="${config.apiKey}"><main><h1>TMS CLI 로그인</h1><p>기존 TMS 이메일과 비밀번호를 입력하세요.</p><form><p><label>이메일 <input name="email" type="email" autocomplete="username" required></label></p><p><label>비밀번호 <input name="password" type="password" autocomplete="current-password" required></label></p><button type="submit">로그인</button></form><p id="status" role="status"></p></main><script src="/browser.js" defer></script></body></html>`;

export function openBrowser(url) {
  const commands = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(commands[0], commands[1], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

export async function login({ launch = openBrowser, timeoutMs = 180000, save = saveSession } = {}) {
  const state = randomBytes(32).toString('hex');
  const browserScript = await readFile(new URL('./browser.js', import.meta.url));
  let settle;
  const completed = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let inProgress = false;
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self' https://identitytoolkit.googleapis.com; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(400).end(); return; }
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html); return; }
    if (req.method === 'GET' && req.url === '/browser.js') { res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' }).end(browserScript); return; }
    if (req.method !== 'POST' || req.url !== '/session' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || inProgress) { res.writeHead(403).end(); return; }
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('request too large'); }
      const data = JSON.parse(body);
      const token = typeof data.state === 'string' ? Buffer.from(data.state) : Buffer.alloc(0);
      const expected = Buffer.from(state);
      if (token.length !== expected.length || !timingSafeEqual(token, expected) || typeof data.refreshToken !== 'string' || !data.refreshToken || typeof data.uid !== 'string' || !data.uid || typeof data.email !== 'string') { res.writeHead(403).end(); return; }
      inProgress = true;
      await save({ refreshToken: data.refreshToken, uid: data.uid, email: data.email });
      res.writeHead(200).end();
      settle.resolve({ uid: data.uid, email: data.email });
    } catch {
      res.writeHead(400).end();
      if (inProgress) settle.reject(new Error('로그인 정보를 보안 저장소에 저장하지 못했습니다.'));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/#${state}`;
  process.stdout.write(`브라우저가 열리지 않으면 다음 주소를 직접 여세요: ${url}\n`);
  const timer = setTimeout(() => settle.reject(new Error('로그인 시간이 초과되었습니다. 다시 실행하세요.')), timeoutMs);
  try { launch(url); return await completed; }
  finally { clearTimeout(timer); server.close(); }
}
