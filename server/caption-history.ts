import type { Caption, ServerEvent } from '../shared/protocol';
import type { TranslationResult } from './translation';

interface Draft {
  caption: Caption;
  translatedEnglish: string;
  requestedEnglish: string;
}
export interface CaptionRequest { id: number; english: string }

// Stable IDs let authoritative transcripts correct live records instead of adding duplicates.
export class CaptionHistory {
  private nextId = 0;
  private drafts: Draft[] = [];
  constructor(private emit: (event: ServerEvent) => void) {}

  private captions(groups: string[], startMs: number, endMs: number, provisional: boolean): Caption[] {
    const total = groups.reduce((sum, group) => sum + group.length, 0);
    let consumed = 0;
    let start = startMs;
    return groups.map((english, index) => {
      const draft = this.drafts[index];
      consumed += english.length;
      const end = index === groups.length - 1 ? endMs : startMs + (endMs - startMs) * consumed / total;
      const reuse = !!draft?.caption.chinese && (provisional
        ? english.startsWith(draft.translatedEnglish)
        : english === draft.translatedEnglish);
      const caption: Caption = {
        id: draft?.caption.id ?? ++this.nextId, english,
        chinese: reuse ? draft!.caption.chinese : '', startMs: start, endMs: end,
        translationState: reuse ? 'done' : 'pending', provisional,
      };
      start = end;
      return caption;
    });
  }

  private retract(count: number): void {
    const ids = this.drafts.slice(count).map(draft => draft.caption.id);
    if (ids.length) this.emit({ type: 'caption-remove', ids });
  }

  update(groups: string[], startMs: number, endMs: number): void {
    const captions = this.captions(groups, startMs, endMs, true);
    this.retract(captions.length);
    this.drafts = captions.map((caption, index) => {
      const previous = this.drafts[index];
      if (!previous || previous.caption.english !== caption.english) this.emit({ type: 'caption', caption });
      return { caption, translatedEnglish: caption.chinese ? previous!.translatedEnglish : '', requestedEnglish: previous?.requestedEnglish || '' };
    });
  }

  preview(english: string, chinese: string): void {
    const draft = this.drafts.at(-1);
    if (!draft || !english || !chinese) return;
    draft.caption = { ...draft.caption, chinese, translationState: 'done' };
    draft.translatedEnglish = english;
    this.emit({ type: 'caption', caption: draft.caption });
  }

  completedRequests(): CaptionRequest[] {
    return this.drafts.slice(0, -1).flatMap(draft => {
      const english = draft.caption.english;
      if (draft.translatedEnglish === english || draft.requestedEnglish === english) return [];
      draft.requestedEnglish = english;
      return [{ id: draft.caption.id, english }];
    });
  }

  translated({ id, english }: CaptionRequest, result: TranslationResult | null): void {
    const draft = this.drafts.find(draft => draft.caption.id === id);
    if (!draft || draft.caption.english !== english) return;
    draft.caption = { ...draft.caption, chinese: result?.text || '', translationState: result ? 'done' : 'error' };
    draft.translatedEnglish = result ? english : '';
    this.emit({ type: 'caption', caption: draft.caption });
  }

  finalize(groups: string[], startMs: number, endMs: number): Caption[] {
    const captions = this.captions(groups, startMs, endMs, false);
    this.retract(captions.length);
    this.drafts = [];
    return captions;
  }

  finish(): void {
    for (const draft of this.drafts) {
      if (draft.caption.translationState === 'pending') this.emit({ type: 'caption', caption: { ...draft.caption, translationState: 'error' } });
    }
    this.drafts = [];
  }
}
