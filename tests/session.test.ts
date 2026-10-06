import test from 'node:test';
import assert from 'node:assert/strict';
import { SubtitleSession, type GatewayCallbacks, type Transcriber } from '../server/session';
import type { ServerEvent } from '../shared/protocol';
import type { Translator } from '../server/translation';
import { exportSrt } from '../shared/subtitles';
import { updateCaptionRecords, parseServerEvent, type Caption } from '../shared/protocol';

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

function records(events: ServerEvent[]): Caption[] {
  return events.reduce<Caption[]>((current, value) => {
    const event = parseServerEvent(JSON.parse(JSON.stringify(value)));
    return event?.type === 'caption' || event?.type === 'caption-remove' ? updateCaptionRecords(current, event) : current;
  }, []);
}

test('subtitle records grow while live previews arrive even if the provider has not finalized speech', async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.callbacks[0]!.message({ interim: 'The meeting starts now. Please review the budget.' });
    await new Promise(resolve => setTimeout(resolve, 10));
    f.callbacks[0]!.message({ interim: 'The meeting starts now. Please review the budget. Do not share your password.' });
    await new Promise(resolve => setTimeout(resolve, 1300));
    const rows = records(f.events);
    assert.equal(rows.length, 2, 'the frontend subtitle count must not remain zero throughout continuous speech');
    assert.equal(rows[0]!.english, 'The meeting starts now. Please review the budget.');
    assert.ok(rows.every(record => record.chinese), 'translated previews must also be visible in subtitle records');
    assert.ok(rows.every(record => record.provisional));
  } finally { f.session.dispose(); }
});

test('a cumulative live paragraph previews only the current one or two sentences', async () => {
  const requested: string[] = [];
  const f = fixture(async english => { requested.push(english); return translator(english, [], new AbortController().signal); });
  try {
    await f.session.start();
    f.callbacks[0]!.message({ interim: 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence is ongoing' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual([...requested].sort(), ['First sentence. Second sentence.', 'Third sentence. Fourth sentence.', 'Fifth sentence is ongoing'].sort());
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
  let firstGroupRequests = 0;
  const f = fixture(async (english, _context, signal) => {
    if (english === 'First sentence. Second sentence.' && firstGroupRequests++ === 0) {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(resolve => { resolveOld = resolve; });
    }
    if (english === 'First sentence. Second sentence.') return { text: '第一句。第二句。', inputTokens: 10, outputTokens: 8 };
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
    assert.equal(records(f.events).some(caption => caption.chinese === '過時的前兩句'), false);
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
    const captions = f.events.flatMap(e => e.type === 'caption' && !e.caption.provisional ? [e.caption] : []);
    assert.equal(captions.length, 2);
    assert.equal(captions[0]!.translationState, 'pending');
    assert.equal(captions[1]!.translationState, 'done');
    assert.equal(captions[1]!.endMs, 100);
    assert.equal(captions[1]!.id, captions[0]!.id);
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
    const rows = records(f.events);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.provisional, true, 'live records must remain distinguishable from authoritative subtitles');
  } finally { f.session.dispose(); }
});

test('the final transcript corrects a provisional negation in the same record without duplication', async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.callbacks[0]!.message({ interim: 'Do share your password' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const before = records(f.events);
    assert.equal(before.length, 1);
    assert.equal(before[0]!.provisional, true);
    f.callbacks[0]!.message({ final: 'Do not share your password.' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const after = records(f.events);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, before[0]!.id);
    assert.equal(after[0]!.english, 'Do not share your password.');
    assert.match(after[0]!.chinese, /Do not/);
    assert.equal(after[0]!.provisional, false);
    assert.doesNotMatch(exportSrt(after, true), /暫定字幕/);
  } finally { f.session.dispose(); }
});

test('a revised final removes excess draft groups so they cannot remain in the record or SRT', async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.callbacks[0]!.message({ interim: 'First sentence. Second sentence. This extra sentence was mistaken.' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(records(f.events).length, 2);
    f.callbacks[0]!.message({ final: 'First sentence. Second sentence.' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const rows = records(f.events);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.provisional, false);
    assert.doesNotMatch(exportSrt(rows, true), /extra sentence/);
  } finally { f.session.dispose(); }
});

test('losing the provider keeps already displayed live translations as explicitly provisional records', async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.callbacks[0]!.message({ interim: 'Please review the budget.' });
    await new Promise(resolve => setTimeout(resolve, 10));
    f.callbacks[0]!.error(new Error('provider unavailable'));
    const rows = records(f.events);
    assert.equal(f.done, true);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.chinese);
    assert.equal(rows[0]!.provisional, true);
    assert.match(exportSrt(rows, true), /［暫定字幕］/);
    assert.match(exportSrt(rows, true), /Please review the budget/);
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

test('stop waits for an outstanding final transcript beyond the initial grace period', async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.session.audio(Buffer.alloc(3200));
    f.callbacks[0]!.message({ interim: 'Please confirm the final figures' });
    f.session.finish();
    await new Promise(resolve => setTimeout(resolve, 2800));
    assert.equal(f.done, false, 'pending recognition must not be mistaken for an empty translation queue');
    f.callbacks[0]!.message({ final: 'Please confirm the final figures. Thank you for joining.' });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(f.events.some(event => event.type === 'caption' && event.caption.translationState === 'done' && event.caption.english.includes('Thank you')));
    assert.equal(f.done, true);
  } finally { f.session.dispose(); }
});

test('stop also waits for trailing audio whose interim transcript has not arrived yet', async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.session.audio(Buffer.alloc(3200));
    f.callbacks[0]!.message({ final: 'The first two sentences are complete.' });
    f.session.audio(Buffer.alloc(3200));
    f.session.finish();
    await new Promise(resolve => setTimeout(resolve, 2800));
    assert.equal(f.done, false, 'trailing audio may precede both interim and final provider events');
    f.callbacks[0]!.message({ final: 'This is the last sentence.' });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(f.events.some(event => event.type === 'caption' && event.caption.translationState === 'done' && event.caption.english === 'This is the last sentence.'));
    assert.equal(f.done, true);
  } finally { f.session.dispose(); }
});
