const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const maxWords = 40;
const wordCount = (text: string): number => text.split(/\s+/u).length;

// Keep titles/initials with the following name; ICU treats some as sentences.
const endsWithTitle = (text: string): boolean => /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\.$/iu.test(text) || /(?:^|\s)[A-Z]\.$/u.test(text);

/** At most two sentences per caption, with word-boundary splits for long run-ons. */
export function sentenceGroups(text: string): string[] {
  const sentences: string[] = [];
  for (const part of segmenter.segment(text.trim())) {
    const sentence = part.segment.trim();
    if (!sentence) continue;
    const previous = sentences.at(-1);
    if (previous && endsWithTitle(previous)) sentences[sentences.length - 1] = `${previous} ${sentence}`;
    else sentences.push(sentence);
  }
  const units = sentences.flatMap(sentence => {
    const words = sentence.split(/\s+/u);
    if (words.length <= maxWords) return [sentence];
    const pieces: string[] = [];
    for (let i = 0; i < words.length; i += maxWords) pieces.push(words.slice(i, i + maxWords).join(' '));
    return pieces;
  });
  const groups: string[] = [];
  for (let i = 0; i < units.length; i++) {
    let group = units[i]!;
    const next = units[i + 1];
    if (next && wordCount(group) + wordCount(next) <= maxWords) { group += ` ${next}`; i++; }
    groups.push(group);
  }
  return groups;
}
