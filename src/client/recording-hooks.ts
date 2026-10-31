import { useLayoutEffect, useRef, useState } from 'react';
import { createMusicCapture, type MusicCapture, type MusicCaptureSnapshot } from './music-capture.js';

const IDLE: MusicCaptureSnapshot = Object.freeze({ phase: 'idle', durationMs: 0, error: null });

/** One local capture owner, never a per-chat cache. StrictMode creates/disposes each effect's own engine. */
export function useLocalRecording(scope: string, allowed: boolean) {
  const engine = useRef<MusicCapture | null>(null);
  const ownedScope = useRef(scope);
  const [observed, setObserved] = useState({ scope, snapshot: IDLE });
  useLayoutEffect(() => {
    const capture = createMusicCapture();
    engine.current = capture;
    const update = () => setObserved({ scope: ownedScope.current, snapshot: capture.getSnapshot() });
    const unsubscribe = capture.subscribe(update);
    update();
    return () => { unsubscribe(); capture.dispose(); if (engine.current === capture) engine.current = null; };
  }, []);
  useLayoutEffect(() => {
    if (ownedScope.current !== scope || !allowed) {
      ownedScope.current = scope;
      engine.current?.cancel();
      setObserved({ scope, snapshot: IDLE });
    }
  }, [scope, allowed]);
  const current = () => allowed && ownedScope.current === scope ? engine.current : null;
  return {
    snapshot: allowed && observed.scope === scope ? observed.snapshot : IDLE,
    start: () => { void current()?.start(); },
    stop: () => { void current()?.stop(); },
    cancel: () => engine.current?.cancel(),
    takeBytes: () => current()?.takeBytes() ?? null,
    /** The same explicit Analyse may adopt entry into a Session before React rerenders. */
    takePreparedBytes: (ready: MusicCaptureSnapshot, expectedScope: string) => allowed && ownedScope.current === expectedScope &&
      ready.phase === 'ready' && engine.current?.getSnapshot() === ready ? engine.current.takeBytes() : null,
    readyMetadata: () => current()?.readyMetadata() ?? Promise.resolve(null),
    matchesReady: (snapshot: MusicCaptureSnapshot) => snapshot.phase === 'ready' && engine.current?.getSnapshot() === snapshot,
    /** Only the owning explicit metadata operation may adopt entry audio into its newly created Session. */
    adoptScope: (from: string, to: string, snapshot: MusicCaptureSnapshot) => {
      if (ownedScope.current !== from || snapshot.phase !== 'ready' || engine.current?.getSnapshot() !== snapshot) return false;
      ownedScope.current = to; setObserved({ scope: to, snapshot }); return true;
    },
  };
}
