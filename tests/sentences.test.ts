import test from 'node:test';
import assert from 'node:assert/strict';
import { sentenceGroups } from '../shared/sentences';

test('captions contain one or two sentences and retain the unfinished last sentence', () => {
  assert.deepEqual(sentenceGroups('First sentence. Second sentence! Third sentence? Fourth sentence. Fifth is still'), [
    'First sentence. Second sentence!', 'Third sentence? Fourth sentence.', 'Fifth is still',
  ]);
  assert.deepEqual(sentenceGroups('  '), []);
});

test('titles, initials, decimals and quoted punctuation do not lose or fragment words', () => {
  assert.deepEqual(sentenceGroups('Dr. Smith paid $3.50. J. Lee said "Really?" Then we left.'), [
    'Dr. Smith paid $3.50. J. Lee said "Really?"', 'Then we left.',
  ]);
});

test('unpunctuated speech is bounded at word boundaries without losing any words', () => {
  const source = Array.from({ length: 101 }, (_, i) => `word${i}`).join(' ');
  const groups = sentenceGroups(source);
  assert.equal(groups.length, 3);
  assert.ok(groups.every(group => group.split(' ').length <= 40));
  assert.equal(groups.join(' '), source);
});

test('provider punctuation without spaces still separates sentences and preserves acronyms', () => {
  assert.deepEqual(sentenceGroups('First sentence.Second sentence.Third sentence!Fourth sentence?Fifth sentence in the U.S. office.'), [
    'First sentence. Second sentence.', 'Third sentence! Fourth sentence?', 'Fifth sentence in the U.S. office.',
  ]);
});
