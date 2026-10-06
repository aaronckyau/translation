import { appPath } from './paths';

export type AudioSource = 'video' | 'meeting' | 'microphone';

export class AudioStartupError extends Error {}

// Activate Web Audio in the start click, before the picker and network round trip.
export function prepareAudioContext(): AudioContext {
  const context = new AudioContext();
  if (context.state === 'suspended') void context.resume().catch(() => {});
  return context;
}

async function waitForAudioStartup<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new AudioStartupError(message)), 5000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

export async function captureAudio(source: AudioSource, includeMic: boolean): Promise<MediaStream[]> {
  if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('請使用 HTTPS 網站或 localhost 開啟翻譯。');
  const streams: MediaStream[] = [];
  try {
    if (source === 'microphone') {
      streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }));
    } else {
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error('此瀏覽器不支援分享音訊，請使用電腦版 Chrome 或 Edge。');
      const options: DisplayMediaStreamOptions & {
        audio: MediaTrackConstraints & { suppressLocalAudioPlayback: boolean };
        systemAudio: 'include' | 'exclude';
        selfBrowserSurface: 'exclude';
        surfaceSwitching: 'exclude';
        controller?: { setFocusBehavior(value: 'focus-capturing-application'): void };
      } = {
        video: { displaySurface: source === 'video' ? 'browser' : 'monitor' },
        audio: { suppressLocalAudioPlayback: false },
        systemAudio: source === 'meeting' ? 'include' : 'exclude',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
      };
      const Controller = (window as Window & {
        CaptureController?: new () => { setFocusBehavior(value: 'focus-capturing-application'): void };
      }).CaptureController;
      if (Controller?.prototype.setFocusBehavior) {
        try {
          const controller = new Controller();
          // Set this before the picker; setting it after sharing a monitor can throw.
          controller.setFocusBehavior('focus-capturing-application');
          options.controller = controller;
        } catch { /* Optional focus control must not prevent capture in older browsers. */ }
      }
      const display = await navigator.mediaDevices.getDisplayMedia(options);
      streams.push(display);
      if (!display.getAudioTracks().length) throw new Error(source === 'video' ? '未收到分頁音訊。請重新選擇影片分頁，並勾選「分享分頁音訊」。' : '未收到音訊。請選擇整個螢幕並勾選「分享系統音訊」，或改用網頁版會議的分頁音訊。');
      if (includeMic) streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }));
    }
    return streams;
  } catch (error) {
    streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError') throw new Error('分享已取消或未獲授權。準備好後可再按開始。');
      if (error.name === 'NotFoundError') throw new Error('找不到可用的聲音來源，請檢查麥克風或分享設定。');
      if (error.name === 'NotReadableError') throw new Error('無法讀取聲音來源，請檢查系統權限後再試。');
    }
    throw error;
  }
}

export interface AudioPipeline { stop(): Promise<void> }
export async function createAudioPipeline(streams: MediaStream[], onAudio: (buffer: ArrayBuffer, rms: number) => void, context = new AudioContext()): Promise<AudioPipeline> {
  try {
    await waitForAudioStartup(context.audioWorklet.addModule(appPath('pcm-worklet.js')), '收音模組載入逾時。請重新整理後再試。');
    if (context.state !== 'running') await waitForAudioStartup(context.resume(), '瀏覽器暫停了收音。請回到翻譯頁，再按開始翻譯。');
    if (context.state !== 'running') throw new AudioStartupError('收音尚未啟動。請回到翻譯頁，再按開始翻譯。');
    const capture = new AudioWorkletNode(context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    const sources = streams.map(stream => context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())));
    sources.forEach(source => source.connect(capture));
    // Drive the worklet without replaying captured audio or creating a feedback loop.
    const mute = context.createGain();
    mute.gain.value = 0;
    capture.connect(mute).connect(context.destination);
    let resolveFlush: (() => void) | undefined;
    let stopped = false;
    capture.port.onmessage = (event: MessageEvent<{ type: string; buffer: ArrayBuffer; rms: number }>) => {
      if (event.data.type === 'audio') onAudio(event.data.buffer, event.data.rms);
      if (event.data.type === 'flushed') resolveFlush?.();
    };
    return {
      async stop() {
        if (stopped) return;
        stopped = true;
        await new Promise<void>(resolve => {
          const timeout = setTimeout(resolve, 100);
          resolveFlush = () => { clearTimeout(timeout); resolve(); };
          capture.port.postMessage('flush');
        });
        sources.forEach(source => source.disconnect());
        capture.disconnect();
        mute.disconnect();
        capture.port.close();
        if (context.state !== 'closed') await context.close().catch(() => {});
      },
    };
  } catch (error) { if (context.state !== 'closed') await context.close().catch(() => {}); throw error; }
}
