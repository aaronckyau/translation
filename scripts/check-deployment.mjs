import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';

// Use a separate process and fake key. No paid provider connection is opened.
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const basePath = process.env.APP_BASE_PATH || '/';
const code = 'test-only-access-code-not-a-secret';
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: new URL('../', import.meta.url),
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), GEMINI_API_KEY: 'test-only-placeholder', APP_ACCESS_CODE: code, APP_BASE_PATH: basePath, TRUST_PROXY: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'],
});
const origin = `http://127.0.0.1:${port}`;
const request = (path, options) => fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
const login = (value, ip = '192.0.2.1') => request('/api/login', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ code: value }),
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error('Production server exited before becoming ready');
    try { if ((await request('/api/health')).status === 200) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'health check must become ready');
  const config = await (await request('/api/config')).json();
  assert.equal(config.authenticated, false);
  assert.equal(config.requiresAccessCode, true);
  const html = await (await request('/')).text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  assert.ok(assets.length >= 3);
  for (const path of assets) {
    assert.ok(path.startsWith(basePath), 'built assets must use the configured public base path');
    assert.equal((await request(`/${path.slice(basePath.length)}`)).status, 200);
  }
  assert.equal((await request('/pcm-worklet.js')).status, 200);
  for (const path of ['/.env', '/.env.production', '/server/config.ts', '/package.json']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/api/login', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  for (let i = 0; i < 10; i++) assert.equal((await login('wrong-code')).status, 401);
  assert.equal((await login(code)).status, 429);
  const signedIn = await login(code, '192.0.2.2');
  assert.equal(signedIn.status, 200, 'a separate client must not inherit another client\'s login limit');
  const setCookie = signedIn.headers.get('set-cookie');
  assert.ok(setCookie.includes(`Path=${basePath};`));
  const cookie = setCookie.split(';')[0];
  const authenticated = await (await request('/api/config', { headers: { Cookie: cookie } })).json();
  assert.equal(authenticated.authenticated, true);
  const loggedOut = await request('/api/logout', { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
  assert.equal(loggedOut.status, 200);
  assert.ok(loggedOut.headers.get('set-cookie').includes(`Path=${basePath};`));
  for (const wsOrigin of [origin, 'https://untrusted.example']) {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/live`, { origin: wsOrigin, handshakeTimeout: 5000 });
      socket.on('unexpected-response', (_req, response) => {
        try { assert.equal(response.statusCode, 403); response.resume(); socket.terminate(); resolve(); } catch (error) { reject(error); }
      });
      socket.on('open', () => { socket.terminate(); reject(new Error('Unauthenticated websocket must not open')); });
      socket.on('error', reject);
    });
  }
  console.log(JSON.stringify({ productionHttpPassed: true, basePath, assetCount: assets.length, authenticationPassed: true, websocketRejectionPassed: true }));
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await once(child, 'exit');
}
