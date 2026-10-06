import express from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';
import { projectRoot, settings } from './config';
import { allowedHost, createAuth, sameOrigin, safeEqual } from './security';
import { createTranslator } from './translation';
import { SubtitleSession, type ConnectTranscriber } from './session';
import type { ServerEvent } from '../shared/protocol';

const dev = process.argv.includes('--dev');
const app = express();
const http = createServer(app);
const auth = createAuth(settings.accessCode);
const ai = settings.apiKey ? new GoogleGenAI({ apiKey: settings.apiKey, httpOptions: { apiVersion: 'v1beta' } }) : null;
const active = new Set<SubtitleSession>();
const loginAttempts = new Map<string, { count: number; since: number }>();
const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(settings.host);
app.disable('x-powered-by');
// Enable only behind the deployment's single, trusted Nginx hop.
app.set('trust proxy', settings.trustProxy ? 1 : false);
app.use((req, res, next) => { if (!allowedHost(req, loopbackOnly)) res.sendStatus(403); else next(); });
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), display-capture=(self)');
  next();
});
app.use('/api', express.json({ limit: '2kb' }));
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.get('/api/health', (_req, res) => {
  res.status(ai ? 200 : 503).json({ status: ai ? 'ok' : 'unconfigured' });
});
app.get('/api/config', (req, res) => {
  res.json({
    configured: !!ai,
    authenticated: auth.verify(req),
    requiresAccessCode: !!settings.accessCode,
    models: { transcription: settings.transcriptionModel, translation: settings.translationModel },
    maxSessionMinutes: settings.maxSessionMinutes,
  });
});
app.post('/api/login', (req, res) => {
  if (!sameOrigin(req)) { res.status(403).json({ message: '請從此網站登入。' }); return; }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let attempt = loginAttempts.get(ip);
  if (!attempt || now - attempt.since > 15 * 60_000) attempt = { count: 0, since: now };
  if (attempt.count >= 10) { res.status(429).json({ message: '嘗試次數過多，請 15 分鐘後再試。' }); return; }
  attempt.count++;
  loginAttempts.set(ip, attempt);
  if (typeof req.body?.code !== 'string' || !safeEqual(req.body.code, settings.accessCode)) { res.status(401).json({ message: '使用密碼不正確。' }); return; }
  loginAttempts.delete(ip);
  // Public hosting is served behind an HTTPS reverse proxy. Never trust arbitrary forwarded IPs.
  const secure = req.headers.origin?.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `subtitle_session=${auth.issue()}; HttpOnly; SameSite=Strict; Path=${settings.basePath}; Max-Age=43200${secure}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  if (!sameOrigin(req)) { res.sendStatus(403); return; }
  const secure = req.headers.origin?.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `subtitle_session=; HttpOnly; SameSite=Strict; Path=${settings.basePath}; Max-Age=0${secure}`);
  res.json({ ok: true });
});
app.use('/api', (_req, res) => { res.status(404).json({ message: '找不到此功能。' }); });

const ws = new WebSocketServer({ noServer: true, maxPayload: 6400, perMessageDeflate: false });
http.on('upgrade', (req, socket, head) => {
  // Other upgrade paths belong to Vite's development HMR server.
  if (req.url?.split('?')[0] !== '/api/live') {
    if (!dev) socket.destroy();
    return;
  }
  const status = !allowedHost(req, loopbackOnly) || !sameOrigin(req) || !auth.verify(req) ? '403 Forbidden' : !ai ? '503 Service Unavailable' : active.size >= settings.maxSessions ? '429 Too Many Requests' : '';
  if (status) { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy(); return; }
  ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client));
});
ws.on('connection', client => {
  if (!ai) { client.close(1011); return; }
  const emit = (event: ServerEvent) => {
    if (client.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > 512_000) { client.close(1013, 'Slow connection'); return; }
      client.send(JSON.stringify(event));
    }
  };
  const connect: ConnectTranscriber = async callbacks => {
    const live = await ai.live.connect({
      model: settings.transcriptionModel,
      config: { responseModalities: [Modality.TEXT], inputAudioTranscription: { languageCodes: ['en-US', 'en-GB'] } },
      callbacks: {
        onmessage: message => {
          const content = message.serverContent;
          callbacks.message({ interim: content?.interimInputTranscription?.text, final: content?.inputTranscription?.text, goAway: !!message.goAway });
        },
        onerror: callbacks.error,
        onclose: callbacks.close,
      },
    });
    return {
      sendAudio: data => live.sendRealtimeInput({ audio: { data: data.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }),
      endAudio: () => live.sendRealtimeInput({ audioStreamEnd: true }),
      close: () => live.close(),
    };
  };
  const session = new SubtitleSession(connect, createTranslator(ai, settings.translationModel), emit, () => { active.delete(session); client.close(1000, 'Session ended'); }, settings.maxSessionMinutes);
  active.add(session);
  let bytesInWindow = 0;
  let windowStart = Date.now();
  let controlsInWindow = 0;
  client.on('message', (data, binary) => {
    if (Date.now() - windowStart > 1000) { windowStart = Date.now(); bytesInWindow = 0; controlsInWindow = 0; }
    if (binary) {
      const buffer = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data);
      bytesInWindow += buffer.length;
      if (bytesInWindow > 96_000) { client.close(1008, 'Audio rate exceeded'); return; }
      session.audio(buffer);
    } else {
      if (++controlsInWindow > 10) { client.close(1008, 'Message rate exceeded'); return; }
      try {
        const message: unknown = JSON.parse(data.toString());
        if (message && typeof message === 'object' && 'type' in message) {
          if (message.type === 'stop') session.finish();
          else if (message.type === 'flush') session.flush();
          else client.close(1008, 'Invalid message');
        } else client.close(1008, 'Invalid message');
      } catch { client.close(1008, 'Invalid JSON'); }
    }
  });
  let alive = true;
  const heartbeat = setInterval(() => { if (!alive) { client.terminate(); return; } alive = false; client.ping(); }, 15_000);
  client.on('pong', () => { alive = true; });
  const dispose = () => { clearInterval(heartbeat); session.dispose(); active.delete(session); };
  client.on('close', dispose);
  client.on('error', dispose);
  void session.start();
});

let closeVite: (() => Promise<void>) | undefined;
if (dev) {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({ root: projectRoot, server: { middlewareMode: true, hmr: { server: http } }, appType: 'spa' });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
} else {
  const dist = resolve(projectRoot, 'dist');
  if (!existsSync(resolve(dist, 'index.html'))) throw new Error('Run npm run build before npm start.');
  app.use(express.static(dist, { index: false }));
  app.get('/', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  app.use((_req, res) => { res.sendStatus(404); });
}
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error instanceof SyntaxError ? 400 : 500).json({ message: '請求無法處理，請重新整理後再試。' });
});
http.listen(settings.port, settings.host, () => {
  console.log(`Subtitle translator: http://${settings.host}:${settings.port}`);
  console.log(settings.apiKey ? 'Gemini: configured (key hidden)' : 'Gemini: not configured; add GEMINI_API_KEY to .env.local');
});
http.on('error', error => { console.error(error instanceof Error && 'code' in error ? `Server could not start: ${error.code}` : 'Server could not start'); process.exitCode = 1; });
const cleanupAttempts = setInterval(() => { for (const [ip, attempt] of loginAttempts) if (Date.now() - attempt.since > 15 * 60_000) loginAttempts.delete(ip); }, 60_000);
async function shutdown(): Promise<void> {
  clearInterval(cleanupAttempts);
  for (const session of active) session.dispose();
  for (const client of ws.clients) client.terminate();
  await closeVite?.();
  http.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
