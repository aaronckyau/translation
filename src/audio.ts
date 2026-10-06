import { appPath } from './paths';

export type AudioSource = 'video' | 'meeting' | 'microphone';

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
      } = {
        video: { displaySurface: source === 'video' ? 'browser' : 'monitor' },
        audio: { suppressLocalAudioPlayback: false },
        systemAudio: source === 'meeting' ? 'include' : 'exclude',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
      };
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
export async function createAudioPipeline(streams: MediaStream[], onAudio: (buffer: ArrayBuffer, rms: number) => void): Promise<AudioPipeline> {
  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule(appPath('pcm-worklet.js'));
    if (context.state === 'suspended') await context.resume();
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
        await context.close();
      },
    };
  } catch (error) { await context.close(); throw error; }
}
