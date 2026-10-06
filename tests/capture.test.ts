import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

// Exercise the actual browser module; only browser APIs and Vite's URL helper are supplied.
const code = transpileModule(readFileSync(new URL('../src/audio.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
interface AudioModule {
  captureAudio(source: 'video' | 'meeting' | 'microphone', includeMic: boolean): Promise<MediaStream[]>;
  createAudioPipeline(streams: MediaStream[], onAudio: (data: ArrayBuffer, rms: number) => void, context?: AudioContext): Promise<{ stop(): Promise<void> }>;
  prepareAudioContext(): AudioContext;
}
function browser(withController = true) {
  let gesture = true;
  let focused = 'translator';
  const contexts: Context[] = [];
  const track = { stop() {} };
  const stream = { getAudioTracks: () => [track], getVideoTracks: () => [track], getTracks: () => [track] };
  class Controller {
    focus = '';
    setFocusBehavior(value: string) { this.focus = value; }
  }
  class Node {
    constructor(private context: Context) {}
    connect(_target: unknown) {
      queueMicrotask(() => {
        if (this.context.state === 'running') this.context.capture?.port.onmessage?.({ data: { type: 'audio', buffer: new ArrayBuffer(3200), rms: 0.02 } });
      });
      return _target;
    }
    disconnect() {}
  }
  class Context {
    state = 'suspended';
    destination = {};
    capture?: Worklet;
    audioWorklet = { addModule: async (_path: string) => {} };
    constructor() { contexts.push(this); }
    resume(): Promise<void> {
      if (!gesture) return new Promise(() => {});
      this.state = 'running';
      return Promise.resolve();
    }
    async close() { this.state = 'closed'; }
    createMediaStreamSource(_stream: unknown) { return new Node(this); }
    createGain() { return Object.assign(new Node(this), { gain: { value: 1 } }); }
  }
  class Worklet extends Node {
    port = {
      onmessage: undefined as ((event: { data: { type: string; buffer?: ArrayBuffer; rms?: number } }) => void) | undefined,
      postMessage: (_message: unknown) => queueMicrotask(() => this.port.onmessage?.({ data: { type: 'flushed' } })),
      close() {},
    };
    constructor(context: Context) { super(context); context.capture = this; }
  }
  const exports: Record<string, unknown> = {};
  runInNewContext(code, {
    exports,
    require: (name: string) => { assert.equal(name, './paths'); return { appPath: (path: string) => `/${path}` }; },
    window: { isSecureContext: true, ...(withController ? { CaptureController: Controller } : {}) },
    navigator: { mediaDevices: {
      getDisplayMedia: async (options: { controller?: Controller }) => {
        focused = options.controller?.focus === 'focus-capturing-application' ? 'translator' : 'youtube';
        return stream;
      },
      getUserMedia: async () => stream,
    } },
    AudioContext: Context, AudioWorkletNode: Worklet, MediaStream: class {}, DOMException,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 20)), clearTimeout,
  });
  return { audio: exports as unknown as AudioModule, Context, contexts, stream: stream as unknown as MediaStream,
    endGesture: () => { gesture = false; }, focused: () => focused };
}

test('sharing a YouTube tab retains the translator page when conditional focus is supported', async () => {
  const fixture = browser();
  const streams = await fixture.audio.captureAudio('video', false);
  assert.equal(streams.length, 1);
  assert.equal(fixture.focused(), 'translator', 'sharing must not hide subtitle and capture status behind YouTube');
});

test('audio continues after the share picker and delayed websocket setup end user activation', async () => {
  const fixture = browser();
  const context = fixture.audio.prepareAudioContext();
  assert.equal(context.state, 'running', 'start click must activate audio before opening the picker');
  fixture.endGesture();
  let frames = 0;
  const pending = fixture.audio.createAudioPipeline([fixture.stream], () => { frames++; }, context);
  const pipeline = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), 60))]);
  try {
    assert.ok(pipeline, 'capture initialization stayed suspended after sharing: no PCM reached the server');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(frames > 0, 'the prepared audio context must emit PCM after setup');
    assert.equal(fixture.contexts.length, 1, 'setup must reuse the context activated by the start click');
    await pipeline.stop();
    assert.equal(context.state, 'closed');
  } finally { await Promise.all(fixture.contexts.map(item => item.close())); }
});

test('a browser that never resumes audio fails promptly and closes its context', async () => {
  const fixture = browser();
  fixture.endGesture();
  const result = await Promise.race([
    fixture.audio.createAudioPipeline([fixture.stream], () => {}).then(() => 'unexpected success', error => String(error.message)),
    new Promise<string>(resolve => setTimeout(() => resolve('still waiting for browser audio'), 60)),
  ]);
  try {
    assert.match(result, /收音|啟動/, 'blocked capture must produce an actionable error instead of showing a live session with 00:00');
    assert.equal(fixture.contexts[0]?.state, 'closed');
  } finally { await Promise.all(fixture.contexts.map(item => item.close())); }
});

test('browsers without conditional focus still capture audio', async () => {
  const fixture = browser(false);
  assert.equal((await fixture.audio.captureAudio('meeting', false)).length, 1);
});
