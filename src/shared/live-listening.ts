/** The one bounded music-stream profile. These are transport limits, not a song-identification guarantee. */
export const LIVE_LISTENING = Object.freeze({
  sampleRate: 24_000, bytesPerFrame: 2, minSeconds: 5, autoFinishSeconds: 8, maxSeconds: 20,
  minFrames: 120_000, maxFrames: 480_000,
  maxChunkBytes: 8192, maxUpstreamChunkBytes: 65_536, maxQueuedBytes: 131_072, maxPackets: 512,
  setupMs: 15_000, inputGraceMs: 3000, executeMs: 90_000,
});

/** Closed, content-free diagnostics for private Live accounting; never response text or call IDs. */
export const LIVE_PROTOCOL_FAILURES = [
  'live_invalid_json', 'live_invalid_message', 'live_output_limit',
  'live_report_early', 'live_report_duplicate', 'live_report_envelope', 'live_report_args',
] as const;
export type LiveProtocolFailure = typeof LIVE_PROTOCOL_FAILURES[number];
