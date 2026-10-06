import type { Caption, ServerEvent } from '../shared/protocol';
import { providerError } from './security';
import { TranslationQueue, type Translator } from './translation';
import { PreviewTranslator } from './preview';

export interface TranscriptMessage { interim?: string; final?: string; goAway?: boolean }
export interface Transcriber { sendAudio(data: Buffer): void; endAudio(): void; close(): void }
export interface GatewayCallbacks { message(message: TranscriptMessage): void; error(error: unknown): void; close(): void }
export type ConnectTranscriber = (callbacks: GatewayCallbacks) => Promise<Transcriber>;

export class SubtitleSession {
  private transcriber: Transcriber | null = null;
  private retiring = new Set<Transcriber>();
  private queue: TranslationQueue;
  private preview: PreviewTranslator;
  private closed = false;
  private finishing = false;
  private connecting = false;
  private generation = 0;
  private retries = 0;
  private buffer: Buffer[] = [];
  private bufferBytes = 0;
  private audioBytes = 0;
  private transcriptTokens = 0;
  private translationInput = 0;
  private translationOutput = 0;
  private boundaryMs = 0;
  private captionId = 0;
  private pending = new Map<number, Caption>();
  private lastAudioAt = Date.now();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private monitor: ReturnType<typeof setInterval>;
  private lastUsageAt = 0;
  private finishStartedAt = 0;

  constructor(
    private connect: ConnectTranscriber,
    translate: Translator,
    private emit: (event: ServerEvent) => void,
    private onDone: () => void,
    maxMinutes = 120,
    previewTranslate: Translator = translate,
  ) {
    this.queue = new TranslationQueue(translate, error => this.emit({ type: 'error', message: providerError(error), fatal: false }));
    this.preview = new PreviewTranslator(previewTranslate, () => this.queue.recentContext,
      (english, chinese) => this.emit({ type: 'preview', english, chinese }),
      result => { this.translationInput += result.inputTokens; this.translationOutput += result.outputTokens; this.usage(); });
    this.monitor = setInterval(() => {
      if (!this.closed && !this.finishing && Date.now() - this.lastAudioAt > 30_000) this.fail('已停止收到音訊，請重新選擇聲音來源。');
      if (this.finishing && ((Date.now() - this.finishStartedAt > 2500 && !this.queue.busy) || Date.now() - this.finishStartedAt > 16_000)) this.complete();
    }, 250);
    this.later(() => { this.emit({ type: 'error', message: '已達本次使用時間上限。', fatal: false }); this.finish(); }, maxMinutes * 60_000);
  }

  get isClosed(): boolean { return this.closed; }
  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.closed) fn(); }, ms);
    this.timers.add(timer);
  }
  private usage(): void {
    const audioSeconds = this.audioBytes / 32_000;
    const estimatedUsd = audioSeconds * 25 / 1e6 * 3.5 + this.transcriptTokens / 1e6 * 21 + this.translationInput / 1e6 * 0.3 + this.translationOutput / 1e6 * 2.5;
    this.emit({ type: 'usage', audioSeconds, estimatedUsd });
  }
  async start(): Promise<void> { await this.open(false); }

  private async open(reconnect: boolean): Promise<void> {
    if (this.closed || this.finishing || this.connecting) return;
    this.connecting = true;
    const generation = ++this.generation;
    this.emit({ type: 'status', phase: reconnect ? 'reconnecting' : 'connecting', message: reconnect ? '正在更新翻譯連線，音訊暫存中…' : '正在連接即時翻譯…' });
    const timeout = setTimeout(() => { if (generation === this.generation && this.connecting) this.fail('Gemini 連線逾時，請重新開始。'); }, 15_000);
    this.timers.add(timeout);
    try {
      const live = await this.connect({
        message: message => { if (!this.closed && generation === this.generation) this.message(message); },
        error: error => { if (!this.closed && generation === this.generation) this.fail(providerError(error)); },
        close: () => {
          if (this.closed || this.finishing || generation !== this.generation) return;
          this.transcriber = null;
          this.connecting = false;
          if (++this.retries > 3) this.fail('翻譯連線多次中斷，請檢查網絡後重新開始。');
          else this.later(() => { void this.open(true); }, 800 * this.retries);
        },
      });
      if (this.closed || this.finishing || generation !== this.generation) { live.close(); return; }
      this.transcriber = live;
      this.connecting = false;
      for (const chunk of this.buffer) live.sendAudio(chunk);
      this.buffer = [];
      this.bufferBytes = 0;
      this.emit({ type: 'status', phase: 'live', message: '正在聆聽及翻譯' });
      this.later(() => { if (generation === this.generation) void this.rotate(); }, 9 * 60_000);
    } catch (error) { this.fail(providerError(error)); }
    finally { clearTimeout(timeout); this.timers.delete(timeout); }
  }

  private async rotate(): Promise<void> {
    if (this.closed || this.finishing || this.connecting || !this.transcriber) return;
    this.emit({ type: 'status', phase: 'reconnecting', message: '正在更新翻譯連線，音訊暫存中…' });
    const previous = this.transcriber;
    this.retiring.add(previous);
    this.transcriber = null;
    this.connecting = true;
    try { previous.endAudio(); } catch { /* Reconnect also handles an expired connection. */ }
    this.later(() => {
      // Ignore intentional close events, while keeping the preceding final transcript.
      ++this.generation;
      previous.close();
      this.retiring.delete(previous);
      this.connecting = false;
      void this.open(true);
    }, 800);
  }

  audio(data: Buffer): void {
    if (this.closed || this.finishing) return;
    if (!data.length || data.length % 2 !== 0 || data.length > 6400) { this.fail('音訊格式不正確，請重新開始。'); return; }
    this.lastAudioAt = Date.now();
    // Prevent clients sending many hours of audio in seconds and incurring unbounded cost.
    this.audioBytes += data.length;
    if (this.transcriber) {
      try { this.transcriber.sendAudio(data); }
      catch { this.fail('音訊傳送中斷，請重新開始。'); return; }
    } else {
      this.buffer.push(data);
      this.bufferBytes += data.length;
      if (this.bufferBytes > 320_000) this.fail('翻譯連線未能及時恢復，請重新開始。');
    }
    // Continuous speech gets previews instead of cutting the audio mid-word.
    // Natural pauses and stop still finalize authoritative captions.
    if (Date.now() - this.lastUsageAt > 1000) { this.lastUsageAt = Date.now(); this.usage(); }
  }
  flush(): void {
    if (!this.transcriber || this.closed || this.finishing) return;
    try { this.transcriber.endAudio(); }
    catch { this.fail('音訊傳送中斷，請重新開始。'); }
  }
  private message(message: TranscriptMessage): void {
    if (message.interim?.trim()) {
      const english = message.interim.trim().slice(0, 6000);
      this.emit({ type: 'interim', english });
      if (!this.finishing) this.preview.update(english);
    }
    const english = message.final?.trim().slice(0, 6000);
    if (english) {
      this.preview.reset();
      this.retries = 0;
      const endMs = this.audioBytes / 32;
      const caption: Caption = { id: ++this.captionId, english, chinese: '', startMs: this.boundaryMs, endMs, translationState: 'pending' };
      this.boundaryMs = endMs;
      this.transcriptTokens += Math.ceil(english.length / 4);
      this.emit({ type: 'interim', english: '' });
      this.emit({ type: 'caption', caption });
      this.pending.set(caption.id, caption);
      const accepted = this.queue.add(english, result => {
        this.pending.delete(caption.id);
        if (result) { this.translationInput += result.inputTokens; this.translationOutput += result.outputTokens; }
        this.emit({ type: 'caption', caption: { ...caption, chinese: result?.text || '', translationState: result ? 'done' : 'error' } });
        this.usage();
      });
      if (!accepted) {
        this.pending.delete(caption.id);
        this.emit({ type: 'caption', caption: { ...caption, translationState: 'error' } });
        this.emit({ type: 'error', message: '翻譯速度暫時跟不上語音，此句保留英文。', fatal: false });
      }
    }
    if (message.goAway && !this.finishing) void this.rotate();
  }

  finish(): void {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    this.preview.reset();
    this.finishStartedAt = Date.now();
    this.emit({ type: 'status', phase: 'finishing', message: '正在完成最後幾句字幕…' });
    try { this.transcriber?.endAudio(); } catch { /* Finish translated captions already received. */ }
  }
  private fail(message: string): void {
    if (this.closed) return;
    this.emit({ type: 'error', message, fatal: true });
    this.complete();
  }
  private complete(): void {
    if (this.closed) return;
    for (const caption of this.pending.values()) this.emit({ type: 'caption', caption: { ...caption, translationState: 'error' } });
    this.usage();
    this.emit({ type: 'status', phase: 'stopped', message: '翻譯已停止' });
    this.dispose();
    this.onDone();
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.monitor);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.queue.close();
    this.preview.close();
    const live = this.transcriber;
    this.transcriber = null;
    live?.close();
    for (const retiring of this.retiring) retiring.close();
    this.retiring.clear();
    this.buffer = [];
    this.pending.clear();
  }
}
