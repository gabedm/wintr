// Self-hosted local PCM capture. Bounds mirror shared/recording.ts and are
// checked by the VM tests. No imports, persistence, network or audio monitoring.
class WintrRecordingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.running = sampleRate === 24000;
    this.frames = 0;
    this.used = 0;
    this.batch = new Float32Array(4096);
    this.port.onmessage = event => {
      if (event.data?.type === 'stop') this.finish();
      else if (event.data?.type === 'cancel') { this.running = false; this.batch.fill(0); this.used = 0; }
    };
    if (!this.running) this.port.postMessage({ type: 'fault' });
  }
  flush() {
    if (!this.used) return;
    const samples = this.batch.slice(0, this.used);
    this.batch.fill(0); this.used = 0;
    this.port.postMessage({ type: 'frames', samples }, [samples.buffer]);
  }
  finish() {
    if (!this.running) return;
    this.running = false; this.flush();
    this.port.postMessage({ type: 'stopped', frames: this.frames });
  }
  fault() {
    if (!this.running) return;
    this.running = false; this.batch.fill(0); this.used = 0;
    this.port.postMessage({ type: 'fault' });
  }
  process(inputs, outputs) {
    // Never route microphone input to speakers, including the final quantum.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (!this.running) return false;
    const input = inputs[0];
    if (!input?.length) return true;
    if (input.length !== 1) { this.fault(); return false; }
    const channel = input[0];
    // Count actual frames; render quanta are not assumed to be 128 samples.
    for (let i = 0; i < channel.length; i++) {
      if (!Number.isFinite(channel[i])) { this.fault(); return false; }
      this.batch[this.used++] = channel[i]; this.frames++;
      if (this.used === this.batch.length) this.flush();
      if (this.frames === 1440000) { this.finish(); return false; }
    }
    return true;
  }
}
registerProcessor('wintr-recording', WintrRecordingProcessor);
