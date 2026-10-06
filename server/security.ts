import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || !req.headers.host) return false;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host;
  } catch { return false; }
}

export function allowedHost(req: IncomingMessage, loopbackOnly: boolean): boolean {
  if (!req.headers.host) return false;
  if (!loopbackOnly) return true;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${req.headers.host}`).hostname);
  } catch { return false; }
}

export function createAuth(accessCode: string) {
  const secret = randomBytes(32);
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest('base64url');
  return {
    issue(): string {
      const expires = String(Date.now() + 12 * 60 * 60 * 1000);
      return `${expires}.${sign(expires)}`;
    },
    verify(req: IncomingMessage): boolean {
      if (!accessCode) return true;
      const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('subtitle_session='))?.slice('subtitle_session='.length);
      if (!cookie) return false;
      const [expires, signature] = cookie.split('.');
      return !!expires && !!signature && Number(expires) > Date.now() && safeEqual(sign(expires), signature);
    },
  };
}

// Never forward raw provider errors: they can contain URLs, credentials or transcripts.
export function providerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) return 'Gemini 用量或請求次數已達上限，請稍後再試或檢查帳戶配額。';
  if (/401|403|API.key|UNAUTHENTICATED|PERMISSION_DENIED/i.test(message)) return 'Gemini 金鑰或模型存取權有問題，請檢查伺服器設定。';
  if (/404|not.found|unsupported|not.supported/i.test(message)) return '目前帳戶無法使用此模型或功能，請檢查 Gemini 模型設定。';
  return 'Gemini 連線失敗，請檢查網絡後重新開始。';
}
