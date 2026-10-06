import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey, validateNetworkAccessCode } from '../server/environment';

test('blank .env.local template does not mask the configured .env key', () => {
  assert.equal(resolveApiKey({}, { GEMINI_API_KEY: '  ' }, { GEMINI_API_KEY: 'test-base-key' }), 'test-base-key');
});
test('key selection respects inherited environment, local file and base file priority', () => {
  assert.equal(resolveApiKey({ GOOGLE_API_KEY: 'test-inherited-key' }, { GEMINI_API_KEY: 'test-local-key' }, { GEMINI_API_KEY: 'test-base-key' }), 'test-inherited-key');
  assert.equal(resolveApiKey({}, { GEMINI_API_KEY: ' test-local-key ' }, { GEMINI_API_KEY: 'test-base-key' }), 'test-local-key');
  assert.equal(resolveApiKey({}, {}, {}), '');
});

test('public hosting retains the default minimum unless short codes are explicitly enabled', () => {
  assert.throws(() => validateNetworkAccessCode('0.0.0.0', 'short'), /at least 16/);
  assert.doesNotThrow(() => validateNetworkAccessCode('0.0.0.0', 'short', true));
  assert.doesNotThrow(() => validateNetworkAccessCode('0.0.0.0', 'test-only-long-access-code'));
});

test('the short-code option never permits an empty public password', () => {
  for (const code of ['', '   ']) assert.throws(() => validateNetworkAccessCode('0.0.0.0', code, true));
  assert.doesNotThrow(() => validateNetworkAccessCode('127.0.0.1', ''));
});
