// Continuous box-filter resampling keeps fractional sample positions across render blocks.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.remaining = this.ratio;
    this.sum = 0;
    this.frames = [];
    this.energy = 0;
    this.port.onmessage = event => {
      if (event.data === 'flush') {
        this.send();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  sample(value) {
    this.frames.push(Math.max(-32768, Math.min(32767, Math.round(value * (value < 0 ? 32768 : 32767)))));
    this.energy += value * value;
    if (this.frames.length === 1600) this.send();
  }
  send() {
    if (!this.frames.length) return;
    const buffer = new ArrayBuffer(this.frames.length * 2);
    const view = new DataView(buffer);
    this.frames.forEach((value, index) => view.setInt16(index * 2, value, true));
    this.port.postMessage({ type: 'audio', buffer, rms: Math.sqrt(this.energy / this.frames.length) }, [buffer]);
    this.frames = [];
    this.energy = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i];
      value /= channels.length;
      let available = 1;
      while (available > 1e-8) {
        const weight = Math.min(available, this.remaining);
        this.sum += value * weight;
        this.remaining -= weight;
        available -= weight;
        if (this.remaining < 1e-8) {
          this.sample(this.sum / this.ratio);
          this.sum = 0;
          this.remaining = this.ratio;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
