import type { Caption } from './protocol';

export function srtTimestamp(ms: number): string {
  const value = Math.max(0, Math.floor(ms));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor(value / 60_000) % 60;
  const seconds = Math.floor(value / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(value % 1000).padStart(3, '0')}`;
}

export function exportSrt(captions: Caption[], bilingual: boolean): string {
  return captions.map((c, index) => {
    const chinese = c.translationState === 'done' ? c.chinese : c.translationState === 'error' ? '［此句翻譯失敗］' : '［此句尚未完成翻譯］';
    const text = bilingual ? `${chinese}\n${c.english}` : chinese;
    return `${index + 1}\n${srtTimestamp(c.startMs)} --> ${srtTimestamp(Math.max(c.endMs, c.startMs + 500))}\n${text}\n`;
  }).join('\n');
}
