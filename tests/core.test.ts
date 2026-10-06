import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { allowedHost, createAuth, providerError, sameOrigin } from '../server/security';
import { mergeCaption, parseServerEvent, updateCaptionRecords, type Caption } from '../shared/protocol';
import { exportSrt, srtTimestamp } from '../shared/subtitles';
import { TranslationQueue } from '../server/translation';

function req(headers: IncomingMessage['headers']): IncomingMessage { return { headers } as IncomingMessage; }
const caption: Caption = { id: 1, english: 'We do not approve this proposal.', chinese: '我們不批准這項提議。', startMs: 0, endMs: 2000, translationState: 'done' };

test('subtitle updates replace pending entries instead of duplicating or reordering them', () => {
  const pending = { ...caption, chinese: '', translationState: 'pending' as const };
  const rows = mergeCaption([pending, { ...caption, id: 2 }], caption);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(c => c.id), [1, 2]);
  assert.equal(rows[0]?.chinese, caption.chinese);
});
test('malformed provider events cannot enter subtitle state', () => {
  assert.equal(parseServerEvent({ type: 'preview', english: 'source', chinese: 123 }), null);
  assert.equal(parseServerEvent({ type: 'preview', english: 'source', chinese: '預覽' })?.type, 'preview');
  assert.equal(parseServerEvent({ type: 'caption', caption: { ...caption, endMs: -1 } }), null);
  assert.equal(parseServerEvent({ type: 'usage', audioSeconds: Infinity, estimatedUsd: 1 }), null);
  assert.equal(parseServerEvent({ type: 'status', phase: 'arbitrary', message: '' }), null);
  assert.equal(parseServerEvent({ type: 'caption', caption })?.type, 'caption');
  assert.equal(parseServerEvent({ type: 'caption', caption: { ...caption, provisional: 'yes' } }), null);
  assert.equal(parseServerEvent({ type: 'caption-remove', ids: [1, '2'] }), null);
  assert.deepEqual(parseServerEvent({ type: 'caption-remove', ids: [1] }), { type: 'caption-remove', ids: [1] });
  assert.deepEqual(updateCaptionRecords([caption, { ...caption, id: 2 }], { type: 'caption-remove', ids: [1] }).map(row => row.id), [2]);
});
test('SRT exports Chinese and English with valid millisecond timestamps and explicit failed segments', () => {
  assert.equal(srtTimestamp(3_661_234), '01:01:01,234');
  assert.match(exportSrt([caption], true), /00:00:00,000 --> 00:00:02,000\n我們不批准這項提議。\nWe do not approve/);
  assert.match(exportSrt([{ ...caption, translationState: 'error', chinese: '' }], false), /此句翻譯失敗/);
});
test('websocket origin and local host checks reject cross-site and DNS rebinding requests', () => {
  assert.equal(sameOrigin(req({ host: 'localhost:3000', origin: 'http://localhost:3000' })), true);
  assert.equal(sameOrigin(req({ host: 'localhost:3000', origin: 'https://example.com' })), false);
  assert.equal(sameOrigin(req({ host: 'localhost:3000' })), false);
  assert.equal(allowedHost(req({ host: 'attacker.example:3000' }), true), false);
  assert.equal(allowedHost(req({ host: '127.0.0.1:3000' }), true), true);
});
test('private app authentication rejects missing, forged and expired session cookies', () => {
  const auth = createAuth('private-example-access-code');
  assert.equal(auth.verify(req({})), false);
  const token = auth.issue();
  assert.equal(auth.verify(req({ cookie: `subtitle_session=${token}` })), true);
  assert.equal(auth.verify(req({ cookie: `subtitle_session=${token}x` })), false);
  assert.equal(auth.verify(req({ cookie: 'subtitle_session=1.forged' })), false);
});
test('provider errors never leak keys, URLs or transcript contents', () => {
  const output = providerError(new Error('403 https://api.example/?key=SECRET_PRIVATE_VALUE transcript=confidential'));
  assert.doesNotMatch(output, /SECRET|confidential|api\.example/);
  assert.match(output, /存取權/);
});
test('translation queue preserves order, bounds context and recovers after one failed sentence', async () => {
  const seen: Array<{ english: string; context: readonly string[] }> = [];
  const results: Array<string | null> = [];
  let errors = 0;
  const queue = new TranslationQueue(async (english, context) => {
    seen.push({ english, context: [...context] });
    await new Promise(resolve => setTimeout(resolve, 2));
    if (english === 'sentence 2') throw new Error('temporary provider failure');
    return { text: `translation ${english}`, inputTokens: 10, outputTokens: 5 };
  }, () => { errors++; });
  for (let i = 0; i < 7; i++) assert.equal(queue.add(`sentence ${i}`, result => results.push(result?.text || null)), true);
  while (queue.busy) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(seen.map(c => c.english), Array.from({ length: 7 }, (_, i) => `sentence ${i}`));
  assert.equal(results[2], null);
  assert.equal(results[6], 'translation sentence 6');
  assert.equal(errors, 1);
  assert.equal(seen[6]?.context.length, 4);
  queue.close();
  assert.equal(queue.add('late sentence', () => {}), false);
});
test('closing a session aborts an in-flight paid translation and does not deliver stale subtitles', async () => {
  let delivered = false;
  let aborted = false;
  const queue = new TranslationQueue(async (_english, _context, signal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
    return { text: 'late', inputTokens: 1, outputTokens: 1 };
  }, () => {});
  queue.add('test', () => { delivered = true; });
  queue.close();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(aborted, true);
  assert.equal(delivered, false);
});
