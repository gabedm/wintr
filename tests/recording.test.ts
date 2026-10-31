import { describe, expect, it } from 'vitest';
import { encodePcmWav, inspectPcmWav, RECORDING } from '../src/shared/recording.js';

// Hand-authored canonical RIFF header, independently of the production encoder.
function fixture(frames = 120_000) {
  const bytes = new Uint8Array(44 + frames * 2), v = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70], 0); v.setUint32(4, bytes.length - 8, true);
  bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true);
  v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  bytes.set([100, 97, 116, 97], 36); v.setUint32(40, frames * 2, true); return bytes;
}

describe('bounded microphone PCM WAVE', () => {
  it('derives duration from validated frames at both limits and rejects too-short/oversized input', () => {
    expect(inspectPcmWav(fixture())).toEqual({ frames: 120000, bytes: 240044, durationMs: 5000 });
    expect(inspectPcmWav(fixture(1440000))).toEqual({ frames: 1440000, bytes: 2880044, durationMs: 60000 });
    expect(() => inspectPcmWav(fixture(119999))).toThrow('recording_too_short');
    expect(() => inspectPcmWav(fixture(1440001))).toThrow('recording_too_long');
  });
  it.each([0, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40])('rejects a changed fixed-header field at %s', offset => {
    const bytes = fixture(); bytes[offset] = bytes[offset]! ^ 1;
    expect(() => inspectPcmWav(bytes)).toThrow('recording_invalid');
  });
  it('rejects truncation, trailing payload, mismatched lengths and compressed formats', () => {
    for (const value of [new Uint8Array(43), fixture().subarray(0, 100), new Uint8Array([...fixture(), 0]), new Uint8Array([79, 103, 103, 83])]) {
      expect(() => inspectPcmWav(value)).toThrow('recording_invalid');
    }
    const bytes = fixture(); new DataView(bytes.buffer).setUint16(20, 3, true); // IEEE float is outside this input contract.
    expect(() => inspectPcmWav(bytes)).toThrow('recording_invalid');
  });
  it('reads a bounded view without interpreting bytes outside it', () => {
    const wav = fixture(), envelope = new Uint8Array(wav.length + 14); envelope.set(wav, 7);
    expect(inspectPcmWav(envelope.subarray(7, -7)).durationMs).toBe(5000);
    expect(() => inspectPcmWav(envelope)).toThrow('recording_invalid');
  });
  it('encodes known signed little-endian samples, clamps amplitude and does not retain or modify input', () => {
    const samples = new Float32Array(120000); samples.set([-2, -1, -0.5, 0, 0.5, 1, 2]);
    const bytes = encodePcmWav(samples), v = new DataView(bytes.buffer);
    expect([...Array(7)].map((_, i) => v.getInt16(44 + i * 2, true))).toEqual([-32768, -32768, -16384, 0, 16384, 32767, 32767]);
    expect(samples[0]).toBe(-2); samples.fill(0);
    expect(v.getInt16(44, true)).toBe(-32768);
    expect([...bytes.subarray(0, 44)]).toEqual([...fixture().subarray(0, 44)]);
  });
  it('rejects nonfinite samples and duration overflow before producing a clip', () => {
    const samples = new Float32Array(120000);
    for (const value of [NaN, Infinity, -Infinity]) { samples[100] = value; expect(() => encodePcmWav(samples)).toThrow('recording_invalid'); }
    expect(() => encodePcmWav(new Float32Array(119999))).toThrow('recording_too_short');
    expect(() => encodePcmWav(new Float32Array(1440001))).toThrow('recording_too_long');
  });
  it('keeps the maximal encoded payload below the proposed bounded JSON ceiling', () => {
    const base64Length = 4 * Math.ceil(RECORDING.maxWavBytes / 3);
    expect(base64Length + 4096).toBeLessThan(RECORDING.maxJsonBytes);
  });
});
