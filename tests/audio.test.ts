import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

interface Captured { type: string; buffer?: ArrayBuffer; rms?: number }
interface Processor { process(inputs: Float32Array[][]): boolean; port: { onmessage: (event: { data: string }) => void } }
type ProcessorConstructor = new () => Processor;
function worklet(rate: number) {
  const messages: Captured[] = [];
  let Constructor: ProcessorConstructor | undefined;
  class Base { port = { postMessage: (value: Captured) => messages.push(value), onmessage: (_event: { data: string }) => {} }; }
  runInNewContext(readFileSync(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8'), {
    sampleRate: rate,
    AudioWorkletProcessor: Base,
    registerProcessor: (_name: string, cls: ProcessorConstructor) => { Constructor = cls; },
  });
  return { processor: new Constructor!(), messages };
}
for (const rate of [16000, 44100, 48000]) {
  test(`worklet resamples ${rate} Hz to exact 16 kHz little-endian PCM across uneven blocks`, () => {
    const { processor, messages } = worklet(rate);
    for (let offset = 0; offset < rate; offset += 128) {
      const input = new Float32Array(Math.min(128, rate - offset)).fill(0.5);
      processor.process([[input]]);
    }
    processor.port.onmessage({ data: 'flush' });
    const chunks = messages.filter(m => m.type === 'audio');
    const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.buffer!.byteLength / 2, 0);
    assert.equal(sampleCount, 16000);
    for (const chunk of chunks) {
      assert.ok(chunk.buffer!.byteLength <= 3200);
      assert.equal(new DataView(chunk.buffer!).getInt16(0, true), 16384);
      assert.ok(Math.abs(chunk.rms! - 0.5) < 1e-6);
    }
  });
}
test('worklet averages stereo channels and flushes the final partial chunk', () => {
  const { processor, messages } = worklet(48000);
  processor.process([[new Float32Array(120).fill(-1), new Float32Array(120).fill(0)]]);
  processor.port.onmessage({ data: 'flush' });
  assert.equal(messages[0]?.buffer?.byteLength, 80);
  assert.equal(new DataView(messages[0]!.buffer!).getInt16(0, true), -16384);
  assert.equal(messages.at(-1)?.type, 'flushed');
});
