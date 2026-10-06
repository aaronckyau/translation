import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey } from '../server/environment';

test('blank .env.local template does not mask the configured .env key', () => {
  assert.equal(resolveApiKey({}, { GEMINI_API_KEY: '  ' }, { GEMINI_API_KEY: 'test-base-key' }), 'test-base-key');
});
test('key selection respects inherited environment, local file and base file priority', () => {
  assert.equal(resolveApiKey({ GOOGLE_API_KEY: 'test-inherited-key' }, { GEMINI_API_KEY: 'test-local-key' }, { GEMINI_API_KEY: 'test-base-key' }), 'test-inherited-key');
  assert.equal(resolveApiKey({}, { GEMINI_API_KEY: ' test-local-key ' }, { GEMINI_API_KEY: 'test-base-key' }), 'test-local-key');
  assert.equal(resolveApiKey({}, {}, {}), '');
});
