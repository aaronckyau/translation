import test from 'node:test';
import assert from 'node:assert/strict';
import { SubtitleSession, type GatewayCallbacks, type Transcriber } from '../server/session';
import type { ServerEvent } from '../shared/protocol';
import type { Translator } from '../server/translation';
import { exportSrt } from '../shared/subtitles';

const translator: Translator = async english => ({ text: `翻譯：${english}`, inputTokens: 100, outputTokens: 50 });
function fixture(translate = translator) {
  const callbacks: GatewayCallbacks[] = [];
  const events: ServerEvent[] = [];
  let closes = 0;
  let ends = 0;
  const audio: Buffer[] = [];
  let done = false;
  const session = new SubtitleSession(async cb => {
    callbacks.push(cb);
    const gateway: Transcriber = { sendAudio: data => audio.push(data), endAudio() { ends++; }, close() { closes++; cb.close(); } };
    return gateway;
  }, translate, event => events.push(event), () => { done = true; });
  return { session, callbacks, events, audio, get closes() { return closes; }, get ends() { return ends; }, get done() { return done; } };
}

test('a cumulative live paragraph previews only the current one or two sentences', async () => {
  const requested: string[] = [];
  const f = fixture(async english => { requested.push(english); return translator(english, [], new AbortController().signal); });
  try {
    await f.session.start();
    f.callbacks[0]!.message({ interim: 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence is ongoing' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(requested, ['Fifth sentence is ongoing']);
    assert.ok(f.events.some(event => event.type === 'interim' && event.english === 'Fifth sentence is ongoing'));
    assert.ok(f.events.some(event => event.type === 'preview' && event.english === 'Fifth sentence is ongoing'));
    assert.equal(f.ends, 0);
  } finally { f.session.dispose(); }
});

test('a long final paragraph becomes ordered short captions with the full transcript retained', async () => {
  const f = fixture();
  try {
    await f.session.start();
    for (let i = 0; i < 100; i++) f.session.audio(Buffer.alloc(3200));
    const source = Array.from({ length: 30 }, (_, i) => `This is sentence ${i}.`).join(' ');
    f.callbacks[0]!.message({ final: source });
    await new Promise(resolve => setTimeout(resolve, 10));
    const captions = f.events.flatMap(event => event.type === 'caption' && event.caption.translationState === 'done' ? [event.caption] : []);
    assert.equal(captions.length, 15, 'a single long provider result must not overflow the translation queue');
    assert.equal(captions.map(caption => caption.english).join(' '), source);
    const srt = exportSrt(captions, true);
    for (const caption of captions) assert.ok(srt.includes(caption.english));
    assert.deepEqual(captions.map(caption => caption.id), Array.from({ length: 15 }, (_, i) => i + 1));
    assert.equal(captions[0]!.startMs, 0);
    assert.equal(captions.at(-1)!.endMs, 10_000);
    captions.forEach((caption, i) => {
      assert.equal(caption.english.split('.').filter(value => value.trim()).length, 2);
      assert.ok(caption.endMs > caption.startMs);
      if (i) assert.equal(caption.startMs, captions[i - 1]!.endMs);
    });
  } finally { f.session.dispose(); }
});

test('advancing to a new sentence group cancels the previous preview and ignores its late response', async () => {
  let resolveOld: ((result: { text: string; inputTokens: number; outputTokens: number }) => void) | undefined;
  let aborted = false;
  const f = fixture(async (english, _context, signal) => {
    if (english === 'First sentence. Second sentence.') {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return { text: '這是第三句。', inputTokens: 10, outputTokens: 8 };
  });
  try {
    await f.session.start();
    f.callbacks[0]!.message({ interim: 'First sentence. Second sentence.' });
    f.callbacks[0]!.message({ interim: 'First sentence. Second sentence. This is the third sentence' });
    assert.equal(aborted, true);
    resolveOld!({ text: '過時的前兩句', inputTokens: 10, outputTokens: 8 });
    await new Promise(resolve => setTimeout(resolve, 1250));
    assert.equal(f.events.some(event => event.type === 'preview' && event.chinese === '過時的前兩句'), false);
    assert.ok(f.events.some(event => event.type === 'preview' && event.chinese === '這是第三句。'));
  } finally { f.session.dispose(); }
});

test('real-time transcript events produce one pending then one translated subtitle and usage', async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.session.audio(Buffer.alloc(3200));
    f.callbacks[0]!.message({ interim: 'This is' });
    f.callbacks[0]!.message({ final: 'This is a live meeting.' });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.audio.length, 1);
    assert.ok(f.events.some(e => e.type === 'interim' && e.english === 'This is'));
    const captions = f.events.filter(e => e.type === 'caption');
    assert.equal(captions.length, 2);
    assert.equal(captions[0]!.caption.translationState, 'pending');
    assert.equal(captions[1]!.caption.translationState, 'done');
    assert.equal(captions[1]!.caption.endMs, 100);
    assert.equal(captions[1]!.caption.id, captions[0]!.caption.id);
    assert.ok(f.events.some(e => e.type === 'usage' && e.audioSeconds === 0.1 && e.estimatedUsd > 0));
  } finally { f.session.dispose(); }
});
test('invalid audio terminates the paid session and closes the provider connection', async () => {
  const f = fixture();
  await f.session.start();
  f.session.audio(Buffer.alloc(3));
  assert.equal(f.session.isClosed, true);
  assert.equal(f.done, true);
  assert.equal(f.closes, 1);
  assert.ok(f.events.some(e => e.type === 'error' && e.fatal));
});

test('Chinese preview arrives while the speaker continues, before the final transcript', async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.callbacks[0]!.message({ interim: 'We are reviewing the quarterly results' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const previews = f.events.filter(event => (event as { type: string }).type === 'preview');
    assert.equal(previews.length, 1, 'ongoing speech must not wait for the final transcript before displaying Chinese');
    assert.equal(f.events.some(event => event.type === 'caption'), false, 'previews must not enter committed subtitles');
  } finally { f.session.dispose(); }
});

test('continuous speech is not cut mid-word merely to accelerate subtitle output', async () => {
  const f = fixture();
  try {
    await f.session.start();
    for (let i = 0; i < 130; i++) f.session.audio(Buffer.alloc(3200));
    assert.equal(f.ends, 0);
    f.session.flush();
    assert.equal(f.ends, 1, 'a real pause still finalizes speech');
  } finally { f.session.dispose(); }
});

test('a slow Chinese preview does not block the final subtitle or overwrite it later', async () => {
  let resolvePreview: ((result: { text: string; inputTokens: number; outputTokens: number }) => void) | undefined;
  let previewAborted = false;
  const f = fixture(async (english, _context, signal) => {
    if (english === 'Do share your password') {
      signal.addEventListener('abort', () => { previewAborted = true; }, { once: true });
      return new Promise(resolve => { resolvePreview = resolve; });
    }
    return { text: '切勿分享你的密碼。', inputTokens: 10, outputTokens: 8 };
  });
  try {
    await f.session.start();
    f.callbacks[0]!.message({ interim: 'Do share your password' });
    f.callbacks[0]!.message({ final: 'Do not share your password.' });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(previewAborted);
    assert.ok(f.events.some(event => event.type === 'caption' && event.caption.chinese === '切勿分享你的密碼。'));
    resolvePreview!({ text: 'outdated preview', inputTokens: 10, outputTokens: 8 });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.events.some(event => event.type === 'preview' && event.chinese === 'outdated preview'), false);
  } finally { f.session.dispose(); }
});
test('go-away rotation buffers audio, flushes it in order, and ignores retiring socket close', async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.callbacks[0]!.message({ goAway: true });
    f.session.audio(Buffer.alloc(3200, 1));
    f.session.audio(Buffer.alloc(3200, 2));
    assert.equal(f.audio.length, 0);
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(f.callbacks.length, 2);
    assert.deepEqual(f.audio.map(buffer => buffer[0]), [1, 2]);
    assert.equal(f.closes, 1);
    assert.equal(f.session.isClosed, false);
    assert.ok(f.events.some(e => e.type === 'status' && e.phase === 'reconnecting'));
  } finally { f.session.dispose(); }
});
test('disconnect during rotation closes the retiring provider instead of leaking billing', async () => {
  const f = fixture();
  await f.session.start();
  f.callbacks[0]!.message({ goAway: true });
  f.session.dispose();
  assert.equal(f.closes, 1);
});
test('stop drains the last translation before closing, and rejects new audio', async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.session.audio(Buffer.alloc(3200));
    f.session.finish();
    f.session.audio(Buffer.alloc(3200));
    f.callbacks[0]!.message({ final: 'The final sentence.' });
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(f.audio.length, 1);
    assert.ok(f.events.some(e => e.type === 'caption' && e.caption.translationState === 'done'));
    assert.equal(f.done, true);
    assert.equal(f.session.isClosed, true);
  } finally { f.session.dispose(); }
});
