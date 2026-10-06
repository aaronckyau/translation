import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewTranslator } from '../server/preview';
import type { TranslationResult, Translator } from '../server/translation';

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const result = (text: string): TranslationResult => ({ text, inputTokens: 10, outputTokens: 8 });

test('partial updates coalesce without creating a backlog, and usage includes previews', async () => {
  const calls: string[] = [];
  const resolutions: Array<(value: TranslationResult) => void> = [];
  const shown: string[] = [];
  let usage = 0;
  const translate: Translator = async english => {
    calls.push(english);
    return new Promise(resolve => { resolutions.push(resolve); });
  };
  const preview = new PreviewTranslator(translate, () => [], (_english, chinese) => shown.push(chinese), value => { usage += value.inputTokens; }, 15);
  try {
    preview.update('We are reviewing');
    preview.update('We are reviewing the');
    preview.update('We are reviewing the quarterly results');
    assert.equal(calls.length, 1);
    resolutions[0]!(result('我們正在檢視'));
    await tick(25);
    assert.deepEqual(calls, ['We are reviewing', 'We are reviewing the quarterly results']);
    resolutions[1]!(result('我們正在檢視季度業績'));
    await tick();
    assert.deepEqual(shown, ['我們正在檢視', '我們正在檢視季度業績']);
    assert.equal(usage, 20);
  } finally { preview.close(); }
});

test('a revised negation invalidates the obsolete partial translation', async () => {
  const resolutions: Array<(value: TranslationResult) => void> = [];
  const shown: string[] = [];
  const preview = new PreviewTranslator(async () => new Promise(resolve => resolutions.push(resolve)), () => [], (_english, chinese) => shown.push(chinese), () => {}, 10);
  try {
    preview.update('Please share your password');
    preview.update('Please do not share your password');
    resolutions[0]!(result('請分享你的密碼'));
    await tick(20);
    assert.deepEqual(shown, []);
    resolutions[1]!(result('切勿分享你的密碼'));
    await tick();
    assert.deepEqual(shown, ['切勿分享你的密碼']);
  } finally { preview.close(); }
});

test('closing aborts speculative billing and prevents late output', async () => {
  let aborted = false;
  const shown: string[] = [];
  const preview = new PreviewTranslator(async (_english, _context, signal) => {
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true }));
  }, () => [], (_english, chinese) => shown.push(chinese), () => {});
  preview.update('This is a test');
  preview.close();
  await tick();
  assert.equal(aborted, true);
  assert.deepEqual(shown, []);
});

test('a timed-out preview recovers on a new partial without retrying the same text', async () => {
  let calls = 0;
  const shown: string[] = [];
  const preview = new PreviewTranslator(async (english, _context, signal) => {
    if (++calls === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
    return result(english);
  }, () => [], (_english, chinese) => shown.push(chinese), () => {}, 10, 10);
  try {
    preview.update('This is a test');
    await tick(30);
    assert.equal(calls, 1);
    preview.update('This is another test');
    await tick();
    assert.deepEqual(shown, ['This is another test']);
  } finally { preview.close(); }
});
