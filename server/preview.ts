import type { TranslationResult, Translator } from './translation';

const comparable = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Coalesce partials into one request at a time. Final translations use a separate
// queue, so a slow speculative request cannot delay the authoritative captions.
export class PreviewTranslator {
  private latest = '';
  private requested = '';
  private generation = 0;
  private lastStarted = -Infinity;
  private running = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;

  constructor(
    private translate: Translator,
    private context: () => readonly string[],
    private publish: (english: string, chinese: string) => void,
    private account: (result: TranslationResult) => void,
    private intervalMs = 1200,
    private timeoutMs = 3000,
  ) {}

  update(english: string): void {
    if (this.closed) return;
    this.latest = english.trim().slice(0, 6000);
    if (this.latest.split(/\s+/).length >= 3) this.schedule();
  }

  reset(): void {
    ++this.generation;
    this.latest = '';
    this.requested = '';
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    if (!this.closed) this.publish('', '');
  }

  close(): void { this.closed = true; this.reset(); }

  private schedule(): void {
    if (this.closed || this.running || this.timer || this.latest.split(/\s+/).length < 3 || this.latest === this.requested) return;
    const delay = Math.max(0, this.lastStarted + this.intervalMs - Date.now());
    if (delay) this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, delay);
    else void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.closed || this.running || this.latest.split(/\s+/).length < 3 || this.latest === this.requested) return;
    const english = this.latest;
    const generation = this.generation;
    this.requested = english;
    this.lastStarted = Date.now();
    this.running = true;
    const controller = new AbortController();
    this.abort = controller;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await this.translate(english, this.context(), controller.signal);
      if (!this.closed) this.account(result);
      // Extensions may reuse a preview. Revisions (especially negations) and
      // final transcripts invalidate it, preventing late results overwriting them.
      if (!this.closed && !controller.signal.aborted && generation === this.generation && comparable(this.latest).startsWith(comparable(english))) {
        this.publish(english, result.text);
      }
    } catch { /* Preview failures must not interrupt committed subtitles. */ }
    finally {
      clearTimeout(timeout);
      this.abort = undefined;
      this.running = false;
      this.schedule();
    }
  }
}
