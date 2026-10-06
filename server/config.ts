import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiKey } from './environment';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const inheritedKeys = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY };
const localEnv = loadEnv({ path: resolve(projectRoot, '.env.local'), quiet: true });
const baseEnv = loadEnv({ path: resolve(projectRoot, '.env'), quiet: true });

function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

export const settings = {
  apiKey: resolveApiKey(inheritedKeys, localEnv.parsed || {}, baseEnv.parsed || {}),
  host: process.env.HOST || '127.0.0.1',
  port: boundedNumber('PORT', 3000, 1, 65535),
  accessCode: process.env.APP_ACCESS_CODE || '',
  transcriptionModel: process.env.TRANSCRIPTION_MODEL || 'gemini-3.5-transcribe-live',
  translationModel: process.env.TRANSLATION_MODEL || 'gemini-3.5-flash-lite',
  maxSessions: boundedNumber('MAX_CONCURRENT_SESSIONS', 3, 1, 50),
  maxSessionMinutes: boundedNumber('MAX_SESSION_MINUTES', 120, 1, 480),
};

if (!['127.0.0.1', 'localhost', '::1'].includes(settings.host) && settings.accessCode.length < 16) {
  throw new Error('Network hosting requires APP_ACCESS_CODE with at least 16 characters.');
}
