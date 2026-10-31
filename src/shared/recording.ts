// The microphone path accepts only the format this client creates. This is not
// a general audio/file decoder. Duration is derived from PCM frames, never from
// a browser's duration claim or compressed-container metadata.
export const RECORDING = Object.freeze({
  sampleRate: 24_000,
  channels: 1,
  bitsPerSample: 16,
  bytesPerFrame: 2,
  headerBytes: 44,
  minFrames: 5 * 24_000,
  maxFrames: 60 * 24_000,
  maxWavBytes: 44 + 60 * 24_000 * 2,
  maxJsonBytes: 4 * 1024 * 1024,
  mimeType: 'audio/wav',
} as const);

export type RecordingProblem = 'recording_invalid' | 'recording_too_short' | 'recording_too_long';
export class RecordingFormatError extends Error {
  constructor(readonly code: RecordingProblem) { super(code); }
}
export interface PcmWavInfo {
  readonly frames: number;
  readonly bytes: number;
  readonly durationMs: number;
}

const framesAllowed = (frames: number) => {
  if (!Number.isSafeInteger(frames) || frames < 0) throw new RecordingFormatError('recording_invalid');
  if (frames < RECORDING.minFrames) throw new RecordingFormatError('recording_too_short');
  if (frames > RECORDING.maxFrames) throw new RecordingFormatError('recording_too_long');
};
function ascii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}
function hasAscii(view: DataView, offset: number, expected: string) {
  for (let i = 0; i < expected.length; i++) if (view.getUint8(offset + i) !== expected.charCodeAt(i)) return false;
  return true;
}

/** Local native PCM samples only; no mutation or retained reference to the caller's samples. */
export function encodePcmWav(samples: Float32Array): Uint8Array {
  framesAllowed(samples.length);
  // Validate before allocation; a broken device/processor must not produce a purported valid recording.
  for (const sample of samples) if (!Number.isFinite(sample)) throw new RecordingFormatError('recording_invalid');
  const bytes = new Uint8Array(RECORDING.headerBytes + samples.length * RECORDING.bytesPerFrame);
  const view = new DataView(bytes.buffer);
  ascii(view, 0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(view, 8, 'WAVE');
  ascii(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, RECORDING.channels, true); view.setUint32(24, RECORDING.sampleRate, true);
  view.setUint32(28, RECORDING.sampleRate * RECORDING.bytesPerFrame, true);
  view.setUint16(32, RECORDING.bytesPerFrame, true); view.setUint16(34, RECORDING.bitsPerSample, true);
  ascii(view, 36, 'data'); view.setUint32(40, samples.length * RECORDING.bytesPerFrame, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(RECORDING.headerBytes + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

/** Call with owned decoded bytes, not an untrusted JS object. Reject every noncanonical container. */
export function inspectPcmWav(bytes: Uint8Array): PcmWavInfo {
  if (bytes.byteLength > RECORDING.maxWavBytes) throw new RecordingFormatError('recording_too_long');
  if (bytes.byteLength < RECORDING.headerBytes) throw new RecordingFormatError('recording_invalid');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!hasAscii(view, 0, 'RIFF') || !hasAscii(view, 8, 'WAVE') || !hasAscii(view, 12, 'fmt ') || !hasAscii(view, 36, 'data') ||
      view.getUint32(4, true) !== bytes.byteLength - 8 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== RECORDING.channels ||
      view.getUint32(24, true) !== RECORDING.sampleRate || view.getUint32(28, true) !== RECORDING.sampleRate * RECORDING.bytesPerFrame ||
      view.getUint16(32, true) !== RECORDING.bytesPerFrame || view.getUint16(34, true) !== RECORDING.bitsPerSample ||
      view.getUint32(40, true) !== bytes.byteLength - RECORDING.headerBytes ||
      (bytes.byteLength - RECORDING.headerBytes) % RECORDING.bytesPerFrame !== 0) throw new RecordingFormatError('recording_invalid');
  const frames = (bytes.byteLength - RECORDING.headerBytes) / RECORDING.bytesPerFrame;
  framesAllowed(frames);
  return Object.freeze({ frames, bytes: bytes.byteLength, durationMs: frames * 1000 / RECORDING.sampleRate });
}
